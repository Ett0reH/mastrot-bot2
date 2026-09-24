// Parità del giorno tra il bot e il backtest sugli stessi dati (F6, F7).
//
// Si riparte dallo stato del core salvato all'inizio del giorno (checkpoint) e si rigioca il giorno
// con lo stesso codice del backtest, sulle candele definitive scaricate dopo la fine del giorno,
// uno slot alla volta. Gli intenti respinti dal bot (guardrail, exchange, ingressi tardivi) vengono
// respinti anche nel replay: così il confronto isola le differenze dovute a dati e tempi.
// - shadow: esecuzione simulata con il modello del backtest; si confrontano decisioni e trade.
// - demo/live: si riusano i fill reali di Kraken negli stessi slot; si confrontano le decisioni
//   (lo scostamento dei prezzi dal modello è nel report come slippage).
// Una differenza è "spiegata" quando la candela di quello slot mancava al momento della decisione.
import { REALISTIC_PROFILE } from '../backtest/profiles';
import { slotEnd } from '../core/aggregator';
import type { CoreConfig, CoreState } from '../core/decisionCore';
import type { DecisionRecord, Fill, Intent, TradeRecord } from '../core/types';
import { BAR_15M_MS } from '../data/dataset';
import { DecisionCycle, type DecisionCycleConfig, type ExecutedFill } from '../live/decisionCycle';
import type { CandleSource, ExecutionPort, ExecutionReport, FundingCharge } from '../live/ports';
import { SimExecutionPort } from '../replay/replay';
import { GatedExecutionPort } from '../runtime/gatedPort';
import type { RestingStop } from '../sim/simExchange';
import type { DayStats } from './dayTracker';

export interface DayCheckpoint {
  day: string;
  savedAt: string;
  /** Stato del core prima del primo slot del giorno (o all'avvio, se il bot è partito in giornata). */
  core: CoreState;
  /** Stop simulati in shadow (null in demo/live). */
  simStops: RestingStop[] | null;
}

export interface Divergence {
  kind: 'decision' | 'trade';
  slotTime: string;
  symbol: string;
  actual: string | null;
  replay: string | null;
  explanation: string | null;
}

export type ParityStatus = 'IDENTICAL' | 'EXPLAINED' | 'DIVERGENT' | 'NOT_AVAILABLE';

export interface ParityResult {
  status: ParityStatus;
  reason: string | null;
  mode: 'simulated' | 'actual_fills';
  fromSlot: string | null;
  toSlot: string | null;
  compared: { decisions: number; trades: number };
  explained: number;
  unexplained: number;
  divergences: Divergence[];
}

export function notAvailable(reason: string, mode: ParityResult['mode']): ParityResult {
  return { status: 'NOT_AVAILABLE', reason, mode, fromSlot: null, toSlot: null, compared: { decisions: 0, trades: 0 }, explained: 0, unexplained: 0, divergences: [] };
}

function stripFill(f: ExecutedFill): Fill {
  const { side: _s, referencePrice: _r, appliedAtSlot: _a, phase: _p, ...fill } = f;
  return fill;
}

/** Porta del replay in demo/live: restituisce i fill e i rifiuti reali, negli stessi slot e fasi del bot. */
class ActualFillsPort implements ExecutionPort {
  constructor(private readonly stats: DayStats) {}

  async settle(slotTime: number): Promise<ExecutionReport> {
    const fills = this.stats.fills.filter((f) => (f.phase === 'settle' && f.appliedAtSlot === slotTime) || (f.phase === 'external' && f.appliedAtSlot !== null && f.appliedAtSlot + BAR_15M_MS === slotTime));
    const rejected = this.stats.rejections.filter((r) => r.phase === 'settle' && r.slot === slotTime).map((r) => ({ positionId: r.positionId, reason: r.reason }));
    return { fills: fills.map(stripFill), rejected };
  }

  async funding(): Promise<FundingCharge[]> {
    return []; // in demo/live il funding reale sta nel ledger, non nel core
  }

  async execute(intents: readonly Intent[]): Promise<ExecutionReport> {
    const out: ExecutionReport = { fills: [], rejected: [] };
    for (const intent of intents) {
      if (intent.kind === 'UPDATE_STOP') continue;
      const fill = this.stats.fills.find((f) => f.phase === 'execute' && f.appliedAtSlot === intent.slotTime && f.positionId === intent.positionId && f.kind === intent.kind);
      if (fill) {
        out.fills.push(stripFill(fill));
        continue;
      }
      const rejection = this.stats.rejections.find((r) => r.phase === 'execute' && r.slot === intent.slotTime && r.positionId === intent.positionId && r.kind === intent.kind);
      if (rejection) out.rejected.push({ positionId: intent.positionId, reason: rejection.reason });
      // altrimenti l'esito è arrivato più tardi (settle di uno slot successivo), come nel bot
    }
    return out;
  }
}

export interface ReplayDayInput {
  mode: 'simulated' | 'actual_fills';
  day: string;
  checkpoint: DayCheckpoint;
  stats: DayStats;
  cycle: Omit<DecisionCycleConfig, 'core'>;
  core: CoreConfig;
  source: CandleSource;
}

/** Rigioca il giorno dal checkpoint; restituisce journal e trade prodotti dal codice del backtest. */
export async function replayDay(input: ReplayDayInput): Promise<{ journal: DecisionRecord[]; trades: TradeRecord[]; fromSlot: number; toSlot: number }> {
  const dayStart = Date.parse(`${input.day}T00:00:00Z`);
  const toSlot = dayStart + 24 * 3_600_000 - BAR_15M_MS;
  const lastSlot = input.checkpoint.core.lastSlot;
  if (lastSlot === null) throw new Error('checkpoint senza slot elaborati');
  const fromSlot = lastSlot + BAR_15M_MS;
  let port: ExecutionPort;
  if (input.mode === 'simulated') {
    const rejectedOpens = new Map(input.stats.rejections.filter((r) => r.kind === 'OPEN').map((r) => [r.positionId, r.reason] as const));
    port = new GatedExecutionPort(new SimExecutionPort(REALISTIC_PROFILE.execution, { kind: 'none' }, { stops: input.checkpoint.simStops ?? [] }), (intent) => rejectedOpens.get(intent.positionId) ?? null);
  } else {
    port = new ActualFillsPort(input.stats);
  }
  const cycle = new DecisionCycle({ ...input.cycle, core: input.core }, { source: input.source, port }, structuredClone(input.checkpoint.core));
  await cycle.start();
  const journal: DecisionRecord[] = [];
  const trades: TradeRecord[] = [];
  // Uno slot alla volta, come il bot puntuale: nessun ingresso scartato per ritardo.
  for (let slot = fromSlot; slot <= toSlot; slot += BAR_15M_MS) {
    const r = await cycle.tick(slotEnd(slot) + input.cycle.candleWaitMs + 1);
    journal.push(...r.journal);
    trades.push(...r.trades);
  }
  return { journal, trades, fromSlot, toSlot };
}

function describe(r: DecisionRecord): string {
  return `${r.action}${r.direction ? ` ${r.direction}` : ''}: ${r.reason}`;
}

function tradeKey(t: TradeRecord): string {
  return `${t.symbol}|${t.entryTime}`;
}

function tradeText(t: TradeRecord): string {
  return `${t.type} ${t.entryPrice} → ${t.exitPrice} (${t.reason}) size ${t.size} PnL ${t.pnl.toFixed(6)}`;
}

export interface CompareInput {
  mode: ParityResult['mode'];
  fromSlot: number;
  toSlot: number;
  actualJournal: readonly DecisionRecord[];
  replayJournal: readonly DecisionRecord[];
  /** Solo in shadow: trade chiusi nel giorno dal bot e dal replay. */
  actualTrades?: readonly TradeRecord[];
  replayTrades?: readonly TradeRecord[];
  /** `${slot}|${symbol}` delle candele mancanti al momento della decisione (giorno). */
  missing: readonly string[];
  /** Candele mancanti degli ultimi 45 giorni: cambiano lo storico del bot rispetto ai dati definitivi. */
  recentMissing?: readonly string[];
  /** Simbolo di riferimento del regime (BTC): una sua candela mancante tocca tutti i simboli. */
  btcSymbol?: string;
}

/** Perché una decisione può differire: candela mancante nello slot o nello storico usato dal bot. */
function explain(slot: number, symbol: string, missing: ReadonlySet<string>, history: readonly string[], btc: string | undefined): string | null {
  if (missing.has(`${slot}|${symbol}`)) return 'candela non disponibile al momento della decisione (pubblicata dopo)';
  const earlier = history
    .map((k) => k.split('|'))
    .filter(([t, s]) => Number(t) <= slot && (s === symbol || s === btc))
    .map(([t, s]) => `${s} ${new Date(Number(t)).toISOString()}`);
  return earlier.length ? `storico del bot diverso dai dati definitivi: candela mancante (${earlier.slice(-3).join(', ')})` : null;
}

/** Confronto decisione per decisione (e trade per trade in shadow) tra il bot e il replay. */
export function compareDay(input: CompareInput): ParityResult {
  const inRange = (r: DecisionRecord) => r.slotTime >= input.fromSlot && r.slotTime <= input.toSlot;
  const actual = input.actualJournal.filter((r) => inRange(r) && r.action !== 'REJECTED');
  const replay = input.replayJournal.filter(inRange);
  const missing = new Set(input.missing);
  const group = (records: readonly DecisionRecord[]) => {
    const m = new Map<string, string[]>();
    for (const r of records) m.set(`${r.slotTime}|${r.symbol}`, [...(m.get(`${r.slotTime}|${r.symbol}`) ?? []), describe(r)]);
    return m;
  };
  const a = group(actual);
  const b = group(replay);
  const divergences: Divergence[] = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const left = (a.get(key) ?? []).sort();
    const right = (b.get(key) ?? []).sort();
    if (left.join('\n') === right.join('\n')) continue;
    const [slot, symbol] = key.split('|');
    divergences.push({
      kind: 'decision',
      slotTime: new Date(Number(slot)).toISOString(),
      symbol,
      actual: left.join(' | ') || null,
      replay: right.join(' | ') || null,
      explanation: explain(Number(slot), symbol, missing, [...(input.recentMissing ?? []), ...input.missing], input.btcSymbol),
    });
  }
  let comparedTrades = 0;
  if (input.actualTrades && input.replayTrades) {
    const ta = new Map(input.actualTrades.map((t) => [tradeKey(t), t] as const));
    const tb = new Map(input.replayTrades.map((t) => [tradeKey(t), t] as const));
    comparedTrades = new Set([...ta.keys(), ...tb.keys()]).size;
    for (const key of [...new Set([...ta.keys(), ...tb.keys()])].sort()) {
      const x = ta.get(key);
      const y = tb.get(key);
      if (x && y && tradeText(x) === tradeText(y) && x.exitTime === y.exitTime) continue;
      divergences.push({ kind: 'trade', slotTime: (x ?? y)!.exitTime, symbol: key.split('|')[0], actual: x ? tradeText(x) : null, replay: y ? tradeText(y) : null, explanation: null });
    }
  }
  // Un trade diverso è spiegato se lo è almeno una decisione dello stesso simbolo nel giorno.
  const explainedSymbols = new Set(divergences.filter((d) => d.kind === 'decision' && d.explanation).map((d) => d.symbol));
  for (const d of divergences) if (d.kind === 'trade' && explainedSymbols.has(d.symbol.split('/')[0])) d.explanation = 'conseguenza di una candela mancante (vedi le decisioni dello stesso simbolo)';
  const unexplained = divergences.filter((d) => d.explanation === null).length;
  return {
    status: divergences.length === 0 ? 'IDENTICAL' : unexplained === 0 ? 'EXPLAINED' : 'DIVERGENT',
    reason: null,
    mode: input.mode,
    fromSlot: new Date(input.fromSlot).toISOString(),
    toSlot: new Date(input.toSlot).toISOString(),
    compared: { decisions: actual.length, trades: comparedTrades },
    explained: divergences.length - unexplained,
    unexplained,
    divergences: divergences.slice(0, 50),
  };
}

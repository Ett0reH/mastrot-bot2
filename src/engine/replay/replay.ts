// Replay harness (F2 Fase C, invariante I3).
//
// Esegue il percorso LIVE (DecisionCycle) su dati storici con orologio simulato:
// - le candele diventano visibili solo dopo la chiusura più un ritardo di pubblicazione;
// - il ciclo viene chiamato a istanti irregolari (dopo ogni ora, a volte anche dopo i 15 minuti
//   intermedi, con ritardi casuali), e riprova se una candela non è ancora pubblicata;
// - a intervalli regolari il processo "riparte": lo stato passa per JSON e il ciclo ricostruisce
//   lo storico dalla fonte dati, come dopo un riavvio del server;
// - l'esecuzione è l'exchange simulato, lo stesso modello del backtest.
// Sugli stessi dati il risultato deve coincidere con il backtest al 100%: stessi intenti (ingressi,
// uscite, direzione, size, leva, livelli di stop), stesso journal, stessi trade, stessa equity.
import { type BacktestConfig, type BacktestResult, finalHourCloseSlot, fundingRateAt, type FundingModel, loadBacktestData } from '../backtest/runner';
import { HOUR_MS, slotEnd } from '../core/aggregator';
import type { DecisionRecord, Intent, TradeRecord } from '../core/types';
import { BAR_15M_MS, type Candle } from '../data/dataset';
import { type CycleEvent, DecisionCycle, type DecisionCycleConfig, LIVE_CYCLE_DEFAULTS } from '../live/decisionCycle';
import type { CandleSource, ExecutionPort, ExecutionReport, FundingCharge, FundingPosition } from '../live/ports';
import { type ExecutionModel, SimExchange } from '../sim/simExchange';
import { canonicalStringify } from '../util/canonical';
import { hash32, mulberry32 } from '../util/prng';

/** Fonte dati del replay: una candela è visibile solo dopo chiusura + ritardo di pubblicazione. */
export class ReplayCandleSource implements CandleSource {
  requests = 0;

  constructor(
    private readonly data: Readonly<Record<string, readonly Candle[]>>,
    private readonly now: () => number,
    private readonly publishDelay: (symbol: string, t: number) => number,
    /** Restituisce anche la candela in formazione (con i valori finali: usarla sarebbe look-ahead). */
    private readonly includeFormingCandle = false,
  ) {}

  published(symbol: string, t: number): boolean {
    return slotEnd(t) + this.publishDelay(symbol, t) <= this.now();
  }

  /** Indice della prima candela con t ≥ `t`. */
  private static lowerBound(list: readonly Candle[], t: number): number {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  async fetchCandles(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
    this.requests++;
    const list = this.data[symbol] ?? [];
    const out: Candle[] = [];
    for (let i = ReplayCandleSource.lowerBound(list, fromMs); i < list.length && list[i].t <= toMs; i++) {
      if (this.published(symbol, list[i].t)) out.push({ ...list[i] });
    }
    if (this.includeFormingCandle) {
      const formingStart = Math.floor(this.now() / BAR_15M_MS) * BAR_15M_MS;
      const i = ReplayCandleSource.lowerBound(list, formingStart);
      if (i < list.length && list[i].t === formingStart) out.push({ ...list[i] });
    }
    return out;
  }
}

/** Exchange simulato dietro l'ExecutionPort: stesso modello di esecuzione del backtest. */
export class SimExecutionPort implements ExecutionPort {
  readonly exchange: SimExchange;
  executed = 0;

  constructor(model: ExecutionModel, private readonly fundingModel: FundingModel) {
    this.exchange = new SimExchange(model);
  }

  async settle(slotTime: number, candles: Readonly<Record<string, Candle | undefined>>): Promise<ExecutionReport> {
    return { fills: this.exchange.onCandles(slotTime, candles), rejected: [] };
  }

  async funding(hourCloseSlot: number, positions: readonly FundingPosition[]): Promise<FundingCharge[]> {
    if (this.fundingModel.kind === 'none') return [];
    const hourStart = hourCloseSlot - 45 * 60_000;
    return positions.map((p) => {
      const rate = fundingRateAt(this.fundingModel, p.symbol, hourStart);
      // Stessa espressione del backtest (runner.ts).
      return { symbol: p.symbol, positionId: p.positionId, amount: p.size * p.markPrice * rate * (p.direction === 'LONG' ? 1 : -1) };
    });
  }

  async execute(intents: readonly Intent[]): Promise<ExecutionReport> {
    this.executed += intents.length;
    return { fills: this.exchange.execute(intents), rejected: [] };
  }
}

export interface ReplayOptions {
  seed: number;
  /** Ritardo di pubblicazione di una candela dopo la chiusura. */
  publishDelayMs: { min: number; max: number };
  /** Ritardo massimo del tick dopo la fine di un'ora (o di uno slot intermedio). */
  tickJitterMs: number;
  /** Probabilità di un tick anche dopo gli slot intermedi (:00, :15, :30). */
  intermediateTickProbability: number;
  /** Intervallo dei nuovi tentativi quando il ciclo aspetta una candela. */
  retryMs: number;
  /** Riavvio simulato del processo a questo intervallo (stato via JSON). */
  restartEveryMs?: number;
  includeFormingCandle?: boolean;
  candleWaitMs?: number;
  maxEntryDelayMs?: number;
}

export const DEFAULT_REPLAY_OPTIONS: ReplayOptions = {
  seed: 20260924,
  publishDelayMs: { min: 2_000, max: 90_000 },
  tickJitterMs: 120_000,
  intermediateTickProbability: 0.3,
  retryMs: 20_000,
  restartEveryMs: 9 * 24 * HOUR_MS + 5 * HOUR_MS + 17 * 60_000,
  includeFormingCandle: true,
};

export interface ReplayResult {
  trades: TradeRecord[];
  intents: Intent[];
  journal: DecisionRecord[];
  events: CycleEvent[];
  finalEquity: number;
  maxDrawdown: number;
  ticks: number;
  restarts: number;
  candleRequests: number;
}

export async function runReplay(config: BacktestConfig, options: ReplayOptions = DEFAULT_REPLAY_OPTIONS, data: Record<string, Candle[]> = loadBacktestData(config)): Promise<ReplayResult> {
  const startMs = Date.parse(config.start);
  const finalSlot = finalHourCloseSlot(Date.parse(config.end));
  const rand = mulberry32(options.seed);
  let now = startMs;
  const { min, max } = options.publishDelayMs;
  const delay = (symbol: string, t: number) => min + Math.floor(mulberry32(hash32(`${options.seed}|${symbol}|${t}`))() * (max - min));
  const source = new ReplayCandleSource(data, () => now, delay, options.includeFormingCandle === true);
  const port = new SimExecutionPort(config.execution, config.funding);
  const cycleConfig: DecisionCycleConfig = {
    core: {
      symbols: config.symbols,
      initialEquity: config.initialEquity,
      feeRate: config.execution.feeRate,
      backstop: config.backstop,
      expectancyMatrix: config.expectancyMatrix,
    },
    startMs,
    warmupMs: config.warmupDays * 24 * HOUR_MS,
    candleWaitMs: options.candleWaitMs ?? LIVE_CYCLE_DEFAULTS.candleWaitMs,
    maxEntryDelayMs: options.maxEntryDelayMs ?? LIVE_CYCLE_DEFAULTS.maxEntryDelayMs,
    finalSlot,
  };
  let cycle = new DecisionCycle(cycleConfig, { source, port });
  await cycle.start();

  const out: ReplayResult = { trades: [], intents: [], journal: [], events: [], finalEquity: 0, maxDrawdown: 0, ticks: 0, restarts: 0, candleRequests: 0 };
  let nextRestart = options.restartEveryMs === undefined ? Infinity : startMs + options.restartEveryMs;
  const maxTicks = Math.ceil((finalSlot - startMs) / BAR_15M_MS) * 20 + 10_000;

  /** Prossimo tick programmato: dopo ogni fine ora; dopo gli altri slot solo a volte. */
  const nextScheduled = (from: number): number => {
    let end = Math.floor(from / BAR_15M_MS) * BAR_15M_MS + BAR_15M_MS;
    for (;;) {
      const hourEnd = end % HOUR_MS === 0;
      if (hourEnd || rand() < options.intermediateTickProbability) return end + Math.floor(rand() * options.tickJitterMs);
      end += BAR_15M_MS;
    }
  };

  for (;;) {
    if (out.ticks++ > maxTicks) throw new Error('Replay: troppi tick, il ciclo non avanza');
    const r = await cycle.tick(now);
    out.trades.push(...r.trades);
    out.intents.push(...r.intents);
    out.journal.push(...r.journal);
    out.events.push(...r.events);
    if (cycle.state.lastSlot === finalSlot) break;
    if (!r.waiting && now >= nextRestart) {
      const persisted = JSON.parse(JSON.stringify(cycle.snapshot()));
      cycle = new DecisionCycle(cycleConfig, { source, port }, persisted);
      await cycle.start();
      out.restarts++;
      nextRestart += options.restartEveryMs ?? Infinity;
    }
    now = r.waiting ? now + options.retryMs : Math.max(now + 1, nextScheduled(now));
  }
  out.finalEquity = cycle.state.realizedEquity;
  out.maxDrawdown = cycle.state.maxDrawdown;
  out.candleRequests = source.requests;
  return out;
}

export interface ParityReport {
  identical: boolean;
  differences: string[];
  counts: { intents: number; journal: number; trades: number };
}

function firstDiff(label: string, a: readonly unknown[], b: readonly unknown[]): string | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = canonicalStringify(a[i]);
    const y = canonicalStringify(b[i]);
    if (x !== y) return `${label} #${i} (backtest ${a.length}, replay ${b.length})\n  backtest: ${x}\n  replay:   ${y}`;
  }
  return null;
}

/** Confronto campo per campo tra backtest (con journal) e replay del percorso live. */
export function compareParity(backtest: BacktestResult, replay: ReplayResult): ParityReport {
  const differences: string[] = [];
  for (const [label, a, b] of [
    ['intento', backtest.intents, replay.intents],
    ['decisione', backtest.journal, replay.journal],
    ['trade', backtest.trades, replay.trades],
  ] as const) {
    const d = firstDiff(label, a, b);
    if (d) differences.push(d);
  }
  if (backtest.finalEquity !== replay.finalEquity) differences.push(`equity finale: backtest ${backtest.finalEquity}, replay ${replay.finalEquity}`);
  if (backtest.maxDrawdown !== replay.maxDrawdown) differences.push(`max drawdown: backtest ${backtest.maxDrawdown}, replay ${replay.maxDrawdown}`);
  const unexpected = replay.events.filter((e) => e.type === 'STALE_ENTRY_REJECTED' || e.type === 'INTENT_REJECTED' || e.type === 'INTENT_PENDING');
  if (unexpected.length) differences.push(`eventi di esecuzione inattesi nel replay: ${unexpected.length} (primo: ${JSON.stringify(unexpected[0])})`);
  return {
    identical: differences.length === 0,
    differences,
    counts: { intents: replay.intents.length, journal: replay.journal.length, trades: replay.trades.length },
  };
}

// Ciclo decisionale del live (F2 Fase C).
//
// Il live non ha più logica di strategia propria: il ciclo porta le candele 15m chiuse al
// DecisionCore (lo stesso del backtest) ed esegue gli intenti tramite l'ExecutionPort. A ogni
// `tick(now)` elabora, in ordine, tutti gli slot 15m chiusi e non ancora elaborati:
//   1. scarica le candele e scarta quelle ancora in formazione o fuori intervallo;
//   2. se manca la candela di un simbolo aspetta (fino a `candleWaitMs` dalla fine dello slot),
//      poi procede senza e lo segnala: una candela arrivata dopo non viene più usata;
//   3. per ogni slot, nello stesso ordine del backtest: stop nativi eseguiti → funding
//      dell'ora → core → esecuzione degli intenti della chiusura oraria.
// Un ingresso deciso troppo tardi rispetto alla chiusura dell'ora (per esempio dopo un fermo del
// processo) non viene eseguito; uscite e aggiornamenti degli stop si eseguono sempre, perché
// riducono il rischio. Il tempo arriva sempre da fuori (`now`): il ciclo non legge l'orologio.
import { BAR_15M_MS, type Candle } from '../data/dataset';
import { isHourCloseSlot, slotEnd } from '../core/aggregator';
import { type CoreConfig, type CoreState, DecisionCore, validateCoreState } from '../core/decisionCore';
import type { DecisionRecord, EquitySnapshot, Fill, Intent, TradeRecord } from '../core/types';
import type { CandleSource, ExecutionPort, ExecutionReport, FundingPosition } from './ports';

export interface DecisionCycleConfig {
  core: CoreConfig;
  /** Primo slot (UTC, ms) in cui si prendono decisioni; quelli precedenti servono al warm-up. */
  startMs: number;
  /** Storico usato per ricostruire le candele 1H/4H all'avvio (almeno 250 candele 4H). */
  warmupMs: number;
  /** Attesa massima, dalla fine di uno slot, delle candele mancanti prima di procedere senza. */
  candleWaitMs: number;
  /** Un ingresso deciso più di così dopo la chiusura della sua ora non viene eseguito. */
  maxEntryDelayMs: number;
  /** Solo replay: ultimo slot, in cui le posizioni si chiudono con END_OF_DATA come nel backtest. */
  finalSlot?: number;
}

/** Default del live: 50 giorni di storico come il backtest, attese in minuti. */
export const LIVE_CYCLE_DEFAULTS = {
  warmupMs: 50 * 24 * 3_600_000,
  candleWaitMs: 3 * 60_000,
  maxEntryDelayMs: 10 * 60_000,
} as const;

export type CycleEvent =
  | { type: 'WAITING_CANDLES'; slot: number; symbols: string[] }
  | { type: 'CANDLE_MISSING'; slot: number; symbols: string[] }
  | { type: 'CANDLE_DISCARDED'; symbol: string; t: number; reason: 'NOT_CLOSED' | 'OUT_OF_RANGE' | 'MISALIGNED' | 'DUPLICATE' }
  | { type: 'STALE_ENTRY_REJECTED'; slot: number; positionId: string; delayMs: number }
  | { type: 'INTENT_REJECTED'; slot: number; positionId: string; reason: string }
  | { type: 'INTENT_PENDING'; slot: number; positionId: string }
  | { type: 'CHECKPOINT_FAILED'; slot: number; reason: string }
  | { type: 'ENTRY_BLOCKED'; slot: number; positionId: string; reason: string };

export interface TickResult {
  processedSlots: number;
  /** true se il ciclo si è fermato in attesa di candele non ancora pubblicate. */
  waiting: boolean;
  lastSlot: number | null;
  intents: Intent[];
  journal: DecisionRecord[];
  trades: TradeRecord[];
  events: CycleEvent[];
  /** Equity alle chiusure orarie elaborate in questo tick. */
  equity: EquitySnapshot[];
}

export interface DecisionCycleDeps {
  source: CandleSource;
  port: ExecutionPort;
  /**
   * Salvataggio dello stato PRIMA di inviare ingressi e uscite (write-ahead): dopo un crash il
   * recovery trova gli intenti già decisi. Se fallisce, gli ingressi non partono (le uscite sì).
   */
  checkpoint?: () => Promise<void>;
}

/** Ultimo slot 15m la cui candela è chiusa al tempo `now`. */
export function lastClosedSlot(now: number): number {
  return Math.floor(now / BAR_15M_MS) * BAR_15M_MS - BAR_15M_MS;
}

export class DecisionCycle {
  private readonly core: DecisionCore;
  private started = false;

  constructor(readonly config: DecisionCycleConfig, private readonly deps: DecisionCycleDeps, state?: CoreState) {
    if (config.startMs % BAR_15M_MS !== 0) throw new Error('startMs deve essere allineato a uno slot 15m');
    if (config.candleWaitMs >= config.maxEntryDelayMs) {
      throw new Error('candleWaitMs deve essere minore di maxEntryDelayMs, altrimenti un ritardo dei dati blocca gli ingressi');
    }
    this.core = new DecisionCore(config.core, state === undefined ? undefined : validateCoreState(state, config.core));
  }

  get state(): CoreState {
    return this.core.state;
  }

  /** Copia dello stato da persistere (JSON). */
  snapshot(): CoreState {
    return structuredClone(this.core.state);
  }

  /**
   * Avvio. Con uno stato ripristinato ricostruisce le candele 1H/4H dallo storico degli ultimi
   * `warmupMs` (lo stato del core non cambia); senza stato il warm-up avviene nei primi tick.
   */
  async start(): Promise<void> {
    if (this.started) throw new Error('DecisionCycle già avviato');
    const lastSlot = this.core.state.lastSlot;
    if (lastSlot !== null) {
      const from = lastSlot + BAR_15M_MS - this.config.warmupMs;
      const bySymbol = await this.fetchAll(from, lastSlot, lastSlot + BAR_15M_MS, []);
      for (let slot = from; slot <= lastSlot; slot += BAR_15M_MS) this.core.warmupSlot(slot, this.candlesAt(bySymbol, slot));
    }
    this.started = true;
  }

  private nextSlot(): number {
    const last = this.core.state.lastSlot;
    return last === null ? this.config.startMs - this.config.warmupMs : last + BAR_15M_MS;
  }

  private candlesAt(bySymbol: Record<string, Map<number, Candle>>, slot: number): Record<string, Candle | undefined> {
    const out: Record<string, Candle | undefined> = {};
    for (const s of this.config.core.symbols) out[s] = bySymbol[s].get(slot);
    return out;
  }

  /** Scarica le candele di tutti i simboli e tiene solo quelle chiuse, allineate e nell'intervallo. */
  private async fetchAll(from: number, to: number, now: number, events: CycleEvent[]): Promise<Record<string, Map<number, Candle>>> {
    const out: Record<string, Map<number, Candle>> = {};
    for (const symbol of this.config.core.symbols) {
      const map = new Map<number, Candle>();
      for (const c of await this.deps.source.fetchCandles(symbol, from, to)) {
        let reason: 'NOT_CLOSED' | 'OUT_OF_RANGE' | 'MISALIGNED' | 'DUPLICATE' | null = null;
        if (c.t % BAR_15M_MS !== 0) reason = 'MISALIGNED';
        else if (slotEnd(c.t) > now) reason = 'NOT_CLOSED';
        else if (c.t < from || c.t > to) reason = 'OUT_OF_RANGE';
        else if (map.has(c.t)) reason = 'DUPLICATE';
        if (reason) {
          events.push({ type: 'CANDLE_DISCARDED', symbol, t: c.t, reason });
          continue;
        }
        map.set(c.t, c);
      }
      out[symbol] = map;
    }
    return out;
  }

  private fundingPositions(candles: Readonly<Record<string, Candle | undefined>>): FundingPosition[] {
    // Stesso prezzo del backtest: chiusura dello slot, altrimenti ultima chiusura nota, altrimenti ingresso.
    return this.core.openPositions().map((pos) => ({
      positionId: pos.id,
      symbol: pos.symbol,
      direction: pos.trade.direction as FundingPosition['direction'],
      size: pos.trade.size,
      markPrice: candles[pos.symbol]?.c ?? this.core.state.lastClose[pos.symbol] ?? pos.trade.entryPrice,
    }));
  }

  private applyFills(fills: readonly Fill[], trades: TradeRecord[]): void {
    for (const fill of fills) {
      const record = this.core.applyFill(fill);
      if (record) trades.push(record);
    }
  }

  private applyReport(slot: number, report: ExecutionReport, result: TickResult): void {
    this.applyFills(report.fills, result.trades);
    for (const rejection of report.rejected) {
      this.core.rejectIntent(rejection.positionId);
      result.events.push({ type: 'INTENT_REJECTED', slot, positionId: rejection.positionId, reason: rejection.reason });
    }
  }

  async tick(now: number): Promise<TickResult> {
    if (!this.started) throw new Error('DecisionCycle non avviato: chiamare start()');
    const result: TickResult = { processedSlots: 0, waiting: false, lastSlot: this.core.state.lastSlot, intents: [], journal: [], trades: [], events: [], equity: [] };
    let latest = lastClosedSlot(now);
    if (this.config.finalSlot !== undefined) latest = Math.min(latest, this.config.finalSlot);
    const first = this.nextSlot();
    if (first > latest) return result;
    const bySymbol = await this.fetchAll(first, latest, now, result.events);

    for (let slot = first; slot <= latest; slot += BAR_15M_MS) {
      const candles = this.candlesAt(bySymbol, slot);
      const missing = this.config.core.symbols.filter((s) => !candles[s]);
      if (missing.length > 0) {
        if (now < slotEnd(slot) + this.config.candleWaitMs) {
          result.events.push({ type: 'WAITING_CANDLES', slot, symbols: missing });
          result.waiting = true;
          break;
        }
        result.events.push({ type: 'CANDLE_MISSING', slot, symbols: missing });
      }
      result.processedSlots++;
      if (slot < this.config.startMs) {
        this.core.processSlot(slot, candles, { warmupOnly: true });
        continue;
      }
      this.applyReport(slot, await this.deps.port.settle(slot, candles), result);
      if (isHourCloseSlot(slot)) {
        for (const charge of await this.deps.port.funding(slot, this.fundingPositions(candles))) this.core.applyFunding(charge.symbol, charge.amount);
      }
      const slotResult = this.core.processSlot(slot, candles, { isFinalSlot: slot === this.config.finalSlot });
      result.journal.push(...slotResult.journal);
      if (slotResult.hourClose && slotResult.equity) result.equity.push(slotResult.equity);
      if (slotResult.intents.length === 0) continue;
      result.intents.push(...structuredClone(slotResult.intents));

      const delayMs = now - slotEnd(slot);
      const toExecute: Intent[] = [];
      for (const intent of slotResult.intents) {
        if (intent.kind === 'OPEN' && delayMs > this.config.maxEntryDelayMs) {
          this.core.rejectIntent(intent.positionId);
          result.events.push({ type: 'STALE_ENTRY_REJECTED', slot, positionId: intent.positionId, delayMs });
          continue;
        }
        toExecute.push(intent);
      }
      if (this.deps.checkpoint && toExecute.some((i) => i.kind !== 'UPDATE_STOP')) {
        try {
          await this.deps.checkpoint();
        } catch (err) {
          const reason = `salvataggio dello stato fallito: ${(err as Error).message}`;
          result.events.push({ type: 'CHECKPOINT_FAILED', slot, reason });
          for (const intent of toExecute.filter((i) => i.kind === 'OPEN')) {
            this.core.rejectIntent(intent.positionId);
            result.events.push({ type: 'ENTRY_BLOCKED', slot, positionId: intent.positionId, reason });
          }
          toExecute.splice(0, toExecute.length, ...toExecute.filter((i) => i.kind !== 'OPEN'));
        }
      }
      this.applyReport(slot, await this.deps.port.execute(toExecute), result);
      for (const id of [...Object.keys(this.core.state.pendingOpens), ...Object.keys(this.core.state.pendingCloses)]) {
        result.events.push({ type: 'INTENT_PENDING', slot, positionId: id });
      }
    }
    result.lastSlot = this.core.state.lastSlot;
    return result;
  }

  openPositions() {
    return this.core.openPositions();
  }

  /** Annulla un intento rimasto in sospeso (recovery: ordine mai inviato). */
  rejectPending(positionId: string): void {
    this.core.rejectIntent(positionId);
  }
}

// Backtest event-driven sul DecisionCore (F2).
//
// Il tempo avanza su una griglia regolare di slot da 15 minuti in UTC, uguale per tutti i
// simboli (D08: il legacy avanzava per indice di array e si disallineava dopo un buco nei dati).
// A ogni slot: stop nativi simulati sulla candela → candele al core → a ogni chiusura oraria
// intenti eseguiti dall'exchange simulato. Con `LEGACY_EXECUTION` e backstop 'none' il
// risultato coincide con il backtest legacy di riferimento (golden).
import type { SetupExpectancyMatrix } from '../../server/core/architecture';
import { BAR_15M_MS, type Candle, defaultDatasetRoot, loadCandles } from '../data/dataset';
import { HOUR_MS, isHourCloseSlot } from '../core/aggregator';
import { type BackstopModel, DecisionCore } from '../core/decisionCore';
import type { DecisionRecord, Intent, TradeRecord } from '../core/types';
import { type ExecutionModel, SimExchange } from '../sim/simExchange';

export type FundingModel =
  | { kind: 'none' }
  | { kind: 'constant'; hourlyRate: number }
  | { kind: 'historical'; rates: Record<string, Map<number, number>> };

export interface BacktestConfig {
  symbols: string[];
  start: string;
  end: string;
  warmupDays: number;
  initialEquity: number;
  execution: ExecutionModel;
  backstop: { model: BackstopModel; bufferPct: number };
  funding: FundingModel;
  expectancyMatrix?: SetupExpectancyMatrix;
  datasetRoot?: string;
  /** Se true journal e intenti completi vengono restituiti (confronto con il replay, test). */
  collectJournal?: boolean;
  /**
   * Solo per i test di ripresa: a questo slot lo stato del core viene serializzato in JSON e il
   * core ricostruito da zero (stato ripristinato + storico degli aggregatori), come farà il live
   * dopo un riavvio. Il risultato deve restare identico.
   */
  resumeFromSnapshotAt?: number;
  /**
   * Storico usato per ricostruire gli aggregatori alla ripresa (default: tutto dall'inizio della
   * griglia). Il live dopo un riavvio scarica solo gli ultimi giorni: il risultato non deve cambiare.
   */
  resumeWarmupDays?: number;
}

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface BacktestResult {
  trades: TradeRecord[];
  finalEquity: number;
  maxDrawdown: number;
  equityCurve: EquityPoint[];
  journal: DecisionRecord[];
  intents: Intent[];
  fundingPaid: number;
}

/** Ultimo slot di chiusura oraria (minuto 45) non successivo a `endMs`. */
export function finalHourCloseSlot(endMs: number): number {
  let slot = Math.floor(endMs / BAR_15M_MS) * BAR_15M_MS;
  while (!isHourCloseSlot(slot)) slot -= BAR_15M_MS;
  return slot;
}

export function fundingRateAt(model: FundingModel, symbol: string, hourStart: number): number {
  if (model.kind === 'none') return 0;
  if (model.kind === 'constant') return model.hourlyRate;
  return model.rates[symbol]?.get(hourStart) ?? 0;
}

/** Carica le candele del periodo (warm-up incluso) dal dataset verificato. */
export function loadBacktestData(config: BacktestConfig): Record<string, Candle[]> {
  const root = config.datasetRoot ?? defaultDatasetRoot();
  const startMs = Date.parse(config.start);
  const endMs = Date.parse(config.end);
  const warmupMs = config.warmupDays * 24 * HOUR_MS;
  const out: Record<string, Candle[]> = {};
  for (const s of config.symbols) out[s] = loadCandles(root, s, startMs - warmupMs, endMs);
  return out;
}

export function runBacktest(config: BacktestConfig, data: Record<string, Candle[]> = loadBacktestData(config)): BacktestResult {
  const startMs = Date.parse(config.start);
  const endMs = Date.parse(config.end);
  const finalSlot = finalHourCloseSlot(endMs);
  const bySymbol: Record<string, Map<number, Candle>> = {};
  let gridStart = Infinity;
  for (const s of config.symbols) {
    const candles = data[s] ?? [];
    bySymbol[s] = new Map(candles.map((c) => [c.t, c]));
    if (candles.length) gridStart = Math.min(gridStart, candles[0].t);
  }
  if (!Number.isFinite(gridStart)) throw new Error('Nessuna candela per il backtest');

  const coreConfig = {
    symbols: config.symbols,
    initialEquity: config.initialEquity,
    feeRate: config.execution.feeRate,
    backstop: config.backstop,
    expectancyMatrix: config.expectancyMatrix,
  };
  let core = new DecisionCore(coreConfig);
  const exchange = new SimExchange(config.execution);
  const trades: TradeRecord[] = [];
  const equityCurve: EquityPoint[] = [];
  const journal: DecisionRecord[] = [];
  const intents: Intent[] = [];
  let fundingPaid = 0;

  for (let slot = gridStart; slot <= finalSlot; slot += BAR_15M_MS) {
    const candles: Record<string, Candle | undefined> = {};
    for (const s of config.symbols) candles[s] = bySymbol[s].get(slot);
    if (slot < startMs) {
      core.processSlot(slot, candles, { warmupOnly: true });
      continue;
    }
    if (slot === config.resumeFromSnapshotAt) {
      const snapshot = JSON.stringify(core.state);
      core = new DecisionCore(coreConfig, JSON.parse(snapshot));
      const warmupFrom = config.resumeWarmupDays === undefined ? gridStart : Math.max(gridStart, slot - config.resumeWarmupDays * 24 * HOUR_MS);
      for (let past = warmupFrom; past < slot; past += BAR_15M_MS) {
        const pastCandles: Record<string, Candle | undefined> = {};
        for (const s of config.symbols) pastCandles[s] = bySymbol[s].get(past);
        core.warmupSlot(past, pastCandles);
      }
    }
    // 1. Stop nativi scattati durante la candela
    for (const fill of exchange.onCandles(slot, candles)) {
      const record = core.applyFill(fill);
      if (record) trades.push(record);
    }
    // 2. Funding dell'ora che si chiude (costo positivo per chi paga)
    if (isHourCloseSlot(slot) && config.funding.kind !== 'none') {
      const hourStart = slot - 45 * 60_000;
      for (const pos of core.openPositions()) {
        const price = candles[pos.symbol]?.c ?? core.state.lastClose[pos.symbol] ?? pos.trade.entryPrice;
        const rate = fundingRateAt(config.funding, pos.symbol, hourStart);
        const amount = pos.trade.size * price * rate * (pos.trade.direction === 'LONG' ? 1 : -1);
        core.applyFunding(pos.symbol, amount);
        fundingPaid += amount;
      }
    }
    // 3. Decisioni ed esecuzione
    const result = core.processSlot(slot, candles, { isFinalSlot: slot === finalSlot });
    if (config.collectJournal) {
      journal.push(...result.journal);
      intents.push(...structuredClone(result.intents));
    }
    for (const fill of exchange.execute(result.intents)) {
      const record = core.applyFill(fill);
      if (record) trades.push(record);
    }
    if (result.hourClose && result.equity) equityCurve.push({ t: slot + 15 * 60_000, equity: result.equity.trueEquity });
  }

  return {
    trades,
    finalEquity: core.state.realizedEquity,
    maxDrawdown: core.state.maxDrawdown,
    equityCurve,
    journal,
    intents,
    fundingPaid,
  };
}

/** Il trade nel formato esatto del backtest legacy (senza i costi dettagliati). */
export function legacyView(trade: TradeRecord): Record<string, unknown> {
  const { costs: _costs, ...rest } = trade;
  return rest;
}

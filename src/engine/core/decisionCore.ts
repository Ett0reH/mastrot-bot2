// DecisionCore: tutta la logica decisionale del bot, identica per backtest, replay e live (F2).
//
// Il core non fa I/O e non legge l'orologio: riceve le candele 15m slot per slot e restituisce
// intenti (OPEN / CLOSE / UPDATE_STOP). Chi lo usa (backtest, replay, live) li esegue e gli
// restituisce i fill con `applyFill`. La strategia è quella di src/server/core/architecture.ts,
// invocata nello stesso ordine del backtest legacy di riferimento (run_kraken.ts):
//   1. mark-to-market dell'equity su ogni candela 15m (anche il massimo storico);
//   2. a ogni chiusura oraria: uscite di tutti i simboli, poi ingressi di tutti i simboli;
//   3. il sizing usa l'equity calcolata all'inizio dello slot, prima delle uscite.
// Lo stato che nel legacy viveva in variabili globali (profit factor dei NORMAL per i tier,
// cooldown, equity) qui è esplicito e serializzabile, così il live lo può persistere.
import {
  type ActiveTrade,
  CapitalManagementLayer,
  ExpectancyTracker,
  FEATURE_FLAGS,
  GatekeeperLayer,
  MarketDataLayer,
  PositionExitLayer,
  RegimeLayer,
  RiskLayer,
  type SetupExpectancyMatrix,
  SignalLayer,
  type TradingRegime,
  resolveRiskTier,
} from '../../server/core/architecture';
import { type Candle, legacySymbol } from '../data/dataset';
import { CandleAggregator, isHourCloseSlot, slotEnd } from './aggregator';
import type {
  CloseIntent,
  CorePosition,
  DecisionRecord,
  Direction,
  EngineName,
  EquitySnapshot,
  Fill,
  Intent,
  OpenIntent,
  TradeRecord,
  UpdateStopIntent,
} from './types';

export const FEATURE_WINDOW = 250;

export type BackstopModel = 'none' | 'close_based_plus_native_backstop' | 'native_intrabar';

export interface CoreConfig {
  /** Simboli base in ordine di valutazione (l'ordine conta: è quello del backtest legacy). */
  symbols: string[];
  initialEquity: number;
  /** Fee stimata per il PnL flottante (le fee reali arrivano con i fill). */
  feeRate: number;
  backstop: { model: BackstopModel; bufferPct: number };
  /** Matrice expectancy: vuota come nel backtest di riferimento (sezione 2 del prompt). */
  expectancyMatrix?: SetupExpectancyMatrix;
  btcSymbol?: string;
}

/**
 * Chiusura decisa ma non ancora eseguita. Come nel backtest legacy, gli effetti della chiusura
 * che influenzano gli ingressi della stessa ora (statistiche dei NORMAL per i tier e cooldown)
 * vengono applicati subito, con il PnL stimato al prezzo di riferimento; il fill reale li
 * riconcilia (senza alcun calcolo se coincide con la stima, per restare bit-per-bit identici).
 */
export interface PendingClose {
  intent: CloseIntent;
  provisionalPnL: number;
  countedInNormalClean: boolean;
  /** Valore del cooldown del simbolo prima della decisione (assente se non c'era). */
  previousLastExit4H?: number | null;
}

export interface CoreState {
  realizedEquity: number;
  maxHistoricalEquity: number;
  maxDrawdown: number;
  positions: Record<string, CorePosition | null>;
  /**
   * Cooldown NORMAL: per ogni simbolo uscito, l'inizio (UTC) del blocco dell'ultima candela 4H
   * chiusa al momento dell'uscita (null se nessuna). Un nuovo ingresso NORMAL richiede una
   * candela 4H chiusa successiva. È un tempo, non un conteggio: resta valido dopo un riavvio
   * anche se gli aggregatori vengono ricostruiti con uno storico più corto.
   */
  lastExit4HStart: Record<string, number | null>;
  normalClean: { grossProfit: number; grossLoss: number };
  lastGapMinutes: Record<string, number>;
  lastClose: Record<string, number>;
  lastSlot: number | null;
  capital: { trueEquity: number; isHalted: boolean; capacityMultiplier: number } | null;
  /** Intenti emessi e non ancora eseguiti né rifiutati: fanno parte dello stato persistito. */
  pendingOpens: Record<string, OpenIntent>;
  pendingCloses: Record<string, PendingClose>;
}

export interface SymbolSnapshot {
  features: ReturnType<typeof MarketDataLayer.prepareFeatures>;
  regime: TradingRegime;
}

export interface SlotResult {
  equity: EquitySnapshot | null;
  hourClose: boolean;
  intents: Intent[];
  journal: DecisionRecord[];
  snapshots: Record<string, SymbolSnapshot | null>;
}

export interface SlotOptions {
  /** Ultimo slot del backtest: chiude le posizioni valutate con END_OF_DATA. */
  isFinalSlot?: boolean;
  /** Prima dell'inizio del periodo di trading le candele servono solo al warm-up. */
  warmupOnly?: boolean;
}

function cloneTrade(trade: ActiveTrade): ActiveTrade {
  return structuredClone(trade);
}

export function initialCoreState(config: CoreConfig): CoreState {
  const positions: Record<string, CorePosition | null> = {};
  for (const s of config.symbols) positions[s] = null;
  return {
    realizedEquity: config.initialEquity,
    maxHistoricalEquity: config.initialEquity,
    maxDrawdown: 0,
    positions,
    lastExit4HStart: {},
    normalClean: { grossProfit: 0, grossLoss: 0 },
    lastGapMinutes: {},
    lastClose: {},
    lastSlot: null,
    capital: null,
    pendingOpens: {},
    pendingCloses: {},
  };
}

const STATE_KEYS: (keyof CoreState)[] = [
  'realizedEquity', 'maxHistoricalEquity', 'maxDrawdown', 'positions', 'lastExit4HStart', 'normalClean',
  'lastGapMinutes', 'lastClose', 'lastSlot', 'capital', 'pendingOpens', 'pendingCloses',
];

/** Verifica la forma di uno stato persistito prima di usarlo: uno stato incompleto non si "ripara". */
export function validateCoreState(state: unknown, config: CoreConfig): CoreState {
  if (typeof state !== 'object' || state === null) throw new Error('Stato del core non valido: non è un oggetto');
  const missing = STATE_KEYS.filter((k) => !(k in state));
  if (missing.length) throw new Error(`Stato del core non valido: mancano ${missing.join(', ')}`);
  const s = state as CoreState;
  for (const k of ['realizedEquity', 'maxHistoricalEquity', 'maxDrawdown'] as const) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) throw new Error(`Stato del core non valido: ${k} non numerico`);
  }
  for (const [symbol, pos] of Object.entries(s.positions)) {
    if (!config.symbols.includes(symbol)) throw new Error(`Stato del core non valido: posizione su ${symbol}, simbolo non configurato`);
    if (pos !== null && (pos.symbol !== symbol || typeof pos.trade?.leverage !== 'number')) throw new Error(`Stato del core non valido: posizione ${symbol} incompleta`);
  }
  return s;
}

export class DecisionCore {
  readonly aggregators: Record<string, CandleAggregator> = {};
  private readonly btcSymbol: string;

  constructor(readonly config: CoreConfig, public state: CoreState = initialCoreState(config)) {
    validateCoreState(state, config);
    for (const s of config.symbols) {
      this.aggregators[s] = new CandleAggregator();
      if (!(s in state.positions)) state.positions[s] = null;
    }
    this.btcSymbol = config.btcSymbol ?? 'BTC';
  }

  // --- Candele ---------------------------------------------------------------------------

  /** Registra una candela 15m chiusa: aggregazione, buchi nei dati, contaminazione delle posizioni. */
  ingestCandle(symbol: string, candle: Candle): void {
    const agg = this.aggregators[symbol];
    if (!agg) throw new Error(`Simbolo non gestito dal core: ${symbol}`);
    const prev = agg.lastCandleTime;
    agg.addCandle(candle);
    const gap = prev === null ? 0 : (candle.t - prev) / 60_000;
    this.state.lastGapMinutes[symbol] = gap;
    this.state.lastClose[symbol] = candle.c;
    const pos = this.state.positions[symbol];
    if (pos && FEATURE_FLAGS.DATA_GAP_VALIDATION) {
      if (gap > 60) pos.trade.isContaminated = true;
      if (gap > 240) pos.trade.shouldInvalidateByGap = true;
    }
  }

  /**
   * Ricostruisce lo storico degli aggregatori (es. dopo un riavvio del live, con lo stato già
   * ripristinato): registra le candele e chiude i bucket terminati senza toccare lo stato
   * (equity, posizioni, statistiche). Gli slot devono essere in ordine crescente.
   */
  warmupSlot(slotTime: number, candles: Readonly<Record<string, Candle | undefined>>): void {
    for (const symbol of this.config.symbols) {
      const candle = candles[symbol];
      if (candle) this.aggregators[symbol].addCandle(candle);
      this.aggregators[symbol].closeUntil(slotEnd(slotTime));
    }
  }

  /**
   * Elabora uno slot 15m: registra le candele, chiude le candele 1H/4H terminate, aggiorna
   * l'equity e, se lo slot chiude un'ora, restituisce gli intenti di uscita e di ingresso.
   */
  processSlot(slotTime: number, candles: Readonly<Record<string, Candle | undefined>>, options: SlotOptions = {}): SlotResult {
    if (this.state.lastSlot !== null && slotTime <= this.state.lastSlot) {
      throw new Error(`Slot già elaborato: ${new Date(slotTime).toISOString()}`);
    }
    for (const symbol of this.config.symbols) {
      const candle = candles[symbol];
      if (candle) {
        if (candle.t !== slotTime) throw new Error(`Candela ${symbol} con tempo ${candle.t} ≠ slot ${slotTime}`);
        this.ingestCandle(symbol, candle);
      }
    }
    const closed4H: Record<string, boolean> = {};
    for (const symbol of this.config.symbols) closed4H[symbol] = this.aggregators[symbol].closeUntil(slotEnd(slotTime)).closed4H;
    this.state.lastSlot = slotTime;

    const empty: SlotResult = { equity: null, hourClose: false, intents: [], journal: [], snapshots: {} };
    if (options.warmupOnly) return empty;

    const equity = this.markToMarket(slotTime, candles);
    if (!isHourCloseSlot(slotTime)) return { ...empty, equity };
    const snapshots = this.computeSnapshots(slotTime, closed4H);
    const { intents, journal } = this.evaluateHourClose(slotTime, snapshots, options.isFinalSlot === true);
    return { equity, hourClose: true, intents, journal, snapshots };
  }

  // --- Equity ----------------------------------------------------------------------------

  private floatingPnL(symbol: string, pos: CorePosition, price: number): number {
    const fee = this.config.feeRate;
    const posValue = pos.trade.size * price;
    const entryValue = pos.trade.size * pos.trade.entryPrice;
    // Stessa formula (e stesso ordine delle operazioni) del backtest legacy.
    const pnl = pos.trade.direction === 'LONG'
      ? posValue - posValue * fee - (entryValue + entryValue * fee)
      : entryValue - entryValue * fee - (posValue + posValue * fee);
    return pnl - pos.fundingPaid;
  }

  private markToMarket(slotTime: number, candles: Readonly<Record<string, Candle | undefined>>): EquitySnapshot {
    let floating = 0;
    for (const symbol of this.config.symbols) {
      const pos = this.state.positions[symbol];
      if (!pos) continue;
      const price = candles[symbol]?.c ?? this.state.lastClose[symbol] ?? pos.trade.entryPrice;
      floating += this.floatingPnL(symbol, pos, price);
    }
    const trueEquity = this.state.realizedEquity + floating;
    if (trueEquity > this.state.maxHistoricalEquity) this.state.maxHistoricalEquity = trueEquity;
    const drawdown = (this.state.maxHistoricalEquity - trueEquity) / this.state.maxHistoricalEquity;
    if (drawdown > this.state.maxDrawdown) this.state.maxDrawdown = drawdown;
    const health = CapitalManagementLayer.evaluateAccountHealth(trueEquity, this.state.maxHistoricalEquity);
    this.state.capital = { trueEquity, isHalted: health.isHalted, capacityMultiplier: health.allowedCapacityMultiplier };
    return {
      slotTime,
      realizedEquity: this.state.realizedEquity,
      floatingPnL: floating,
      trueEquity,
      maxHistoricalEquity: this.state.maxHistoricalEquity,
      drawdown,
      isHalted: health.isHalted,
      capacityMultiplier: health.allowedCapacityMultiplier,
    };
  }

  // --- Decisioni -------------------------------------------------------------------------

  /** Feature e regime dei simboli che hanno la candela di chiusura dell'ora e abbastanza storia. */
  private computeSnapshots(slotTime: number, closed4H: Record<string, boolean>): Record<string, SymbolSnapshot | null> {
    const out: Record<string, SymbolSnapshot | null> = {};
    for (const symbol of this.config.symbols) {
      const agg = this.aggregators[symbol];
      const ready = agg.bars1H.length >= FEATURE_WINDOW && agg.bars4H.length >= FEATURE_WINDOW && agg.lastCandleTime === slotTime;
      if (!ready) {
        out[symbol] = null;
        continue;
      }
      const features = MarketDataLayer.prepareFeatures(agg.bars1H.slice(-FEATURE_WINDOW), agg.bars4H.slice(-FEATURE_WINDOW), closed4H[symbol]);
      out[symbol] = { features, regime: RegimeLayer.detect(features) };
    }
    return out;
  }

  /** Minuti dall'ultima candela precedente; definito per ogni simbolo che ha ricevuto candele. */
  private gapOf(symbol: string): number {
    const gap = this.state.lastGapMinutes[symbol];
    if (gap === undefined) throw new Error(`Gap sconosciuto per ${symbol}: nessuna candela registrata`);
    return gap;
  }

  /** true se un ingresso NORMAL sul simbolo è ancora in cooldown (nessuna 4H chiusa dopo l'uscita). */
  normalCooldownActive(symbol: string): boolean {
    const current = this.aggregators[symbol].lastClosed4HStart;
    const atExit = symbol in this.state.lastExit4HStart ? this.state.lastExit4HStart[symbol] : null;
    return current === null || (atExit !== null && current <= atExit);
  }

  backstopLevel(direction: Direction, strategyStop: number): number | null {
    const { model, bufferPct } = this.config.backstop;
    if (model === 'none') return null;
    const buffer = model === 'native_intrabar' ? 0 : bufferPct / 100;
    return direction === 'LONG' ? strategyStop * (1 - buffer) : strategyStop * (1 + buffer);
  }

  private evaluateHourClose(slotTime: number, snapshots: Record<string, SymbolSnapshot | null>, isFinalSlot: boolean): { intents: Intent[]; journal: DecisionRecord[] } {
    const intents: Intent[] = [];
    const journal: DecisionRecord[] = [];
    const closing = new Set<string>();
    // ExpectancyTracker è statico (condiviso nel processo): la matrice di questo core viene
    // caricata a ogni decisione, così due core nello stesso processo non si influenzano.
    ExpectancyTracker.loadMatrix(this.config.expectancyMatrix ?? {});

    // 1. Uscite (per tutti i simboli, prima degli ingressi)
    for (const symbol of this.config.symbols) {
      const pos = this.state.positions[symbol];
      const snap = snapshots[symbol];
      if (!pos || !snap) continue;
      const trade = cloneTrade(pos.trade);
      let decision: { shouldExit: boolean; exitType: string } = PositionExitLayer.monitorAndExit(trade, snap.features, snap.regime);
      if (isFinalSlot) decision = { shouldExit: true, exitType: 'END_OF_DATA' };
      if (FEATURE_FLAGS.DATA_GAP_VALIDATION && (this.gapOf(symbol) > 240 || trade.shouldInvalidateByGap)) {
        decision = { shouldExit: true, exitType: 'INVALIDATED_DATA_GAP' };
      }
      pos.trade = trade;
      if (decision.shouldExit) {
        const intent: CloseIntent = {
          kind: 'CLOSE',
          symbol,
          slotTime,
          positionId: pos.id,
          direction: trade.direction as Direction,
          size: trade.size,
          referencePrice: snap.features.price,
          exitType: decision.exitType as CloseIntent['exitType'],
        };
        this.registerPendingClose(pos, intent);
        closing.add(symbol);
        intents.push(intent);
        journal.push({ slotTime, symbol, action: 'CLOSE', reason: decision.exitType, direction: intent.direction, regime: snap.regime, price: intent.referencePrice, engine: trade.engine });
      } else {
        const backstop = this.backstopLevel(trade.direction as Direction, trade.currentStopLoss);
        if (backstop !== null) {
          pos.backstop = backstop;
          const update: UpdateStopIntent = {
            kind: 'UPDATE_STOP',
            symbol,
            slotTime,
            positionId: pos.id,
            direction: trade.direction as Direction,
            size: trade.size,
            strategyStop: trade.currentStopLoss,
            backstop,
          };
          intents.push(update);
        }
        journal.push({ slotTime, symbol, action: 'HOLD', reason: `stop ${trade.currentStopLoss}`, direction: trade.direction as Direction, regime: snap.regime, price: snap.features.price, engine: trade.engine });
      }
    }

    // 2. Ingressi
    const capital = this.state.capital;
    const btc = snapshots[this.btcSymbol];
    // Senza la candela di BTC in quest'ora: trend 0 e regime UNKNOWN, come nel backtest legacy.
    const btcContext = { trend1H: btc ? btc.features.trend1H : 0, regime: (btc ? btc.regime : 'UNKNOWN') as TradingRegime };
    const { grossProfit, grossLoss } = this.state.normalClean;
    const cleanProfitFactor = grossLoss === 0 ? 1.0 : grossProfit / Math.abs(grossLoss);
    const opens: OpenIntent[] = [];
    for (const symbol of this.config.symbols) {
      const snapshot = snapshots[symbol];
      if (!snapshot || !capital) continue;
      if (this.state.positions[symbol] && !closing.has(symbol)) continue;
      const decision = decideEntry({
        slotTime,
        symbol,
        snapshot,
        btc: btcContext,
        capital,
        normalCooldownActive: this.normalCooldownActive(symbol),
        gapMinutes: this.gapOf(symbol),
        cleanProfitFactor,
        backstopLevel: (direction, stop) => this.backstopLevel(direction, stop),
      });
      journal.push(decision.record);
      if (decision.intent) opens.push(decision.intent);
    }
    for (const open of opens) this.state.pendingOpens[open.positionId] = open;
    intents.push(...opens);
    return { intents, journal };
  }

  /** PnL della chiusura di `pos` al prezzo dato (stessa formula del backtest legacy). */
  private closePnL(pos: CorePosition, exitPrice: number, exitFee: number): number {
    const trade = pos.trade;
    const exitSizeValue = trade.size * exitPrice;
    const entryValue = trade.size * trade.entryPrice;
    const pnl = trade.direction === 'LONG'
      ? exitSizeValue - exitFee - (entryValue + pos.entryFee)
      : entryValue - pos.entryFee - (exitSizeValue + exitFee);
    return pnl - pos.fundingPaid;
  }

  private addToNormalClean(pnl: number): void {
    if (pnl > 0) this.state.normalClean.grossProfit += pnl;
    else this.state.normalClean.grossLoss += pnl;
  }

  /** Annulla un contributo precedente, dal bucket in cui era stato aggiunto. */
  private removeFromNormalClean(pnl: number): void {
    if (pnl > 0) this.state.normalClean.grossProfit -= pnl;
    else this.state.normalClean.grossLoss -= pnl;
  }

  private registerPendingClose(pos: CorePosition, intent: CloseIntent): void {
    const estimatedFee = pos.trade.size * intent.referencePrice * this.config.feeRate;
    const provisionalPnL = 0 + this.closePnL(pos, intent.referencePrice, estimatedFee);
    const counted = pos.trade.engine === 'NORMAL' && !pos.trade.isContaminated;
    if (counted) this.addToNormalClean(provisionalPnL);
    const pending: PendingClose = { intent, provisionalPnL, countedInNormalClean: counted };
    if (pos.symbol in this.state.lastExit4HStart) pending.previousLastExit4H = this.state.lastExit4HStart[pos.symbol];
    this.state.lastExit4HStart[pos.symbol] = this.aggregators[pos.symbol].lastClosed4HStart;
    this.state.pendingCloses[pos.id] = pending;
  }

  // --- Fill ------------------------------------------------------------------------------

  /** Applica un fill. Per le chiusure restituisce il trade nel formato del backtest legacy. */
  applyFill(fill: Fill): TradeRecord | null {
    if (fill.kind === 'OPEN') {
      const intent = this.state.pendingOpens[fill.positionId];
      if (!intent) throw new Error(`Fill di apertura senza intento: ${fill.positionId}`);
      delete this.state.pendingOpens[fill.positionId];
      if (this.state.positions[intent.symbol]) throw new Error(`Posizione già aperta su ${intent.symbol}`);
      const trade: ActiveTrade = {
        id: new Date(intent.slotTime).toISOString(),
        symbol: legacySymbol(intent.symbol),
        direction: intent.direction,
        entryPrice: fill.price,
        size: fill.size,
        leverage: intent.leverage,
        stopLoss: intent.stopLoss,
        initialStopLoss: intent.stopLoss,
        currentStopLoss: intent.stopLoss,
        catastropheStopLoss: intent.catastropheStopLoss,
        highWaterMark: fill.price,
        lowWaterMark: fill.price,
        barsHeld: 0,
        entryRegime: intent.regime,
        setup: intent.setup,
        engine: intent.engine,
      };
      this.state.positions[intent.symbol] = {
        id: intent.positionId,
        symbol: intent.symbol,
        entryTime: new Date(intent.slotTime).toISOString(),
        entrySlot: intent.slotTime,
        trade,
        entryFee: fill.fee,
        fundingPaid: 0,
        tierLabel: intent.tierLabel,
        isChopEntry: intent.isChopEntry,
        isReducedLeverageAction: intent.isReducedLeverageAction,
        quality: intent.quality,
        backstop: intent.backstop,
        meta: intent.meta,
      };
      return null;
    }

    const pos = Object.values(this.state.positions).find((p) => p?.id === fill.positionId) ?? null;
    if (!pos) throw new Error(`Fill di chiusura per una posizione sconosciuta: ${fill.positionId}`);
    const pending = this.state.pendingCloses[pos.id] ?? null;
    delete this.state.pendingCloses[pos.id];
    const reason = fill.exitType ?? pending?.intent.exitType;
    if (!reason) throw new Error(`Fill di chiusura senza motivo: ${fill.positionId}`);
    return this.realize(pos, fill, reason, pending);
  }

  /**
   * Intento non eseguito dall'exchange. Un'apertura viene semplicemente scartata; per una
   * chiusura vengono annullati gli effetti provvisori e la posizione resta aperta (verrà
   * rivalutata alla prossima chiusura oraria).
   */
  rejectIntent(positionId: string): void {
    delete this.state.pendingOpens[positionId];
    const pending = this.state.pendingCloses[positionId];
    if (!pending) return;
    delete this.state.pendingCloses[positionId];
    if (pending.countedInNormalClean) this.removeFromNormalClean(pending.provisionalPnL);
    const symbol = pending.intent.symbol;
    if (pending.previousLastExit4H === undefined) delete this.state.lastExit4HStart[symbol];
    else this.state.lastExit4HStart[symbol] = pending.previousLastExit4H;
  }

  applyFunding(symbol: string, amount: number): void {
    const pos = this.state.positions[symbol];
    if (pos) pos.fundingPaid += amount;
  }

  private realize(pos: CorePosition, fill: Fill, reason: CloseIntent['exitType'], pending: PendingClose | null): TradeRecord {
    const trade = pos.trade;
    const exitPrice = fill.price;
    const size = trade.size;
    const exitFee = fill.fee;
    const entryValue = size * trade.entryPrice;
    const entryFee = pos.entryFee;
    // Stessa formula e stesso ordine delle operazioni del backtest legacy (harvest disattivato).
    const runnerPnL = this.closePnL(pos, exitPrice, exitFee);
    const tradeNetPnL = 0 + runnerPnL;
    const totalEntryValue = size * trade.entryPrice;
    const pnlPercent = (tradeNetPnL / totalEntryValue) * 100 * trade.leverage;

    this.state.realizedEquity += tradeNetPnL;
    if (this.state.realizedEquity > this.state.maxHistoricalEquity) this.state.maxHistoricalEquity = this.state.realizedEquity;

    let maxUnrealizedPnlPercent: number;
    let maxNegativeExcursionPercent: number;
    if (trade.direction === 'LONG') {
      maxUnrealizedPnlPercent = ((trade.highWaterMark - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage;
      maxNegativeExcursionPercent = ((trade.lowWaterMark - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage;
    } else {
      maxUnrealizedPnlPercent = ((trade.entryPrice - trade.lowWaterMark) / trade.entryPrice) * 100 * trade.leverage;
      maxNegativeExcursionPercent = ((trade.entryPrice - trade.highWaterMark) / trade.entryPrice) * 100 * trade.leverage;
    }

    if (pending) {
      // Effetti già applicati alla decisione: si corregge solo se il fill reale è diverso.
      if (pending.countedInNormalClean && pending.provisionalPnL !== tradeNetPnL) {
        this.removeFromNormalClean(pending.provisionalPnL);
        this.addToNormalClean(tradeNetPnL);
      }
    } else {
      // Chiusura non decisa dal core (es. backstop nativo scattato sull'exchange).
      if (trade.engine === 'NORMAL' && !trade.isContaminated) this.addToNormalClean(tradeNetPnL);
      this.state.lastExit4HStart[pos.symbol] = this.aggregators[pos.symbol].lastClosed4HStart;
    }
    this.state.positions[pos.symbol] = null;

    const record: TradeRecord = {
      symbol: legacySymbol(pos.symbol),
      type: trade.direction as Direction,
      entryTime: pos.entryTime,
      entryPrice: trade.entryPrice,
      exitTime: new Date(fill.time).toISOString(),
      exitPrice,
      pnl: tradeNetPnL,
      pnlPercent,
      reason,
      size,
      leverage: trade.leverage,
      entryRegime: trade.entryRegime,
      setup: trade.setup || 'N/A',
      engine: trade.engine || 'NONE',
      tierLabel: pos.tierLabel,
      isChopEntry: pos.isChopEntry,
      isHarvestExecuted: false,
      harvestPnL: 0,
      runnerPnL,
      originalSize: size,
      maxUnrealizedPnlPercent,
      maxNegativeExcursionPercent,
      margin: entryValue / trade.leverage,
      barsHeld: trade.barsHeld,
      isContaminated: trade.isContaminated,
      mfeR: trade.mfeR,
      maeR: trade.maeR,
      barsUnderEntry: trade.barsUnderEntry,
      barsToHalfR: trade.barsToHalfR,
      barsToOneR: trade.barsToOneR,
      ...(pos.isReducedLeverageAction ? { isReducedLeverageAction: true } : {}),
      costs: { entryFee, exitFee, funding: pos.fundingPaid },
    };
    return record;
  }

  openPositions(): CorePosition[] {
    return this.config.symbols.map((s) => this.state.positions[s]).filter((p): p is CorePosition => p !== null);
  }
}

// --- Decisione di ingresso (pura) ---------------------------------------------------------

export interface EntryInput {
  slotTime: number;
  symbol: string;
  snapshot: SymbolSnapshot;
  btc: { trend1H: number; regime: TradingRegime };
  capital: { trueEquity: number; isHalted: boolean; capacityMultiplier: number };
  normalCooldownActive: boolean;
  gapMinutes: number;
  /** Profit factor dei NORMAL "puliti" chiusi finora (1,0 senza perdite, come nel backtest). */
  cleanProfitFactor: number;
  backstopLevel: (direction: Direction, strategyStop: number) => number | null;
}

export interface EntryDecision {
  record: DecisionRecord;
  intent: OpenIntent | null;
}

/**
 * Pipeline di ingresso per un simbolo alla chiusura oraria, nello stesso ordine del backtest
 * legacy: halt per drawdown → SignalLayer → cooldown NORMAL → GatekeeperLayer (inclusa la
 * matrice expectancy) → resolveRiskTier (incluso il blocco di TRANSITION) → RiskLayer. La leva
 * viene decisa qui, una sola volta, e non cambia più per tutta la durata del trade.
 */
export function decideEntry(input: EntryInput): EntryDecision {
  const { slotTime, symbol, snapshot, capital } = input;
  const { features, regime } = snapshot;
  const price = features.price;
  const skip = (action: DecisionRecord['action'], reason: string, extra: Partial<DecisionRecord> = {}): EntryDecision => ({
    record: { slotTime, symbol, action, reason, regime, price, ...extra },
    intent: null,
  });
  if (capital.isHalted) return skip('HALTED', 'Drawdown ≥ 25%: nessun nuovo ingresso');
  const lsym = legacySymbol(symbol);
  const globals = { btcTrend1H: input.btc.trend1H, btcRegime: input.btc.regime };
  const signal = SignalLayer.evaluate(features, regime, lsym, globals);
  if (signal.direction === 'NEUTRAL') return skip('NO_SIGNAL', 'Nessun setup', { direction: 'NEUTRAL' });
  const engine = signal.engine as EngineName;
  const direction = signal.direction as Direction;
  if (engine === 'NORMAL' && input.normalCooldownActive) {
    return skip('COOLDOWN', 'NORMAL: attesa di una candela 4H completa dopo l\'uscita', { direction, engine });
  }
  const gate = GatekeeperLayer.allowEntry(signal, features, regime, lsym);
  if (!gate.allowed) return skip('BLOCKED', gate.reason, { direction, engine });
  const tier = resolveRiskTier({ engine, gapMinutes: input.gapMinutes, regime, setup: signal.type }, { cleanProfitFactor: input.cleanProfitFactor });
  if (tier.blocked || tier.tierLabel === 'TRANSITION_BLOCKED') return skip('TIER_BLOCKED', tier.reason, { direction, engine });
  const risk = RiskLayer.calculateRisk(signal, features, capital.trueEquity, regime, gate.riskModifier, lsym, globals, tier.exposurePct);
  const size = risk.positionSize * capital.capacityMultiplier;
  if (!(size > 0)) return skip('SIZE_ZERO', 'Size nulla', { direction, engine });
  const intent: OpenIntent = {
    kind: 'OPEN',
    symbol,
    slotTime,
    positionId: `${symbol}-${new Date(slotTime).toISOString()}`,
    direction,
    size,
    leverage: risk.leverage,
    referencePrice: price,
    stopLoss: risk.stopLoss,
    catastropheStopLoss: risk.catastropheStopLoss,
    backstop: input.backstopLevel(direction, risk.stopLoss) ?? risk.stopLoss,
    engine,
    setup: signal.type,
    regime,
    tierLabel: tier.tierLabel,
    quality: signal.quality,
    isChopEntry: features.isChop,
    isReducedLeverageAction: risk.isReducedLeverageAction === true,
    meta: signal.meta,
  };
  return { record: { slotTime, symbol, action: 'OPEN', reason: `${gate.reason} · ${tier.tierLabel}`, direction, regime, price, engine }, intent };
}

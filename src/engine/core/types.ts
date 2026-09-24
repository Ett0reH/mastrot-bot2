// Tipi del DecisionCore: il codice decisionale unico usato da backtest, replay e live (F2).
import type { ActiveTrade, ExitReason, TradingRegime } from '../../server/core/architecture';

export type Direction = 'LONG' | 'SHORT';
export type EngineName = 'EXTREME' | 'NORMAL' | 'NONE';

/**
 * Uscita decisa dal core (legacy) oppure avvenuta sull'exchange: backstop nativo, chiusura
 * esterna (manuale), liquidazione, chiusura d'emergenza per protezione mancante (I7).
 */
export type CloseReason = ExitReason | 'BACKSTOP' | 'EXTERNAL_CLOSE' | 'LIQUIDATION' | 'PROTECTION_FAILURE' | 'KILL_SWITCH';

/** Posizione gestita dal core. `trade` è la struttura valutata da PositionExitLayer. */
export interface CorePosition {
  id: string;
  symbol: string;
  /** Tempo di apertura della candela 15m di ingresso (ISO), come `entryTime` del backtest legacy. */
  entryTime: string;
  entrySlot: number;
  trade: ActiveTrade;
  entryFee: number;
  fundingPaid: number;
  tierLabel: string;
  isChopEntry: boolean;
  isReducedLeverageAction: boolean;
  quality: number;
  /** Livello dello stop nativo di emergenza sull'exchange (null se non ancora calcolato). */
  backstop: number | null;
  meta?: unknown;
}

interface IntentBase {
  symbol: string;
  slotTime: number;
}

export interface OpenIntent extends IntentBase {
  kind: 'OPEN';
  positionId: string;
  direction: Direction;
  size: number;
  leverage: number;
  referencePrice: number;
  stopLoss: number;
  catastropheStopLoss: number;
  backstop: number;
  engine: EngineName;
  setup: string;
  regime: TradingRegime;
  tierLabel: string;
  quality: number;
  isChopEntry: boolean;
  isReducedLeverageAction: boolean;
  meta?: unknown;
}

export interface CloseIntent extends IntentBase {
  kind: 'CLOSE';
  positionId: string;
  direction: Direction;
  size: number;
  referencePrice: number;
  exitType: CloseReason;
}

export interface UpdateStopIntent extends IntentBase {
  kind: 'UPDATE_STOP';
  positionId: string;
  direction: Direction;
  size: number;
  strategyStop: number;
  backstop: number;
}

export type Intent = OpenIntent | CloseIntent | UpdateStopIntent;

/** Esecuzione (simulata o reale) di un intento OPEN o CLOSE, o di un backstop nativo. */
export interface Fill {
  kind: 'OPEN' | 'CLOSE';
  symbol: string;
  positionId: string;
  price: number;
  size: number;
  fee: number;
  time: number;
  exitType?: CloseReason;
  source: 'sim' | 'exchange';
  /** true se la fee è stimata (la fee reale arriva dal ledger di Kraken, F4). */
  feeEstimated?: boolean;
}

/** Voce del journal delle decisioni: anche i segnali neutrali o bloccati, con il motivo. */
export interface DecisionRecord {
  slotTime: number;
  symbol: string;
  /**
   * REJECTED: intento deciso dal core e respinto prima dell'invio (guardrail) o dall'exchange.
   * NO_DATA: simbolo non valutato all'ora (candela mancante o storico insufficiente).
   */
  action: 'NO_SIGNAL' | 'COOLDOWN' | 'BLOCKED' | 'TIER_BLOCKED' | 'SIZE_ZERO' | 'OPEN' | 'CLOSE' | 'HOLD' | 'HALTED' | 'PENDING_ORDER' | 'REJECTED' | 'NO_DATA';
  reason: string;
  direction?: Direction | 'NEUTRAL';
  regime?: TradingRegime;
  price?: number;
  engine?: EngineName;
}

/** Trade chiuso, nel formato del backtest legacy (per il confronto con il golden) più i costi. */
export interface TradeRecord {
  symbol: string;
  type: Direction;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  reason: CloseReason;
  size: number;
  leverage: number;
  entryRegime: TradingRegime;
  setup: string;
  engine: string;
  tierLabel: string;
  isChopEntry: boolean;
  isHarvestExecuted: boolean;
  harvestPnL: number;
  runnerPnL: number;
  originalSize: number;
  maxUnrealizedPnlPercent: number;
  maxNegativeExcursionPercent: number;
  margin: number;
  barsHeld: number;
  isContaminated?: boolean;
  mfeR?: number;
  maeR?: number;
  barsUnderEntry?: number;
  barsToHalfR?: number;
  barsToOneR?: number;
  isReducedLeverageAction?: boolean;
  meta?: unknown;
  /** Costi reali o simulati (assenti nel formato legacy). */
  costs?: { entryFee: number; exitFee: number; funding: number };
}

export interface EquitySnapshot {
  slotTime: number;
  realizedEquity: number;
  floatingPnL: number;
  trueEquity: number;
  maxHistoricalEquity: number;
  drawdown: number;
  isHalted: boolean;
  capacityMultiplier: number;
}

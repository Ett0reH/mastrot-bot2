// --- CORE STATE MACHINES & ENUMS ---

export enum SystemState {
  BOOTSTRAPPING = "BOOTSTRAPPING",
  SYNCING = "SYNCING",
  HEALTHY = "HEALTHY",
  DEGRADED_DATA = "DEGRADED_DATA",
  DEGRADED_BROKER = "DEGRADED_BROKER",
  DEGRADED_MODEL = "DEGRADED_MODEL",
  DEGRADED_TIME = "DEGRADED_TIME",
  UNCERTAINTY_MODE = "UNCERTAINTY_MODE",
  RECOVERING = "RECOVERING",
  RISK_HALTED = "RISK_HALTED",
  SYSTEM_HALTED = "SYSTEM_HALTED",
  SHUTTING_DOWN = "SHUTTING_DOWN"
}

export enum MarketRegime {
  CALM = "CALM",
  NORMAL = "NORMAL",
  TURBULENT = "TURBULENT",
  PANIC = "PANIC"
}

export enum OrderIntent {
  PULLBACK_RECLAIM_LONG = "PULLBACK_RECLAIM_LONG",
  BREAKOUT_LONG = "BREAKOUT_LONG",
  STOP_LOSS = "STOP_LOSS",
  TAKE_PROFIT = "TAKE_PROFIT"
}

// --- DATA LAYER ---

export interface BinanceTradeEvent {
  eventTime: number;
  symbol: string;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
}

export interface KLineData {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

// --- LOGIC ENGINE CONTRACTS ---

export interface RegimeOutput {
  currentRegime: MarketRegime;
  confidence: number;
  transitionProbability: Record<MarketRegime, number>;
  isFlickerDetected: boolean;
  timestamp: number;
}

export interface FilterOutput {
  tradableSymbols: string[];
  alignmentScore: number; // 0.0 to 1.0
  rejectionReasons: Map<string, string>;
}

export interface TriggerSignal {
  symbol: string;
  intent: OrderIntent;
  suggestedEntry: number;
  suggestedStop: number;
  confidence: number;
  timestamp: number;
}

export interface RiskEvaluation {
  approved: boolean;
  modifiedSize: number;
  modifiedStop: number;
  vetoReason?: string;
  enforcedBreakers: string[];
}

// --- EXECUTION LAYER ---

export enum OrderLifecycle {
  NEW = "NEW",
  SUBMITTED = "SUBMITTED",
  PARTIALLY_FILLED = "PARTIALLY_FILLED",
  FILLED = "FILLED",
  CANCELED = "CANCELED",
  REJECTED = "REJECTED",
  EXPIRED = "EXPIRED"
}

export interface StatefulOrder {
  clientOrderId: string;
  symbol: string;
  lifecycle: OrderLifecycle;
  intent: OrderIntent;
  targetSize: number;
  filledSize: number;
  averagePrice: number | null;
  lastUpdate: number;
}

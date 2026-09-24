export enum IntentStatus {
  INTENT_CREATED = "INTENT_CREATED",
  SUBMITTED = "SUBMITTED",
  ACKNOWLEDGED = "ACKNOWLEDGED",
  FILLED = "FILLED",
  PARTIAL = "PARTIAL",
  CANCELED = "CANCELED",
  REJECTED = "REJECTED",
  FAILED = "FAILED",
  UNKNOWN_TIMEOUT = "UNKNOWN_TIMEOUT",
  RECONCILED = "RECONCILED",
  MANUAL_REVIEW_REQUIRED = "MANUAL_REVIEW_REQUIRED"
}

export interface OrderIntent {
  intentId: string;
  clientOrderId: string;
  actionType: "ENTRY" | "STOP_LOSS" | "TAKE_PROFIT" | "CLOSE" | "EMERGENCY_CLOSE" | "CANCEL" | "REPLACE";
  symbol: string;
  side: "buy" | "sell";
  amount: number;
  price?: number;
  triggerPrice?: number;
  reduceOnly: boolean;
  status: IntentStatus;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
  linkedPositionId?: string;
  linkedEntryClientOrderId?: string;
  error?: string;
}

export interface FillRecord {
  fillId: string;
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  amount: number;
  price: number;
  fee: number;
  feeCurrency: string;
  timestamp: string;
  liquidityType: "maker" | "taker";
  positionId: string;
  source: "broker_fetchOrder" | "broker_myTrades" | "reconciliation";
  rawBrokerPayload?: any;
}

export interface PositionLedgerEntry {
  positionId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  status: "OPEN" | "CLOSED" | "PARTIAL_CLOSED" | "EMERGENCY_UNPROTECTED";
  entryOrderIds: string[];
  exitOrderIds: string[];
  clientOrderIds: string[];
  totalEntryAmount: number;
  totalExitAmount: number;
  averageEntryPrice: number;
  averageExitPrice: number;
  realizedFees: number;
  unrealizedFeesEstimate: number;
  realizedPnlGross: number;
  realizedPnlNet: number;
  currentOpenAmount: number;
  nativeStopLossOrderId?: string;
  nativeTakeProfitOrderId?: string;
  mfe: number;
  mae: number;
  barsHeld: number;
  createdAt: string;
  updatedAt: string;
}

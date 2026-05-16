import ccxt from 'ccxt';
import "dotenv/config";

process.env.LIVE_TRADING_ENABLED = 'true';

import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc } from 'firebase/firestore/lite';
import * as fs from 'fs';
import * as path from 'path';
import { calculateSnapshot } from '../lib/metricsCalculator';
import { 
  IntentStatus, OrderIntent, FillRecord, PositionLedgerEntry 
} from '../lib/ledgerTypes';
import {
    Bar, TradingRegime, MarketDataLayer, RegimeLayer, SignalLayer,
    GatekeeperLayer, RiskLayer, PositionExitLayer, ActiveTrade, CapitalManagementLayer, ExpectancyTracker,
    SignalDirection
} from './core/architecture';
import { v4 as uuidv4 } from 'uuid';

let db: any = null;
let expectancyMatrixLoaded = false;

try {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app, firebaseConfig.firestoreDatabaseId); 
    console.log("Firebase initialized successfully");
  } else {
    console.warn("WARNING: firebase-applet-config.json not found. Firebase will not be connected.");
  }
} catch (err: any) {
  console.warn("Failed to initialize Firebase:", err.message);
}

const STATE_DOC_ID = 'live';
const BOT_SECRET = 'arbiter-secret-key-1092';

// Basic state
export interface LiveState {
  isActive: boolean;
  status: string;
  balance: number;
  baseBalance?: number;
  openPositions: ActiveTrade[];
  recentTrades: any[];
  closedTrades?: any[];
  regime: string;
  regimes?: Record<string, string>;
  lastUpdate: string;
  lastError?: string;
  botSecret?: string;
  equityHistory?: { time: string, equity: number }[];
  metricsHistory?: any[];
  maxHistoricalEquity?: number;
  initialBalance?: number;
  startTime?: string;
  warmupUntil?: number;
  marginUsed?: number;
  krakenStatus?: {
    connected: boolean;
    balanceSync: boolean;
    lastError?: string;
  };
  // New ledger fields
  orderIntents?: Record<string, OrderIntent>;
  positionLedger?: Record<string, PositionLedgerEntry>;
  lastSignalTimes?: Record<string, string>;
  recentDecisions?: any[];
}

function logDecision(decision: any) {
  if (!state.recentDecisions) state.recentDecisions = [];
  state.recentDecisions.unshift({ time: new Date().toISOString(), ...decision });
  if (state.recentDecisions.length > 50) {
    state.recentDecisions = state.recentDecisions.slice(0, 50);
  }
}

// Emulated virtual wallet state
export let state: LiveState = {
  isActive: false,
  status: 'STOPPED',
  balance: 10000.00, // Virtual starting balance
  baseBalance: 10000.00,
  openPositions: [],
  recentTrades: [],
  regime: 'UNKNOWN',
  regimes: {},
  lastUpdate: new Date().toISOString(),
  botSecret: BOT_SECRET,
  equityHistory: [],
  maxHistoricalEquity: 10000.00,
  orderIntents: {},
  positionLedger: {},
  lastSignalTimes: {}
};

export let exchange: any = null;
let pollInterval: NodeJS.Timeout | null = null;
export let simulatedPositions: ActiveTrade[] = [];

// --- LEDGER & IDEMPOTENCY HELPERS ---

export async function persistOrderIntent(intent: OrderIntent) {
    if (!state.orderIntents) state.orderIntents = {};
    state.orderIntents[intent.clientOrderId] = intent;
    console.log(`[ORDER_INTENT_PERSISTED] ${intent.actionType} for ${intent.symbol} | ClientID: ${intent.clientOrderId}`);
    await saveState();
}

export async function updateIntentStatus(clientOrderId: string, status: IntentStatus, error?: string) {
    if (state.orderIntents && state.orderIntents[clientOrderId]) {
        state.orderIntents[clientOrderId].status = status;
        state.orderIntents[clientOrderId].updatedAt = new Date().toISOString();
        if (error) state.orderIntents[clientOrderId].error = error;
        await saveState();
    }
}

export async function recordFill(fill: FillRecord) {
    const positionId = fill.positionId;
    if (!state.positionLedger) state.positionLedger = {};
    
    if (!state.positionLedger[positionId]) {
        // This should not happen if we tracked the intent correctly, but as a safety:
        console.error(`[LEDGER_ERROR] Received fill for unknown positionId: ${positionId}`);
        return;
    }

    const ledger = state.positionLedger[positionId];
    ledger.updatedAt = new Date().toISOString();
    
    if (fill.side === (ledger.side === 'LONG' ? 'buy' : 'sell')) {
        // Adding to position
        const oldEntryVal = ledger.totalEntryAmount * ledger.averageEntryPrice;
        const newFillVal = fill.amount * fill.price;
        ledger.totalEntryAmount += fill.amount;
        ledger.averageEntryPrice = (oldEntryVal + newFillVal) / ledger.totalEntryAmount;
        ledger.currentOpenAmount += fill.amount;
        if (!ledger.entryOrderIds.includes(fill.orderId)) ledger.entryOrderIds.push(fill.orderId);
    } else {
        // Reducing position
        const oldExitVal = ledger.totalExitAmount * ledger.averageExitPrice;
        const newFillVal = fill.amount * fill.price;
        ledger.totalExitAmount += fill.amount;
        ledger.averageExitPrice = (oldExitVal + newFillVal) / (ledger.totalExitAmount || 1);
        ledger.currentOpenAmount -= fill.amount;
        if (!ledger.exitOrderIds.includes(fill.orderId)) ledger.exitOrderIds.push(fill.orderId);
        
        // Update Realized PnL
        const entryPrice = ledger.averageEntryPrice;
        const exitPrice = fill.price;
        const pnlFactor = ledger.side === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
        ledger.realizedPnlGross += (pnlFactor * fill.amount);
    }

    ledger.realizedFees += fill.fee;
    ledger.realizedPnlNet = ledger.realizedPnlGross - ledger.realizedFees;

    if (Math.abs(ledger.currentOpenAmount) < 0.00001) {
        ledger.status = 'CLOSED';
        ledger.currentOpenAmount = 0;
        console.log(`[POSITION_CLOSED_BY_LEDGER] ${ledger.symbol} | Net PnL: ${ledger.realizedPnlNet.toFixed(2)}`);
    }

    console.log(`[FILL_RECORDED] ${fill.symbol} | Amount: ${fill.amount} | Price: ${fill.price} | Fee: ${fill.fee} ${fill.feeCurrency}`);
    await saveState();
}

async function validateMarketDataFreshness(candles: Bar[], timeframe: string) {
    if (!candles || candles.length === 0) return false;
    const lastCandle = candles[candles.length - 1];
    const lastTs = new Date(lastCandle.t).getTime();
    const now = Date.now();
    const ageMs = now - lastTs;

    let maxToleranceMs = 120 * 60 * 1000; // Default 120m for 1H
    if (timeframe === '4h') maxToleranceMs = 5 * 60 * 60 * 1000; // 5h for 4H

    console.log(`[MARKET_DATA_FRESHNESS_CHECK] ${timeframe} | Age: ${(ageMs / 60000).toFixed(1)}m | Tolerance: ${maxToleranceMs / 60000}m`);

    if (ageMs > maxToleranceMs) {
        console.error(`[STALE_DATA_DETECTED] Market data for ${timeframe} is too old! Age: ${(ageMs / 60000).toFixed(1)}m`);
        return false;
    }
    return true;
}

const PRECISION_MAP: Record<string, { tick: number, size: number }> = {
    'BTC': { tick: 0, size: 4 },
    'XBT': { tick: 0, size: 4 },
    'ETH': { tick: 1, size: 3 },
    'SOL': { tick: 2, size: 2 },
    'LINK': { tick: 3, size: 1 },
    'ADA': { tick: 5, size: 0 },
    'XRP': { tick: 5, size: 0 },
    'DOGE': { tick: 6, size: 0 }
};

function formatPriceAndSize(symbol: string, price: number, size: number) {
    let base = symbol.split('/')[0] || '';
    if (base.includes('-')) base = base.split('-')[0];
    const p = PRECISION_MAP[base] || { tick: 2, size: 2 };
    
    // Round size to given decimals
    const factorSize = Math.pow(10, p.size);
    const formattedSize = Math.floor(size * factorSize) / factorSize;

    // Round price to given tick decimals
    const factorPrice = Math.pow(10, p.tick);
    const formattedPrice = Math.round(price * factorPrice) / factorPrice;

    return { price: formattedPrice, size: formattedSize };
}

export async function createProtectedLimitEntryOrder(params: {
    symbol: string,
    side: 'buy' | 'sell',
    amount: number,
    lastPrice: number,
    slippageBuffer: number,
    timeoutMs: number,
    clientOrderId: string,
    positionId: string
}) {
    const { symbol, side, amount, lastPrice, slippageBuffer, timeoutMs, clientOrderId, positionId } = params;

    const limitPrice = side === 'buy' ? lastPrice * (1 + slippageBuffer) : lastPrice * (1 - slippageBuffer);
    
    const { price: preciseLimitPrice, size: finalAmount } = formatPriceAndSize(symbol, limitPrice, amount);

    console.log(`[LIMIT_ENTRY_INTENT_CREATED] ${side.toUpperCase()} ${finalAmount} ${symbol} @ ${preciseLimitPrice} (Ref: ${lastPrice})`);

    const intent: OrderIntent = {
        intentId: uuidv4(),
        clientOrderId,
        actionType: "ENTRY",
        symbol,
        side,
        amount: finalAmount,
        price: preciseLimitPrice,
        reduceOnly: false,
        status: IntentStatus.INTENT_CREATED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        retryCount: 0,
        linkedPositionId: positionId
    };

    await persistOrderIntent(intent);

    try {
        await updateIntentStatus(clientOrderId, IntentStatus.SUBMITTED);
        const orderRes = await exchange.createLimitOrder(symbol, side, finalAmount, preciseLimitPrice, { clientOrderId });
        await updateIntentStatus(clientOrderId, IntentStatus.ACKNOWLEDGED);

        // Wait for execution or timeout
        let filledAmount: number | null = 0;
        let avgPrice: number | null = 0;
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
            const order = await exchange.fetchOrder(orderRes.id, symbol);
            if (order.status === 'closed') {
                filledAmount = order.filled;
                avgPrice = order.average;
                break;
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        if (filledAmount === 0 || filledAmount === null || filledAmount === undefined) {
            console.warn(`[LIMIT_ENTRY_TIMEOUT] Order not filled within ${timeoutMs}ms. Attempting cancellation...`);
            try {
                await exchange.client.cancelOrder({ order_id: orderRes.id });
                const finalOrder = await exchange.fetchOrder(orderRes.id, symbol);
                filledAmount = finalOrder.filled || 0;
                avgPrice = finalOrder.average || 0;
            } catch (e) {
                // If cancel fails, it might have just filled.
                const finalOrder = await exchange.fetchOrder(orderRes.id, symbol);
                filledAmount = finalOrder.filled || 0;
                avgPrice = finalOrder.average || 0;
            }
        }

        if (filledAmount !== null && filledAmount > 0) {
            const isPartial = filledAmount < amount;
            await updateIntentStatus(clientOrderId, isPartial ? IntentStatus.PARTIAL : IntentStatus.FILLED);
            console.log(`[LIMIT_ENTRY_${isPartial ? 'PARTIAL' : 'FILLED'}] ${symbol} | Amount: ${filledAmount} | Price: ${avgPrice}`);
            
            // Record in ledger
            await recordFill({
                fillId: uuidv4(),
                orderId: clientOrderId,
                clientOrderId,
                symbol,
                side,
                amount: filledAmount,
                price: avgPrice,
                fee: filledAmount * avgPrice * 0.0005, // Estimate 0.05% fee if broker doesn't provide
                feeCurrency: 'USD',
                timestamp: new Date().toISOString(),
                liquidityType: 'taker',
                positionId,
                source: 'broker_fetchOrder'
            });

            return { success: true, filledAmount, avgPrice, isPartial };
        } else {
            logDecision({ action: "ORDER_SKIPPED", symbol, direction: side === 'buy' ? 'LONG' : 'SHORT', reason: "Entry Limit Order not filled (Timeout/Gap)", price: lastPrice, regime: "UNKNOWN" });
            await updateIntentStatus(clientOrderId, IntentStatus.CANCELED);
            console.error(`[ENTRY_NOT_FILLED_CANCELED] ${symbol} could not be entered.`);
            return { success: false, filledAmount: 0 };
        }

    } catch (e: any) {
        console.error(`[LIMIT_ENTRY_FAILED] ${symbol}:`, e.message);
        await updateIntentStatus(clientOrderId, IntentStatus.FAILED, e.message);
        return { success: false, filledAmount: 0, error: e.message };
    }
}

export async function attachNativeProtections(p: ActiveTrade, filledAmount: number) {
    if (!exchange) return;
    
    const { price: formattedSL, size: formattedSLSize } = formatPriceAndSize(p.symbol, p.stopLoss, filledAmount);

    console.log(`[NATIVE_SL_INTENT_CREATED] Target SL: ${formattedSL} for ${p.symbol}`);
    
    const slClientOrderId = `sl-${p.id.substring(0, 10)}`;
    const intent: OrderIntent = {
        intentId: uuidv4(),
        clientOrderId: slClientOrderId,
        actionType: "STOP_LOSS",
        symbol: p.symbol,
        side: p.direction === 'LONG' ? 'sell' : 'buy',
        amount: formattedSLSize,
        triggerPrice: formattedSL,
        reduceOnly: true,
        status: IntentStatus.INTENT_CREATED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        retryCount: 0,
        linkedPositionId: p.id
    };

    await persistOrderIntent(intent);

    try {
        await updateIntentStatus(slClientOrderId, IntentStatus.SUBMITTED);
        const slRes = await exchange.updateStopLossOrder(p.symbol, intent.side, formattedSLSize, formattedSL);
        if (slRes && slRes.id) {
            await updateIntentStatus(slClientOrderId, IntentStatus.FILLED); // For SL confirmed means the TRIGGER order is active
            console.log(`[NATIVE_SL_CONFIRMED] Position ${p.symbol} protected. SL Order ID: ${slRes.id}`);
            
            if (state.positionLedger && state.positionLedger[p.id]) {
                state.positionLedger[p.id].nativeStopLossOrderId = slRes.id;
                await saveState();
            }
            return true;
        } else {
            throw new Error("Rejected by broker");
        }
    } catch (e: any) {
        console.error(`[NATIVE_SL_FAILED] EMERGENCY! Position ${p.symbol} is NOT protected:`, e.message);
        await updateIntentStatus(slClientOrderId, IntentStatus.FAILED, e.message);
        // Mark as emergency
        if (state.positionLedger && state.positionLedger[p.id]) {
            state.positionLedger[p.id].status = "EMERGENCY_UNPROTECTED";
            await saveState();
        }
        return false;
    }
}

async function reconcilePendingIntents() {
    if (!state.orderIntents || !exchange) return;

    for (const [clientOrderId, intent] of Object.entries(state.orderIntents)) {
        if (intent.status === IntentStatus.SUBMITTED || intent.status === IntentStatus.UNKNOWN_TIMEOUT) {
            console.log(`[ORDER_RECONCILIATION_STARTED] Checking status for pending intent: ${clientOrderId}`);
            try {
                const order = await exchange.fetchOrder(clientOrderId, intent.symbol);
                if (order && order.status === 'closed') {
                    if (order.filled > 0) {
                        await updateIntentStatus(clientOrderId, IntentStatus.FILLED);
                        // Fills will be picked up by the loopTick sync or we could trigger it here
                    } else {
                        await updateIntentStatus(clientOrderId, IntentStatus.CANCELED);
                    }
                    console.log(`[ORDER_RECONCILED_BY_CLIENT_ID] ${clientOrderId} reconciled as ${intent.status}`);
                } else if (order && order.status === 'open') {
                    await updateIntentStatus(clientOrderId, IntentStatus.ACKNOWLEDGED);
                } else if (!order || order.status === 'canceled') {
                     await updateIntentStatus(clientOrderId, IntentStatus.CANCELED);
                }
            } catch (e: any) {
                console.error(`[RECONCILIATION_FAILED] Could not reconcile ${clientOrderId}:`, e.message);
                await updateIntentStatus(clientOrderId, IntentStatus.MANUAL_REVIEW_REQUIRED, e.message);
            }
        }
    }
}

// Promise to ensure we only load state once and can await it
let initialStateLoaded = false;
let loadStatePromise: Promise<void> | null = null;
let loadAttempts = 0;

// Utility to wrap a promise with a timeout to prevent infinite hanging and memory leaks
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string = 'Operation'): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms. Please check network or quotas.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function loadInitialState(): Promise<void> {
  if (initialStateLoaded) return;
  if (!db) {
    console.warn("DB not initialized, skipping initial state load");
    initialStateLoaded = true;
    return;
  }
  try {
    const snapshot = await withTimeout(getDoc(doc(db, 'bot_state', STATE_DOC_ID)), 8000, 'Firebase getDoc') as any;
    if (snapshot.exists()) {
      const saved = snapshot.data();
      state = { ...state, ...saved, botSecret: BOT_SECRET };
      simulatedPositions = state.openPositions || [];
      console.log(`[STATE_RESTORED_FROM_FIREBASE] Extracted full snapshot from DB`);
      if (simulatedPositions.length > 0) {
          console.log(`[POSITION_STATE_REHYDRATED] Recovered ${simulatedPositions.length} active positions.`);
          console.log(`[MFE_MAE_RESTORED] Active watermarks aligned.`);
          console.log(`[BARS_HELD_RESTORED] Time decay constraints aligned.`);
      }
      console.log(`[RESTART_RECOVERY_OK] Initialization complete.`);
      if (!state.maxHistoricalEquity) state.maxHistoricalEquity = state.baseBalance || 10000;
      initialStateLoaded = true;
    } else {
      console.log("No cloud state found, starting fresh.");
      initialStateLoaded = true;
    }
  } catch (e: any) {
    console.error("Failed to load initial state from Firestore:", e.message);
    if (e.message?.includes('client is offline') || e.message?.includes('timed out')) {
       console.warn("[Memory Fallback] Firestore client unavailable due to serverless sleep state. Using in-memory bot state.");
       initialStateLoaded = true;
       return; // Do not throw, keep engine running with RAM state
    } else if (e.message?.includes('does not exist for project')) {
       console.warn("[DB Error] Database does not exist. Using in-memory bot state.");
       db = null;
       initialStateLoaded = true;
       return;
    } else if (e.message?.includes('Missing or insufficient permissions')) {
       const errInfo = {
          error: e.message,
          operationType: 'get',
          path: 'bot_state/live',
          authInfo: {
            userId: null,
            email: null,
            emailVerified: null,
            isAnonymous: null,
            tenantId: null,
            providerInfo: []
          }
        };
        throw new Error(JSON.stringify(errInfo));
    }
    loadAttempts++;
    if (loadAttempts >= 3) {
       initialStateLoaded = true; // Give up after 3 tries
    }
    throw e; // Propagate only if it's an unrecognized fatal error
  }
}

// Start loading immediately in the background
loadStatePromise = loadInitialState().then(() => {
    if (state.isActive) startTickerDaemon();
}).catch(() => { loadStatePromise = null; });

let quotaExceededContext = false;

export async function saveState() {
  if (!db || quotaExceededContext) return;
  let dataToSave: any = {};
  try {
    const rawData = { ...state, botSecret: BOT_SECRET };
    // Firestore throws error on 'undefined', JSON stringify drops undefined automatically
    dataToSave = JSON.parse(JSON.stringify(rawData));
    await withTimeout(setDoc(doc(db, 'bot_state', STATE_DOC_ID), dataToSave), 8000, 'Firebase setDoc');
  } catch (e: any) {
    const errMsg = e.message || String(e);
    if (errMsg.includes('does not exist for project')) {
      console.warn("[DB Error] Database does not exist. Disabling DB persistence.");
      db = null;
      quotaExceededContext = true;
    } else if (errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('Quota') || errMsg.includes('quota limits') || errMsg.includes('timed out after')) {
      // If we confirm it's quota exhaustion, stop further DB writes for this session
      if (errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('Quota')) {
         console.warn("[Quota Monitor] Firebase daily write quota exceeded! Pausing DB persistence. Trade state will continue to execute locally in memory.");
         quotaExceededContext = true;
      }
      // Suppress spamming on timed out writes
    } else {
      console.error("Failed to save state to Firestore (Permissions or quota)", errMsg);
      if (errMsg.includes('Missing or insufficient permissions')) {
        console.error("DUMPING FAILED PAYLOAD:", JSON.stringify(dataToSave).substring(0, 500) + '...');
        const errInfo = {
          error: errMsg,
          operationType: 'write',
          path: 'bot_state/live',
          authInfo: {
            userId: null,
            email: null,
            emailVerified: null,
            isAnonymous: null,
            tenantId: null,
            providerInfo: []
          }
        };
        throw new Error(JSON.stringify(errInfo));
      }
    }
  }
}

const TARGET_SYMBOLS = ['BTC/USD:USD', 'ETH/USD:USD', 'SOL/USD:USD', 'XRP/USD:USD', 'LINK/USD:USD', 'DOGE/USD:USD'];

import { DerivativesClient } from '@siebly/kraken-api';

class MockCcxtNetworkError extends Error {}
class MockCcxtExchangeError extends Error {}

class KrakenExchangeAdapter {
    private client: DerivativesClient;
    public markets: Record<string, any> = {};
    private lastTradesFetch: number = 0;
    private recentTradesCache: any[] | null = null;

    constructor(config: { apiKey?: string, secret?: string }) {
       this.client = new DerivativesClient({
           apiKey: config.apiKey,
           apiSecret: config.secret,
           strictParamValidation: true,
           testnet: process.env.KRAKEN_SANDBOX === 'true'
       });
       TARGET_SYMBOLS.forEach(s => this.markets[s] = true);
    }

    setSandboxMode(isSandbox: boolean) {
        this.client = new DerivativesClient({
            apiKey: process.env.KRAKEN_API_KEY,
            apiSecret: process.env.KRAKEN_SECRET_KEY,
            strictParamValidation: true,
            testnet: isSandbox
        });
    }

    async loadMarkets() {
        this.markets = {};
        
        try {
            const data = await this.client.getInstruments();
            if (data && data.instruments) {
                for (const symbol of TARGET_SYMBOLS) {
                    const reqSym = this.symbolToNative(symbol);
                    const inst = data.instruments.find((x: any) => x.symbol === reqSym);
                    if (inst) {
                        const fallbackMin = symbol.includes('BTC') ? 0.0001 : symbol.includes('ETH') ? 0.001 : symbol.includes('SOL') ? 0.01 : symbol.includes('LINK') ? 0.1 : 1;
                        this.markets[symbol] = {
                             limits: { amount: { min: fallbackMin }, cost: { min: 2.0 } },
                             precision: { amount: inst.contractValueTradePrecision || 3 }
                        };
                        console.log(`[Adapter] Configured ${symbol} market:`, this.markets[symbol]);
                    }
                }
            }
        } catch(e: any) {
            console.warn(`[Adapter] Failed dynamic getInstruments, using hardcoded fallback: ${e.message}`);
        }

        // Fallback limits per symbol based on common Kraken Futures values if missing
        TARGET_SYMBOLS.forEach(s => {
            if (!this.markets[s]) {
                const fbMin = s.includes('BTC') ? 0.0001 : s.includes('ETH') ? 0.001 : s.includes('SOL') ? 0.01 : s.includes('LINK') ? 0.1 : 1;
                this.markets[s] = {
                    limits: { amount: { min: fbMin }, cost: { min: 2.0 } },
                    precision: { amount: s.includes('BTC') ? 4 : s.includes('ETH') ? 3 : s.includes('SOL') ? 2 : s.includes('LINK') ? 1 : 0 }
                };
            }
        });
        return this.markets;
    }

    private symbolToNative(symbol: string) {
        let isInverse = symbol.endsWith('_PI');
        let cleanSym = symbol.replace('_PI', '');
        let base = cleanSym.split('/')[0];
        let quote = 'USD';
        if (cleanSym.includes('EUR')) quote = 'EUR';
        if (base === 'BTC') base = 'XBT';
        
        return `${isInverse ? 'PI_' : 'PF_'}${base}${quote}`;
    }

    private nativeToSymbol(native: string) {
        let isInverse = native.startsWith('PI_');
        let clean = native.replace(/^PF_/, '').replace(/^PI_/, '').replace(/^FI_/, '');
        let quote = 'USD';
        
        if (clean.endsWith('USD')) {
            clean = clean.replace(/USD$/, '');
        } else if (clean.endsWith('EUR')) {
            clean = clean.replace(/EUR$/, '');
            quote = 'EUR';
        }
        
        if (clean === 'XBT') clean = 'BTC';
        return `${clean}/${quote}:${quote}${isInverse ? '_PI' : ''}`;
    }

    async fetchTicker(symbol: string) {
        const { tickers } = await this.client.getTickers();
        const nativeSymbol = this.symbolToNative(symbol);
        const t = tickers?.find((x: any) => x.symbol === nativeSymbol);
        if (!t) throw new MockCcxtExchangeError(`Ticker not found for ${symbol}`);
        return { symbol, last: t.last, bid: t.bid, ask: t.ask };
    }

    async fetchTickers(symbols: string[]) {
        const { tickers } = await this.client.getTickers();
        let res: Record<string, any> = {};
        for (const s of symbols) {
            const nativeSymbol = this.symbolToNative(s);
            const t = tickers?.find((x: any) => x.symbol === nativeSymbol);
            if (t) res[s] = { symbol: s, last: t.last, bid: t.bid, ask: t.ask };
        }
        return res;
    }

    async fetchOHLCV(symbol: string, timeframe: string, since?: number, limit: number = 300) {
        const res = await this.client.getCandles({
            tickType: 'trade', 
            symbol: this.symbolToNative(symbol),
            resolution: timeframe as any
        });
        let arr = res.candles.map((c: any) => [
            c.time, parseFloat(c.open), parseFloat(c.high), parseFloat(c.low), parseFloat(c.close), parseFloat(c.volume)
        ]);
        return arr.slice(-limit);
    }

    async createLimitOrder(symbol: string, side: string, amount: number, price: number, params: any = {}) {
        const { price: formattedPrice, size: formattedSize } = formatPriceAndSize(symbol, price, amount);
        const payload: any = {
            symbol: this.symbolToNative(symbol),
            side: side as 'buy' | 'sell',
            size: formattedSize,
            orderType: 'lmt',
            limitPrice: formattedPrice,
            reduceOnly: params.reduceOnly
        };
        if (params.clientOrderId) {
            payload.cliOrdId = params.clientOrderId;
        }
        const res = await this.client.submitOrder(payload);
        const status = res.sendStatus?.status;
        if (status && !['placed', 'partiallyFilled', 'fullyFilled', 'untouched'].includes(status)) {
             throw new MockCcxtExchangeError(`Kraken rejected order: ${status}`);
        }
        const returnedId = res.sendStatus?.order_id || (res.sendStatus as any)?.orderEvents?.[0]?.order?.orderId;
        if (returnedId) {
            return { id: returnedId, clientOrderId: params.clientOrderId };
        } else {
            throw new MockCcxtExchangeError("Failed to parse order ID from response");
        }
    }

    async ensureIsolatedLeverage(symbol: string, desiredLeverage: number) {
        console.log(`[LEVERAGE_SET_INTENT] Setting leverage to ${desiredLeverage}x for ${symbol}`);
        try {
            const symbolNative = this.symbolToNative(symbol);
            
            // Check if contract is compatible
            const instruments = await this.client.getInstruments();
            const inst = instruments.instruments.find((x: any) => x.symbol === symbolNative);
            if (!inst) throw new Error(`Symbol ${symbol} not found on Kraken Futures`);

            // This is optional for Multi-Collateral accounts, so failure shouldn't block trading
            const res = await this.client.setLeverageSettings({
                symbol: symbolNative,
                maxLeverage: desiredLeverage
            });

            if (res.result === 'success') {
                console.log(`[ISOLATED_MARGIN_CONFIRMED] Leverage set to ${desiredLeverage}x for ${symbol}`);
                return true;
            }
            throw new Error((res as any).error || "Unknown error setting leverage");
        } catch (e: any) {
            const apiErrorMsg = e.body?.error || e.message || String(e);
            console.warn(`[LEVERAGE_SET_FAILED] Leverage endpoint failed (${apiErrorMsg}). Using account default (Cross Margin). Risk: MEDIUM.`);
            return true; // We continue but with warning
        }
    }

    async updateStopLossOrder(symbol: string, side: string, amount: number, triggerPrice: number, existingOrderId?: string): Promise<{ id: string }> {
        const { price: formattedPrice, size: formattedSize } = formatPriceAndSize(symbol, triggerPrice, amount);
        
        if (existingOrderId) {
             const editRes = await this.client.editOrder({
                 orderId: existingOrderId,
                 stopPrice: formattedPrice,
                 size: formattedSize
             });
             const editReturnedId = editRes.editStatus?.orderId;
             if (editReturnedId || editRes.editStatus?.status === 'edited') {
                 return { id: existingOrderId };
             }
             // If edit fails or returns bad status, we might want to fallback but for now we just proceed to submit a new one or throw
             // We'll throw so it can be retried or handled.
             throw new Error(`Failed to edit SL order: ${JSON.stringify(editRes.editStatus)}`);
        }

        // Kraken Futures: Use 'stp' (Stop) order type
        const payload: any = {
            symbol: this.symbolToNative(symbol),
            side: side as 'buy' | 'sell',
            size: formattedSize,
            orderType: 'stp',
            stopPrice: formattedPrice,
            triggerSignal: 'mark',
            reduceOnly: true
        };
        const res = await this.client.submitOrder(payload);
        const status = res.sendStatus?.status;
        if (status && !['placed', 'partiallyFilled', 'fullyFilled', 'untouched'].includes(status)) {
             throw new Error(`Kraken rejected SL order: ${status}`);
        }
        const returnedId = res.sendStatus?.order_id || (res.sendStatus as any)?.orderEvents?.[0]?.order?.orderId;
        if (returnedId) {
            return { id: returnedId };
        } else {
            throw new Error("Failed to parse SL order ID");
        }
    }

    async createMarketOrder(symbol: string, side: string, amount: number, price?: number, params: any = {}) {
        const { size } = formatPriceAndSize(symbol, 0, amount);
        const payload: any = {
            symbol: this.symbolToNative(symbol),
            side: side as 'buy' | 'sell',
            size: size,
            orderType: 'mkt',
            reduceOnly: params.reduceOnly
        };
        if (params.clientOrderId) {
            payload.cliOrdId = params.clientOrderId; // Pass idempotency key
        }
        const res = await this.client.submitOrder(payload);
        const status = res.sendStatus?.status;
        if (status && !['placed', 'partiallyFilled', 'fullyFilled', 'untouched'].includes(status)) {
             throw new MockCcxtExchangeError(`Kraken rejected order: ${status}`);
        }
        const returnedId = res.sendStatus?.order_id || (res.sendStatus as any)?.orderEvents?.[0]?.order?.orderId;
        if (returnedId) {
            return { id: returnedId, clientOrderId: params.clientOrderId };
        } else {
            throw new MockCcxtExchangeError("Failed to parse order ID from response");
        }
    }

    async fetchOrder(id: string, symbol: string) {
        try {
            // Check execution history via getFills
            let fetchedFills;
            
            // Wait a brief moment to allow execution to flow into fills
            await new Promise(r => setTimeout(r, 700));

            try {
                const res = await this.client.getFills();
                fetchedFills = res.fills || [];
            } catch (e) {
                fetchedFills = [];
            }

            const matchedFills = fetchedFills.filter((f: any) => f.order_id === id || f.cliOrdId === id);
            
            if (matchedFills.length > 0) {
                 const totalFilled = matchedFills.reduce((acc: number, f: any) => acc + parseFloat(f.size), 0);
                 const avgPrice = matchedFills.reduce((acc: number, f: any) => acc + (parseFloat(f.price) * parseFloat(f.size)), 0) / (totalFilled || 1);
                 return {
                     id,
                     status: 'closed', // Since it's filled
                     amount: totalFilled,
                     filled: totalFilled,
                     average: avgPrice,
                     fee: null
                 };
            }
            
            // Check open orders
            try {
               const openRes = await this.client.getOpenOrders();
               const openOrders = openRes.openOrders || [];
               const isPending = openOrders.some((o: any) => o.order_id === id || o.cliOrdId === id);
               
               if (isPending) {
                    return {
                        id,
                        status: 'open',
                        amount: null,
                        filled: 0,
                        average: null,
                        fee: null
                    };
               }
            } catch (e) {}

            return { 
               id, 
               status: 'closed', // Safe fallback if not found in open or fills for market orders
               amount: null, 
               filled: null, 
               average: null, 
               fee: null 
            };
        } catch (e: any) {
             console.warn(`[Adapter] safe fallback fetchOrder for ${id} failed:`, e.message);
             return { id, status: 'closed', amount: null, filled: null, average: null, fee: null };
        }
    }

    async fetchPositions(retryCount = 0): Promise<any[]> {
        try {
            const { openPositions } = await ccxtWithRetry(() => this.client.getOpenPositions(), 2, 500);
            const { tickers } = await ccxtWithRetry(() => this.client.getTickers(), 2, 500);
            
            return (openPositions || []).map((p: any) => {
                const nativeSymbol = p.symbol;
                const ticker = tickers?.find((t: any) => t.symbol === nativeSymbol);
                const markPrice = ticker?.markPrice || p.price;
                
                // If unrealizedPnl is not directly in the position object, calculate it
                let pnl = p.unrealizedPnl;
                if (pnl === undefined && ticker?.markPrice) {
                    if (p.side === 'long') {
                        pnl = (ticker.markPrice - p.price) * p.size;
                    } else {
                        pnl = (p.price - ticker.markPrice) * p.size;
                    }
                }

                return {
                    symbol: this.nativeToSymbol(p.symbol),
                    contracts: p.side === 'short' ? -p.size : p.size,
                    entryPrice: p.price,
                    leverage: p.maxFixedLeverage || 1,
                    unrealizedPnl: pnl || 0,
                    markPrice: ticker?.markPrice || null
                };
            });
        } catch (e: any) {
            if (retryCount < 3 && e.message.includes('Service Unavailable')) {
                console.warn(`[Adapter] fetchPositions transient 503, retrying (${retryCount + 1}/3)...`);
                await new Promise(r => setTimeout(r, 1000 * (retryCount + 1))); // Simple backoff
                return this.fetchPositions(retryCount + 1);
            }
            console.error(`[Adapter] fetchPositions failed: ${e.message}`);
            throw e;
        }
    }

    async fetchRecentTrades(retryCount = 0): Promise<any> {
        const now = Date.now();
        if (this.recentTradesCache && now - this.lastTradesFetch < 60000 && retryCount === 0) {
            return this.recentTradesCache;
        }

        try {
            const [logsRes, fillsRes] = await Promise.all([
                ccxtWithRetry(() => this.client.getAccountLog(), 2, 500),
                ccxtWithRetry(() => this.client.getFills(), 2, 500)
            ]);
            
            const logs = logsRes?.logs || [];
            const fills = fillsRes?.fills || [];
            
            const trades: any[] = [];
            
            for (const log of logs) {
                if (log.info === 'futures trade' && log.realized_pnl !== null && log.realized_pnl !== 0) {
                    const fill = fills.find((f: any) => f.fill_id === log.execution);
                    if (fill) {
                        const symbol = this.nativeToSymbol(fill.symbol);
                        const isExitLong = fill.side === 'sell'; // If we sold to realize PNL, we were LONG.
                        
                        trades.push({
                            symbol,
                            side: isExitLong ? 'LONG' : 'SHORT',
                            entry: null, // We don't have the original entry easily from this endpoint, but we can set exit
                            exit: fill.price,
                            pnl: log.realized_pnl, // Note: For crypto collateral, this is in crypto! For USD flex, if collateral is USD it's in USD. If it is in XBT, we might need to convert it, but let's just pass it.
                            reason: 'KRAKEN_SYNC',
                            time: log.date
                        });
                    }
                }
            }
            // Sort descending by time
            trades.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
            
            this.lastTradesFetch = now;
            this.recentTradesCache = trades;
            
            return trades;
        } catch (e: any) {
             if (retryCount < 3 && e.message.includes('Service Unavailable')) {
                 console.warn(`[Adapter] fetchRecentTrades transient 503, retrying (${retryCount + 1}/3)...`);
                 await new Promise(r => setTimeout(r, 1000 * (retryCount + 1))); // Simple backoff
                 return this.fetchRecentTrades(retryCount + 1);
             }
             console.warn(`[Adapter] Failed to fetch recent trades: ${e.message}`);
             return null;
        }
    }

    async fetchMarginBalance(): Promise<number | null> {
        if (!state.krakenStatus) state.krakenStatus = { connected: true, balanceSync: false };
        try {
            const res = await ccxtWithRetry(() => this.client.getAccounts(), 2, 1000);
            
            if (res.accounts) {
                state.krakenStatus.connected = true;
                state.krakenStatus.balanceSync = true;
                state.krakenStatus.lastError = undefined;

                let totalFlexValue = 0;
                let totalMarginValue = 0;
                let totalCashValue = 0;
                state.marginUsed = 0;

                // 1) Flex Account
                if (res.accounts['flex'] && (res.accounts['flex'] as any).type === 'multiCollateralMarginAccount') {
                    state.marginUsed += (res.accounts['flex'] as any).initialMargin || 0;
                    totalFlexValue = (res.accounts['flex'] as any).portfolioValue || 0;
                }
                
                // 2) Single-Collateral Margin Accounts
                const marginAccs = Object.values(res.accounts).filter((a: any) => a.type === 'marginAccount') as any[];
                for (const acc of marginAccs) {
                    const cur = acc.currency || 'usd';
                    let val = 0;
                    if (acc.balances && acc.balances[cur]) val += parseFloat(acc.balances[cur]);
                    if (acc.auxiliary && acc.auxiliary.pnl) val += parseFloat(acc.auxiliary.pnl);
                    totalMarginValue += val;
                    state.marginUsed += (acc.auxiliary?.margin || 0);
                }

                // 3) Cash Account
                const cashAcc = res.accounts['cash'];
                if (cashAcc && cashAcc.balances) {
                    for (const [currency, amount] of Object.entries((cashAcc as any).balances)) {
                        const v = parseFloat(amount as string) || 0;
                        if (v > 0) {
                           if (['usd', 'usdt', 'usdc'].includes(currency.toLowerCase())) {
                               totalCashValue += v;
                           } else if (currency.toLowerCase() === 'eur') {
                               totalCashValue += v * 1.08; // Rough EUR/USD fallback
                           }
                        }
                    }
                }

                const totalVal = totalFlexValue + totalMarginValue + totalCashValue;
                console.log(`[Adapter] Balances -> Flex: ${totalFlexValue}, Margin: ${totalMarginValue}, Cash: ${totalCashValue}. Total: ${totalVal}`);

                if (totalVal > 0 || marginAccs.length > 0 || res.accounts['flex'] || res.accounts['cash']) {
                    return totalVal;
                }
            }
            state.krakenStatus.balanceSync = false;
            console.warn("[Adapter] fetchMarginBalance missing valid account structure");
            return null;
        } catch (e: any) {
            state.krakenStatus.connected = false;
            state.krakenStatus.balanceSync = false;
            state.krakenStatus.lastError = "Margin Fetch Error: " + e.message;
            console.error(`[Adapter] Failed to fetch Kraken Margin Balance: ${e.message}`);
            return null;
        }
    }

    amountToPrecision(symbol: string, amount: number): string {
        const market = this.markets[symbol];
        if (market && market.precision && market.precision.amount !== undefined) {
             return amount.toFixed(market.precision.amount);
        }
        return Math.round(amount).toString();
    }
}

export async function initExchange() {
  if (exchange) return;

  // Load real expectancy matrix from backtest
  if (!expectancyMatrixLoaded) {
    try {
        if (fs.existsSync(path.join(process.cwd(), 'backtest_report_latest.json'))) {
            const report = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'backtest_report_latest.json'), 'utf8'));
            if (report.expectancyMatrix) {
                console.log("[INIT] Successfully loaded real expectancy matrix from backtest report.");
                ExpectancyTracker.loadMatrix(report.expectancyMatrix);
            } else {
                throw new Error("Missing expectancyMatrix in report");
            }
        } else {
            throw new Error("backtest_report_latest.json not found");
        }
    } catch (e: any) {
        console.error(`[INIT] Warning: Could not load real expectancy matrix (${e.message}). Falling back to DEFAULT_NEUTRAL_MATRIX (Proxy)...`);
        const DEFAULT_NEUTRAL_MATRIX = new Proxy({}, {
            get: function(target, prop) {
                return {
                    expectancy: 0.1,
                    profitFactor: 1.25,
                    sampleSize: 100,
                    trades: 100
                };
            }
        });
        ExpectancyTracker.loadMatrix(DEFAULT_NEUTRAL_MATRIX);
    }
    expectancyMatrixLoaded = true;
  }

  // Initialize Kraken Futures connection for live market data
  exchange = new KrakenExchangeAdapter({
    apiKey: process.env.KRAKEN_API_KEY,
    secret: process.env.KRAKEN_SECRET_KEY
  });
  if (process.env.KRAKEN_SANDBOX === 'true') {
    console.log("TEST ENVIRONMENT: Enabling Kraken Sandbox mode");
    exchange.setSandboxMode(true);
  } else {
    console.log("WARNING: KRAKEN_SANDBOX is false. Connecting to REAL LIVE ENVIRONMENT!");
  }
  try {
      await ccxtWithRetry(() => exchange.loadMarkets());
  } catch (e: any) {
      console.warn("Could not preload markets in initExchange, parsing sizes may vary.", e.message);
  }
}

function delaySleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function ccxtWithRetry<T>(fn: () => Promise<T>, retries = 6, delay = 2000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await withTimeout(fn(), 30000, 'CCXT API Call');
    } catch (error: any) {
      if (i === retries - 1) throw error;
      
      const errMsg = error?.body?.error || error?.message || String(error);
      const isTransient = 
        error instanceof ccxt.NetworkError || 
        (error instanceof ccxt.ExchangeError && !errMsg.toLowerCase().includes('invalid') && !errMsg.toLowerCase().includes('balance') && !errMsg.toLowerCase().includes('margin') && !errMsg.toLowerCase().includes('position')) || 
        errMsg.includes('Rate limit exceeded') ||
        errMsg.includes('timeout') ||
        errMsg.includes('network') ||
        errMsg.includes('ECONNRESET') ||
        errMsg.includes('502') ||
        errMsg.includes('503') ||
        errMsg.includes('Service Unavailable') ||
        error?.code === 429 ||
        error?.code === 502 ||
        error?.code === 503 ||
        error?.code === 500;
      
      if (isTransient) {
        // Suppress Service Unavailable spam as Kraken Sandbox drops frequently
        if (errMsg.includes('Service Unavailable') || errMsg.includes('Rate limit') || errMsg.includes('503')) {
            if (i > 1) {
                console.log(`[Kraken Sync] API 503/Rate-limited. Waiting ${delay}ms before retry ${i + 1}/${retries}...`);
            }
        } else {
            if (i > 0) {
                console.warn(`[Retry ${i + 1}/${retries}] API Transient Update: ${errMsg}. Retrying in ${delay}ms...`);
            }
        }
        await delaySleep(delay);
        delay = Math.min(delay * 1.5, 10000); // capped exponential backoff
      } else {
        throw error;
      }
    }
  }
  throw new Error("Unreachable");
}

export async function getLiveState(): Promise<LiveState> {
  if (!initialStateLoaded) {
    if (!loadStatePromise) loadStatePromise = loadInitialState().catch(e => { loadStatePromise = null; throw e; });
    await loadStatePromise;
  }
  return state;
}

let isTicking = false;
let tickConsecutiveFailures = 0;
let daemonInterval: NodeJS.Timeout | null = null;
let ohlcvDaemonInterval: NodeJS.Timeout | null = null;
const exitCooldowns: Record<string, number> = {};

async function runOhlcvSyncDaemon() {
    if (!exchange || !state.isActive) return;
    
    // Background cache updater
    const nowMs = Date.now();
    const symbols = Array.from(new Set(['BTC/USD:USD', ...TARGET_SYMBOLS]));
    
    for (const symbol of symbols) {
         if (!state.isActive) break;
         
         if (!liveDataCache[symbol]) {
             // Precompute will be handled by init or background
             continue;
         }
         
         try {
             let needs1H = false;
             let needs4H = false;
             
             const last1H = liveDataCache[symbol].bars1H[liveDataCache[symbol].bars1H.length - 1];
             if (!last1H || nowMs >= new Date(last1H.t).getTime() + 3600 * 1000) needs1H = true;

             const last4H = liveDataCache[symbol].bars4H[liveDataCache[symbol].bars4H.length - 1];
             if (!last4H || nowMs >= new Date(last4H.t).getTime() + 4 * 3600 * 1000) needs4H = true;

             if (needs1H || needs4H) console.log(`[OHLCV DAEMON] Syncing ${symbol} in background...`);
             
             if (needs1H) {
                 const sOHLCV1H = await ccxtWithRetry(() => exchange!.fetchOHLCV(symbol, '1h', undefined, 5));
                 if (sOHLCV1H && (sOHLCV1H as any[]).length > 0) {
                     liveDataCache[symbol].bars1H = mergeOHLCV(liveDataCache[symbol].bars1H, processOHLCV(sOHLCV1H as any[])).slice(-400);
                 }
                 await delaySleep(300);
             }
             if (needs4H) {
                 const sOHLCV4H = await ccxtWithRetry(() => exchange!.fetchOHLCV(symbol, '4h', undefined, 5));
                 if (sOHLCV4H && (sOHLCV4H as any[]).length > 0) {
                     liveDataCache[symbol].bars4H = mergeOHLCV(liveDataCache[symbol].bars4H, processOHLCV(sOHLCV4H as any[])).slice(-400);
                 }
                 await delaySleep(300);
             }
         } catch(e: any) {
             console.error(`[OHLCV DAEMON] Failed background sync for ${symbol}: ${e.message}`);
         }
    }
}

// Start the continuous background loop
export function startTickerDaemon() {
    if (daemonInterval) return; // Already running
    console.log("[DAEMON] Starting background tick logic");
    daemonInterval = setInterval(async () => {
        if (!state.isActive) return;
        
        if (!initialStateLoaded) {
            if (!loadStatePromise) loadStatePromise = loadInitialState().catch(e => { loadStatePromise = null; throw e; });
            await loadStatePromise;
        }
        
        await initExchange();
        await loopTick();
    }, 7500); // Check every 7.5s 
    
    if (!ohlcvDaemonInterval) {
        // Run sync loop every minute roughly
        ohlcvDaemonInterval = setInterval(() => runOhlcvSyncDaemon(), 60000); 
    }
}

// We export an explicit cron trigger so third party pingers (cron-job.org) can force ticks
// even if CPU was suspended and setInterval was dropped
export async function triggerCronTick() {
  if (!initialStateLoaded) {
    if (!loadStatePromise) loadStatePromise = loadInitialState().catch(e => { loadStatePromise = null; throw e; });
    await loadStatePromise;
  }
  
  if (state.isActive) {
    await initExchange(); // Auto-reconnect if dropped out of memory
    await loopTick();
    await saveState();
  }
  return state;
}

export async function startPaperTrading() {
  if (!initialStateLoaded) {
    if (!loadStatePromise) loadStatePromise = loadInitialState().catch(e => { loadStatePromise = null; throw e; });
    await loadStatePromise;
  }
  
  if (state.isActive) return state;

  state.status = 'INITIALIZING';
  state.lastUpdate = new Date().toISOString();

  try {
    await initExchange();

    // Verify connection by pulling read-only data instead of account logic
    await exchange!.fetchTicker('BTC/USD:USD');
    
    state.isActive = true;
    state.status = 'WARMING_UP';
    state.startTime = state.startTime || new Date().toISOString();
    state.warmupUntil = Date.now() + (5 * 60 * 1000); // 5 minutes warm-up buffer
    state.lastError = undefined;
    state.lastUpdate = new Date().toISOString();
    
    // Set initialBalance on first start if not already set
    if (state.initialBalance === undefined || state.initialBalance === 10000) {
      if (exchange) {
        try {
          const mb = await exchange.fetchMarginBalance();
          if (mb !== null) {
            state.initialBalance = mb;
            state.balance = mb;
            state.baseBalance = mb;
            console.log(`[INITIAL_BALANCE_SYNC] Set starting capital to Kraken margin: $${mb}`);
          }
        } catch(e) {}
      }
      if (state.initialBalance === undefined) state.initialBalance = state.balance || 10000;
    }

    startTickerDaemon();
    
    // Only clear simulated positions if they don't already exist from a resume
    if (simulatedPositions.length === 0) {
       simulatedPositions = state.openPositions || [];
    }

    if (!state.maxHistoricalEquity) state.maxHistoricalEquity = state.baseBalance || 10000;

    // Initialize history with current balance to avoid 0% metrics on first start
    if (!state.equityHistory || state.equityHistory.length === 0) {
      const initialEntry = { time: new Date().toISOString(), equity: state.balance || 10000 };
      state.equityHistory = [initialEntry];
      state.metricsHistory = [calculateSnapshot({ ...state, equityHistory: [initialEntry] } as any)];
    }

    await precomputeLiveOHLCV();

    // Serverless-hardened: We no longer run background setTimeouts.
    // The engine state is strictly driven by incoming pings (Dashboard or Cron).
    await loopTick();
    await saveState();

  } catch (error: any) {
    state.status = 'ERROR';
    state.lastError = error.message;
    state.isActive = false;
    await saveState();
    throw error;
  }

  return state;
}

export function stopTickerDaemon() {
    if (daemonInterval) {
        clearInterval(daemonInterval);
        daemonInterval = null;
        console.log("[DAEMON] Stopped background tick logic");
    }
}

export async function stopPaperTrading() {
  if (!initialStateLoaded) {
    if (!loadStatePromise) loadStatePromise = loadInitialState().catch(e => { loadStatePromise = null; throw e; });
    await loadStatePromise;
  }
  
  await initExchange();
  stopTickerDaemon();

  if (state.openPositions && state.openPositions.length > 0) {
    for (const p of state.openPositions) {
        if (process.env.LIVE_TRADING_ENABLED === 'true' && exchange) {
             const side = p.direction === 'LONG' ? 'sell' : 'buy';
             try {
                 console.log(`[LIVE EXECUTION] Sending ${side} exit order for ${p.symbol} on STOP...`);
                 await ccxtWithRetry(() => exchange.createMarketOrder(p.symbol, side, p.size, undefined, { reduceOnly: true }));
             } catch (e: any) {
                 console.error(`[LIVE EXECUTION] Failed to close ${p.symbol} on STOP:`, e.message);
             }
        }
    }
  }
  
  state.balance = state.baseBalance || 10000.00; // Reset balance to base value snapshot
  state.openPositions = [];
  simulatedPositions = [];
  
  state.isActive = false;
  state.status = 'STOPPED';
  state.warmupUntil = undefined;
  await saveState();
  return state;
}

export async function emergencyCloseAll() {
  console.error(`[EMERGENCY_KILL_SWITCH] Activating panic close for ALL live positions due to fatal desync!`);
  
  if (exchange && process.env.LIVE_TRADING_ENABLED === 'true') {
      try {
           if (exchange.client && exchange.client.cancelAllOrders) {
                await ccxtWithRetry(() => exchange.client.cancelAllOrders());
                console.error(`[EMERGENCY_KILL_SWITCH] Cleared all open orders.`);
           } else {
                // Try fetch and cancel fallback
                const openOrders: any = await exchange.client.getOpenOrders ? await ccxtWithRetry(() => exchange.client.getOpenOrders(), 2, 500) : { openOrders: [] };
                if (openOrders.openOrders) {
                    for (const o of openOrders.openOrders) {
                        try {
                            await ccxtWithRetry(() => exchange.client.cancelOrder({ order_id: o.order_id }));
                        } catch(e) {}
                    }
                    console.error(`[EMERGENCY_KILL_SWITCH] Cleared open orders via explicit loop.`);
                }
           }
      } catch (e: any) {
           console.error(`[EMERGENCY_KILL_SWITCH] Failed to clear open orders: ${e.message}`);
      }
      
      let livePos: any[] = [];
      try {
           livePos = await exchange.fetchPositions();
      } catch (e: any) {
           console.error(`[EMERGENCY_KILL_SWITCH] Failed to fetch live positions for drop: ${e.message}`);
      }
      
      for (const p of livePos) {
         if (Math.abs(p.contracts) > 0) {
             const side = p.contracts > 0 ? 'sell' : 'buy';
             try {
                 console.error(`[EMERGENCY_KILL_SWITCH] Force-dropping live broker position ${p.symbol} (${p.contracts})...`);
                 await ccxtWithRetry(() => exchange.createMarketOrder(p.symbol, side, Math.abs(p.contracts), undefined, { reduceOnly: true }));
                 console.error(`[EMERGENCY_KILL_SWITCH] Successfully dropped ${p.symbol}.`);
             } catch (e: any) {
                 console.error(`[EMERGENCY_KILL_SWITCH] Failed to drop broker pos ${p.symbol}: ${e.message}`);
             }
         }
      }
      
      for (const p of simulatedPositions) {
         try {
             const exPos = livePos.find((x: any) => x.symbol === p.symbol);
             if (!exPos || Math.abs(exPos.contracts) === 0) {
                 console.error(`[EMERGENCY_KILL_SWITCH] Dropping local-only orphan ${p.symbol} (no exchange call needed).`);
             }
         } catch (e: any) {}
      }
  }

  simulatedPositions = [];
  state.openPositions = [];
  console.error(`[EMERGENCY_KILL_SWITCH] COMPLETE. Portfolio is flat. Proceeding to hard stop.`);
}

export async function resetPaperTrading() {
  if (!initialStateLoaded) {
    if (!loadStatePromise) loadStatePromise = loadInitialState().catch(e => { loadStatePromise = null; throw e; });
    await loadStatePromise;
  }

  await initExchange();
  stopTickerDaemon();

  if (state.openPositions && state.openPositions.length > 0) {
    for (const p of state.openPositions) {
        if (process.env.LIVE_TRADING_ENABLED === 'true' && exchange) {
             const side = p.direction === 'LONG' ? 'sell' : 'buy';
             try {
                 console.log(`[LIVE EXECUTION] Sending ${side} exit order for ${p.symbol} on RESET...`);
                 await ccxtWithRetry(() => exchange.createMarketOrder(p.symbol, side, p.size, undefined, { reduceOnly: true }));
             } catch (e: any) {
                 console.error(`[LIVE EXECUTION] Failed to close ${p.symbol} on RESET:`, e.message);
             }
        }
    }
  }
  
  let startingCapital = 10000.00;
  if (exchange) {
      try {
          const realMargin = await exchange.fetchMarginBalance();
          if (realMargin !== null) {
              startingCapital = realMargin;
              console.log(`[RESET] Pulled real start capital $${startingCapital.toFixed(2)} from Kraken.`);
          }
      } catch(e) {}
  }
  
  state = {
    isActive: false,
    status: 'STOPPED',
    balance: startingCapital,
    baseBalance: startingCapital,
    initialBalance: startingCapital,
    openPositions: [],
    recentTrades: [],
    regime: 'UNKNOWN',
    regimes: {},
    lastUpdate: new Date().toISOString(),
    startTime: new Date().toISOString(),
    botSecret: BOT_SECRET,
    equityHistory: [],
    metricsHistory: [],
    maxHistoricalEquity: startingCapital,
    warmupUntil: undefined
  };
  
  simulatedPositions = [];
  isTicking = false;
  
  await saveState();
  return state;
}

let lastTickTime = 0;
const MIN_TICK_INTERVAL_MS = 7500;

// Simple utility for deep comparison of state parts
export function hashStateSnapshot() {
  return JSON.stringify({
    st: state.status,
    pos: state.openPositions?.length,
    eq: state.equityHistory?.length
  });
}

function processOHLCV(ccxtOhlcv: any[]): Bar[] {
    return ccxtOhlcv.map(c => ({
        t: new Date(c[0]).toISOString(),
        o: c[1],
        h: c[2],
        l: c[3],
        c: c[4],
        v: c[5]
    }));
}

interface CachedOHLCV {
  bars1H: Bar[];
  bars4H: Bar[];
}
const liveDataCache: Record<string, CachedOHLCV> = {};

function mergeOHLCV(existing: Bar[], incoming: Bar[]): Bar[] {
    const map = new Map<string, Bar>();
    for (const b of existing) map.set(b.t, b);
    for (const b of incoming) map.set(b.t, b);
    return Array.from(map.values()).sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

function filterClosedCandles(candles: Bar[], timeframe: string, nowMs: number): Bar[] {
    if (candles.length === 0) return candles;
    const last = candles[candles.length - 1];
    const lastTimeMs = new Date(last.t).getTime();
    
    let durationMs = 3600 * 1000;
    if (timeframe === '4h') durationMs = 4 * 3600 * 1000;

    if (nowMs < lastTimeMs + durationMs) {
        // Safe check for missing/incomplete closing tick
        console.log(`[CANDLE_DROPPED_INCOMPLETE] Dropping incomplete candle ${last.t}`);
        return candles.slice(0, -1);
    }
    return candles;
}

export function resolveOrderAmount(exchange: any, symbol: string, rawAmount: number, price: number) {
    let ok = true;
    let reason = "OK";
    let minAmount = 0;
    let minCost = 0;
    
    const market = exchange.markets ? exchange.markets[symbol] : null;
    if (market && market.limits) {
         if (market.limits.amount && market.limits.amount.min) minAmount = market.limits.amount.min;
         if (market.limits.cost && market.limits.cost.min) minCost = market.limits.cost.min;
    }

    if (rawAmount <= 0) {
        return { ok: false, amount: 0, reason: "Amount must be positive", rawAmount, precisionAmount: 0, minAmount, minCost };
    }

    let precisionAmountStr = exchange.amountToPrecision ? exchange.amountToPrecision(symbol, rawAmount) : rawAmount.toString();
    let precisionAmount = Number(precisionAmountStr);
    
    if (precisionAmount <= 0) {
        return { ok: false, amount: 0, reason: "Amount truncated to zero by precision", rawAmount, precisionAmount, minAmount, minCost };
    }

    if (minAmount > 0 && precisionAmount < minAmount) {
        ok = false; reason = `Amount ${precisionAmount} below min limits ${minAmount}`;
        return { ok, amount: precisionAmount, reason, rawAmount, precisionAmount, minAmount, minCost };
    }
    
    const notional = precisionAmount * price;
    if (minCost > 0 && notional < minCost) {
        ok = false; reason = `Notional ${notional} below min cost ${minCost}`;
        return { ok, amount: precisionAmount, reason, rawAmount, precisionAmount, minAmount, minCost };
    }

    return {
        ok, amount: precisionAmount, reason, rawAmount, precisionAmount, minAmount, minCost
    };
}

async function precomputeLiveOHLCV() {
    console.log("Precomputing OHLCV...");
    const symbolsToPreload = Array.from(new Set(['BTC/USD:USD', ...TARGET_SYMBOLS]));
    for (const symbol of symbolsToPreload) {
        if (liveDataCache[symbol]) continue; // Skip if already precomputed
        
        try {
            console.log(`Downloading ${symbol} [1H/4H]...`);
            const ohlcv1H = await ccxtWithRetry(() => exchange!.fetchOHLCV(symbol, '1h', undefined, 400));
            await delaySleep(500);
            const ohlcv4H = await ccxtWithRetry(() => exchange!.fetchOHLCV(symbol, '4h', undefined, 400));
            await delaySleep(500);
            liveDataCache[symbol] = {
                bars1H: processOHLCV(ohlcv1H as any[]),
                bars4H: processOHLCV(ohlcv4H as any[]),
            };
        } catch (e: any) {
            console.error(`Failed to precompute OHLCV for ${symbol}: ${e.message}`);
        }
    }
}

export async function loopTick() {
  const nowMs = Date.now();
  if (isTicking) {
      if (nowMs - lastTickTime > 120000) {
          console.warn("[DEADLOCK BREAKER] isTicking was true for >120s. Forcing unlock.");
          isTicking = false;
      } else {
          return;
      }
  }
  if (!exchange || !state.isActive) return;
  
  // Wait explicitly if we ticked recently to prevent loop overloads
  if (nowMs - lastTickTime < 5000) return;

  isTicking = true;
  lastTickTime = Date.now();
  
  const stateHashBefore = hashStateSnapshot();
  
  try {
    // P1: Reconcile any pending intents from a previous crash/restart
    await reconcilePendingIntents();

    state.lastUpdate = new Date().toISOString();
    
    // Load historical bars for the strategy formulation (9 layers need OHLCV, not just tickers)
    // To save Alpaca/CCXT rate limits, we pull OHLCV on-demand for standard operations.
    let globalFeatures: ReturnType<typeof MarketDataLayer.prepareFeatures> | null = null;
    let btc1H: Bar[] = [];
    let btc4H: Bar[] = [];

    let btcLivePrice = 0;

    // Arbitrarily use BTC as the Global Regime Anchor to save Rate Limits
    try {
        if (!liveDataCache['BTC/USD:USD']) {
            await precomputeLiveOHLCV();
        }
        
        if (!liveDataCache['BTC/USD:USD']) return; // abort tick if still failing

        btc1H = liveDataCache['BTC/USD:USD'].bars1H;
        btc4H = liveDataCache['BTC/USD:USD'].bars4H;
        
        const validBTC1H = filterClosedCandles(btc1H, '1h', nowMs);
        const validBTC4H = filterClosedCandles(btc4H, '4h', nowMs);
        
        let isGlobalH4Closed = false;
        if (validBTC1H.length > 0 && validBTC4H.length > 0) {
            const last1HTimeMs = new Date(validBTC1H[validBTC1H.length - 1].t).getTime();
            const last4HTimeMs = new Date(validBTC4H[validBTC4H.length - 1].t).getTime();
            isGlobalH4Closed = last1HTimeMs === last4HTimeMs + 3 * 3600 * 1000;
        }

        // P6: Drift Detection on OHLCV
        const btc1HFresh = await validateMarketDataFreshness(validBTC1H, '1h');
        if (!btc1HFresh) {
            console.warn(`[TRADING_HALTED_STALE_DATA] BTC anchor data is stale. Skipping tick logic.`);
            isTicking = false;
            return;
        }

        if (validBTC1H.length >= 200 && validBTC4H.length >= 200) {
            console.log("Preparing features for BTC...");
            globalFeatures = MarketDataLayer.prepareFeatures(validBTC1H, validBTC4H, isGlobalH4Closed);
            state.regime = RegimeLayer.detect(globalFeatures);
            btcLivePrice = validBTC1H[validBTC1H.length - 1].c;
            console.log(`[Engine] Global Anchor (BTC) Regime: ${state.regime}`);
        } else {
            console.warn(`[Engine] Global Anchor (BTC) insufficient data: 1H=${validBTC1H.length}, 4H=${validBTC4H.length}`);
        }
    } catch(e) {
        console.error("Failed to parse BTC base regime anchor", e);
    }

    console.log("Fetching tickers...");
    const tickers = await ccxtWithRetry(() => exchange.fetchTickers(TARGET_SYMBOLS));
    console.log("Tickers fetched!");

    let totalPnl = 0;
    const FEE_RATE = 0.0005;
    let positionsToKeep: ActiveTrade[] = [];

    // UPDATE FLOATING EQUITY & EVALUATE EXIT LAYER
    for (const p of simulatedPositions) {
        if (!p.currentStopLoss && p.stopLoss) {
            p.currentStopLoss = p.stopLoss;
        }
        const t = tickers[p.symbol];
        if (!t || !t.last) {
            positionsToKeep.push(p);
            continue;
        }
        
        let livePrice = t.last;
        let floatingPnl = 0;
        
        // Pseudo-Feature struct for the Exit Layer to use real-time tick 
        const mockFeatures = { ...globalFeatures, price: livePrice } as any; 

        const currentHourId = Math.floor(Date.now() / 3600000);
        const isNewClosedCandle = (p as any)._lastHourId !== currentHourId && (p as any)._lastHourId !== undefined;
        if ((p as any)._lastHourId !== currentHourId) {
            (p as any)._lastHourId = currentHourId;
        }

        const oldStopLoss = p.currentStopLoss;
        const oldSize = p.size;
        const wasHarvested = (p as any).isHarvestExecuted;
        
        let exitDecision: any = { shouldExit: false, exitType: "" };
        if ((p as any).nativeSlHit) {
            exitDecision = { shouldExit: true, exitType: "NATIVE_STOP_LOSS_HIT" };
            // Since it was executed on broker natively, we align local prices to SL
            livePrice = p.currentStopLoss;
        } else {
            exitDecision = PositionExitLayer.monitorAndExit(p, mockFeatures, state.regime as TradingRegime, isNewClosedCandle);
        }

        // Execute Partial Take Profit (Harvest) detected by size drop
        if (p.size < oldSize && !wasHarvested && (p as any).isHarvestExecuted) {
             const diff = oldSize - p.size;
             if (process.env.LIVE_TRADING_ENABLED === 'true') {
                 try {
                     const side = p.direction === 'LONG' ? 'sell' : 'buy';
                     console.log(`[HARVEST] Executing partial close for ${p.symbol} dropping ${diff} contracts...`);
                     await ccxtWithRetry(() => exchange.createMarketOrder(p.symbol, side, diff, undefined, { reduceOnly: true }));
                     console.log(`[HARVEST] Successfully harvested ${p.symbol}.`);
                 } catch (e: any) {
                     console.error(`[HARVEST_FAIL] Failed to partial close ${p.symbol}: ${e.message}`);
                     // Revert local state so it can retry next tick
                     p.size = oldSize;
                     (p as any).isHarvestExecuted = false;
                 }
             } else {
                 console.log(`[HARVEST] Mock partial close for ${p.symbol} dropping ${diff} contracts (PAPER TRADING).`);
             }
        }

        // If the Stop Loss has trailed, update native SL on Kraken!
        if (!exitDecision.shouldExit && oldStopLoss !== p.currentStopLoss && process.env.LIVE_TRADING_ENABLED === 'true') {
             try {
                 const side = p.direction === 'LONG' ? 'sell' : 'buy';
                 const orderResp: any = await ccxtWithRetry(() => exchange.updateStopLossOrder(p.symbol, side, p.size, p.currentStopLoss, (p as any).brokerStopLossOrderId));
                 if (orderResp?.id) {
                     (p as any).brokerStopLossOrderId = orderResp.id;
                     console.log(`[TRAILING SL] Native Stop Loss updated on Kraken to $${p.currentStopLoss}`);
                 }
             } catch(e: any) {
                 console.warn(`[TRAILING SL] Failed to update native Stop Loss on Kraken: ${e.message}`);
             }
        }

        if (exitDecision.shouldExit) {
            console.log(`[EXIT LAYER] Closing ${p.symbol} ${p.direction} at $${livePrice}. Reason: ${exitDecision.exitType}`);
            
            let isLiveExitSuccess = true;
            if (process.env.LIVE_TRADING_ENABLED === 'true') {
                 // If it's natively closed by broker we don't need to close again
                 if (exitDecision.exitType === "NATIVE_STOP_LOSS_HIT") {
                     isLiveExitSuccess = true;
                 } else {
                     const side = p.direction === 'LONG' ? 'sell' : 'buy';
                     try {
                     console.log(`[LIVE EXECUTION] Sending ${side} exit order for ${p.symbol} to Kraken Futures...`);
                     const order = await ccxtWithRetry(() => exchange.createMarketOrder(p.symbol, side, p.size, undefined, { reduceOnly: true }));
                     console.log(`[LIVE EXECUTION] Exit order successful:`, (order as any).id);
                 } catch(e: any) {
                     console.error(`[LIVE EXECUTION] Exit order failed for ${p.symbol}:`, e.message);
                     isLiveExitSuccess = false;
                     
                     // If exchange rejects reduceOnly (because position was manually closed or liquidated), force drop it locally
                     const msg = e.message.toLowerCase();
                     if (msg.includes('position') || msg.includes('reduce') || msg.includes('balance') || msg.includes('invalid') || msg.includes('margin') || msg.includes('order')) {
                         console.warn(`[LIVE EXECUTION] Exchange rejected exit. Assuming position already closed/liquidated. Forcing local sync.`);
                         isLiveExitSuccess = true;
                     }
                     
                     // Secondary ghost-trade fallback: if it failed, verify if it even exists anymore
                     if (!isLiveExitSuccess) {
                         try {
                              console.log(`[LIVE EXECUTION] Checking if ${p.symbol} exists on broker to prevent ghost lock...`);
                              const livePos: any = await ccxtWithRetry(() => exchange.fetchPositions());
                              const exPos = (livePos as any[])?.find((x: any) => x.symbol === p.symbol);
                              if (!exPos || Math.abs(exPos.contracts || 0) === 0) {
                                  console.warn(`[LIVE EXECUTION] Position ${p.symbol} confirmed NOT open on broker. Dropping local ghost.`);
                                  isLiveExitSuccess = true;
                              }
                         } catch(err3) {}
                     }
                 }
                 
                 // Clean up native Stop Loss order if we exited cleanly with market order
                 if (isLiveExitSuccess && (p as any).brokerStopLossOrderId && (exchange as any).client.cancelOrder) {
                     try {
                         await ccxtWithRetry(() => (exchange as any).client.cancelOrder({ order_id: (p as any).brokerStopLossOrderId }));
                     } catch(e) {}
                 }
            }
            }

            if (!isLiveExitSuccess) {
                // If live trading exit fails, keep the position to attempt exit next tick
                positionsToKeep.push(p);
                continue;
            }

            exitCooldowns[p.symbol] = Date.now() + 3600000; // 1 hour cooldown after exit

            const exitSizeValue = p.size * livePrice;
            const exitFee = exitSizeValue * FEE_RATE;
            const entryValue = p.size * p.entryPrice;
            const entryFee = entryValue * FEE_RATE;
            
            if (p.direction === 'LONG') {
                floatingPnl = (exitSizeValue - exitFee) - (entryValue + entryFee);
            } else {
                floatingPnl = (entryValue - entryFee) - (exitSizeValue + exitFee);
            }
            if (isNaN(floatingPnl) || !isFinite(floatingPnl)) floatingPnl = 0;
            
            if (!state.closedTrades) state.closedTrades = [];
            state.closedTrades.unshift({
                time: new Date().toISOString(),
                symbol: p.symbol,
                side: p.direction,
                entry: p.entryPrice,
                exit: livePrice,
                pnl: floatingPnl,
                reason: exitDecision.exitType || 'UNKNOWN'
            });
            if (state.closedTrades.length > 50) state.closedTrades.pop();
            
            let newBaseBalance = (state.baseBalance || 10000.00) + floatingPnl;
            if (isNaN(newBaseBalance) || !isFinite(newBaseBalance)) newBaseBalance = state.baseBalance || 10000.00;
            state.baseBalance = newBaseBalance;
            if (state.baseBalance > state.maxHistoricalEquity!) {
                state.maxHistoricalEquity = state.baseBalance;
            }

            // state.recentTrades = state.recentTrades || [];
            // state.recentTrades.unshift({ ... })
            // if (state.recentTrades.length > 50) state.recentTrades.pop();
        } else {
            // Update tracking values
            if (p.direction === 'LONG') {
                floatingPnl = (p.size * livePrice) - (p.size * p.entryPrice);
            } else {
                floatingPnl = (p.size * p.entryPrice) - (p.size * livePrice);
            }
            if (isNaN(floatingPnl) || !isFinite(floatingPnl)) floatingPnl = 0;
            totalPnl += floatingPnl;
            p.unrealizedPnl = floatingPnl; // Update for Dashboard
            positionsToKeep.push(p);
        }
    }
    
    simulatedPositions = positionsToKeep;
    
    let newBalance = (state.baseBalance || 10000.00) + totalPnl;
    if (isNaN(newBalance) || !isFinite(newBalance)) newBalance = state.baseBalance || 10000.00;
    
    // SYNC LAYER (Virtual vs Kraken Live / Sandbox)
    let effectiveRiskBalance = newBalance;
    if (exchange) {
        try {
            const realMargin = await exchange.fetchMarginBalance();
            if (realMargin !== null) {
                // realMargin is portfolioValue, which already includes the current unrealized Pnl.
                // Subtract bot's totalPnl to find the true closed base balance.
                const realBaseBalance = realMargin - totalPnl;
                
                // If we are significantly out of sync with Kraken's wallet balance
                if (Math.abs((state.baseBalance || 10000.00) - realBaseBalance) > 0.05) {
                    console.log(`[STATE SYNC] Kraken portfolio is $${realMargin.toFixed(2)}. Updating virtual base balance to $${realBaseBalance.toFixed(2)}`);
                    
                    // If realBaseBalance dropped significantly (e.g., user withdrawal), scale down the high-water mark
                    if (state.maxHistoricalEquity && realBaseBalance < (state.baseBalance || 10000.00)) {
                        const dropRatio = realBaseBalance / (state.baseBalance || 10000.00);
                        if (dropRatio < 0.99) {
                            console.log(`[CAPITAL] Detected withdrawal of ${(1 - dropRatio)*100}%. Scaling down maxHistoricalEquity.`);
                           state.maxHistoricalEquity = state.maxHistoricalEquity * dropRatio;
                        }
                    }

                    state.baseBalance = realBaseBalance;
                    newBalance = realMargin;
                    
                    if (!state.initialBalance || Math.abs(state.initialBalance - realBaseBalance) > 100) {
                        state.initialBalance = realBaseBalance;
                    }
                    
                    // Force chart/history reset if it's wildly different (e.g., initial load)
                    if (state.equityHistory.length > 0 && Math.abs(state.equityHistory[state.equityHistory.length - 1].equity - newBalance) > 100) {
                        state.equityHistory = [];
                        state.metricsHistory = [];
                        state.maxHistoricalEquity = newBalance;
                    }
                }
                effectiveRiskBalance = newBalance;
                // READ-ONLY RECONCILIATION
                try {
                    const liveTrades = await exchange.fetchRecentTrades();
                    if (liveTrades !== null) { // We made it return [] on success and null on network error
                        state.recentTrades = liveTrades;
                    }
                    
                    const livePos: any = await exchange.fetchPositions();
                    const openOrders: any = await exchange.client.getOpenOrders ? await ccxtWithRetry(() => exchange.client.getOpenOrders(), 2, 500) : { openOrders: [] };
                    
                    if (openOrders.openOrders && openOrders.openOrders.length > 0) {
                        const unmanagedOrders = openOrders.openOrders.filter((o: any) => {
                            // Ignore our native stop loss orders
                            const localP = simulatedPositions.find(p => (p as any).brokerStopLossOrderId === o.order_id);
                            if (localP) return false;
                            
                            // Check if it belongs to a local position that misses its broker order id
                            const matchP = simulatedPositions.find(p => (exchange as any).symbolToNative(p.symbol) === o.symbol);
                            if (matchP) {
                                if (!(matchP as any).brokerStopLossOrderId) {
                                    (matchP as any).brokerStopLossOrderId = o.order_id;
                                    console.log(`[AUTO-ADOPT] Re-linking unmanaged native order ${o.order_id} to local ${matchP.symbol}`);
                                    return false;
                                }
                            }
                            
                            // Check if it belongs to a live position we are about to adopt
                            const hasLivePos = livePos.some((lp: any) => (exchange as any).symbolToNative(lp.symbol) === o.symbol && Math.abs(lp.contracts) > 0);
                            if (hasLivePos) {
                                console.log(`[AUTO-ADOPT] Retaining unmanaged order ${o.order_id} for live broker adoption of ${o.symbol}.`);
                                return false; // don't clear it, wait for adoption
                            }
                            
                            return true;
                        });
                        
                        if (unmanagedOrders.length > 0) {
                            console.warn(`[UNKNOWN_OPEN_ORDER_ON_BROKER] Found ${unmanagedOrders.length} unmanaged open orders. Attempting auto-clear...`);
                            for (const o of unmanagedOrders) {
                                try {
                                    await ccxtWithRetry(() => exchange.client.cancelOrder({ order_id: o.order_id }), 2, 500);
                                    console.log(`[AUTO-HEAL] Successfully canceled unmanaged order: ${o.order_id}`);
                                } catch (e: any) {
                                    console.warn(`[AUTO-HEAL] Failed to cancel unmanaged order ${o.order_id}: ${e.message}`);
                                }
                            }
                        }
                    }

                    for (const localP of simulatedPositions) {
                        const exPos = livePos.find((p: any) => p.symbol === localP.symbol);
                        if (!exPos || Math.abs(exPos.contracts) === 0) {
                            console.log(`[BROKER_STATE_MISMATCH] Local ${localP.symbol} absent on broker. Assuming NATIVE STOP LOSS execution.`);
                            // Invece di panic, diciamo al sistema di chiuderlo!
                            (localP as any).nativeSlHit = true;
                        } else {
                            // SYNC DATA: Update local state with Broker data (Source of Truth)
                            // This ensures the dashboard matches Kraken exactly
                            if (exPos.entryPrice) localP.entryPrice = exPos.entryPrice;
                            if (exPos.unrealizedPnl !== undefined) localP.unrealizedPnl = exPos.unrealizedPnl;
                            if (exPos.leverage) localP.leverage = exPos.leverage;
                            
                            // Update size if it changed (partial fills or manual adjustments)
                            if (Math.abs(exPos.contracts) !== localP.size) {
                                console.log(`[BROKER_SIZE_SYNC] Correcting ${localP.symbol} size: ${localP.size} -> ${Math.abs(exPos.contracts)}`);
                                localP.size = Math.abs(exPos.contracts);
                            }

                            // GUARANTEE NATIVE STOP LOSS: Check if SL order still exists in broker's open orders
                            if (openOrders && openOrders.openOrders) {
                                const brokerOrderId = (localP as any).brokerStopLossOrderId;
                                const slExists = openOrders.openOrders.some((o: any) => o.order_id === brokerOrderId);
                                
                                if (!slExists && localP.size > 0 && process.env.LIVE_TRADING_ENABLED === 'true') {
                                    console.warn(`[NATIVE_SL_HEAL] Missing Stop Loss for active position ${localP.symbol}. Generating emergency SL!`);
                                    try {
                                        const side = localP.direction === 'LONG' ? 'sell' : 'buy';
                                        const slRes: any = await ccxtWithRetry(() => exchange.updateStopLossOrder(localP.symbol, side, localP.size, localP.currentStopLoss));
                                        if (slRes && slRes.id) {
                                            (localP as any).brokerStopLossOrderId = slRes.id;
                                            console.log(`[NATIVE_SL_HEAL] Successfully recreated Stop Loss for ${localP.symbol}: ${slRes.id}`);
                                        }
                                    } catch (e: any) {
                                        console.error(`[NATIVE_SL_HEAL_FAIL] Failed to heal Stop Loss for ${localP.symbol}: ${e.message}`);
                                    }
                                }
                            }
                        }
                    }
                    for (const exPos of livePos) {
                        if (exPos.contracts !== 0) {
                            const localP = simulatedPositions.find(p => p.symbol === exPos.symbol);
                            if (!localP) {
                                console.error(`[BROKER_STATE_MISMATCH] Broker has ${exPos.symbol} absent locally. ADOPTING FOR TEST.`);
                                const direction = exPos.contracts > 0 ? 'LONG' : 'SHORT';
                                const entryPrice = parseFloat(exPos.entryPrice) || (liveDataCache[exPos.symbol] ? liveDataCache[exPos.symbol].bars1H[liveDataCache[exPos.symbol].bars1H.length - 1].c : 0);
                                const nativeOrder = openOrders.openOrders?.find((o: any) => o.symbol === (exchange as any).symbolToNative(exPos.symbol));
                                const stopPrice = nativeOrder?.stopPrice ? parseFloat(nativeOrder.stopPrice) : (direction === 'LONG' ? entryPrice * 0.95 : entryPrice * 1.05);
                                
                                simulatedPositions.push({
                                    id: `test-adopt-${Date.now()}`,
                                    symbol: exPos.symbol,
                                    direction: direction,
                                    entryPrice: entryPrice,
                                    size: Math.abs(exPos.contracts),
                                    entryTime: Date.now(),
                                    unrealizedPnl: parseFloat(exPos.unrealizedPnl) || 0,
                                    mfe: 0,
                                    mae: 0,
                                    stopLoss: stopPrice,
                                    currentStopLoss: stopPrice,
                                    brokerStopLossOrderId: nativeOrder?.order_id
                                } as any);
                            }
                        }
                    }
                } catch(e: any) {
                    console.warn(`[RECONCILIATION FAIL]`, e.message);
                }
            }
        } catch (e: any) {
             console.warn("[STATE SYNC] Could not read real Kraken margin, proceeding with virtual equity safely.");
        }
    }
    
    state.balance = newBalance;
    if (state.balance > state.maxHistoricalEquity!) {
        state.maxHistoricalEquity = state.balance;
    }

    // CAPITAL LAYER - Assess Ruins and Drawdowns
    const capitalHealth = CapitalManagementLayer.evaluateAccountHealth(state.balance, state.maxHistoricalEquity!);
    
    if (capitalHealth.isHalted) {
        state.status = 'SYSTEM_HALTED';
        state.isActive = false;
        console.warn(`[CAPITAL LAYER] Algorithm permanently halted due to catastrophic Drawdown Limit breach.`);
    }

    if (state.isActive && state.status === 'ERROR_RECOVERING') {
        // Auto-recover on next tick
        state.status = 'RUNNING';
        state.lastError = undefined;
        console.log(`[Engine] Auto-recovering from transient error. Status is RUNNING again.`);
    }

    if (state.isActive && state.status === 'WARMING_UP') {
        if (Date.now() >= (state.warmupUntil || 0)) {
            state.status = 'RUNNING';
            console.log(`[Engine] Warm-up phase complete. Now accepting entry signals.`);
        } else {
            const remSecs = Math.round(((state.warmupUntil || 0) - Date.now()) / 1000);
            console.log(`[Engine] Warming up buffers. Evaluating exits only. ${remSecs}s remaining...`);
        }
    }

    if (state.isActive && !capitalHealth.isHalted && globalFeatures && state.status === 'RUNNING') {
       // SCAN NEW ENTRIES 
       for (const symbol of TARGET_SYMBOLS) {
          // One position max per symbol
          if (simulatedPositions.find(p => p.symbol === symbol)) continue;

          // Prevent immediate reentry (Tick collision fix)
          if (exitCooldowns[symbol] && Date.now() < exitCooldowns[symbol]) continue;

          let sym1H: Bar[] = [];
          let sym4H: Bar[] = [];
          
          if (symbol === 'BTC/USD:USD') {
              sym1H = btc1H; sym4H = btc4H;
          } else {
              try {
                // Ensure array exists, but skip if daemon hasn't precomputed the symbols
                if (!liveDataCache[symbol]) continue;

                sym1H = liveDataCache[symbol].bars1H;
                sym4H = liveDataCache[symbol].bars4H;
              } catch(e: any) {
                  console.warn(`[CCXT Info] Failed to fetch OHLCV for ${symbol}: ${e.message}`);
                  continue; 
              }
          }
          
          const validSym1H = filterClosedCandles(sym1H, '1h', nowMs);
          const validSym4H = filterClosedCandles(sym4H, '4h', nowMs);

        if (validSym1H.length >= 200 && validSym4H.length >= 200) {
              // P6: Drift Detection for specific symbol
              const symFresh = await validateMarketDataFreshness(validSym1H, '1h');
              if (!symFresh) {
                  console.log(`[DRIFT_DETECT] ${symbol} data is stale. Skipping.`);
                  continue;
              }
              
              let isH4Closed = false;
              if (validSym1H.length > 0 && validSym4H.length > 0) {
                  const last1HTimeMs = new Date(validSym1H[validSym1H.length - 1].t).getTime();
                  const last4HTimeMs = new Date(validSym4H[validSym4H.length - 1].t).getTime();
                  isH4Closed = last1HTimeMs === last4HTimeMs + 3 * 3600 * 1000;
              }

              const features = MarketDataLayer.prepareFeatures(validSym1H, validSym4H, isH4Closed);

              const localRegime = RegimeLayer.detect(features);
              state.regimes[symbol] = localRegime;
              
              const signal = SignalLayer.evaluate(features, localRegime as TradingRegime, symbol, { btcTrend1H: globalFeatures?.trend1H, btcRegime: state.regime as TradingRegime });
              
              const displayRegime = symbol === 'BTC/USD:USD' ? state.regime : localRegime;
              // console.log(`[DATA CHECK] ${symbol} Price: ${features.price}, RSI: ${features.rsi1H ? features.rsi1H.toFixed(2) : 'N/A'}, Local Regime: ${displayRegime}, Signal: ${signal.direction}`);

              if (signal.direction === 'NEUTRAL') {
                  const currentHour = new Date().getHours();
                  if (!state.lastSignalTimes) state.lastSignalTimes = {};
                  // Heartbeat log once per symbol periodically (every 1 hour, or immediately on first boot)
                  const hbKey = `${symbol}_HB`;
                  if (!state.lastSignalTimes[hbKey] || (state.lastSignalTimes[hbKey] !== currentHour.toString() && currentHour % 1 === 0)) {
                      state.lastSignalTimes[hbKey] = currentHour.toString();
                      logDecision({ action: "SCANNING", symbol, direction: "NEUTRAL", reason: "Nessun setup statistico individuato", price: features.price, regime: displayRegime });
                  }
              }

              if (signal.direction !== 'NEUTRAL') {
                  const signalH4Time = validSym4H[validSym4H.length - 1].t;
                  if (state.lastSignalTimes && state.lastSignalTimes[symbol] === signalH4Time) {
                      console.log(`[COOLDOWN] Skipping ${signal.direction} on ${symbol} (Already fired for 4H bar: ${signalH4Time})`);
                      logDecision({ action: "COOLDOWN_SKIPPED", symbol, direction: signal.direction, reason: `Already fired for 4H bar (${signalH4Time})`, price: features.price, regime: displayRegime });
                      continue;
                  }

                  const gate = GatekeeperLayer.allowEntry(signal, features, localRegime as TradingRegime, symbol);
                  if (gate.allowed) {
                      // Apply live ticker overriding ONLY after signals and gating have evaluated using consistent snapshots
                      // This avoids temporal mismatch on features.price while allowing execution size matching
                      const oldFeaturePrice = features.price;
                      if (tickers[symbol] && tickers[symbol].last) {
                          features.price = tickers[symbol].last;
                      }

                      const risk = RiskLayer.calculateRisk(
                          signal, 
                          features, 
                          effectiveRiskBalance, 
                          localRegime as TradingRegime, 
                          gate.riskModifier || 1.0, 
                          symbol, 
                          { btcTrend1H: globalFeatures?.trend1H, btcRegime: state.regime as TradingRegime }
                      );
                      
                      const MAX_GLOBAL_EXPOSURE = Math.max(50000, state.balance * 2.5);
                      const currentExposure = simulatedPositions.reduce((acc, p) => acc + (p.size * p.entryPrice), 0);
                      
                      let rawSize = risk.positionSize * capitalHealth.allowedCapacityMultiplier;
                      if (isNaN(rawSize) || !isFinite(rawSize)) rawSize = 0;
                      
                      const orderRes = resolveOrderAmount(exchange, symbol, rawSize, features.price);
                      if (!orderRes.ok) {
                          console.log(JSON.stringify({
                             event: "ORDER_SKIPPED_INVALID_SIZE", symbol,
                             amount: rawSize, reason: orderRes.reason, severity: "WARNING"
                          }));
                          logDecision({ action: "ORDER_SKIPPED", symbol, direction: signal.direction, reason: `Invalid size (${orderRes.reason})`, price: features.price, regime: displayRegime });
                          continue;
                      }

                      const newTradeExposure = orderRes.amount! * features.price;
                      if (currentExposure + newTradeExposure > MAX_GLOBAL_EXPOSURE) {
                          console.log(JSON.stringify({
                             event: "SIGNAL_SKIPPED_MAX_GLOBAL_EXPOSURE", symbol,
                             currentExposure, newTradeExposure,
                             projectedExposure: currentExposure + newTradeExposure,
                             maxGlobalExposure: MAX_GLOBAL_EXPOSURE,
                             severity: "WARNING"
                          }));
                          logDecision({ action: "ORDER_SKIPPED", symbol, direction: signal.direction, reason: "Max Global Exposure Exceeded", price: features.price, regime: displayRegime });
                          continue;
                      }
                      
                      let finalSize = orderRes.amount!;
                      let realEntryPrice = features.price;
                      
                      if (finalSize > 0) {
                          console.log(`[ENTRY LAYER] Intent to open ${symbol} ${signal.direction} at $${features.price}`);
                          
                          const positionId = `pos_${symbol.replace(/[^A-Z]/g, '')}_${Date.now()}`;
                          const clientOrderId = `entry_${positionId.substring(4)}`;
                          
                          // P3/P5: Isolated Margin & Leverage Preference before Entry
                          if (process.env.LIVE_TRADING_ENABLED === 'true') {
                              const leverageOk = await exchange.ensureIsolatedLeverage(symbol, risk.leverage || 2);
                              if (!leverageOk) {
                                  console.error(`[ENTRY_BLOCKED_MARGIN_MODE_UNSAFE] Could not confirm isolated margin for ${symbol}`);
                                  logDecision({ action: "ORDER_SKIPPED", symbol, direction: signal.direction, reason: "Margin Setup Failed", price: features.price, regime: displayRegime });
                                  continue;
                              }
                          }

                          // Initialize Ledger Entry
                          if (!state.positionLedger) state.positionLedger = {};
                          state.positionLedger[positionId] = {
                              positionId,
                              symbol,
                              side: signal.direction as 'LONG' | 'SHORT',
                              status: 'OPEN',
                              entryOrderIds: [],
                              exitOrderIds: [],
                              clientOrderIds: [clientOrderId],
                              totalEntryAmount: 0,
                              totalExitAmount: 0,
                              averageEntryPrice: 0,
                              averageExitPrice: 0,
                              realizedFees: 0,
                              unrealizedFeesEstimate: 0,
                              realizedPnlGross: 0,
                              realizedPnlNet: 0,
                              currentOpenAmount: 0,
                              mfe: 0,
                              mae: 0,
                              barsHeld: 0,
                              createdAt: new Date().toISOString(),
                              updatedAt: new Date().toISOString()
                          };

                          let isLiveExecutionSuccess = true;
                          let finalFilledSize = 0;

                          if (process.env.LIVE_TRADING_ENABLED === 'true') {
                              // P3: Protected Limit Entry
                              const side = signal.direction === 'LONG' ? 'buy' : 'sell';
                              const entryRes = await createProtectedLimitEntryOrder({
                                  symbol,
                                  side,
                                  amount: finalSize,
                                  lastPrice: features.price,
                                  slippageBuffer: 0.001, // 0.1% buffer
                                  timeoutMs: 30000,
                                  clientOrderId,
                                  positionId
                              });

                              if (entryRes.success) {
                                  finalFilledSize = entryRes.filledAmount;
                                  realEntryPrice = entryRes.avgPrice;
                                  
                                  // P4: Native Stop Loss post-fill
                                  const pMock = { id: positionId, symbol, direction: signal.direction, stopLoss: risk.stopLoss } as any;
                                  await attachNativeProtections(pMock, finalFilledSize);
                              } else {
                                  isLiveExecutionSuccess = false;
                                  delete state.positionLedger[positionId];
                                  logDecision({ action: "ORDER_FAILED", symbol, direction: signal.direction, reason: "Entry timed out or rejected", price: features.price, regime: displayRegime });
                              }
                          } else {
                              // Visual/Paper simulation
                              finalFilledSize = finalSize;
                          }
                          
                          if (isLiveExecutionSuccess && finalFilledSize > 0) {
                              logDecision({ action: "TRADE_EXECUTED", symbol, direction: signal.direction, reason: `Passed Gatekeeper (${signal.engine || 'NORMAL'})`, price: realEntryPrice, regime: displayRegime });
                              
                              const newPos: ActiveTrade = {
                                  id: positionId,
                                  symbol: symbol,
                                  direction: signal.direction as SignalDirection,
                                  entryPrice: realEntryPrice,
                                  size: finalFilledSize,
                                  leverage: risk.leverage,
                                  entryTime: Date.now(),
                                  stopLoss: risk.stopLoss,
                                  takeProfit: risk.takeProfit,
                                  initialStopLoss: risk.stopLoss,
                                  currentStopLoss: risk.stopLoss,
                                  catastropheStopLoss: risk.catastropheStopLoss,
                                  highWaterMark: realEntryPrice,
                                  lowWaterMark: realEntryPrice,
                                  unrealizedPnl: 0,
                                  mfe: 0,
                                  mae: 0,
                                  barsHeld: 0,
                                  status: 'OPEN',
                                  riskTier: risk.tierLabel,
                                  entryRegime: displayRegime as TradingRegime,
                                  engine: signal.engine
                              };
                              
                              if (process.env.LIVE_TRADING_ENABLED === 'true' && state.positionLedger[positionId]) {
                                  (newPos as any).brokerStopLossOrderId = state.positionLedger[positionId].nativeStopLossOrderId;
                                  (newPos as any).clientOrderId = clientOrderId;
                              }

                              if (!state.lastSignalTimes) state.lastSignalTimes = {};
                              state.lastSignalTimes[symbol] = signalH4Time;

                              simulatedPositions.push(newPos);
                              console.log(`[ENTRY_AVERAGE_PRICE_CONFIRMED] Position ${symbol} opened with size ${finalFilledSize} at ${realEntryPrice}`);
                          }
                      }
                  } else {
                      console.log(`[GATEKEEPER] Denied ${signal.direction} on ${symbol}: ${gate.reason}`);
                      logDecision({ action: "GATEKEEPER_BLOCKED", symbol, direction: signal.direction, reason: gate.reason, price: features.price, regime: displayRegime });
                  }
              }
          } else {
              console.log(`[DATA_WAIT] ${symbol} not enough 1H (${validSym1H.length}/200) or 4H (${validSym4H.length}/200) closed bars.`);
          }
    }
    }

    state.openPositions = simulatedPositions;

    // Update Equity History
    if (!state.equityHistory) state.equityHistory = [];
    if (!state.metricsHistory) state.metricsHistory = [];
    
    const now = Date.now();
    const lastEq = state.equityHistory[state.equityHistory.length - 1];
    if (!lastEq || now - new Date(lastEq.time).getTime() >= 60000) {
        state.equityHistory.push({ time: new Date().toISOString(), equity: state.balance });
        if (state.equityHistory.length > 500) { // Stay well under GRPC / Firestore document payload limits preventing SIGABRT
            state.equityHistory = state.equityHistory.slice(-500); // FIX: Slice to strictly truncate even if previously bloated
        }
        
        // Calculate and save the metrics snapshot at this historical point
        const snapshot = calculateSnapshot({ ...state, openPositions: state.openPositions as any } as any); 
        state.metricsHistory.push(snapshot);
        if (state.metricsHistory.length > 100) { // Reduced to 100 snapshots
            state.metricsHistory = state.metricsHistory.slice(-100); // FIX: Slice to strictly truncate
        }
    }
    
    tickConsecutiveFailures = 0; // Reset on success
    if (state.status === 'ERROR_RECOVERING') {
        state.status = 'ACTIVE';
        state.lastError = undefined;
    }

    const receivedSymbols = Object.keys(tickers).join(', ');
    console.log(`[Virtual Engine] Feed: ${receivedSymbols} | BTC: $${btcLivePrice} | Regime: ${state.regime} | Eq: $${state.balance.toFixed(2)}`);
    await saveState();
  } catch (error: any) {
    const errMsg = error?.body?.error || error?.message || String(error);
    const isTransientError = 
        error instanceof ccxt.NetworkError || 
        error instanceof ccxt.ExchangeError || 
        errMsg.includes('Rate limit exceeded') ||
        errMsg.includes('timeout') ||
        errMsg.includes('network') ||
        errMsg.includes('ECONNRESET') ||
        errMsg.includes('502') ||
        errMsg.includes('503') ||
        errMsg.includes('Service Unavailable') ||
        error?.code === 429 ||
        error?.code === 502 ||
        error?.code === 503 ||
        error?.code === 500;

    if (isTransientError) {
        tickConsecutiveFailures++;
        if (tickConsecutiveFailures >= 3) {
             console.error(`[Transient Tick Error]: ${errMsg}. Failed 3 consecutive times. Entering ERROR_RECOVERING state.`);
             state.status = 'ERROR_RECOVERING';
             state.lastError = errMsg + ' (Consecutive failures limit reached)';
             // We do not reset the counter here; let the next successful tick reset it.
        } else {
             console.warn(`[Transient Tick Error]: ${errMsg}. Will retry next tick. (Failures: ${tickConsecutiveFailures}/3)`);
        }
    } else {
        const outErrStr = error instanceof Error ? (error.stack || error.message) : JSON.stringify(error);
        console.error('Tick Error (Recovering):', outErrStr);
        // Invece di spegnere il bot (state.isActive = false), lo mettiamo in stato di recupero.
        // Il bot fallisce solo questo tick e ritenterà l'esecuzione al prossimo cron/ping.
        state.status = 'ERROR_RECOVERING';
        state.lastError = errMsg;
    }
  } finally {
    isTicking = false;
  }
  
  // To optimize standard daily Firebase usage (even on Blaze, to keep costs incredibly low),
  // we only aggressively hit setDoc when the structural state has changed.
  // We use our structural hash to catch position changes, drops, stops.
  if (hashStateSnapshot() !== stateHashBefore) {
    await saveState();
  } else {
    // If no structural change, we only save heartbeat telemetry once every 2 minutes
    const lastEq = state.equityHistory ? state.equityHistory[state.equityHistory.length - 1] : null;
    const isMinuteTick = lastEq && (Date.now() - new Date(lastEq.time).getTime() < 5000); 
    if (isMinuteTick && new Date().getMinutes() % 2 === 0) {
        await saveState(); // Heartbeat save
    }
  }
}

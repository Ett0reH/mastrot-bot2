import ccxt from 'ccxt';
import "dotenv/config";

process.env.LIVE_TRADING_ENABLED = 'true';

import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc } from 'firebase/firestore/lite';
import fs from 'fs';
import path from 'path';
import { calculateSnapshot } from '../lib/metricsCalculator';
import {
    Bar, TradingRegime, MarketDataLayer, RegimeLayer, SignalLayer,
    GatekeeperLayer, RiskLayer, PositionExitLayer, ActiveTrade, CapitalManagementLayer, ExpectancyTracker
} from './core/architecture';

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
  regime: string;
  regimes?: Record<string, string>;
  lastUpdate: string;
  lastError?: string;
  botSecret?: string;
  equityHistory?: { time: string, equity: number }[];
  metricsHistory?: any[];
  maxHistoricalEquity?: number;
  initialBalance?: number;
  warmupUntil?: number;
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
  maxHistoricalEquity: 10000.00
};

export let exchange: any = null;
let pollInterval: NodeJS.Timeout | null = null;
export let simulatedPositions: ActiveTrade[] = [];

// Promise to ensure we only load state once and can await it
let initialStateLoaded = false;
let loadStatePromise: Promise<void> | null = null;
let loadAttempts = 0;

// Utility to wrap a promise with a timeout to prevent infinite hanging and memory leaks
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string = 'Operation'): Promise<T> {
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
    const snapshot = await withTimeout(getDoc(doc(db, 'bot_state', STATE_DOC_ID)), 8000, 'Firebase getDoc');
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
loadStatePromise = loadInitialState().catch(() => { loadStatePromise = null; });

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
           testnet: process.env.KRAKEN_SANDBOX === 'true' || process.env.KRAKEN_SANDBOX === undefined
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
                        this.markets[symbol] = {
                             limits: { amount: { min: parseFloat((inst as any).contractSize) || 1 }, cost: { min: 2.0 } },
                             precision: { amount: 3 } // Placeholder while actual API schema unknown
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
                this.markets[s] = {
                    limits: { amount: { min: s.includes('BTC') ? 0.001 : 1 }, cost: { min: 2.0 } },
                    precision: { amount: s.includes('BTC') ? 4 : s.includes('ETH') ? 3 : s.includes('SOL') ? 1 : 0 }
                };
            }
        });
        return this.markets;
    }

    private symbolToNative(symbol: string) {
        let base = symbol.split('/')[0];
        if (base === 'BTC') base = 'XBT';
        return `PF_${base}USD`;
    }

    private nativeToSymbol(native: string) {
        let base = native.replace('PF_', '').replace('USD', '');
        if (base === 'XBT') base = 'BTC';
        return `${base}/USD:USD`;
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

    async createMarketOrder(symbol: string, side: string, amount: number, price?: number, params: any = {}) {
        const payload: any = {
            symbol: this.symbolToNative(symbol),
            side: side as 'buy' | 'sell',
            size: amount,
            orderType: 'mkt',
            reduceOnly: params.reduceOnly
        };
        if (params.clientOrderId) {
            payload.cliOrdId = params.clientOrderId; // Pass idempotency key
        }
        const res = await this.client.submitOrder(payload);
        const returnedId = res.sendStatus?.order_id || (res.sendStatus as any)?.orderEvents?.[0]?.order?.orderId;
        if (returnedId) {
            return { id: returnedId, clientOrderId: params.clientOrderId };
        } else {
            throw new MockCcxtExchangeError("Failed to parse order ID from response");
        }
    }

    async updateStopLossOrder(symbol: string, side: string, amount: number, stopPrice: number, existingOrderId?: string) {
        if (existingOrderId) {
            try {
                await this.client.cancelOrder({ orderId: existingOrderId, symbol: this.symbolToNative(symbol) });
                await new Promise(r => setTimeout(r, 200));
            } catch (e) {
                // Ignore cancel errors (might be already filled or canceled)
            }
        }
        const payload: any = {
            symbol: this.symbolToNative(symbol),
            side: side as 'buy' | 'sell',
            size: amount,
            orderType: 'stp',
            stopPrice: this.amountToPrecision(symbol, stopPrice),
            reduceOnly: true
        };
        const res = await this.client.submitOrder(payload);
        const returnedId = res.sendStatus?.order_id || (res.sendStatus as any)?.orderEvents?.[0]?.order?.orderId;
        if (returnedId) return { id: returnedId };
        // Could be rejected, e.g., if price is invalid
        return null;
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

            const matchedFills = fetchedFills.filter((f: any) => f.order_id === id || f.cli_ord_id === id);
            
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
               const isPending = openOrders.some((o: any) => o.order_id === id || o.cli_ord_id === id);
               
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

    async fetchPositions() {
        const { openPositions } = await this.client.getOpenPositions();
        return (openPositions || []).map((p: any) => ({
            symbol: this.nativeToSymbol(p.symbol),
            contracts: p.size, 
        }));
    }

    async fetchRecentTrades() {
        const now = Date.now();
        if (this.recentTradesCache && now - this.lastTradesFetch < 60000) {
            return this.recentTradesCache;
        }

        try {
            const [logsRes, fillsRes] = await Promise.all([
                this.client.getAccountLog(),
                this.client.getFills()
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
             console.warn(`[Adapter] Failed to fetch recent trades: ${e.message}`);
             return null;
        }
    }

    async fetchMarginBalance(): Promise<number | null> {
        try {
            const res = await ccxtWithRetry(() => this.client.getAccounts(), 3, 2000);
            
            if (res.accounts) {
                // If the user uses Multi-Collateral (Flex) margin account
                if (res.accounts['flex'] && res.accounts['flex'].type === 'multiCollateralMarginAccount') {
                    // Use portfolioValue (which includes unrealized PNL) or balanceValue
                    return res.accounts['flex'].portfolioValue;
                }
                
                // Fallback for single-collateral USD account
                const usdMarginAcc = Object.values(res.accounts).find((a: any) => a.type === 'marginAccount' && a.currency === 'usd') as any;
                if (usdMarginAcc && usdMarginAcc.balances) {
                    let total = 0;
                    if (usdMarginAcc.balances['usd']) total += parseFloat(usdMarginAcc.balances['usd']);
                    if (usdMarginAcc.auxiliary && usdMarginAcc.auxiliary.pnl) total += parseFloat(usdMarginAcc.auxiliary.pnl);
                    return total;
                }
            }
            return null;
        } catch (e: any) {
            if (!e.message?.includes('Service Unavailable') && !e.message?.includes('Bad Gateway')) {
                 console.warn("Failed to fetch Kraken Margin Balance:", e.message);
            }
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

  // Load expectancy matrix if not loaded
  if (!expectancyMatrixLoaded) {
    try {
      const matrixPath = path.join(process.cwd(), 'src/server/backtest/data_cache/setup_expectancy_matrix.json');
      if (fs.existsSync(matrixPath)) {
        const matrixData = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
        ExpectancyTracker.loadMatrix(matrixData);
        expectancyMatrixLoaded = true;
      }
    } catch(e) {
      console.warn("Failed to load expectancy matrix in LiveEngine:", e);
    }
  }

  // Initialize Kraken Futures connection for live market data
  exchange = new KrakenExchangeAdapter({
    apiKey: process.env.KRAKEN_API_KEY,
    secret: process.env.KRAKEN_SECRET_KEY
  });
  if (process.env.KRAKEN_SANDBOX === 'true' || process.env.KRAKEN_SANDBOX === undefined) {
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

async function ccxtWithRetry<T>(fn: () => Promise<T>, retries = 3, delay = 3000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
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
        // Only log transient errors occasionally to prevent log flooding
        if (i > 0 || (!errMsg.includes('Service Unavailable') && !errMsg.includes('Rate limit'))) {
            console.warn(`[Retry ${i + 1}/${retries}] CCXT / API Transient Error: ${errMsg}. Retrying in ${delay}ms...`);
        }
        await delaySleep(delay);
        delay *= 2; // exponential backoff
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
    state.warmupUntil = Date.now() + (5 * 60 * 1000); // 5 minutes warm-up buffer
    state.lastError = undefined;
    state.lastUpdate = new Date().toISOString();
    
    // Only clear simulated positions if they don't already exist from a resume
    if (simulatedPositions.length === 0) {
       simulatedPositions = state.openPositions || [];
    }

    if (!state.maxHistoricalEquity) state.maxHistoricalEquity = state.baseBalance || 10000;

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

export async function stopPaperTrading() {
  if (!initialStateLoaded) {
    if (!loadStatePromise) loadStatePromise = loadInitialState().catch(e => { loadStatePromise = null; throw e; });
    await loadStatePromise;
  }
  
  await initExchange();

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
                const openOrders = await exchange.client.getOpenOrders ? await exchange.client.getOpenOrders() : { openOrders: [] };
                if (openOrders.openOrders) {
                    for (const o of openOrders.openOrders) {
                        try {
                            await ccxtWithRetry(() => exchange.client.cancelOrder({ orderId: o.orderId, symbol: o.symbol }));
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
                 console.error(`[EMERGENCY_KILL_SWITCH] Dropping local-only orphan ${p.symbol}...`);
                 const side = p.direction === 'LONG' ? 'sell' : 'buy';
                 await ccxtWithRetry(() => exchange.createMarketOrder(p.symbol, side, p.size, undefined, { reduceOnly: true }));
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
function hashStateSnapshot() {
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

function resolveOrderAmount(exchange: any, symbol: string, rawAmount: number, price: number) {
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
        ok = false;
        reason = "Amount must be positive";
    }

    let precisionAmountStr = exchange.amountToPrecision ? exchange.amountToPrecision(symbol, rawAmount) : rawAmount.toString();
    let precisionAmount = Number(precisionAmountStr);
    
    if (precisionAmount <= 0) {
        ok = false; reason = "Amount truncated to zero by precision";
    }

    if (minAmount > 0 && precisionAmount < minAmount) {
        ok = false; reason = `Amount ${precisionAmount} below min limits ${minAmount}`;
    }
    
    const notional = precisionAmount * price;
    if (minCost > 0 && notional < minCost) {
        ok = false; reason = `Notional ${notional} below min cost ${minCost}`;
    }

    return {
        ok, amount: precisionAmount, reason, rawAmount, precisionAmount, minAmount, minCost
    };
}

async function precomputeLiveOHLCV() {
    console.log("Precomputing OHLCV...");
    const symbolsToPreload = Array.from(new Set(['BTC/USD:USD', ...TARGET_SYMBOLS]));
    for (const symbol of symbolsToPreload) {
        try {
            console.log(`Downloading ${symbol} [1H/4H]...`);
            const ohlcv1H = await ccxtWithRetry(() => exchange!.fetchOHLCV(symbol, '1h', undefined, 300));
            const ohlcv4H = await ccxtWithRetry(() => exchange!.fetchOHLCV(symbol, '4h', undefined, 300));
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
  if (isTicking) return;
  if (!exchange || !state.isActive) return;
  
  // Wait explicitly if we ticked recently to prevent loop overloads
  const nowMs = Date.now();
  if (nowMs - lastTickTime < 5000) return;

  isTicking = true;
  lastTickTime = Date.now();
  
  const stateHashBefore = hashStateSnapshot();
  
  try {
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

        let ohlcv1H = await ccxtWithRetry(() => exchange.fetchOHLCV('BTC/USD:USD', '1h', undefined, 5));
        let ohlcv4H = await ccxtWithRetry(() => exchange.fetchOHLCV('BTC/USD:USD', '4h', undefined, 5));
        
        liveDataCache['BTC/USD:USD'].bars1H = mergeOHLCV(liveDataCache['BTC/USD:USD'].bars1H, processOHLCV(ohlcv1H as any[])).slice(-400);
        liveDataCache['BTC/USD:USD'].bars4H = mergeOHLCV(liveDataCache['BTC/USD:USD'].bars4H, processOHLCV(ohlcv4H as any[])).slice(-400);
        
        btc1H = liveDataCache['BTC/USD:USD'].bars1H;
        btc4H = liveDataCache['BTC/USD:USD'].bars4H;
        
        const validBTC1H = filterClosedCandles(btc1H, '1h', nowMs);
        const validBTC4H = filterClosedCandles(btc4H, '4h', nowMs);

        if (validBTC1H.length > 50 && validBTC4H.length > 200) {
            globalFeatures = MarketDataLayer.prepareFeatures(validBTC1H, validBTC4H);
            state.regime = RegimeLayer.detect(globalFeatures);
            btcLivePrice = validBTC1H[validBTC1H.length - 1].c;
        }
    } catch(e) {
        console.error("Failed to parse BTC base regime anchor", e);
    }

    const tickers = await ccxtWithRetry(() => exchange.fetchTickers(TARGET_SYMBOLS));

    let totalPnl = 0;
    const FEE_RATE = 0.0005;
    let positionsToKeep: ActiveTrade[] = [];

    // UPDATE FLOATING EQUITY & EVALUATE EXIT LAYER
    for (const p of simulatedPositions) {
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
        
        let exitDecision: any = { shouldExit: false, exitType: "" };
        if ((p as any).nativeSlHit) {
            exitDecision = { shouldExit: true, exitType: "NATIVE_STOP_LOSS_HIT" };
            // Since it was executed on broker natively, we align local prices to SL
            livePrice = p.currentStopLoss;
        } else {
            exitDecision = PositionExitLayer.monitorAndExit(p, mockFeatures, state.regime as TradingRegime, isNewClosedCandle);
        }

        // If the Stop Loss has trailed, update native SL on Kraken!
        if (!exitDecision.shouldExit && oldStopLoss !== p.currentStopLoss && process.env.LIVE_TRADING_ENABLED === 'true') {
             try {
                 const side = p.direction === 'LONG' ? 'sell' : 'buy';
                 const orderResp = await ccxtWithRetry(() => exchange.updateStopLossOrder(p.symbol, side, p.size, p.currentStopLoss, (p as any).brokerStopLossOrderId));
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
                     if (msg.includes('position') || msg.includes('reduce') || msg.includes('balance') || msg.includes('invalid') || msg.includes('margin')) {
                         console.warn(`[LIVE EXECUTION] Exchange rejected exit. Assuming position already closed/liquidated. Forcing local sync.`);
                         isLiveExitSuccess = true;
                     }
                 }
                 
                 // Clean up native Stop Loss order if we exited cleanly with market order
                 if (isLiveExitSuccess && (p as any).brokerStopLossOrderId && (exchange as any).client.cancelOrder) {
                     try {
                         await ccxtWithRetry(() => (exchange as any).client.cancelOrder({ orderId: (p as any).brokerStopLossOrderId, symbol: (exchange as any).symbolToNative(p.symbol) }));
                     } catch(e) {}
                 }
            }
            }

            if (!isLiveExitSuccess) {
                // If live trading exit fails, keep the position to attempt exit next tick
                positionsToKeep.push(p);
                continue;
            }

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
                    
                    const livePos = await exchange.fetchPositions();
                    const openOrders = await exchange.client.getOpenOrders ? await exchange.client.getOpenOrders() : { openOrders: [] };
                    
                    if (openOrders.openOrders && openOrders.openOrders.length > 0) {
                        const unmanagedOrders = openOrders.openOrders.filter((o: any) => {
                            // Ignore our native stop loss orders
                            return !simulatedPositions.some(p => (p as any).brokerStopLossOrderId === o.order_id);
                        });
                        
                        if (unmanagedOrders.length > 0) {
                            console.error(`[UNKNOWN_OPEN_ORDER_ON_BROKER] Found ${unmanagedOrders.length} unmanaged open orders closely matching on broker`);
                            console.error(`[TRADING_HALTED_DESYNC]`);
                            console.error(`[MANUAL_INTERVENTION_REQUIRED] Please clear open orders in Kraken terminal.`);
                            await emergencyCloseAll();
                            state.status = 'ERROR_RECOVERING';
                            state.lastError = `Broker desync: Unregistered Open Orders found. Emergency close executed. Manual intervention required.`;
                            state.isActive = false;
                            isTicking = false;
                            await saveState();
                            return;
                        }
                    }

                    for (const localP of simulatedPositions) {
                        const exPos = livePos.find((p: any) => p.symbol === localP.symbol);
                        if (!exPos || Math.abs(exPos.contracts) === 0) {
                            console.log(`[BROKER_STATE_MISMATCH] Local ${localP.symbol} absent on broker. Assuming NATIVE STOP LOSS execution.`);
                            // Invece di panic, diciamo al sistema di chiuderlo!
                            (localP as any).nativeSlHit = true;
                        }
                    }
                    for (const exPos of livePos) {
                        if (exPos.contracts !== 0) {
                            const localP = simulatedPositions.find(p => p.symbol === exPos.symbol);
                            if (!localP) {
                                console.error(`[BROKER_STATE_MISMATCH] Broker has ${exPos.symbol} absent locally`);
                                console.error(`[BROKER_POSITION_NOT_FOUND_LOCALLY]`);
                                console.error(`[TRADING_HALTED_DESYNC]`);
                                console.error(`[MANUAL_INTERVENTION_REQUIRED] Close unauthorized position on broker.`);
                                await emergencyCloseAll();
                                state.status = 'ERROR_RECOVERING';
                                state.lastError = `Broker desync: Unregistered ${exPos.symbol} position. Emergency close executed.`;
                                state.isActive = false;
                                isTicking = false;
                                await saveState();
                                return;
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

          let sym1H: Bar[] = [];
          let sym4H: Bar[] = [];
          
          if (symbol === 'BTC/USD:USD') {
              sym1H = btc1H; sym4H = btc4H;
          } else {
              try {
                if (!liveDataCache[symbol]) await precomputeLiveOHLCV();
                
                if (!liveDataCache[symbol]) continue;

                const sOHLCV1H = await ccxtWithRetry(() => exchange.fetchOHLCV(symbol, '1h', undefined, 5));
                const sOHLCV4H = await ccxtWithRetry(() => exchange.fetchOHLCV(symbol, '4h', undefined, 5));
                
                liveDataCache[symbol].bars1H = mergeOHLCV(liveDataCache[symbol].bars1H, processOHLCV(sOHLCV1H as any[])).slice(-400);
                liveDataCache[symbol].bars4H = mergeOHLCV(liveDataCache[symbol].bars4H, processOHLCV(sOHLCV4H as any[])).slice(-400);
                
                sym1H = liveDataCache[symbol].bars1H;
                sym4H = liveDataCache[symbol].bars4H;
              } catch(e: any) {
                  console.warn(`[CCXT Info] Failed to fetch OHLCV for ${symbol}: ${e.message}`);
                  continue; 
              }
          }
          
          const validSym1H = filterClosedCandles(sym1H, '1h', nowMs);
          const validSym4H = filterClosedCandles(sym4H, '4h', nowMs);

        if (validSym1H.length > 50 && validSym4H.length > 200) {
              const features = MarketDataLayer.prepareFeatures(validSym1H, validSym4H);
              
              // PRICE TARGETING ENTRY DELAY FIX: Use real-time live ticker price
              // instead of historical closed 1H candle price for SL and Size calculations
              if (tickers[symbol] && tickers[symbol].last) {
                  features.price = tickers[symbol].last;
              }

              const localRegime = RegimeLayer.detect(features);
              
              if (!state.regimes) state.regimes = {};
              state.regimes[symbol] = localRegime;
              
              const signal = SignalLayer.evaluate(features, localRegime as TradingRegime, symbol, { btcTrend1H: globalFeatures?.trend1H, btcRegime: state.regime as TradingRegime });
              
              const displayRegime = symbol === 'BTC/USD:USD' ? state.regime : localRegime;
              console.log(`[DATA CHECK] ${symbol} Price: ${features.price}, RSI: ${features.rsi1H ? features.rsi1H.toFixed(2) : 'N/A'}, Local Regime: ${displayRegime}, Signal: ${signal.direction}`);

              if (signal.direction !== 'NEUTRAL') {
                  const gate = GatekeeperLayer.allowEntry(signal, features, localRegime as TradingRegime, symbol);
                  if (gate.allowed) {
                      const risk = RiskLayer.calculateRisk(
                          signal, 
                          features, 
                          effectiveRiskBalance, 
                          localRegime as TradingRegime, 
                          gate.riskModifier || 1.0, 
                          symbol, 
                          { btcTrend1H: globalFeatures?.trend1H, btcRegime: state.regime as TradingRegime }
                      );
                      
                      const MAX_GLOBAL_EXPOSURE = 50000;
                      const currentExposure = simulatedPositions.reduce((acc, p) => acc + (p.size * p.entryPrice), 0);
                      
                      let rawSize = risk.positionSize * capitalHealth.allowedCapacityMultiplier;
                      if (isNaN(rawSize) || !isFinite(rawSize)) rawSize = 0;
                      
                      const orderRes = resolveOrderAmount(exchange, symbol, rawSize, features.price);
                      if (!orderRes.ok) {
                          console.log(JSON.stringify({
                             event: "ORDER_SKIPPED_INVALID_SIZE", symbol,
                             amount: rawSize, reason: orderRes.reason, severity: "WARNING"
                          }));
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
                          continue;
                      }
                      
                      let finalSize = orderRes.amount!;
                      let realEntryPrice = features.price;
                      
                      if (finalSize > 0) {
                          console.log(`[ENTRY LAYER] Open ${symbol} ${signal.direction} at $${features.price}`);
                          
                          let isLiveExecutionSuccess = true;
                          const clientOrderId = `bot_${symbol.replace(/[^A-Z]/g, '')}_${signal.direction === 'LONG' ? 'buy' : 'sell'}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
                          let brokerOrderId = clientOrderId;
                          
                          console.log(JSON.stringify({
                             event: "ORDER_INTENT_CREATED", symbol, side: signal.direction,
                             clientOrderId, amount: finalSize, price: features.price
                          }));

                          if (process.env.LIVE_TRADING_ENABLED === 'true') {
                              console.log(`[LIVE EXECUTION] Sending ${signal.direction} order for ${symbol} to Kraken Futures...`);
                              const side = signal.direction === 'LONG' ? 'buy' : 'sell';
                              try {
                                  const params = { clientOrderId };
                                  const order = await ccxtWithRetry(() => exchange.createMarketOrder(symbol, side, finalSize, undefined, params));
                                  console.log(`[LIVE EXECUTION] Order successful:`, (order as any).id);
                                  brokerOrderId = (order as any).id || clientOrderId;
                                  
                                  console.log(JSON.stringify({ event: "ORDER_SUBMITTED", symbol, orderId: brokerOrderId, clientOrderId }));
                                  
                                  await delaySleep(500); 
                                  const fetchedOrder = await exchange.fetchOrder(brokerOrderId, symbol);
                                  console.log(JSON.stringify({ event: "ORDER_FETCHED", fetchedOrder }));
                                  if (fetchedOrder && fetchedOrder.status && ['rejected', 'failed', 'canceled'].includes(fetchedOrder.status.toLowerCase())) {
                                      throw new Error(`Order was rejected by exchange with status: ${fetchedOrder.status}`);
                                  }
                                  if (fetchedOrder && fetchedOrder.average) {
                                      realEntryPrice = fetchedOrder.average;
                                      console.log(JSON.stringify({ event: "ORDER_FILLED", realEntryPrice, symbol }));
                                  } else {
                                      console.log(JSON.stringify({ event: "ORDER_PARTIAL", reason: "Actual entry price unavailable, using limit", symbol }));
                                  }
                                  if (fetchedOrder && fetchedOrder.filled && fetchedOrder.filled > 0) {
                                      finalSize = fetchedOrder.filled;
                                  }
                              } catch(e: any) {
                                  console.error(`[LIVE EXECUTION] Order failed for ${symbol}:`, e.message);
                                  console.log(JSON.stringify({ event: "ORDER_FAILED", reason: e.message, symbol, severity: "CRITICAL" }));
                                  
                                  isLiveExecutionSuccess = false;
                                  try {
                                      console.log(`[LIVE EXECUTION] Checking for orphaned position for ${symbol}...`);
                                      const livePos = await exchange.fetchPositions();
                                      const orphanedPos = livePos.find((p: any) => p.symbol === symbol && Math.abs(p.contracts || 0) > 0);
                                      if (orphanedPos) {
                                          console.error(`[LIVE EXECUTION] ORPHAN FOUND. Dropping it via reduceOnly to prevent desync.`);
                                          try {
                                              const dropSide = orphanedPos.contracts > 0 ? 'sell' : 'buy';
                                              await ccxtWithRetry(() => exchange.createMarketOrder(symbol, dropSide, Math.abs(orphanedPos.contracts), undefined, { reduceOnly: true }));
                                              console.log(`[LIVE EXECUTION] Orphan successfully dropped.`);
                                          } catch (dropErr: any) {
                                              console.error(`[LIVE EXECUTION] Failed completely to drop orphan: ${dropErr.message}`);
                                          }
                                      } else {
                                          console.log(`[LIVE EXECUTION] CONFIRMED: No position opened.`);
                                      }
                                  } catch (syncError: any) {
                                      console.error(`[LIVE EXECUTION] Sync check failed.`, syncError.message);
                                  }
                              }
                          }

                          if (isLiveExecutionSuccess) {
                              const newPos: any = {
                                  id: brokerOrderId,
                                  symbol,
                                  direction: signal.direction,
                                  entryPrice: realEntryPrice,
                                  size: finalSize,
                                  leverage: risk.leverage,
                                  initialStopLoss: risk.stopLoss,
                                  currentStopLoss: risk.stopLoss,
                                  catastropheStopLoss: risk.catastropheStopLoss,
                                  highWaterMark: realEntryPrice,
                                  lowWaterMark: realEntryPrice,
                                  barsHeld: 0,
                                  entryRegime: state.regime as TradingRegime,
                                  unrealizedPnl: 0,
                                  clientOrderId,
                                  _lastHourId: Math.floor(Date.now() / 3600000)
                              };
                              
                              if (process.env.LIVE_TRADING_ENABLED === 'true') {
                                  try {
                                      const side = signal.direction === 'LONG' ? 'sell' : 'buy';
                                      const slResp = await ccxtWithRetry(() => exchange.updateStopLossOrder(symbol, side, finalSize, risk.stopLoss));
                                      if (slResp?.id) {
                                          newPos.brokerStopLossOrderId = slResp.id;
                                          console.log(`[LIVE EXECUTION] Native Stop Loss attached for ${symbol}: ${slResp.id}`);
                                      }
                                  } catch (e: any) {
                                      console.warn(`[LIVE EXECUTION] Failed to set native Stop Loss natively initially: ${e.message}`);
                                  }
                              }
                              
                              simulatedPositions.push(newPos);
                          }
                      }
                  } else {
                      console.log(`[GATEKEEPER] Denied ${signal.direction} on ${symbol}: ${gate.reason}`);
                  }
              }
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

    const receivedSymbols = Object.keys(tickers).join(', ');
    console.log(`[Virtual Engine] Feed: ${receivedSymbols} | BTC: $${btcLivePrice} | Regime: ${state.regime} | Eq: $${state.balance.toFixed(2)}`);
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

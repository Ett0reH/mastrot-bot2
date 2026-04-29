import ccxt from 'ccxt';
import "dotenv/config";
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
  lastUpdate: string;
  lastError?: string;
  botSecret?: string;
  equityHistory?: { time: string, equity: number }[];
  metricsHistory?: any[];
  maxHistoricalEquity?: number;
  warmupUntil?: number;
}

// Emulated virtual wallet state
let state: LiveState = {
  isActive: false,
  status: 'STOPPED',
  balance: 10000.00, // Virtual starting balance
  baseBalance: 10000.00,
  openPositions: [],
  recentTrades: [],
  regime: 'UNKNOWN',
  lastUpdate: new Date().toISOString(),
  botSecret: BOT_SECRET,
  equityHistory: [],
  maxHistoricalEquity: 10000.00
};

let exchange: any = null;
let pollInterval: NodeJS.Timeout | null = null;
let simulatedPositions: ActiveTrade[] = [];

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
  exchange = new ccxt.krakenfutures({
    apiKey: process.env.KRAKEN_API_KEY,
    secret: process.env.KRAKEN_SECRET_KEY,
    enableRateLimit: true,
    timeout: 30000 // enforce 30s ccxt timeout
  });
  exchange.setSandboxMode(true); // Ensure all execution goes to https://demo-futures.kraken.com/
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
      
      const isTransient = 
        error instanceof ccxt.NetworkError || 
        error instanceof ccxt.ExchangeError || 
        error.message?.includes('Rate limit exceeded') ||
        error.message?.includes('timeout') ||
        error.message?.includes('network') ||
        error.message?.includes('ECONNRESET') ||
        error.message?.includes('502') ||
        error.message?.includes('503 Service Unavailable');
      
      if (isTransient) {
        console.warn(`[Retry ${i + 1}/${retries}] CCXT Transient Error: ${error.message}. Retrying in ${delay}ms...`);
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
  
  // Base balance doesn't update until trade closes. Wait.
  // Actually, let's liquidate virtual positions to save the realized profit into base balance
  if (state.openPositions && state.openPositions.length > 0) {
    for (const p of state.openPositions) {
        // We need the current ticker to evaluate PnL. For simplicity on stop, we just keep the base unchanged unless we explicitly fetch.
        // For accurate tracking, use floating PnL from latest snapshot. 
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

export async function resetPaperTrading() {
  if (!initialStateLoaded) {
    if (!loadStatePromise) loadStatePromise = loadInitialState().catch(e => { loadStatePromise = null; throw e; });
    await loadStatePromise;
  }
  
  state = {
    isActive: false,
    status: 'STOPPED',
    balance: 10000.00,
    baseBalance: 10000.00,
    openPositions: [],
    recentTrades: [],
    regime: 'UNKNOWN',
    lastUpdate: new Date().toISOString(),
    botSecret: BOT_SECRET,
    equityHistory: [],
    metricsHistory: [],
    maxHistoricalEquity: 10000.00,
    warmupUntil: undefined
  };
  
  simulatedPositions = [];
  isTicking = false;
  
  await saveState();
  return state;
}

const TARGET_SYMBOLS = ['BTC/USD:USD', 'ETH/USD:USD', 'SOL/USD:USD', 'XRP/USD:USD', 'LINK/USD:USD', 'DOGE/USD:USD'];

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

async function precomputeLiveOHLCV() {
    console.log("Precomputing OHLCV...");
    const symbolsToPreload = Array.from(new Set(['BTC/USD:USD', ...TARGET_SYMBOLS]));
    for (const symbol of symbolsToPreload) {
        try {
            console.log(`Downloading ${symbol} [1H/4H]...`);
            const ohlcv1H = await ccxtWithRetry(() => exchange!.fetchOHLCV(symbol, '1h', undefined, 55));
            const ohlcv4H = await ccxtWithRetry(() => exchange!.fetchOHLCV(symbol, '4h', undefined, 210));
            liveDataCache[symbol] = {
                bars1H: processOHLCV(ohlcv1H),
                bars4H: processOHLCV(ohlcv4H),
            };
        } catch (e: any) {
            console.error(`Failed to precompute OHLCV for ${symbol}: ${e.message}`);
        }
    }
}

async function loopTick() {
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
        
        liveDataCache['BTC/USD:USD'].bars1H = mergeOHLCV(liveDataCache['BTC/USD:USD'].bars1H, processOHLCV(ohlcv1H)).slice(-55);
        liveDataCache['BTC/USD:USD'].bars4H = mergeOHLCV(liveDataCache['BTC/USD:USD'].bars4H, processOHLCV(ohlcv4H)).slice(-210);
        
        btc1H = liveDataCache['BTC/USD:USD'].bars1H;
        btc4H = liveDataCache['BTC/USD:USD'].bars4H;
        
        if (btc1H.length > 50 && btc4H.length > 200) {
            globalFeatures = MarketDataLayer.prepareFeatures(btc1H, btc4H);
            state.regime = RegimeLayer.detect(globalFeatures);
            btcLivePrice = btc1H[btc1H.length - 1].c;
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
        
        const livePrice = t.last;
        let floatingPnl = 0;
        
        // Pseudo-Feature struct for the Exit Layer to use real-time tick 
        const mockFeatures = { ...globalFeatures, price: livePrice } as any; 

        let exitDecision = PositionExitLayer.monitorAndExit(p, mockFeatures, state.regime as TradingRegime);

        if (exitDecision.shouldExit) {
            console.log(`[EXIT LAYER] Closing ${p.symbol} ${p.direction} at $${livePrice}. Reason: ${exitDecision.exitType}`);
            
            let isLiveExitSuccess = true;
            if (process.env.LIVE_TRADING_ENABLED === 'true') {
                 const side = p.direction === 'LONG' ? 'sell' : 'buy';
                 try {
                     console.log(`[LIVE EXECUTION] Sending ${side} exit order for ${p.symbol} to Kraken Futures...`);
                     const order = await ccxtWithRetry(() => exchange.createMarketOrder(p.symbol, side, p.size));
                     console.log(`[LIVE EXECUTION] Exit order successful:`, order.id);
                 } catch(e: any) {
                     console.error(`[LIVE EXECUTION] Exit order failed for ${p.symbol}:`, e.message);
                     isLiveExitSuccess = false;
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

            state.recentTrades = state.recentTrades || [];
            state.recentTrades.unshift({
                symbol: p.symbol,
                side: p.direction,
                entry: p.entryPrice,
                exit: livePrice,
                pnl: floatingPnl,
                reason: exitDecision.exitType,
                time: new Date().toISOString()
            });
            if (state.recentTrades.length > 50) state.recentTrades.pop();
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
                
                liveDataCache[symbol].bars1H = mergeOHLCV(liveDataCache[symbol].bars1H, processOHLCV(sOHLCV1H)).slice(-55);
                liveDataCache[symbol].bars4H = mergeOHLCV(liveDataCache[symbol].bars4H, processOHLCV(sOHLCV4H)).slice(-210);
                
                sym1H = liveDataCache[symbol].bars1H;
                sym4H = liveDataCache[symbol].bars4H;
              } catch(e: any) {
                  console.warn(`[CCXT Info] Failed to fetch OHLCV for ${symbol}: ${e.message}`);
                  continue; 
              }
          }
          
          if (sym1H.length > 50 && sym4H.length > 200) {
              const features = MarketDataLayer.prepareFeatures(sym1H, sym4H);
              const signal = SignalLayer.evaluate(features, state.regime as TradingRegime, symbol, { btcTrend1H: globalFeatures?.trend1H, btcRegime: state.regime as TradingRegime });
              
              if (symbol === 'BTC/USD:USD') {
                  console.log(`[DATA CHECK] ${symbol} Price: ${features.price}, RSI: ${features.rsi1H ? features.rsi1H.toFixed(2) : 'N/A'}, Regime: ${state.regime}, Signal: ${signal.direction}`);
              }

              if (signal.direction !== 'NEUTRAL') {
                  const gate = GatekeeperLayer.allowEntry(signal, features, state.regime as TradingRegime, symbol);
                  if (gate.allowed) {
                      const risk = RiskLayer.calculateRisk(
                          signal, 
                          features, 
                          state.balance, 
                          state.regime as TradingRegime, 
                          gate.riskModifier || 1.0, 
                          symbol, 
                          { btcTrend1H: globalFeatures?.trend1H, btcRegime: state.regime as TradingRegime }
                      );
                      
                      let finalSize = risk.positionSize * capitalHealth.allowedCapacityMultiplier;
                      if (isNaN(finalSize) || !isFinite(finalSize)) finalSize = 0;
                      
                      if (finalSize > 0) {
                          console.log(`[ENTRY LAYER] Open ${symbol} ${signal.direction} at $${features.price}`);
                          
                          let isLiveExecutionSuccess = true;
                          let brokerOrderId = `t_${Date.now()}_${symbol}`;

                          if (process.env.LIVE_TRADING_ENABLED === 'true') {
                              console.log(`[LIVE EXECUTION] Sending ${signal.direction} order for ${symbol} to Kraken Futures...`);
                              const side = signal.direction === 'LONG' ? 'buy' : 'sell';
                              try {
                                  // For Kraken Futures, we execute a market order
                                  const order = await ccxtWithRetry(() => exchange.createMarketOrder(symbol, side, finalSize));
                                  console.log(`[LIVE EXECUTION] Order successful:`, order.id);
                                  brokerOrderId = order.id;
                              } catch(e: any) {
                                  console.error(`[LIVE EXECUTION] Order failed for ${symbol}:`, e.message);
                                  isLiveExecutionSuccess = false;
                              }
                          }

                          if (isLiveExecutionSuccess) {
                              simulatedPositions.push({
                                  id: brokerOrderId,
                                  symbol,
                                  direction: signal.direction,
                                  entryPrice: features.price,
                                  size: finalSize,
                                  leverage: risk.leverage,
                                  initialStopLoss: risk.stopLoss,
                                  currentStopLoss: risk.stopLoss,
                                  catastropheStopLoss: risk.catastropheStopLoss,
                                  highWaterMark: features.price,
                                  lowWaterMark: features.price,
                                  barsHeld: 0,
                                  entryRegime: state.regime as TradingRegime,
                                  unrealizedPnl: 0
                              } as ActiveTrade);
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
    
    const receivedSymbols = Object.keys(tickers).join(', ');
    console.log(`[Virtual Engine] Feed: ${receivedSymbols} | BTC: $${btcLivePrice} | Regime: ${state.regime} | Eq: $${state.balance.toFixed(2)}`);
  } catch (error: any) {
    const isTransientError = 
        error instanceof ccxt.NetworkError || 
        error instanceof ccxt.ExchangeError || 
        error.message?.includes('Rate limit exceeded') ||
        error.message?.includes('timeout') ||
        error.message?.includes('network') ||
        error.message?.includes('ECONNRESET');

    if (isTransientError) {
        console.warn(`[Transient Tick Error]: ${error.message}. Will retry next tick. Bot remains active.`);
    } else {
        console.error('Tick Error (Recovering):', error);
        // Invece di spegnere il bot (state.isActive = false), lo mettiamo in stato di recupero.
        // Il bot fallisce solo questo tick e ritenterà l'esecuzione al prossimo cron/ping.
        state.status = 'ERROR_RECOVERING';
        state.lastError = error.message;
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

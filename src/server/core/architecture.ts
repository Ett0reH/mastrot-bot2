export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type TradingRegime =
  | "BULL"
  | "BEAR"
  | "CRASH"
  | "EUPHORIA"
  | "TRANSITION"
  | "UNKNOWN";
export type SignalDirection = "LONG" | "SHORT" | "NEUTRAL";
export type ExitReason =
  | "STOP_LOSS" // legacy
  | "TRAILING_STOP" // legacy
  | "MAX_BARS" // legacy
  | "EMERGENCY_EXIT" // legacy
  | "INITIAL_STOP_LOSS"
  | "PROFIT_STOP"
  | "TRAILING_PROFIT_STOP"
  | "TRAILING_STOP_LOSS"
  | "CATASTROPHE_STOP"
  | "SIGNAL_EXIT"
  | "EDGE_DECAY"
  | "EDGE_DECAY_EARLY"
  | "EDGE_DECAY_NORMAL_LESS_AGGRESSIVE"
  | "EDGE_DECAY_EXTREME_UNCHANGED"
  | "REGIME_DERISK"
  | "END_OF_DATA"
  | "INVALIDATED_DATA_GAP"
  | "NONE";

// Feature Flags per evoluzione incrementale
export const FEATURE_FLAGS = {
  ENHANCED_PULLBACK: true, // Fase 1: Filtro anti-coltello cadente sui pullback
  DATA_GAP_VALIDATION: true, // Fase 0: Validazione buchi dati nel backtester
  SEMANTIC_EXIT_REASONS: true, // Fase 1: Classificazione semantica uscite
  SETUP_EXPECTANCY_FILTER: true, // Fase 3: Enable filtering setups based on historical expectancy
  CHOP_REGIME: true, // Fase 4: Overlay per bloccare trade in regime laterale
  ENABLE_CONFIRMED_PULLBACKS: false, // Fase 6: Pullback confermati BULL/BEAR
  ENABLE_BREAKOUT_RETEST: true, // Fase 7: Settato off di default
  ENABLE_PARTIAL_TAKE_PROFIT: false, // Fase 8: Gestione posizione Parziale (Harvest + Runner)
  enableProgressiveEdgeDecay: true, // Fase 9: MFE/MAE based early exit
  enableLessAggressiveEdgeDecayNormal: true, // Edge decay prudente solo per Normal
  enableQualityGatedLeverage: true, // Fase 10: Quality-Gated Leverage
  enableTradeBudgetPerCandle: false, // Fase 11: Trade Budget Per Candela e Correlazione
};

export const EDGE_DECAY_CONFIG = {
  extreme: {
    enabled: true,
    firstCheckBars: 8,
    hardExitBars: 16,
    minProgressRForEarlyAction: 0.5,
    riskReductionFactor: 0.5 // keeps 50% of the initial risk
  },
  normal: {
    enabled: true,
    mode: "LESS_AGGRESSIVE",
    firstCheckBars: 12,
    hardExitBars: 24,
    minProgressRForEarlyAction: 0.5,
    requireBelowEntryForHardExit: false,
    reduceStopInsteadOfClose: true,
    riskReductionFactor: 0.75 // keeps 75% of the initial risk (softer stop tightening)
  }
};

// Common Math Utilities
export const MathUtils = {
  getSMA: (arr: number[], period: number) =>
    arr.length >= period
      ? arr.slice(-period).reduce((a, b) => a + b, 0) / period
      : null,
  getATR: (bars: Bar[], period: number) => {
    if (bars.length < period + 1) return null;
    let trSum = 0;
    for (let i = bars.length - period; i < bars.length; i++) {
      const high = bars[i].h,
        low = bars[i].l,
        prevClose = bars[i - 1].c;
      trSum += Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose),
      );
    }
    return trSum / period;
  },
  getRSI: (arr: number[], period: number): number | null => {
    if (arr.length <= period) return null;
    let gains = 0,
      losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = arr[i] - arr[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < arr.length; i++) {
      const change = arr[i] - arr[i - 1];
      if (change > 0) {
        avgGain = (avgGain * (period - 1) + change) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) - change) / period;
      }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  },
  getStdDev: (arr: number[], mean: number) => {
    if (arr.length === 0) return 0;
    return Math.sqrt(
      arr.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / arr.length,
    );
  },
  getEMA: (arr: number[], period: number) => {
    if (arr.length < period) return null;
    const k = 2 / (period + 1);
    let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < arr.length; i++) {
      ema = (arr[i] - ema) * k + ema;
    }
    return ema;
  },
  getBollingerBands: (arr: number[], period: number, mult: number) => {
    if (arr.length < period) return null;
    const slice = arr.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const stdDev = Math.sqrt(slice.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / period);
    return {
      upper: mean + stdDev * mult,
      middle: mean,
      lower: mean - stdDev * mult
    };
  },
  getADX: (bars: Bar[], period: number) => {
    if (bars.length <= period) return null;
    let smoothedTR = 0;
    let smoothedPlusDM = 0;
    let smoothedMinusDM = 0;
    
    // Initial smoothing
    for (let i = 1; i <= period; i++) {
        const h0 = bars[i-1].h, l0 = bars[i-1].l, c0 = bars[i-1].c;
        const h1 = bars[i].h, l1 = bars[i].l, c1 = bars[i-1].c;
        const tr = Math.max(h1 - l1, Math.abs(h1 - c0), Math.abs(l1 - c0));
        let plusDM = h1 - h0 > l0 - l1 ? Math.max(h1 - h0, 0) : 0;
        let minusDM = l0 - l1 > h1 - h0 ? Math.max(l0 - l1, 0) : 0;
        smoothedTR += tr;
        smoothedPlusDM += plusDM;
        smoothedMinusDM += minusDM;
    }

    let dxArray: number[] = [];
    
    for (let i = period + 1; i < bars.length; i++) {
        const h0 = bars[i-1].h, l0 = bars[i-1].l, c0 = bars[i-1].c;
        const h1 = bars[i].h, l1 = bars[i].l, c1 = bars[i-1].c;
        const tr = Math.max(h1 - l1, Math.abs(h1 - c0), Math.abs(l1 - c0));
        let plusDM = h1 - h0 > l0 - l1 ? Math.max(h1 - h0, 0) : 0;
        let minusDM = l0 - l1 > h1 - h0 ? Math.max(l0 - l1, 0) : 0;

        smoothedTR = smoothedTR - (smoothedTR / period) + tr;
        smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDM;
        smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDM;

        const plusDI = (smoothedPlusDM / smoothedTR) * 100;
        const minusDI = (smoothedMinusDM / smoothedTR) * 100;
        const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
        dxArray.push(dx);
    }
    
    if (dxArray.length < period) return null;
    
    let adx = dxArray.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < dxArray.length; i++) {
        adx = ((adx * (period - 1)) + dxArray[i]) / period;
    }
    return adx;
  }
};

// 1. MARKET DATA LAYER
// Reads OHLCV, calculates volatility, momentum, statistical features.
export class MarketDataLayer {
  static prepareFeatures(bars1H: Bar[], bars4H: Bar[], isH4Closed: boolean = false) {
    const closes1H = bars1H.map((b) => b.c);
    const closes4H = bars4H.map((b) => b.c);

    const atr1H =
      MathUtils.getATR(bars1H.slice(-15), 14) ||
      closes1H[closes1H.length - 1] * 0.02;
    const atr4H =
      MathUtils.getATR(bars4H.slice(-15), 14) ||
      closes4H[closes4H.length - 1] * 0.02;

    const atr1H_prev =
      MathUtils.getATR(bars1H.slice(-16, -1), 14) ||
      closes1H[closes1H.length - 2] * 0.02;

    const rsi1H = MathUtils.getRSI(closes1H, 14) || 50;
    const rsi1H_prev = MathUtils.getRSI(closes1H.slice(0, -1), 14) || 50;
    const rsi2_1H = MathUtils.getRSI(closes1H, 2) || 50;
    const sma50_1H =
      MathUtils.getSMA(closes1H, 50) || closes1H[closes1H.length - 1];
    const sma200_4H =
      MathUtils.getSMA(closes4H, 200) || closes4H[closes4H.length - 1];
    
    const ema50_1H = MathUtils.getEMA(closes1H, 50) || closes1H[closes1H.length - 1];
    const ema200_1H = MathUtils.getEMA(closes1H, 200) || closes1H[closes1H.length - 1];
    
    const rsi2_4H = MathUtils.getRSI(closes4H, 2) || 50;
    const ema50_4H = MathUtils.getEMA(closes4H, 50) || closes4H[closes4H.length - 1];
    const ema200_4H = MathUtils.getEMA(closes4H, 200) || closes4H[closes4H.length - 1];
    
    const adx_1H = MathUtils.getADX(bars1H, 14) || 0;
    const bollinger_1H = MathUtils.getBollingerBands(closes1H, 20, 2.2);

    const prevHigh_1H = bars1H[bars1H.length - 2].h;
    const currentHigh_1H = bars1H[bars1H.length - 1].h;
    const currentLow_1H = bars1H[bars1H.length - 1].l;
    const prevLow_1H = bars1H[bars1H.length - 2].l;

    const lastC = closes1H[closes1H.length - 1];
    const volPct = (atr4H / lastC) * 100;

    // Volatility regime scaling (Z-score of recent volatility vs normal)
    const recentVol = closes1H
      .slice(-20)
      .map((v, i, arr) => (i > 0 ? Math.abs(v - arr[i - 1]) / arr[i - 1] : 0));
    const meanVol =
      recentVol.reduce((a, b) => a + b, 0) / (recentVol.length || 1);
    const stdDevVol = MathUtils.getStdDev(recentVol, meanVol);
    const lastVol = recentVol[recentVol.length - 1];
    const volZScore = stdDevVol === 0 ? 0 : (lastVol - meanVol) / stdDevVol;

    // Fase 4: Chop Regime definition
    const rsiChop = rsi1H >= 42 && rsi1H <= 58; // RSI strictly compressed
    const volChop = volZScore < -0.5; // Volatility significantly below recent mean
    const priceNearSma = Math.abs(lastC - sma50_1H) / sma50_1H < 0.02; // Tight range near moving average
    const isChop = rsiChop && volChop && priceNearSma;

    // FASE 7: Breakout & Retest candidates
    // Look back N bars to define a resistance/support box
    const lookbackBars = bars1H.slice(-25, -5);
    const recentBars = bars1H.slice(-5);
    let resistance = -Infinity;
    let support = Infinity;
    if (lookbackBars.length > 0) {
      resistance = Math.max(...lookbackBars.map(b => b.h));
      support = Math.min(...lookbackBars.map(b => b.l));
    }
    const currentOpen_1H = bars1H[bars1H.length - 1].o;
    const isBullBar = lastC > currentOpen_1H;
    const isBearBar = lastC < currentOpen_1H;

    // LONG: broke above resistance recently, and retesting it now (low touched resistance zone)
    const brokeResistance = recentBars.some(b => b.c > resistance);
    const retestedResistance = recentBars.some(b => b.l <= resistance + atr1H * 0.5 && b.l >= resistance - atr1H * 1.5);
    let isBreakoutRetestLong = brokeResistance && retestedResistance && (lastC > resistance) && isBullBar;

    // SHORT: broke below support recently, and retesting it now (high touched support zone)
    const brokeSupport = recentBars.some(b => b.c < support);
    const retestedSupport = recentBars.some(b => b.h >= support - atr1H * 0.5 && b.h <= support + atr1H * 1.5);
    let isBreakoutRetestShort = brokeSupport && retestedSupport && (lastC < support) && isBearBar;

    return {
      price: lastC,
      atr1H,
      atr1H_prev,
      atr4H,
      rsi1H,
      rsi1H_prev,
      sma50_1H,
      sma200_4H,
      prevHigh_1H,
      currentHigh_1H,
      prevLow_1H,
      currentLow_1H,
      volPct,
      volZScore,
      isChop,
      isBreakoutRetestLong,
      isBreakoutRetestShort,
      trend1H: lastC > sma50_1H ? 1 : -1,
      trend4H: lastC > sma200_4H ? 1 : -1,
      rsi2_1H,
      ema50_1H,
      ema200_1H,
      rsi2_4H,
      ema50_4H,
      ema200_4H,
      isH4Closed,
      adx_1H,
      bollinger_1H,
      t: bars1H[bars1H.length - 1].t
    };
  }
}

// 2. REGIME LAYER
// Implements Hidden Markov Model (HMM) proxy. Uses probabilistic bounds to detect regime shift.
export class RegimeLayer {
  // Basic Transition Matrix probabilities representation (P_ij = P(State_j | State_i))
  // We proxy the emission probabilities via volZScore & Price/SMA distance.
  static detect(
    features: ReturnType<typeof MarketDataLayer.prepareFeatures>,
  ): TradingRegime {
    const distFromSMA =
      (features.price - features.sma200_4H) / features.sma200_4H;

    // High volatility shock emission
    if (features.volPct > 4.5 || features.volZScore > 3.0) {
      if (distFromSMA < -0.1) return "CRASH";
      if (distFromSMA > 0.15) return "EUPHORIA";
      return "TRANSITION";
    }

    // Standard emission states
    if (features.trend4H === 1) {
      if (distFromSMA > 0.25) return "EUPHORIA"; // Way above multi-month mean
      if (features.rsi1H < 40 && features.trend1H === -1) return "TRANSITION"; // Pullback in bull
      return "BULL";
    } else {
      if (distFromSMA < -0.25) return "CRASH"; // Way below multi-month mean
      if (features.rsi1H > 60 && features.trend1H === 1) return "TRANSITION"; // Relief rally in bear
      return "BEAR";
    }
  }
}

// 3. SIGNAL LAYER (Fase 5 - Refactored Engines)

export interface SignalContext {
  features: ReturnType<typeof MarketDataLayer.prepareFeatures>;
  regime: TradingRegime;
  symbol: string;
  globalFeatures?: { btcTrend1H?: number; btcRegime?: TradingRegime };
}

export interface SignalCandidate {
  direction: SignalDirection;
  quality: number;
  type: string;
  engine: "EXTREME" | "NORMAL" | "NONE";
  meta?: any;
}

export function generateExtremeSignals(context: SignalContext): SignalCandidate {
  const { features, regime } = context;
  // Mean Reversion in CRASH
  if (regime === "CRASH" && features.rsi1H < 25) {
    return { direction: "LONG", quality: 0.9, type: "MEAN_REVERSION", engine: "EXTREME" };
  }
  // Mean Reversion in EUPHORIA (OMEGA NEW FIX: Shorting the absolute blow-off top)
  if (regime === "EUPHORIA" && features.rsi1H > 85) {
    return { direction: "SHORT", quality: 0.9, type: "MEAN_REVERSION", engine: "EXTREME" };
  }
  return { direction: "NEUTRAL", quality: 0, type: "NONE", engine: "NONE" };
}

export const PullbackMetrics = {
  candidates: 0,
  confirmed: 0,
  blocked: 0,
  reasons: {} as Record<string, number>,
};

export const BreakoutRetestMetrics = {
  candidates: 0,
  confirmed: 0,
  retestFailed: 0, // when the retest was supposed to be short but failed
  blocked: 0,
  reasons: {} as Record<string, number>,
};

export const RiskTierConfig = {
  EXTREME_CLEAN: { exposure: 0.10, label: "EXTREME_10" },
  EXTREME_FALLBACK: { exposure: 0.05, label: "EXTREME_FALLBACK_5" },
  NORMAL_BASE: { exposure: 0.05, label: "NORMAL_5" },
  NORMAL_UPGRADED: { exposure: 0.07, label: "NORMAL_UPGRADED" },
  NORMAL_DOWNGRADED: { exposure: 0.03, label: "NORMAL_DOWNGRADED" },
  TRANSITION_BLOCKED: { exposure: 0.0, label: "TRANSITION_BLOCKED" }
};

interface TradeContext {
  engine: "EXTREME" | "NORMAL" | "NONE";
  gapMinutes: number;
  regime: string;
  setup: string;
}

interface ClusterStats {
  cleanProfitFactor: number;
}

export function isTradeDataClean(tradeContext: TradeContext): boolean {
  return tradeContext.gapMinutes <= 60;
}

export function resolveRiskTier(tradeContext: TradeContext, clusterStats: ClusterStats): {
  exposurePct: number;
  blocked: boolean;
  fallback: boolean;
  reason: string;
  cleanPFUsed: number;
  tierLabel: string;
} {
  const isClean = isTradeDataClean(tradeContext);
  const { engine, regime, setup } = tradeContext;

  if (regime === "TRANSITION") {
     return {
       exposurePct: RiskTierConfig.TRANSITION_BLOCKED.exposure,
       blocked: true,
       fallback: false,
       reason: "TRANSITION regime blocks entries",
       cleanPFUsed: clusterStats.cleanProfitFactor,
       tierLabel: RiskTierConfig.TRANSITION_BLOCKED.label
     };
  }

  if (setup === "BREAKOUT_RETEST" && regime === "TRANSITION") {
     return {
       exposurePct: RiskTierConfig.TRANSITION_BLOCKED.exposure,
       blocked: true,
       fallback: false,
       reason: "BREAKOUT_RETEST blocked in TRANSITION",
       cleanPFUsed: clusterStats.cleanProfitFactor,
       tierLabel: RiskTierConfig.TRANSITION_BLOCKED.label
     };
  }

  if (engine === "EXTREME") {
    if (isClean) {
      return {
        exposurePct: RiskTierConfig.EXTREME_CLEAN.exposure,
        blocked: false,
        fallback: false,
        reason: "EXTREME engine + clean data",
        cleanPFUsed: clusterStats.cleanProfitFactor,
        tierLabel: RiskTierConfig.EXTREME_CLEAN.label
      };
    } else {
      return {
        exposurePct: RiskTierConfig.EXTREME_FALLBACK.exposure,
        blocked: false, // fallback
        fallback: true,
        reason: "EXTREME engine + data gap fallback",
        cleanPFUsed: clusterStats.cleanProfitFactor,
        tierLabel: RiskTierConfig.EXTREME_FALLBACK.label
      };
    }
  }

  if (engine === "NORMAL") {
    if (isClean && clusterStats.cleanProfitFactor >= 1.20) {
      return {
        exposurePct: RiskTierConfig.NORMAL_UPGRADED.exposure,
        blocked: false,
        fallback: false,
        reason: "NORMAL engine + upgraded exposure (PF >= 1.20)",
        cleanPFUsed: clusterStats.cleanProfitFactor,
        tierLabel: RiskTierConfig.NORMAL_UPGRADED.label
      };
    } else if (clusterStats.cleanProfitFactor < 1.0) {
      return {
        exposurePct: RiskTierConfig.NORMAL_DOWNGRADED.exposure,
        blocked: false,
        fallback: !isClean,
        reason: "NORMAL engine + downgraded exposure (PF < 1.0)",
        cleanPFUsed: clusterStats.cleanProfitFactor,
        tierLabel: RiskTierConfig.NORMAL_DOWNGRADED.label
      };
    } else {
      return {
        exposurePct: RiskTierConfig.NORMAL_BASE.exposure,
        blocked: false,
        fallback: !isClean,
        reason: isClean ? "NORMAL engine base exposure" : "NORMAL engine + data gap",
        cleanPFUsed: clusterStats.cleanProfitFactor,
        tierLabel: RiskTierConfig.NORMAL_BASE.label
      };
    }
  }

  return {
    exposurePct: 0.05,
    blocked: false,
    fallback: false,
    reason: "DEFAULT",
    cleanPFUsed: clusterStats.cleanProfitFactor,
    tierLabel: "DEFAULT"
  };
}

export const TradeBudgetMetrics = {
  totalValidSignals: 0,
  executedSignals: 0,
  skippedSignals: 0,
  newPositionsDistribution: {} as Record<number, number>,
  NormalCleanGrossProfit: 0,
  NormalCleanGrossLoss: 0,
};

export const NormalRsi2TrendTrailingConfig = {
  enabled: true,
  allowLong: true,
  allowShort: false,
  rsiLength: 2,
  rsiLongThreshold: 10,
  fastMaLength: 50,
  slowMaLength: 200,
  maType: "EMA",
  longTrailingStopPercent: 0.02,
  cooldownBarsAfterExit: 1,
  allowedNormalSubRegimes: ["BULL"],
  blockedNormalSubRegimes: ["BEAR"],
};

export const NormalRsi2TrendTrailingStats = {
  candidatesLong: 0,
  entriesLong: 0,
  pnlLong: 0,
  pfLong: 0,
  winRateLong: 0,

  shortArmedSetups: 0,
  shortConfirmedSetups: 0,
  shortExpiredSetups: 0,
  shortRejectedNoRejection: 0,
  shortRejectedRegimeChanged: 0,
  shortRejectedCloseAboveEma50: 0,
  entriesShort: 0,
  pnlShort: 0,
  pfShort: 0,
  winRateShort: 0,

  totalNormalTrades: 0,
  totalNormalPnL: 0,
  totalNormalPF: 0,
  totalNormalWinRate: 0,

  blockedByRegime: 0,
  blockedByExistingPosition: 0,
  blockedByCooldown: 0,
  exitsByTrailingStop: 0,
  
  extremeSignalsBlockedByNormalPosition: 0,
  normalSignalsBlockedByExtremePosition: 0,
};

interface ArmedShortSetup {
  armedTime: string; // we'll use candle block abstractly or something, or just an armed flag
  armedClose: number;
  armedRsi2: number;
  armedEma50: number;
  armedEma200: number;
}
export const normalShortSetups: Record<string, ArmedShortSetup | null> = {};

export function generateNormalMarketSignals(context: SignalContext): SignalCandidate {
  const { features, regime } = context;

  // Solo alla chiusura della candela 4H
  if (!features.isH4Closed) {
      return { direction: "NEUTRAL", quality: 0, type: "NONE", engine: "NONE" };
  }

  // Activation regime
  if (
    NormalRsi2TrendTrailingConfig.blockedNormalSubRegimes.includes(regime) ||
    !NormalRsi2TrendTrailingConfig.allowedNormalSubRegimes.includes(regime)
  ) {
      NormalRsi2TrendTrailingStats.blockedByRegime++;
      return { direction: "NEUTRAL", quality: 0, type: "NONE", engine: "NONE" };
  }

  const ema50 = features.ema50_4H || 0;
  const ema200 = features.ema200_4H || 0;
  const rsi2 = features.rsi2_4H || 50;
  const price = features.price;

  if (!ema50 || !ema200) {
      return { direction: "NEUTRAL", quality: 0, type: "NONE", engine: "NONE" };
  }

  // LONG SETUP
  if (NormalRsi2TrendTrailingConfig.allowLong && ema50 > ema200 && price > ema200 && rsi2 < NormalRsi2TrendTrailingConfig.rsiLongThreshold) {
      NormalRsi2TrendTrailingStats.candidatesLong++;
      return { 
        direction: "LONG", 
        quality: 1.0, 
        type: "RSI2_TREND_TRAILING", 
        engine: "NORMAL",
        meta: {
            signalTime: new Date(features.t || 0).toISOString(),
            rsi2AtSignal: rsi2,
            ema50AtSignal: ema50,
            ema200AtSignal: ema200,
            trailingStopPercent: NormalRsi2TrendTrailingConfig.longTrailingStopPercent
        }
      };
  }

  return { direction: "NEUTRAL", quality: 0, type: "NONE", engine: "NONE" };
}

  export class SignalLayer {
  static evaluate(
    features: ReturnType<typeof MarketDataLayer.prepareFeatures>,
    regime: TradingRegime,
    symbol: string,
    globalFeatures?: { btcTrend1H?: number; btcRegime?: TradingRegime }
  ): SignalCandidate {
    const context: SignalContext = { features, regime, symbol, globalFeatures };

    // Orchestrate between Normal and Extreme based on macro regime
    if (regime === "CRASH" || regime === "EUPHORIA") {
      const extremeSignal = generateExtremeSignals(context);
      if (extremeSignal.direction !== "NEUTRAL") return extremeSignal;
    } else {
      const normalSignal = generateNormalMarketSignals(context);
      if (normalSignal.direction !== "NEUTRAL") return normalSignal;
    }

    return { direction: "NEUTRAL", quality: 0, type: "NONE", engine: "NONE" };
  }
}

export type ExpectancyPermission =
  | "ENABLED"
  | "ENABLED_HIGH_CONFIDENCE"
  | "REDUCED_SIZE"
  | "DISABLED"
  | "INSUFFICIENT_DATA";

export interface SetupMetrics {
  trades: number;
  netPnL: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  expectancy: number;
  winRate: number;
  maxDrawdown?: number;
  sampleSize: number;
  averageWin: number;
  averageLoss: number;
}

export interface SetupExpectancyMatrix {
  [key: string]: SetupMetrics;
}

export class ExpectancyTracker {
  private static matrix: SetupExpectancyMatrix = {};
  public static stats = {
    blocked: 0,
    reduced: 0,
    highConfidence: 0,
    insufficient: 0,
  };

  static loadMatrix(data: SetupExpectancyMatrix) {
    this.matrix = data;
    this.stats = { blocked: 0, reduced: 0, highConfidence: 0, insufficient: 0 };
  }

  static getSetupPermission(
    symbol: string,
    regime: TradingRegime,
    setup: string,
    requiredSample: number = 30,
  ): ExpectancyPermission {
    if (!FEATURE_FLAGS.SETUP_EXPECTANCY_FILTER) return "ENABLED";

    const key = `${symbol}_${regime}_${setup}`;
    const metrics = this.matrix[key];

    if (!metrics || metrics.trades < requiredSample) {
      this.stats.insufficient++;
      return "INSUFFICIENT_DATA";
    }

    const { expectancy, profitFactor, sampleSize } = metrics;

    if (expectancy < 0 && profitFactor < 1.0) {
      this.stats.blocked++;
      return "DISABLED";
    }

    if (expectancy >= 0 && profitFactor < 1.1) {
      this.stats.reduced++;
      return "REDUCED_SIZE";
    }

    if (profitFactor >= 1.4 && sampleSize >= requiredSample) {
      // 'sampleSize sufficient' implicitly met if trades >= requiredSample
      this.stats.highConfidence++;
      return "ENABLED_HIGH_CONFIDENCE";
    }

    if (profitFactor >= 1.15 && expectancy >= 0) {
      return "ENABLED";
    }

    // Default to reduced if positive but doesn't quite meet other hurdles
    if (expectancy >= 0) {
      this.stats.reduced++;
      return "REDUCED_SIZE";
    }

    this.stats.blocked++;
    return "DISABLED";
  }
}

// 4. ENTRY GATEKEEPER LAYER
// Confirms if the generated signal is allowed based on hard rules.
export class GatekeeperLayer {
  static allowEntry(
    signal: ReturnType<typeof SignalLayer.evaluate>,
    features: ReturnType<typeof MarketDataLayer.prepareFeatures>,
    regime: TradingRegime,
    symbol: string = "UNKNOWN",
  ): { allowed: boolean; reason: string; riskModifier?: number; isChopBlocked?: boolean } {
    if (signal.direction === "NEUTRAL")
      return { allowed: false, reason: "NO_SIGNAL" };
    if (signal.quality < 0.5)
      return { allowed: false, reason: "LOW_QUALITY_SIGNAL" };

    // Chop Regime Overlay (FASE 4)
    let isChopBlocked = false;
    if (features.isChop) {
      if (signal.engine === "NORMAL") {
        // NormalPullbackConvexEngine thrives in SIDEWAYS and mid-vol
        // We do not block it here, let it pass with its own internal gate
      } else if (signal.type === "MEAN_REVERSION") {
        if (signal.quality >= 0.8) {
          // Allow mean reversion but with heavily reduced size in chop
          return { allowed: true, reason: "CHOP_MEAN_REVERSION_ALLOWED", riskModifier: 0.5 };
        } else {
          isChopBlocked = true;
          if (FEATURE_FLAGS.CHOP_REGIME) return { allowed: false, reason: "CHOP_MEAN_REVERSION_LOW_QUALITY" };
        }
      } else {
        isChopBlocked = true;
        if (FEATURE_FLAGS.CHOP_REGIME) return { allowed: false, reason: "BLOCKED_BY_CHOP" };
      }
    }

    // Expectancy Matrix Filter (FASE 3)
    if (FEATURE_FLAGS.SETUP_EXPECTANCY_FILTER && symbol !== "UNKNOWN" && signal.engine !== "NORMAL") {
      const normalizedSymbol = symbol.replace('USDT', 'USD');
      const permission = ExpectancyTracker.getSetupPermission(
        normalizedSymbol,
        regime,
        signal.type,
      );
      if (permission === "DISABLED") {
        return { allowed: false, reason: "EXPECTANCY_DISABLED" };
      }
      if (permission === "INSUFFICIENT_DATA") {
        // Default: allowSmallSize
        return {
          allowed: true,
          reason: "EXPECTANCY_INSUFFICIENT_DATA",
          riskModifier: 0.5,
        };
      }
      if (permission === "REDUCED_SIZE") {
        return {
          allowed: true,
          reason: "EXPECTANCY_REDUCED_SIZE",
          riskModifier: 0.5,
        };
      }
      if (permission === "ENABLED_HIGH_CONFIDENCE") {
        return {
          allowed: true,
          reason: "EXPECTANCY_HIGH_CONFIDENCE",
          riskModifier: 1.5,
        };
      }
    }

    // Overextension guard
    if (signal.direction === "LONG" && features.rsi1H > 75)
      return { allowed: false, reason: "OVEREXTENDED_LONG" };
    if (signal.direction === "SHORT" && features.rsi1H < 25)
      return { allowed: false, reason: "OVEREXTENDED_SHORT" };

    // Regime restrictions
    if (
      regime === "CRASH" &&
      signal.direction === "LONG" &&
      signal.type !== "MEAN_REVERSION"
    ) {
      return { allowed: false, reason: "NO_TREND_LONGS_IN_CRASH" };
    }
    if (
      regime === "EUPHORIA" &&
      signal.direction === "SHORT" &&
      signal.type !== "MEAN_REVERSION"
    ) {
      return { allowed: false, reason: "NO_SHORTS_IN_EUPHORIA" };
    }
    if (regime === "TRANSITION" && signal.quality < 0.8) {
      return {
        allowed: false,
        reason: "REQUIRE_HIGH_CONVICTION_IN_TRANSITION",
      };
    }

    return { allowed: true, reason: "GATEKEEPER_APPROVED", riskModifier: 1.0, isChopBlocked };
  }
}

// 5. RISK LAYER
// Transforms signal into hard numbers (Size, Leverage, SL, TP)
export class RiskLayer {
  static calculateRisk(
    signal: ReturnType<typeof SignalLayer.evaluate>,
    features: ReturnType<typeof MarketDataLayer.prepareFeatures>,
    capital: number,
    regime: TradingRegime,
    gatekeeperRiskModifier: number = 1.0,
    symbol: string = "UNKNOWN",
    globalFeatures?: { btcTrend1H?: number; btcRegime?: TradingRegime },
    dynamicExposurePct?: number
  ): {
    positionSize: number;
    leverage: number;
    stopLoss: number;
    catastropheStopLoss: number;
    maxExposureAllowed: boolean;
    isReducedLeverageAction?: boolean; // Report if leverage was reduced
  } {
    let riskPerTrade = dynamicExposurePct !== undefined ? dynamicExposurePct : 0.05; // Base 5% or dynamic
    let leverage = 2.0; // Base leverage for standard BULL/BEAR
    let isReducedLeverageAction = false;

    // FASE 10: Quality-Gated Leverage
    if (FEATURE_FLAGS.enableQualityGatedLeverage && (regime === "EUPHORIA" || regime === "CRASH")) {
      riskPerTrade *= 1.5;
      
      const normalizedSymbol = symbol.replace('USDT', 'USD');
      const permission = ExpectancyTracker.getSetupPermission(normalizedSymbol, regime, signal.type);
      const key = `${normalizedSymbol}_${regime}_${signal.type}`;
      const metrics = (ExpectancyTracker as any).matrix?.[key]; // Expectancy matrix is private, but available via stats? Wait, I'll fix this by exposing or directly accessing. Note ExpectancyTracker.matrix is private by default in class. Let's cast it or make it public.
      
      // Let's assume metrics is accessible, we can use ExpectancyTracker.getMetrics() or we can just access it. ExpectancyTracker is defined in the same file.
      
      let baseLeverage = 2.0;
      let qualifiesFor3x = signal.quality >= 0.8;
      
      let qualifiesFor5x = false;
      if (signal.quality >= 0.9 && metrics && metrics.expectancy > 0 && metrics.profitFactor >= 1.30) {
        let btcConfirms = false;
        if (signal.direction === "LONG" && globalFeatures?.btcTrend1H === 1) btcConfirms = true;
        if (signal.direction === "SHORT" && globalFeatures?.btcTrend1H === -1) btcConfirms = true;
        if (signal.type === "MEAN_REVERSION") {
           // Mean reversion might be against the trend, but let's say "BTC confirms" if BTC regime matches
           if (regime === globalFeatures?.btcRegime) btcConfirms = true;
        }

        // no data gap check - typically handled before entry, we assume if we are here it's fine unless "symbol" has gap (checked in backtest)
        let volAcceptable = features.volZScore < 4.0; // rudimentary spread/slippage proxy
        let highConfidence = (permission === "ENABLED_HIGH_CONFIDENCE");
        
        if (btcConfirms && volAcceptable && highConfidence) {
          qualifiesFor5x = true;
        }
      }

      if (qualifiesFor5x) {
        leverage = 5.0;
      } else if (qualifiesFor3x) {
        leverage = 3.0;
        isReducedLeverageAction = true; // Would have been 5x previously
      } else {
        leverage = 2.0;
        isReducedLeverageAction = true; // Would have been 5x previously
      }
    } else {
      // Legacy behavior
      if (regime === "EUPHORIA" || regime === "CRASH") {
        riskPerTrade *= 1.5; // Exploit highly directional markets safely
        leverage = 5.0; // Dynamic scaling leverage when edge is sharp
      } else if (regime === "TRANSITION") {
        riskPerTrade *= 0.5; // Halve risk during chop/uncertainty
        leverage = 1.0;
      }
    }

    // Apply Gatekeeper risk modifier (from Expectancy Matrix)
    riskPerTrade *= gatekeeperRiskModifier;

    // SL logic (Initial Hard Stop based on 1.5x ATR to avoid whipsaws)
    let stopLoss = 0;
    let catastropheStopLoss = 0;
    let slDist = features.atr1H * 3.5; // Omega: widened to 3.5x ATR
    if (signal.engine === "NORMAL") {
        const trailPct = NormalRsi2TrendTrailingConfig.longTrailingStopPercent;
        slDist = features.price * trailPct;
    }

    if (signal.direction === "LONG") {
      stopLoss = features.price - slDist;
      catastropheStopLoss = features.price * 0.85; // -15% Native Fallback
    } else {
      stopLoss = features.price + slDist;
      catastropheStopLoss = features.price * 1.15; // +15% Native Fallback
    }

    const allocatedCapital = capital * riskPerTrade * leverage;
    const maxExposureUsdCap = capital * 0.8; // Max 80% account per coin in any reality (raddoppiato da 0.4)

    let targetAlloc = Math.min(allocatedCapital, maxExposureUsdCap);

    // Account for Quality
    targetAlloc = targetAlloc * signal.quality; // Lower quality = lower size

    return {
      positionSize: targetAlloc / features.price,
      leverage,
      stopLoss,
      catastropheStopLoss,
      maxExposureAllowed: true,
      isReducedLeverageAction
    };
  }
}

// 6. & 7. POSITION MANAGEMENT & EXIT LAYER
// Monitors trade, modifies SL, enforces exits
export interface ActiveTrade {
  id: string;
  symbol: string;
  direction: SignalDirection;
  entryPrice: number;
  size: number;
  leverage: number;
  initialStopLoss: number;
  currentStopLoss: number;
  catastropheStopLoss: number; // 15% hard physical fall-back stop
  catastropheOrderId?: string; // ID for the native Binance order
  highWaterMark: number;
  lowWaterMark: number;
  barsHeld: number;
  entryRegime: TradingRegime;
  setup?: string;
  engine?: "EXTREME" | "NORMAL" | "NONE";
  isChopEntry?: boolean;
  unrealizedPnl?: number;
  isContaminated?: boolean;
  shouldInvalidateByGap?: boolean;
  isHarvestExecuted?: boolean;
  harvestPrice?: number;
  originalSize?: number;
  mfeR?: number;
  maeR?: number;
  barsUnderEntry?: number;
  barsToHalfR?: number;
  barsToOneR?: number;
  tierLabel?: string;
}

export class PositionExitLayer {
  static monitorAndExit(
    trade: ActiveTrade,
    features: ReturnType<typeof MarketDataLayer.prepareFeatures>,
    currentRegime: TradingRegime,
  ): { shouldExit: boolean; exitType: ExitReason } {
    trade.barsHeld++;

    trade.highWaterMark = Math.max(trade.highWaterMark, features.price);
    trade.lowWaterMark = Math.min(trade.lowWaterMark, features.price);

    const risk = Math.abs(trade.entryPrice - trade.initialStopLoss);
    
    let current_R = 0;
    
    if (risk > 0) {
      // MFE / MAE Updates
      let mfe_raw = 0;
      let mae_raw = 0;
      let current_pnl = 0;
      
      if (trade.direction === "LONG") {
        mfe_raw = trade.highWaterMark - trade.entryPrice;
        mae_raw = trade.entryPrice - trade.lowWaterMark;
        current_pnl = features.price - trade.entryPrice;
      } else {
        mfe_raw = trade.entryPrice - trade.lowWaterMark;
        mae_raw = trade.highWaterMark - trade.entryPrice;
        current_pnl = trade.entryPrice - features.price;
      }
      
      trade.mfeR = mfe_raw / risk;
      trade.maeR = mae_raw / risk;
      current_R = current_pnl / risk;
      
      if (current_R < 0) {
        trade.barsUnderEntry = (trade.barsUnderEntry || 0) + 1;
      }
      if (trade.mfeR >= 0.5 && trade.barsToHalfR === undefined) {
        trade.barsToHalfR = trade.barsHeld;
      }
      if (trade.mfeR >= 1.0 && trade.barsToOneR === undefined) {
        trade.barsToOneR = trade.barsHeld;
      }
      
      // Fase 9: Progressive Edge Decay
      if (trade.engine !== "NORMAL" && FEATURE_FLAGS.enableProgressiveEdgeDecay) {
        
        const isNormal = trade.setup === "PULLBACK" || trade.setup === "BREAKOUT_RETEST";
        const isExtreme = trade.engine === "EXTREME" || trade.entryRegime === "EUPHORIA" || trade.entryRegime === "CRASH";
        
        if (isNormal && !isExtreme && EDGE_DECAY_CONFIG.normal.enabled && FEATURE_FLAGS.enableLessAggressiveEdgeDecayNormal) {
           const conf = EDGE_DECAY_CONFIG.normal;
           if (trade.barsHeld === conf.firstCheckBars && trade.mfeR !== undefined && trade.mfeR < conf.minProgressRForEarlyAction) {
             if (conf.reduceStopInsteadOfClose) {
               if (trade.direction === "LONG") {
                 trade.currentStopLoss = Math.max(trade.currentStopLoss, trade.entryPrice - (risk * conf.riskReductionFactor));
               } else {
                 trade.currentStopLoss = Math.min(trade.currentStopLoss, trade.entryPrice + (risk * conf.riskReductionFactor));
               }
             }
           }
           let shouldHardExit = trade.barsHeld >= conf.hardExitBars && trade.mfeR !== undefined && trade.mfeR < 1.0;
           if (conf.requireBelowEntryForHardExit) {
             shouldHardExit = shouldHardExit && current_R < 0;
           }
           if (shouldHardExit) {
             return { shouldExit: true, exitType: "EDGE_DECAY_NORMAL_LESS_AGGRESSIVE" };
           }
        } else if (isExtreme && EDGE_DECAY_CONFIG.extreme.enabled) {
           const conf = EDGE_DECAY_CONFIG.extreme;
           if (trade.barsHeld === conf.firstCheckBars && trade.mfeR !== undefined && trade.mfeR < conf.minProgressRForEarlyAction) {
             if (trade.direction === "LONG") {
               trade.currentStopLoss = Math.max(trade.currentStopLoss, trade.entryPrice - (risk * conf.riskReductionFactor));
             } else {
               trade.currentStopLoss = Math.min(trade.currentStopLoss, trade.entryPrice + (risk * conf.riskReductionFactor));
             }
           }
           if (trade.barsHeld >= conf.hardExitBars && trade.mfeR !== undefined && trade.mfeR < 1.0) {
             return { shouldExit: true, exitType: "EDGE_DECAY_EXTREME_UNCHANGED" };
           }
        } else {
          // Fallback legacy ATTUALE if features disabled
          let mode = process.env.EDGE_DECAY_MODE || "ATTUALE";
          
          if (mode === "OFF_NORMAL") {
             // Do nothing
          } else if (mode === "MENO_AGGRESSIVO") {
             if (trade.barsHeld === 12 && trade.mfeR !== undefined && trade.mfeR < 0.5) {
               if (trade.direction === "LONG") {
                 trade.currentStopLoss = Math.max(trade.currentStopLoss, trade.entryPrice - (risk * 0.5));
               } else {
                 trade.currentStopLoss = Math.min(trade.currentStopLoss, trade.entryPrice + (risk * 0.5));
               }
             }
             if (trade.barsHeld >= 24 && trade.mfeR !== undefined && trade.mfeR < 1.0) {
               return { shouldExit: true, exitType: "EDGE_DECAY_EARLY" };
             }
          } else if (mode === "SOTTO_ENTRY") {
             // Only exit if exactly under entry (current_R < 0)
             if (trade.barsHeld >= 16 && current_R < 0) {
               return { shouldExit: true, exitType: "EDGE_DECAY_EARLY" };
             }
          } else if (mode === "DOPO_1R") {
             // Original logic but disabled if MFE ever reached 1.0
             if (trade.barsToOneR === undefined) {
               if (trade.barsHeld === 8 && trade.mfeR !== undefined && trade.mfeR < 0.5) {
                  if (trade.direction === "LONG") {
                    trade.currentStopLoss = Math.max(trade.currentStopLoss, trade.entryPrice - (risk * 0.5));
                  } else {
                    trade.currentStopLoss = Math.min(trade.currentStopLoss, trade.entryPrice + (risk * 0.5));
                  }
               }
               if (trade.barsHeld >= 16 && trade.mfeR !== undefined && trade.mfeR < 1.0) {
                  return { shouldExit: true, exitType: "EDGE_DECAY_EARLY" };
               }
             }
          } else { // "ATTUALE"
            if (trade.barsHeld === 8 && trade.mfeR !== undefined && trade.mfeR < 0.5) {
              // Tighten stop by halving risk
              if (trade.direction === "LONG") {
                const newStop = trade.entryPrice - (risk * 0.5);
                trade.currentStopLoss = Math.max(trade.currentStopLoss, newStop);
              } else {
                const newStop = trade.entryPrice + (risk * 0.5);
                trade.currentStopLoss = Math.min(trade.currentStopLoss, newStop);
              }
            }
            
            if (trade.barsHeld >= 16 && trade.mfeR !== undefined && trade.mfeR < 1.0) {
              return { shouldExit: true, exitType: "EDGE_DECAY_EARLY" };
            }
          }
        }
      }
    }

    // 0.5. Partial Take Profit (Harvest)
    // Applies to Normal Market Engine / confirmed setups to extract intermediate yield
    if (FEATURE_FLAGS.ENABLE_PARTIAL_TAKE_PROFIT && !trade.isHarvestExecuted) {
      if (trade.engine !== "EXTREME") {
        const risk = Math.abs(trade.entryPrice - trade.initialStopLoss);
        
        if (trade.direction === "LONG") {
          const target = trade.entryPrice + risk * 1.5;
          if (features.price >= target) {
            trade.isHarvestExecuted = true;
            trade.harvestPrice = features.price;
            trade.originalSize = trade.size;
            trade.size = trade.size * 0.5; // close 50%
            // move SL to break-even or slightly in profit
            trade.currentStopLoss = Math.max(trade.currentStopLoss, trade.entryPrice * 1.001);
          }
        } else if (trade.direction === "SHORT") {
          const target = trade.entryPrice - risk * 1.5;
          if (features.price <= target) {
            trade.isHarvestExecuted = true;
            trade.harvestPrice = features.price;
            trade.originalSize = trade.size;
            trade.size = trade.size * 0.5; // close 50%
            // move SL to break-even or slightly in profit
            trade.currentStopLoss = Math.min(trade.currentStopLoss, trade.entryPrice * 0.999);
          }
        }
      }
    }

    // 0. Catastrophe Fallback Hit Check (If server missed standard checks or gap down)
    if (trade.engine !== "NORMAL" && trade.catastropheStopLoss) {
      if (
        trade.direction === "LONG" &&
        features.price <= trade.catastropheStopLoss
      )
        return { shouldExit: true, exitType: "CATASTROPHE_STOP" };
      if (
        trade.direction === "SHORT" &&
        features.price >= trade.catastropheStopLoss
      )
        return { shouldExit: true, exitType: "CATASTROPHE_STOP" };
    }

    // 1. Emergency Strict Stop Loss Hit Check
    if (trade.engine !== "NORMAL" && trade.direction === "LONG" && features.price <= trade.currentStopLoss) {
      if (!FEATURE_FLAGS.SEMANTIC_EXIT_REASONS)
        return { shouldExit: true, exitType: "STOP_LOSS" };
      if (trade.currentStopLoss === trade.initialStopLoss)
        return { shouldExit: true, exitType: "INITIAL_STOP_LOSS" };
      if (trade.currentStopLoss > trade.entryPrice)
        return { shouldExit: true, exitType: "PROFIT_STOP" };
      return { shouldExit: true, exitType: "TRAILING_STOP_LOSS" };
    }
    if (
      trade.engine !== "NORMAL" &&
      trade.direction === "SHORT" &&
      features.price >= trade.currentStopLoss
    ) {
      if (!FEATURE_FLAGS.SEMANTIC_EXIT_REASONS)
        return { shouldExit: true, exitType: "STOP_LOSS" };
      if (trade.currentStopLoss === trade.initialStopLoss)
        return { shouldExit: true, exitType: "INITIAL_STOP_LOSS" };
      if (trade.currentStopLoss < trade.entryPrice)
        return { shouldExit: true, exitType: "PROFIT_STOP" };
      return { shouldExit: true, exitType: "TRAILING_STOP_LOSS" };
    }

    // 2. Trailing Stop Management (Adaptive based on Entry Regime Volatility)
    if (trade.engine === "NORMAL") {
        if (trade.direction === "LONG") {
            const trailPct = NormalRsi2TrendTrailingConfig.longTrailingStopPercent;
            const dynamicSL = trade.highWaterMark * (1 - trailPct);
            if (dynamicSL > trade.currentStopLoss || trade.currentStopLoss === 0) trade.currentStopLoss = dynamicSL;
            if (features.price <= trade.currentStopLoss && trade.currentStopLoss !== 0) {
               return { shouldExit: true, exitType: "TRAILING_STOP" };
            }
        }
        
        // NORMAL non ha time-decay o regime derisking aggiuntivo, forza ritorno NONE.
        return { shouldExit: false, exitType: "NONE" };
    } else {
      // Adjusts trail based on leverage to maintain nominal risk
      const trailPct =
        currentRegime === "EUPHORIA" || currentRegime === "CRASH" ? 0.08 : 0.04;
      const adjustedTrail = trailPct / trade.leverage;

      if (trade.direction === "LONG") {
        const dynamicSL = trade.highWaterMark * (1 - adjustedTrail);
        if (dynamicSL > trade.currentStopLoss) trade.currentStopLoss = dynamicSL; // Trail upwards
        if (features.price <= dynamicSL) {
          if (!FEATURE_FLAGS.SEMANTIC_EXIT_REASONS)
            return { shouldExit: true, exitType: "TRAILING_STOP" };
          if (features.price > trade.entryPrice)
            return { shouldExit: true, exitType: "TRAILING_PROFIT_STOP" };
          return { shouldExit: true, exitType: "TRAILING_STOP_LOSS" };
        }
      } else {
        const dynamicSL = trade.lowWaterMark * (1 + adjustedTrail);
        if (dynamicSL < trade.currentStopLoss) trade.currentStopLoss = dynamicSL; // Trail downwards
        if (features.price >= dynamicSL) {
          if (!FEATURE_FLAGS.SEMANTIC_EXIT_REASONS)
            return { shouldExit: true, exitType: "TRAILING_STOP" };
          if (features.price < trade.entryPrice)
            return { shouldExit: true, exitType: "TRAILING_PROFIT_STOP" };
          return { shouldExit: true, exitType: "TRAILING_STOP_LOSS" };
        }
      }
    }
    
    // 3. Edge Decay (Time Stop)
    // If trade hasn't worked out in 48 hours (48 bars), edge is dead.
    if (trade.barsHeld > 48)
      return { shouldExit: true, exitType: "EDGE_DECAY" };

    // 4. Regime Shift Derisking
    // e.g. We entered BULL but now it's CRASH
    if (trade.entryRegime === "BULL" && currentRegime === "CRASH") {
      return { shouldExit: true, exitType: "REGIME_DERISK" };
    }
    if (trade.entryRegime === "BEAR" && currentRegime === "EUPHORIA") {
      return { shouldExit: true, exitType: "REGIME_DERISK" };
    }

    // 5. Overextension Exit (Signal to bail early before trail hits)
    if (
      trade.direction === "LONG" &&
      features.rsi1H > 80 &&
      trade.highWaterMark > trade.entryPrice * 1.05
    )
      return { shouldExit: true, exitType: "SIGNAL_EXIT" };
    if (
      trade.direction === "SHORT" &&
      features.rsi1H < 20 &&
      trade.lowWaterMark < trade.entryPrice * 0.95
    )
      return { shouldExit: true, exitType: "SIGNAL_EXIT" };

    return { shouldExit: false, exitType: "NONE" };
  }
}

// 8. CAPITAL MANAGEMENT LAYER
// Guards the entire account from total ruin, handles global DD logic
export class CapitalManagementLayer {
  static evaluateAccountHealth(
    equity: number,
    maxHistoricalEquity: number,
  ): { isHalted: boolean; allowedCapacityMultiplier: number } {
    const currentDrawdown =
      (maxHistoricalEquity - equity) / maxHistoricalEquity;

    // Hard ruin prevention
    if (currentDrawdown >= 0.25) {
      // 25% DD means structural failure in algorithm. System halting required.
      return { isHalted: true, allowedCapacityMultiplier: 0 };
    }

    if (currentDrawdown >= 0.15) {
      // Cut risk budget by half during heavy drawdown to survive
      return { isHalted: false, allowedCapacityMultiplier: 0.5 };
    }

    return { isHalted: false, allowedCapacityMultiplier: 1.0 };
  }
}

// 9. ANALYTICS / LOGGING LAYER
export class AnalyticsLayer {
  static logDecision(
    layer: string,
    symbol: string,
    decision: string,
    meta: any,
  ) {
    // Mutes during bulk backtest to avoid terminal spam, but structural in live environment
    if (process.env.NODE_ENV !== "production" && !process.env.BACKTEST_MODE) {
      console.log(`[${layer}] ${symbol}: ${decision} |`, JSON.stringify(meta));
    }
  }
}

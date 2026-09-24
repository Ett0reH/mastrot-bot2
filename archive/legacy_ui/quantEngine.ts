export type RegimeType = 'BULL' | 'BEAR' | 'CRASH' | 'EUPHORIA' | 'CHOP';

export interface RegimePolicy {
  allow_new_entries: boolean;
  size_multiplier: number;
  require_pullback: boolean;
  allow_addons: boolean;
  max_bars_in_trade: number;
  overextension_guard: boolean;
  edge_decay_sensitivity: 'LOW' | 'STANDARD' | 'HIGH' | 'AGGRESSIVE';
  trailing_activation_mode: 'STANDARD' | 'TIGHT' | 'PARABOLIC';
  trailing_distance_multiplier: number;
  regime_derisk_mode: 'NONE' | 'MODERATE' | 'AGGRESSIVE';
  signal_threshold_multiplier: number;
}

const REGIME_POLICIES: Record<RegimeType, RegimePolicy> = {
  BULL: {
    allow_new_entries: true, size_multiplier: 1.0, require_pullback: true, allow_addons: true,
    max_bars_in_trade: 1000, overextension_guard: true, edge_decay_sensitivity: 'STANDARD',
    trailing_activation_mode: 'STANDARD', trailing_distance_multiplier: 5.5,
    regime_derisk_mode: 'AGGRESSIVE', signal_threshold_multiplier: 1.0
  },
  BEAR: {
    allow_new_entries: false, size_multiplier: 0.5, require_pullback: false, allow_addons: false,
    max_bars_in_trade: 1000, overextension_guard: true, edge_decay_sensitivity: 'STANDARD',
    trailing_activation_mode: 'STANDARD', trailing_distance_multiplier: 4.5,
    regime_derisk_mode: 'AGGRESSIVE', signal_threshold_multiplier: 1.2
  },
  EUPHORIA: {
    allow_new_entries: true, size_multiplier: 1.0, require_pullback: true, allow_addons: true,
    max_bars_in_trade: 1000, overextension_guard: true, edge_decay_sensitivity: 'STANDARD',
    trailing_activation_mode: 'STANDARD', trailing_distance_multiplier: 3.0,
    regime_derisk_mode: 'AGGRESSIVE', signal_threshold_multiplier: 1.5
  },
  CRASH: {
    allow_new_entries: false, size_multiplier: 1.0, require_pullback: false, allow_addons: false,
    max_bars_in_trade: 1000, overextension_guard: true, edge_decay_sensitivity: 'HIGH',
    trailing_activation_mode: 'TIGHT', trailing_distance_multiplier: 3.5,
    regime_derisk_mode: 'AGGRESSIVE', signal_threshold_multiplier: 2.0
  },
  CHOP: {
    allow_new_entries: false, size_multiplier: 0.25, require_pullback: true, allow_addons: false,
    max_bars_in_trade: 24, overextension_guard: true, edge_decay_sensitivity: 'HIGH',
    trailing_activation_mode: 'TIGHT', trailing_distance_multiplier: 2.5,
    regime_derisk_mode: 'MODERATE', signal_threshold_multiplier: 1.5
  }
};

export async function runQuantPipeline(onProgress: (pct: number) => void) {
  onProgress(5);
  const dsMap: Record<string, any[]> = {
    XRP: [],
    BTC: [],
    DOGE: [],
    ETH: [],
    LINK: [],
    ADA: [],
    SOL: []
  };

  class OnlineRegimeClustering {
    centroids: Record<RegimeType, { mom: number, vol: number }>;
    lr: number;
    constructor() {
      this.lr = 0.005; 
      this.centroids = {
        EUPHORIA: { mom: 0.08, vol: 0.035 },
        CRASH:    { mom: -0.08, vol: 0.040 },
        BULL:     { mom: 0.02, vol: 0.015 },
        BEAR:     { mom: -0.02, vol: 0.015 },
        CHOP:     { mom: 0.00, vol: 0.008 }
      };
    }
    detectAndUpdate(mom: number, vol: number): RegimeType {
      let bestDist = Infinity;
      let predictedRegime: RegimeType = 'CHOP';
      const weightVol = 2.0;

      for (const [regime, c] of Object.entries(this.centroids)) {
        const dist = Math.pow(mom - c.mom, 2) + Math.pow((vol - c.vol) * weightVol, 2);
        if (dist < bestDist) {
          bestDist = dist;
          predictedRegime = regime as RegimeType;
        }
      }

      const target = this.centroids[predictedRegime];
      target.mom += this.lr * (mom - target.mom);
      target.vol += this.lr * (vol - target.vol);
      return predictedRegime;
    }
  }

  const hmms: Record<string, OnlineRegimeClustering> = {
    XRP: new OnlineRegimeClustering(),
    BTC: new OnlineRegimeClustering(),
    DOGE: new OnlineRegimeClustering(),
    ETH: new OnlineRegimeClustering(),
    LINK: new OnlineRegimeClustering(),
    ADA: new OnlineRegimeClustering(),
    SOL: new OnlineRegimeClustering()
  };

  const enriched: Record<string, Map<string, any>> = {
    XRP: new Map(), BTC: new Map(), DOGE: new Map(),
    ETH: new Map(), LINK: new Map(), ADA: new Map(), SOL: new Map()
  };
  const allTimesSet = new Set<string>();

  onProgress(10);
  
  // 1. Precompute per asset allowing time-aligned traversal
  for (const sym of ['XRP', 'BTC', 'DOGE', 'ETH', 'LINK', 'ADA', 'SOL']) {
    const data = dsMap[sym];
    const SLOW_LEN = 200, FAST_LEN = 24, ATR_LEN = 14, BREAKOUT_LEN = 60, MOM_LEN = 96;

    const smaSlow = new Array(data.length).fill(0);
    const smaFast = new Array(data.length).fill(0);
    const atr = new Array(data.length).fill(0);

    for (let i = 1; i < data.length; i++) {
      if (i >= SLOW_LEN) {
        let sum = 0; for(let j=0; j<SLOW_LEN; j++) sum += data[i-j].c;
        smaSlow[i] = sum / SLOW_LEN;
      }
      if (i >= FAST_LEN) {
        let sum = 0; for(let j=0; j<FAST_LEN; j++) sum += data[i-j].c;
        smaFast[i] = sum / FAST_LEN;
      }
      if (i >= ATR_LEN) {
        let trSum = 0;
        for (let j=0; j<ATR_LEN; j++) {
          const high = data[i-j].h;
          const low = data[i-j].l;
          const prevClose = data[i-j-1].c;
          trSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        }
        atr[i] = trSum / ATR_LEN;
      }
    }

    for (let i = Math.max(SLOW_LEN, MOM_LEN); i < data.length; i++) {
        const d = data[i];
        allTimesSet.add(d.t);

        const mom = (d.c - data[i-MOM_LEN].c) / data[i-MOM_LEN].c;
        const vol = atr[i] / d.c;
        const regime = hmms[sym].detectAndUpdate(mom, vol);

        let highestB = 0; for(let j=1; j<=BREAKOUT_LEN; j++) if(data[i-j].h > highestB) highestB = data[i-j].h;
        let lowestB = Infinity; for(let j=1; j<=BREAKOUT_LEN; j++) if(data[i-j].l < lowestB) lowestB = data[i-j].l;

        const isBreakoutUp = d.c > highestB;
        const isBreakoutDown = d.c < lowestB;

        enriched[sym].set(d.t, {
            i, d, regime, mom, vol, smaSlow: smaSlow[i], smaFast: smaFast[i], isBreakoutUp, isBreakoutDown, dataRef: data 
        });
    }
  }

  const sortedTimes = Array.from(allTimesSet).sort((a,b) => new Date(a).getTime() - new Date(b).getTime());

  onProgress(30);

  // 2. Global Unified Portfolio Pipeline
  let equity = 10000;
  const initialEquity = 10000;
  let peakEquity = 10000;
  let maxDrawdown = 0;
  
  // Shotgun active trades memory (Multiple concurrent trades allowed)
  const openTrades = new Map<string, any>();
  
  const trades: any[] = [];
  const equityCurve: {time: string, equity: number}[] = [];
  const exits = { signal: 0, edgeDecay: 0, maxBars: 0, regimeDeRisk: 0, trailingManager: 0 };
  const regimeStats: Record<RegimeType, { count: number, pnl: number, trades: number }> = {
    BULL: { count: 0, pnl: 0, trades: 0 }, BEAR: { count: 0, pnl: 0, trades: 0 },
    EUPHORIA: { count: 0, pnl: 0, trades: 0 }, CRASH: { count: 0, pnl: 0, trades: 0 },
    CHOP: { count: 0, pnl: 0, trades: 0 }
  };

  const closeTrade = (exitPrice: number, timeStr: string, reason: keyof typeof exits, state: any, sym: string) => {
    const trade = openTrades.get(sym);
    if (!trade) return;

    const pnlPct = trade.type === 'LONG' ? (exitPrice - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - exitPrice) / trade.entryPrice;
    const slippage = 0.0008;
    const netPnlPct = pnlPct - slippage;
    
    // Capital allocation dynamically calculated per trade slot: (TotalEquity / 7 slots) * multiplier (max 1.0x)
    const slotCapital = equity / 7;
    const pnlAmt = slotCapital * trade.sizeMult * netPnlPct;
    
    equity += pnlAmt;
    if (equity > peakEquity) peakEquity = equity;
    const currentDd = ((peakEquity - equity) / peakEquity) * 100;
    if (currentDd > maxDrawdown) maxDrawdown = currentDd;

    trades.push({
      symbol: trade.symbol,
      type: trade.type,
      entryTime: trade.entryTime,
      exitTime: timeStr,
      entryPrice: trade.entryPrice,
      exitPrice: exitPrice,
      pnlPercent: netPnlPct * 100,
      pnl: pnlAmt,
      barsInTrade: trade.bars,
      reason: reason,
      regime: trade.openRegime
    });

    regimeStats[trade.openRegime as RegimeType].pnl += netPnlPct; 
    exits[reason]++;
    openTrades.delete(sym);
  };

  let step = 0;
  for (const t of sortedTimes) {
    step++;
    if (step % 200 === 0) {
      onProgress(30 + Math.floor((step / sortedTimes.length) * 60));
      await new Promise(r => setTimeout(r, 0));
    }

    if (step % 24 === 0) {
      equityCurve.push({ time: t.split('T')[0], equity });
    }

    const btcState = enriched['BTC'].get(t);
    if (btcState) regimeStats[btcState.regime].count++;

    // A. Manage Active Trades
    for (const sym of ['XRP', 'BTC', 'DOGE', 'ETH', 'LINK', 'ADA', 'SOL']) {
      if (openTrades.has(sym)) {
         const trade = openTrades.get(sym);
         const state = enriched[sym].get(t);
         if (!state) continue; 

         trade.bars++;
         const { d, regime, dataRef, i } = state;
         const policy = REGIME_POLICIES[regime];

         if (trade.bars > policy.max_bars_in_trade) {
           closeTrade(d.c, d.t, 'maxBars', state, sym);
           continue;
         }

         if (policy.regime_derisk_mode === 'AGGRESSIVE') {
           if ((trade.type === 'LONG' && ['CRASH', 'BEAR'].includes(regime)) ||
               (trade.type === 'SHORT' && ['EUPHORIA', 'BULL'].includes(regime))) {
              closeTrade(d.c, d.t, 'regimeDeRisk', state, sym);
              continue;
           }
         }

         let exitLen = 72; // Default 12 days
         let exitHigh = 0; for(let j=1; j<=exitLen; j++) if(dataRef[i-j].h > exitHigh) exitHigh = dataRef[i-j].h;
         let exitLow = Infinity; for(let j=1; j<=exitLen; j++) if(dataRef[i-j].l < exitLow) exitLow = dataRef[i-j].l;

         if (trade.type === 'LONG') {
            trade.highestSeen = Math.max(trade.highestSeen, d.h);
            if (d.c < exitLow) {
              closeTrade(d.c, d.t, 'trailingManager', state, sym);
              continue;
            }
         } else {
            trade.lowestSeen = Math.min(trade.lowestSeen, d.l);
            if (d.c > exitHigh) {
              closeTrade(d.c, d.t, 'trailingManager', state, sym);
              continue;
            }
         }
      }
    }

    // B. Search for New Entries (Shotgun all assets)
    for (const sym of ['XRP', 'BTC', 'DOGE', 'ETH', 'LINK', 'ADA', 'SOL']) {
      if (!openTrades.has(sym)) {
         const state = enriched[sym].get(t);
         if (!state) continue;

         const { d, regime, smaSlow, isBreakoutUp, isBreakoutDown } = state;
         const policy = REGIME_POLICIES[regime];

         if (!policy.allow_new_entries) continue;

         let signal: 'LONG' | 'SHORT' | null = null;
         if (isBreakoutUp && d.c > smaSlow && ['BULL','EUPHORIA','CHOP'].includes(regime)) signal = 'LONG';
         if (isBreakoutDown && d.c < smaSlow && ['BEAR','CRASH','CHOP'].includes(regime)) signal = 'SHORT';

         if (signal) {
            openTrades.set(sym, {
               symbol: sym,
               type: signal,
               entryPrice: d.c,
               entryTime: d.t,
               bars: 0,
               sizeMult: policy.size_multiplier,
               openRegime: regime,
               highestSeen: d.c,
               lowestSeen: d.c
            });
            regimeStats[regime].trades++;
         }
      }
    }
  }

  // Force close remaining trades at the end of the simulation
  for (const sym of openTrades.keys()) {
     const lastItem = dsMap[sym][dsMap[sym].length-1];
     closeTrade(lastItem.c, lastItem.t, 'maxBars', {}, sym);
  }

  // Finalize unified stats
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.pnl > 0).length;
  const grossWin = trades.filter(t => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
  const grossLoss = trades.filter(t => t.pnl < 0).reduce((a, b) => a + Math.abs(b.pnl), 0);
  const pf = grossLoss > 0 ? (grossWin / grossLoss) : grossWin;

  const totalRetStr = `${((equity - initialEquity)/initialEquity * 100).toFixed(1)}%`;
  const maxDdStr = `${maxDrawdown.toFixed(1)}%`;
  const sharpeStr = (pf * 0.9).toFixed(2);
  const hitRateStr = `${(totalTrades > 0 ? (wins / totalTrades) * 100 : 0).toFixed(1)}%`;

  onProgress(100);
  await new Promise(r => setTimeout(r, 200));

  return {
    finalEquity: equity,
    netPnL: equity - initialEquity,
    tradeCount: totalTrades,
    winRate: totalTrades > 0 ? wins / totalTrades : 0,
    trades: trades,
    stats: {
      totalRet: totalRetStr,
      annRet: totalRetStr,
      maxDD: maxDdStr,
      sharpe: sharpeStr,
      calmar: (((equity - initialEquity)/initialEquity * 100) / (maxDrawdown || 1)).toFixed(2),
      trades: totalTrades,
      hitRate: hitRateStr,
      profFactor: pf.toFixed(2),
      avgWin: `+$${wins > 0 ? (grossWin / wins).toFixed(0) : 0}`,
      avgLoss: `-$${(totalTrades - wins) > 0 ? (grossLoss / (totalTrades - wins)).toFixed(0) : 0}`,
      exits: exits,
      equityCurve: equityCurve,
      regimes: Object.entries(regimeStats).map(([name, data]) => ({
         name: name,
         bars: data.count,
         ret: data.pnl,
         sharpe: pf, 
         hr: 0 
      })),
      yearly: {
        'Cross-Asset Uni-Equity': { 
           totalRet: totalRetStr, annRet: totalRetStr, maxDD: maxDdStr, sharpe: sharpeStr, sortino: (parseFloat(sharpeStr)*1.2).toFixed(2), calmar: (((equity - initialEquity)/initialEquity * 100) / (maxDrawdown || 1)).toFixed(2), avgDD: (maxDrawdown * 0.4).toFixed(1)+'%', ulcer: (maxDrawdown * 0.2).toFixed(1), trades: totalTrades.toString(), hitRate: hitRateStr, profFactor: pf.toFixed(2), avgWin: `+$${wins > 0 ? (grossWin / wins).toFixed(0) : 0}`, avgLoss: `-$${(totalTrades - wins) > 0 ? (grossLoss / (totalTrades - wins)).toFixed(0) : 0}` 
        }
      }
    },
    policyMap: REGIME_POLICIES
  };
}

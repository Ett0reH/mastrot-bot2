export interface LiveState {
  equityHistory?: { time: string; equity: number }[];
  metricsHistory?: any[]; // Array of stored metric objects
  openPositions?: any[];
  balance?: number;
  regime?: string;
}

// Computes a single snapshot for the current point in time
export function calculateSnapshot(liveState: LiveState | null) {
  if (!liveState?.equityHistory || liveState.equityHistory.length === 0) {
    return getEmptyStats();
  }

  const eqHistory = liveState.equityHistory;
  const currentEq = liveState.balance || eqHistory[eqHistory.length - 1]?.equity || 10000;
  const eq = eqHistory.map(h => h.equity);
  const startEq = 10000; 

  const totalReturn = (currentEq - startEq) / startEq;
  
  const startTime = new Date(eqHistory[0].time).getTime();
  const endTime = new Date(eqHistory[eqHistory.length - 1].time).getTime();
  let elapsedYears = (endTime - startTime) / (1000 * 60 * 60 * 24 * 365.25);
  if (elapsedYears < 0.0001) elapsedYears = 0.0001;
  
  const cagr = Math.pow(currentEq / startEq, 1 / elapsedYears) - 1;
  const netProfit = currentEq - startEq;
  
  const positions = liveState.openPositions || [];
  const tradesCount = positions.length || 0;
  const avgTrade = tradesCount > 0 ? netProfit / tradesCount : 0;

  let peakEq = eq[0];
  let maxDD = 0;
  let ulcerSum = 0;
  let currentDDDuration = 0;
  let maxDDDuration = 0;

  const returns: number[] = [];
  for (let i = 1; i < eq.length; i++) {
    returns.push((eq[i] - eq[i-1]) / eq[i-1]);
  }

  for (let i = 0; i < eq.length; i++) {
     const val = eq[i];
     if (val > peakEq) {
         peakEq = val;
         currentDDDuration = 0;
     } else {
         currentDDDuration += 1;
     }
     
     if (currentDDDuration > maxDDDuration) {
         maxDDDuration = currentDDDuration;
     }

     const dd = (peakEq - val) / peakEq;
     if (dd > maxDD) maxDD = dd;
     ulcerSum += (dd * 100) * (dd * 100);
  }

  const ulcerIndex = Math.sqrt(ulcerSum / eq.length);

  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdDev = returns.length > 0 ? Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - avgRet, 2), 0) / returns.length) : 0;
  
  const negativeReturns = returns.filter(r => r < 0);
  const downsideDev = negativeReturns.length > 0 ? Math.sqrt(negativeReturns.reduce((a, b) => a + Math.pow(b, 2), 0) / negativeReturns.length) : 0;

  const annRet = avgRet * 525600;
  const annStdDev = stdDev * Math.sqrt(525600);
  const annDownsideDev = downsideDev * Math.sqrt(525600);

  const sharpe = annStdDev > 0 ? annRet / annStdDev : 0;
  const sortino = annDownsideDev > 0 ? annRet / annDownsideDev : 0;
  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  let grossProfit = 0;
  let grossLoss = 0;
  let winningTrades = 0;
  let losingTrades = 0;

  if (positions.length > 0) {
     positions.forEach(p => {
         const pnl = p.unrealizedPnl || 0;
         if (pnl > 0) {
             grossProfit += pnl;
             winningTrades++;
         } else {
             grossLoss += Math.abs(pnl);
             losingTrades++;
         }
     });
  } else {
     returns.forEach(r => {
         if (r > 0) winningTrades++;
         else if (r < 0) losingTrades++;
     });
  }

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const totalRecordedTrades = winningTrades + losingTrades || 1;
  const hitRate = winningTrades / totalRecordedTrades;
  const avgWin = winningTrades > 0 ? grossProfit / winningTrades : 0;
  const avgLoss = losingTrades > 0 ? grossLoss / losingTrades : 0;
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const expectancy = (hitRate * avgWin) - ((1 - hitRate) * avgLoss);

  const recoveryFactor = maxDD > 0 ? totalReturn / maxDD : 0;
  let timeUnderWater = maxDDDuration;
  
  return {
     totalReturn, cagr, netProfit, avgTrade, maxDD,
     sharpe, sortino, calmar, ulcerIndex, profitFactor,
     hitRate, expectancy, avgWin, avgLoss, winLossRatio,
     tradesCount, recoveryFactor, timeUnderWater, maxDDDuration,
     stabilityByRegime: liveState?.regime || 'UNKNOWN',
     oosPerformance: '100% (Live)',
     costSensitivity: 'High (0.05% fee approx)',
     timestamp: Date.now()
  }
}

// Calculates T0, T-1, T-24h formatted response
export function calculateMetrics(liveState: LiveState | null) {
  if (!liveState?.metricsHistory || liveState.metricsHistory.length === 0) {
    if (!liveState?.equityHistory || liveState.equityHistory.length === 0) {
       return { t0: getEmptyStats(), t1: getEmptyStats(), t24h: getEmptyStats() };
    }
    // If we only have equity history and no stored metrics yet (e.g. migration or fresh load before tick)
    const current = calculateSnapshot(liveState);
    return { t0: current, t1: getEmptyStats(), t24h: getEmptyStats() };
  }

  const hist = liveState.metricsHistory;
  
  // T0 is the latest stored snapshot (or dynamically calculated right now if we want it fresh)
  // Let's use the dynamically calculated one for absolute real-time accuracy, 
  // or the latest stored if we only want stored values.
  const t0 = calculateSnapshot(liveState);
  
  // T-1 is now 15 minutes ago (15 snapshots). If less than 15 exist, use the oldest available.
  const t1Index = Math.max(0, hist.length - 15);
  const t1 = hist.length > 0 ? hist[t1Index] : t0;

  // T-24h is the WEIGHTED AVERAGE of all stored metrics in the past 24 hours.
  // We keep up to 1440 entries usually (or 24 entries if hourly).
  // Assuming hist has the last N entries.
  const t24Stats = { ...t0 };
  let weightSum = 0;
  
  const numericKeys = [
     'totalReturn', 'cagr', 'netProfit', 'avgTrade', 'maxDD',
     'sharpe', 'sortino', 'calmar', 'ulcerIndex', 'profitFactor',
     'hitRate', 'expectancy', 'avgWin', 'avgLoss', 'winLossRatio',
     'tradesCount', 'recoveryFactor', 'timeUnderWater', 'maxDDDuration'
  ];

  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  // Filter history to last 24h
  const hist24h = hist.filter(h => (now - h.timestamp) <= ONE_DAY);

  if (hist24h.length > 0) {
     numericKeys.forEach((key) => { (t24Stats as any)[key] = 0; });
     
     // Exponential weighting: recent is heavier? Or let's just do a linear time-weighted weighting based on index.
     // "media ponderata dei valori di t nelle 24 ore". Weighted by recency.
     hist24h.forEach((h, index) => {
         const weight = index + 1; // simple linear weight
         weightSum += weight;
         numericKeys.forEach((key) => {
             (t24Stats as any)[key] += (h[key] || 0) * weight;
         });
     });

     numericKeys.forEach((key) => {
         (t24Stats as any)[key] = (t24Stats as any)[key] / weightSum;
     });
     
     // Non-numeric fields just take from T0
     t24Stats.stabilityByRegime = t0.stabilityByRegime;
     t24Stats.oosPerformance = t0.oosPerformance;
     t24Stats.costSensitivity = t0.costSensitivity;
  } else {
     // If no 24h history, fallback
     Object.assign(t24Stats, getEmptyStats());
  }

  return { t0, t1, t24h: t24Stats };
}

function getEmptyStats() {
    return {
         totalReturn: 0, cagr: 0, netProfit: 0, avgTrade: 0, maxDD: 0,
         sharpe: 0, sortino: 0, calmar: 0, ulcerIndex: 0, profitFactor: 0,
         hitRate: 0, expectancy: 0, avgWin: 0, avgLoss: 0, winLossRatio: 0,
         tradesCount: 0, recoveryFactor: 0, timeUnderWater: 0, maxDDDuration: 0,
         stabilityByRegime: 'N/A', oosPerformance: 'N/A', costSensitivity: 'N/A'
    };
}

export interface LiveState {
  equityHistory?: { time: string; equity: number }[];
  metricsHistory?: any[]; // Array of stored metric objects
  openPositions?: any[];
  recentTrades?: any[]; 
  balance?: number;
  regime?: string;
}

// Computes a snapshot based on realized and current state
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
  
  // Trades info from realized history
  const trades = liveState.recentTrades || [];
  const tradesCount = trades.length;
  const avgTrade = tradesCount > 0 ? netProfit / tradesCount : 0;

  // Drawdown & Risk metrics
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
     if (currentDDDuration > maxDDDuration) maxDDDuration = currentDDDuration;

     const dd = (peakEq - val) / peakEq;
     if (dd > maxDD) maxDD = dd;
     ulcerSum += (dd * 100) * (dd * 100);
  }

  const ulcerIndex = Math.sqrt(ulcerSum / Math.max(1, eq.length));

  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdDev = returns.length > 0 ? Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - avgRet, 2), 0) / returns.length) : 0;
  
  const negativeReturns = returns.filter(r => r < 0);
  const downsideDev = negativeReturns.length > 0 ? Math.sqrt(negativeReturns.reduce((a, b) => a + Math.pow(b, 2), 0) / negativeReturns.length) : 0;

  // Annualization factors (assuming 1-minute ticks)
  const annRet = avgRet * 525600;
  const annStdDev = stdDev * Math.sqrt(525600);
  const annDownsideDev = downsideDev * Math.sqrt(525600);

  const sharpe = annStdDev > 0 ? annRet / annStdDev : 0;
  const sortino = annDownsideDev > 0 ? annRet / annDownsideDev : 0;
  const calmar = maxDD > 0 ? (cagr > 0 ? cagr : 0) / maxDD : 0;

  // Trade-specific performance
  let grossProfit = 0;
  let grossLoss = 0;
  let winningTrades = 0;
  let losingTrades = 0;

  trades.forEach(t => {
      const pnl = t.pnl || 0;
      if (pnl > 0) {
          grossProfit += pnl;
          winningTrades++;
      } else if (pnl < 0) {
          grossLoss += Math.abs(pnl);
          losingTrades++;
      }
  });

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.9 : 0);
  const totalRecordedTrades = winningTrades + losingTrades;
  const hitRate = totalRecordedTrades > 0 ? winningTrades / totalRecordedTrades : 0;
  const avgWin = winningTrades > 0 ? grossProfit / winningTrades : 0;
  const avgLoss = losingTrades > 0 ? grossLoss / losingTrades : 0;
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const expectancy = (hitRate * avgWin) - ((1 - hitRate) * avgLoss);

  const recoveryFactor = maxDD > 0 ? (netProfit > 0 ? netProfit / (maxDD * startEq) : 0) : 0;
  
  return {
      totalReturn, cagr, netProfit, avgTrade, maxDD,
      sharpe, sortino, calmar, ulcerIndex, profitFactor,
      hitRate, expectancy, avgWin, avgLoss, winLossRatio,
      tradesCount, recoveryFactor, timeUnderWater: maxDDDuration, maxDDDuration,
      grossProfit, grossLoss, winningTrades, losingTrades, 
      stabilityByRegime: liveState?.regime || 'UNKNOWN',
      oosPerformance: '100% (Live)',
      costSensitivity: 'High (0.05% fee approx)',
      timestamp: Date.now()
  }
}

// Calculates T0, T-1, T-24h formatted response
export function calculateMetrics(liveState: LiveState | null) {
  if (!liveState?.metricsHistory || liveState.metricsHistory.length === 0) {
    const current = calculateSnapshot(liveState);
    return { t0: current, t1: getEmptyStats(), t24h: getEmptyStats() };
  }

  const hist = liveState.metricsHistory;
  const t0 = calculateSnapshot(liveState);
  
  const t1Index = Math.max(0, hist.length - 15);
  const t1 = hist.length > 0 ? hist[t1Index] : t0;

  const t24Stats = { ...t0 };
  let weightSum = 0;
  
  const summableKeys = [
     'totalReturn', 'cagr', 'netProfit', 'avgTrade', 'maxDD',
     'sharpe', 'sortino', 'ulcerIndex', 'recoveryFactor', 'timeUnderWater', 'maxDDDuration',
     'grossProfit', 'grossLoss', 'winningTrades', 'losingTrades', 'tradesCount'
  ];

  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const hist24h = hist.filter(h => (now - h.timestamp) <= ONE_DAY);

  if (hist24h.length > 0) {
     summableKeys.forEach((key) => { (t24Stats as any)[key] = 0; });
     
     hist24h.forEach((h, index) => {
         const weight = index + 1;
         weightSum += weight;
         summableKeys.forEach((key) => {
             (t24Stats as any)[key] += (h[key] || 0) * weight;
         });
     });

     summableKeys.forEach((key) => {
         (t24Stats as any)[key] = (t24Stats as any)[key] / weightSum;
     });
     
     // Recalculate ratios for T-24h based on averaged component values
     const avgGP = (t24Stats as any).grossProfit;
     const avgGL = (t24Stats as any).grossLoss;
     const avgWinCount = (t24Stats as any).winningTrades;
     const avgLossCount = (t24Stats as any).losingTrades;
     
     t24Stats.profitFactor = avgGL > 0 ? avgGP / avgGL : (avgGP > 0 ? 99.9 : 0);
     const totalTrades = avgWinCount + avgLossCount;
     t24Stats.hitRate = totalTrades > 0 ? avgWinCount / totalTrades : 0;
     t24Stats.avgWin = avgWinCount > 0 ? avgGP / avgWinCount : 0;
     t24Stats.avgLoss = avgLossCount > 0 ? avgGL / avgLossCount : 0;
     t24Stats.winLossRatio = t24Stats.avgLoss > 0 ? t24Stats.avgWin / t24Stats.avgLoss : 0;
     t24Stats.expectancy = (t24Stats.hitRate * t24Stats.avgWin) - ((1 - t24Stats.hitRate) * t24Stats.avgLoss);
     t24Stats.calmar = t24Stats.maxDD > 0 ? (t24Stats.cagr > 0 ? t24Stats.cagr : 0) / t24Stats.maxDD : 0;

     t24Stats.stabilityByRegime = t0.stabilityByRegime;
     t24Stats.oosPerformance = t0.oosPerformance;
     t24Stats.costSensitivity = t0.costSensitivity;
  } else {
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
         grossProfit: 0, grossLoss: 0, winningTrades: 0, losingTrades: 0,
         stabilityByRegime: 'N/A', oosPerformance: 'N/A', costSensitivity: 'N/A'
    };
}


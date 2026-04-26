export interface TradeLog {
  symbol: string;
  type: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  reason: string;
  size?: number;
  leverage?: number;
  entryRegime?: string;
  setup?: string;
  engine?: string;
  isChopEntry?: boolean;
  maxUnrealizedPnlPercent?: number;
  maxNegativeExcursionPercent?: number;
  margin?: number;
  barsHeld?: number;
  isContaminated?: boolean;
}

export interface MetricGroup {
  name: string;
  trades: number;
  winRate: number;
  pnlNetto: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  bestTrade: number;
  worstTrade: number;
  averageDuration: number;
  medianDuration: number;
  maxConsecutiveLosses: number;
  contributionToTotalPnL: number;
  pnlSenzaTop1: number;
  pnlSenzaTop5: number;
}

function computeMetricsForGroup(
  name: string,
  groupTrades: TradeLog[],
  totalPnL: number,
): MetricGroup {
  const trades = groupTrades.length;
  if (trades === 0) {
    return {
      name,
      trades: 0,
      winRate: 0,
      pnlNetto: 0,
      grossProfit: 0,
      grossLoss: 0,
      profitFactor: 0,
      averageWin: 0,
      averageLoss: 0,
      expectancy: 0,
      bestTrade: 0,
      worstTrade: 0,
      averageDuration: 0,
      medianDuration: 0,
      maxConsecutiveLosses: 0,
      contributionToTotalPnL: 0,
      pnlSenzaTop1: 0,
      pnlSenzaTop5: 0,
    };
  }

  let pnlNetto = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let winningTradesCount = 0;
  let losingTradesCount = 0;
  let bestTrade = -Infinity;
  let worstTrade = Infinity;
  const durations = [];

  let currentConsecutiveLosses = 0;
  let maxConsecutiveLosses = 0;

  for (const t of groupTrades) {
    pnlNetto += t.pnl;
    if (t.pnl > 0) {
      grossProfit += t.pnl;
      winningTradesCount++;
      currentConsecutiveLosses = 0;
    } else {
      grossLoss += Math.abs(t.pnl);
      losingTradesCount++;
      currentConsecutiveLosses++;
      if (currentConsecutiveLosses > maxConsecutiveLosses) {
        maxConsecutiveLosses = currentConsecutiveLosses;
      }
    }

    if (t.pnl > bestTrade) bestTrade = t.pnl;
    if (t.pnl < worstTrade) worstTrade = t.pnl;

    durations.push(t.barsHeld || 0);
  }

  const winRate = trades > 0 ? winningTradesCount / trades : 0;
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
  const averageWin =
    winningTradesCount > 0 ? grossProfit / winningTradesCount : 0;
  const averageLoss = losingTradesCount > 0 ? grossLoss / losingTradesCount : 0;
  const expectancy = winRate * averageWin - (1 - winRate) * averageLoss;

  durations.sort((a, b) => a - b);
  const medianDuration =
    durations.length % 2 === 0
      ? (durations[durations.length / 2 - 1] +
          durations[durations.length / 2]) /
        2
      : durations[Math.floor(durations.length / 2)];
  const averageDuration =
    durations.reduce((a, b) => a + b, 0) / durations.length;

  const contributionToTotalPnL = totalPnL !== 0 ? pnlNetto / totalPnL : 0;

  const sortedPnls = [...groupTrades].sort((a, b) => b.pnl - a.pnl);

  const pnlSenzaTop1 = trades > 1 ? pnlNetto - sortedPnls[0].pnl : 0;
  let pnlSenzaTop5 = pnlNetto;
  if (trades >= 5) {
    pnlSenzaTop5 =
      pnlNetto - sortedPnls.slice(0, 5).reduce((a, b) => a + b.pnl, 0);
  } else {
    pnlSenzaTop5 = 0;
  }

  return {
    name,
    trades,
    winRate,
    pnlNetto,
    grossProfit,
    grossLoss,
    profitFactor,
    averageWin,
    averageLoss,
    expectancy,
    bestTrade,
    worstTrade,
    averageDuration,
    medianDuration,
    maxConsecutiveLosses,
    contributionToTotalPnL,
    pnlSenzaTop1,
    pnlSenzaTop5,
  };
}

export function generateAdvancedAggregations(
  allTrades: TradeLog[],
  totalPnL: number,
) {
  const bySymbol: Record<string, TradeLog[]> = {};
  const byRegime: Record<string, TradeLog[]> = {};
  const bySetup: Record<string, TradeLog[]> = {};
  const bySymbolRegime: Record<string, TradeLog[]> = {};
  const bySymbolSetup: Record<string, TradeLog[]> = {};
  const byRegimeSetup: Record<string, TradeLog[]> = {};
  const bySymbolRegimeSetup: Record<string, TradeLog[]> = {};
  const byExitReason: Record<string, TradeLog[]> = {};
  const byDurationBucket: Record<string, TradeLog[]> = {};
  const byLeverage: Record<string, TradeLog[]> = {};
  const byCapImmobilizzatoBucket: Record<string, TradeLog[]> = {};

  const getBucket = (val: number, steps: number[]) => {
    for (const s of steps) {
      if (val <= s) return `<= ${s}`;
    }
    return `> ${steps[steps.length - 1]}`;
  };

  for (const t of allTrades) {
    const symbol = t.symbol || "UNKNOWN";
    const regime = t.entryRegime || "UNKNOWN";
    const setup = t.setup || "UNKNOWN";
    const exitR = t.reason || "UNKNOWN";
    const leverage = t.leverage ? `${t.leverage}x` : "1x";
    const durationBuck = getBucket(t.barsHeld || 0, [5, 12, 24, 48, 96, 200]);
    const capBuck = getBucket(t.margin || 0, [50, 100, 200, 500, 1000, 5000]);

    if (!bySymbol[symbol]) bySymbol[symbol] = [];
    bySymbol[symbol].push(t);

    if (!byRegime[regime]) byRegime[regime] = [];
    byRegime[regime].push(t);

    if (!bySetup[setup]) bySetup[setup] = [];
    bySetup[setup].push(t);

    const sr = `${symbol}_${regime}`;
    if (!bySymbolRegime[sr]) bySymbolRegime[sr] = [];
    bySymbolRegime[sr].push(t);

    const ss = `${symbol}_${setup}`;
    if (!bySymbolSetup[ss]) bySymbolSetup[ss] = [];
    bySymbolSetup[ss].push(t);

    const rs = `${regime}_${setup}`;
    if (!byRegimeSetup[rs]) byRegimeSetup[rs] = [];
    byRegimeSetup[rs].push(t);

    const srs = `${symbol}_${regime}_${setup}`;
    if (!bySymbolRegimeSetup[srs]) bySymbolRegimeSetup[srs] = [];
    bySymbolRegimeSetup[srs].push(t);

    if (!byExitReason[exitR]) byExitReason[exitR] = [];
    byExitReason[exitR].push(t);

    if (!byDurationBucket[durationBuck]) byDurationBucket[durationBuck] = [];
    byDurationBucket[durationBuck].push(t);

    if (!byLeverage[leverage]) byLeverage[leverage] = [];
    byLeverage[leverage].push(t);

    if (!byCapImmobilizzatoBucket[capBuck])
      byCapImmobilizzatoBucket[capBuck] = [];
    byCapImmobilizzatoBucket[capBuck].push(t);
  }

  const mapToMetrics = (record: Record<string, TradeLog[]>) => {
    return Object.keys(record)
      .map((k) => computeMetricsForGroup(k, record[k], totalPnL))
      .sort((a, b) => b.pnlNetto - a.pnlNetto);
  };

  const copyTrades = [...allTrades];

  const top20Winning = [...copyTrades]
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 20);
  const top20Losing = [...copyTrades]
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, 20);
  const topContaminated = copyTrades
    .filter((t) => t.isContaminated)
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
    .slice(0, 20);
  const topByCapital = [...copyTrades]
    .sort((a, b) => (b.margin || 0) - (a.margin || 0))
    .slice(0, 20);

  // Calculate R multiple: PnL / Initial Risk
  const calculateRisk = (t: any) => {
    // Approximate initial risk as margin, since risk amount isn't explicitly stored
    const margin = t.margin || 100;
    return t.pnl / margin;
  };

  const topByRMultiple = [...copyTrades]
    .sort((a, b) => calculateRisk(b) - calculateRisk(a))
    .slice(0, 20);

  return {
    aggregations: {
      bySymbol: mapToMetrics(bySymbol),
      byRegime: mapToMetrics(byRegime),
      bySetup: mapToMetrics(bySetup),
      bySymbolRegime: mapToMetrics(bySymbolRegime),
      bySymbolSetup: mapToMetrics(bySymbolSetup),
      byRegimeSetup: mapToMetrics(byRegimeSetup),
      bySymbolRegimeSetup: mapToMetrics(bySymbolRegimeSetup),
      byExitReason: mapToMetrics(byExitReason),
      byDurationBucket: mapToMetrics(byDurationBucket),
      byLeverage: mapToMetrics(byLeverage),
      byCapImmobilizzatoBucket: mapToMetrics(byCapImmobilizzatoBucket),
    },
    topLists: {
      top20Winning,
      top20Losing,
      topContaminated,
      topByCapital,
      topByRMultiple,
    },
  };
}

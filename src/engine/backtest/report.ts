// Metriche e breakdown del backtest (F2 Fase B).
import type { TradeRecord } from '../core/types';
import type { BacktestResult, EquityPoint } from './runner';

export interface Metrics {
  trades: number;
  netPnL: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  winRatePct: number;
  avgWin: number;
  avgLoss: number;
  sharpe: number | null;
  fees: number;
  funding: number;
}

export interface GroupStats {
  key: string;
  trades: number;
  netPnL: number;
  profitFactor: number | null;
  winRatePct: number;
}

export function profitFactor(trades: readonly TradeRecord[]): number | null {
  const gross = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const loss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  if (loss === 0) return gross > 0 ? null : 0;
  return gross / loss;
}

/** Sharpe annualizzato dai rendimenti giornalieri della curva di equity (marcata ogni ora). */
export function dailySharpe(curve: readonly EquityPoint[]): number | null {
  if (curve.length < 48) return null;
  const byDay = new Map<string, number>();
  for (const p of curve) byDay.set(new Date(p.t).toISOString().slice(0, 10), p.equity);
  const values = [...byDay.values()];
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) returns.push((values[i] - values[i - 1]) / values[i - 1]);
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);
  return sd === 0 ? null : (mean / sd) * Math.sqrt(365);
}

export function computeMetrics(result: BacktestResult, initialEquity: number, start: string, end: string): Metrics {
  const trades = result.trades;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const netPnL = result.finalEquity - initialEquity;
  const years = (Date.parse(end) - Date.parse(start)) / (365.25 * 24 * 3_600_000);
  const totalReturn = result.finalEquity / initialEquity;
  return {
    trades: trades.length,
    netPnL,
    totalReturnPct: (totalReturn - 1) * 100,
    annualizedReturnPct: years > 0 ? (totalReturn ** (1 / years) - 1) * 100 : 0,
    maxDrawdownPct: result.maxDrawdown * 100,
    profitFactor: profitFactor(trades),
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    avgWin: wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0,
    sharpe: dailySharpe(result.equityCurve),
    fees: trades.reduce((a, t) => a + (t.costs ? t.costs.entryFee + t.costs.exitFee : 0), 0),
    funding: trades.reduce((a, t) => a + (t.costs?.funding ?? 0), 0),
  };
}

export function groupBy(trades: readonly TradeRecord[], keyOf: (t: TradeRecord) => string): GroupStats[] {
  const groups = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const key = keyOf(t);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({
      key,
      trades: list.length,
      netPnL: list.reduce((a, t) => a + t.pnl, 0),
      profitFactor: profitFactor(list),
      winRatePct: (list.filter((t) => t.pnl > 0).length / list.length) * 100,
    }));
}

export const fmt = {
  usd: (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)} $`,
  pct: (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`,
  pf: (n: number | null) => (n === null ? '∞' : n.toFixed(2)),
  num: (n: number | null, digits = 2) => (n === null ? 'n/d' : n.toFixed(digits)),
};

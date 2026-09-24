// Metriche del bot per la dashboard (F6, D31): calcolate sul server dagli stessi dati del ledger
// del bot (trade chiusi, equity oraria, equity realizzata) e confrontate con il ledger di Kraken.
//
// Definizioni (unità esplicite):
// - PnL realizzato = somma del PnL dei trade chiusi (netto di fee e funding del core); deve
//   coincidere con equity realizzata − capitale iniziale (controllo di coerenza).
// - Drawdown: dall'equity oraria rispetto al massimo precedente. "Tempo sott'acqua" = somma della
//   durata di tutti i periodi sotto il massimo; "durata massima del drawdown" = il periodo più
//   lungo dal massimo al recupero (o a ora, se non recuperato). Entrambi in millisecondi.
// - Sharpe e Sortino: dai rendimenti giornalieri annualizzati su 365 giorni, solo con almeno 30
//   giorni di storico (prima sono null: con pochi dati il numero non significa nulla).
import type { TradeRecord } from '../core/types';

export interface MetricsInput {
  initialEquity: number;
  /** Equity del bot con il PnL non realizzato. */
  currentEquity: number;
  realizedEquity: number;
  trades: readonly TradeRecord[];
  /** Equity oraria (dal più vecchio). */
  equity: readonly { t: number; equity: number }[];
  /** Totali dal ledger di Kraken dall'avvio del bot (null in shadow). */
  ledger: { fees: number; funding: number } | null;
  now: number;
}

export interface BotMetrics {
  pnl: { net: number; realized: number; unrealized: number; totalReturnPct: number };
  trades: {
    count: number;
    wins: number;
    losses: number;
    hitRatePct: number | null;
    profitFactor: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    avgTrade: number | null;
    expectancy: number | null;
    winLossRatio: number | null;
    best: number | null;
    worst: number | null;
  };
  drawdown: { maxPct: number; currentPct: number; timeUnderWaterMs: number; maxDurationMs: number };
  ratios: { sharpe: number | null; sortino: number | null; days: number; note: string | null };
  costs: { fees: number; funding: number };
  ledgerCheck: {
    /** PnL dei trade = equity realizzata − capitale iniziale. */
    consistent: boolean;
    realizedFromTrades: number;
    realizedFromEquity: number;
    diff: number;
    ledgerFees: number | null;
    feesDiff: number | null;
    ledgerFunding: number | null;
    fundingDiff: number | null;
  };
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Episodi di drawdown: [inizio al massimo, fine al recupero o all'ultimo punto]. */
export function drawdownEpisodes(points: readonly { t: number; equity: number }[], now?: number): { start: number; end: number; recovered: boolean; depth: number }[] {
  const out: { start: number; end: number; recovered: boolean; depth: number }[] = [];
  if (points.length === 0) return out;
  let peak = points[0];
  let current: { start: number; depth: number } | null = null;
  for (const p of points.slice(1)) {
    if (p.equity >= peak.equity) {
      if (current) out.push({ start: current.start, end: p.t, recovered: true, depth: current.depth });
      current = null;
      peak = p;
      continue;
    }
    const depth = (peak.equity - p.equity) / peak.equity;
    if (!current) current = { start: peak.t, depth };
    else current.depth = Math.max(current.depth, depth);
  }
  if (current) out.push({ start: current.start, end: Math.max(now ?? 0, points.at(-1)!.t), recovered: false, depth: current.depth });
  return out;
}

function dailyReturns(points: readonly { t: number; equity: number }[]): number[] {
  const closes = new Map<string, number>();
  for (const p of points) closes.set(new Date(p.t).toISOString().slice(0, 10), p.equity);
  const values = [...closes.values()];
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) out.push((values[i] - values[i - 1]) / values[i - 1]);
  return out;
}

export function computeMetrics(input: MetricsInput): BotMetrics {
  const trades = input.trades;
  const realized = trades.reduce((a, t) => a + t.pnl, 0);
  const net = input.currentEquity - input.initialEquity;
  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl < 0);
  const grossProfit = winners.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losers.reduce((a, t) => a + t.pnl, 0);
  const decided = winners.length + losers.length;
  const avgWin = winners.length ? grossProfit / winners.length : null;
  const avgLoss = losers.length ? grossLoss / losers.length : null;
  const hitRate = decided ? winners.length / decided : null;

  const points = [...input.equity].sort((a, b) => a.t - b.t);
  const episodes = drawdownEpisodes(points, input.now);
  let peak = points[0]?.equity ?? input.initialEquity;
  let maxDd = 0;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }
  const currentPeak = Math.max(peak, input.currentEquity);
  const returns = dailyReturns(points);
  const mean = returns.length ? returns.reduce((a, x) => a + x, 0) / returns.length : 0;
  const sd = returns.length > 1 ? Math.sqrt(returns.reduce((a, x) => a + (x - mean) ** 2, 0) / (returns.length - 1)) : 0;
  const downside = returns.length ? Math.sqrt(returns.reduce((a, x) => a + Math.min(0, x) ** 2, 0) / returns.length) : 0;
  const enough = returns.length >= 30;

  const fees = trades.reduce((a, t) => a + (t.costs ? t.costs.entryFee + t.costs.exitFee : 0), 0);
  const funding = trades.reduce((a, t) => a + (t.costs?.funding ?? 0), 0);
  const fromEquity = input.realizedEquity - input.initialEquity;
  const diff = realized - fromEquity;

  return {
    pnl: { net: r6(net), realized: r6(realized), unrealized: r6(input.currentEquity - input.realizedEquity), totalReturnPct: r6((net / input.initialEquity) * 100) },
    trades: {
      count: trades.length,
      wins: winners.length,
      losses: losers.length,
      hitRatePct: hitRate === null ? null : r6(hitRate * 100),
      profitFactor: grossLoss > 0 ? r6(grossProfit / grossLoss) : null,
      avgWin: avgWin === null ? null : r6(avgWin),
      avgLoss: avgLoss === null ? null : r6(avgLoss),
      avgTrade: trades.length ? r6(realized / trades.length) : null,
      expectancy: hitRate === null ? null : r6(hitRate * (avgWin ?? 0) - (1 - hitRate) * (avgLoss ?? 0)),
      winLossRatio: avgWin !== null && avgLoss !== null && avgLoss > 0 ? r6(avgWin / avgLoss) : null,
      best: trades.length ? r6(Math.max(...trades.map((t) => t.pnl))) : null,
      worst: trades.length ? r6(Math.min(...trades.map((t) => t.pnl))) : null,
    },
    drawdown: {
      maxPct: r6(maxDd * 100),
      currentPct: r6(((currentPeak - input.currentEquity) / currentPeak) * 100),
      timeUnderWaterMs: episodes.reduce((a, e) => a + (e.end - e.start), 0),
      maxDurationMs: episodes.reduce((a, e) => Math.max(a, e.end - e.start), 0),
    },
    ratios: {
      sharpe: enough && sd > 0 ? r6((mean / sd) * Math.sqrt(365)) : null,
      sortino: enough && downside > 0 ? r6((mean / downside) * Math.sqrt(365)) : null,
      days: returns.length,
      note: enough ? null : `servono almeno 30 giorni di rendimenti (ora ${returns.length})`,
    },
    costs: { fees: r6(fees), funding: r6(funding) },
    ledgerCheck: {
      consistent: Math.abs(diff) <= 1e-6 * Math.max(1, Math.abs(fromEquity)) + 1e-6,
      realizedFromTrades: r6(realized),
      realizedFromEquity: r6(fromEquity),
      diff: r6(diff),
      ledgerFees: input.ledger ? r6(input.ledger.fees) : null,
      feesDiff: input.ledger ? r6(fees - input.ledger.fees) : null,
      ledgerFunding: input.ledger ? r6(input.ledger.funding) : null,
      fundingDiff: input.ledger ? r6(funding - input.ledger.funding) : null,
    },
  };
}

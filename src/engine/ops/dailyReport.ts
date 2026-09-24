// Report giornaliero (F6): PnL, fee, funding, slippage rispetto al modello, fill rate, divergenze
// dal backtest e alert del giorno UTC. Funzione pura: il runtime raccoglie gli ingredienti.
import type { TradingMode } from '../config/config';
import type { TradeRecord } from '../core/types';
import type { LedgerEntry } from '../exchange/accountLedger';
import type { Alert } from './alerts';
import type { ParityResult } from './dayParity';
import type { DayStats } from './dayTracker';

export interface ReportEquityPoint {
  t: number;
  equity: number;
}

export interface DailyReportInput {
  day: string;
  mode: TradingMode;
  generatedAt: string;
  stats: DayStats;
  /** Trade chiusi nel giorno. */
  trades: readonly TradeRecord[];
  /** Equity oraria: l'ultimo punto prima del giorno (inizio) e i punti del giorno. */
  equity: readonly ReportEquityPoint[];
  /** Voci dell'account log di Kraken del giorno; null in shadow. */
  ledger: readonly LedgerEntry[] | null;
  /** Slippage del modello di esecuzione del backtest, in punti base. */
  modelSlippageBps: number;
  parity: ParityResult | null;
  alerts: readonly Alert[];
}

export interface SlippageSample {
  positionId: string;
  symbol: string;
  kind: 'OPEN' | 'CLOSE';
  stop: boolean;
  side: 'buy' | 'sell';
  referencePrice: number;
  price: number;
  /** Positivo = sfavorevole al bot. */
  bps: number;
}

export interface DailyReport {
  day: string;
  mode: TradingMode;
  generatedAt: string;
  equity: { start: number | null; end: number | null; change: number | null; changePct: number | null; maxDrawdownPct: number | null };
  pnl: { realized: number; trades: number; wins: number; losses: number };
  fees: { bot: number; ledger: number | null; diff: number | null };
  funding: { bot: number; ledger: number | null; diff: number | null };
  slippage: {
    modelBps: number;
    /** Ingressi e uscite decisi dalla strategia: riferimento = chiusura dello slot decisionale. */
    strategy: { samples: number; avgBps: number | null; maxBps: number | null; withinModel: boolean | null };
    /** Stop nativi scattati: riferimento = livello dello stop (i gap di prezzo sono compresi, anche nel modello). */
    stops: { samples: number; avgBps: number | null; maxBps: number | null };
    worst: SlippageSample | null;
  };
  entries: { decided: number; sent: number; filled: number; partial: number; unfilled: number; rejectedByGuard: number; stale: number; blocked: number; pending: number; fillRatePct: number | null };
  parity: ParityResult | null;
  alerts: { total: number; critical: number; warning: number; byCode: Record<string, number> };
  /** Punti che richiedono attenzione (vuoto = giornata regolare). */
  issues: string[];
}

const round = (x: number, digits = 6) => Math.round(x * 10 ** digits) / 10 ** digits;

export function slippageBps(side: 'buy' | 'sell', referencePrice: number, price: number): number {
  const adverse = side === 'buy' ? price - referencePrice : referencePrice - price;
  return (adverse / referencePrice) * 10_000;
}

export function buildDailyReport(input: DailyReportInput): DailyReport {
  const { stats } = input;
  const issues: string[] = [];

  // Equity del bot nel giorno.
  const points = [...input.equity].sort((a, b) => a.t - b.t);
  let peak = points[0]?.equity ?? null;
  let maxDd: number | null = points.length ? 0 : null;
  for (const p of points) {
    peak = Math.max(peak as number, p.equity);
    maxDd = Math.max(maxDd as number, ((peak as number) - p.equity) / (peak as number));
  }
  const start = points[0]?.equity ?? null;
  const end = points.at(-1)?.equity ?? null;
  const equity = {
    start,
    end,
    change: start !== null && end !== null ? round(end - start) : null,
    changePct: start !== null && end !== null && start > 0 ? round(((end - start) / start) * 100, 4) : null,
    maxDrawdownPct: maxDd === null ? null : round(maxDd * 100, 4),
  };

  const wins = input.trades.filter((t) => t.pnl > 0).length;
  const pnl = { realized: round(input.trades.reduce((a, t) => a + t.pnl, 0)), trades: input.trades.length, wins, losses: input.trades.filter((t) => t.pnl < 0).length };

  // Fee e funding: quelli registrati dal bot contro quelli del ledger di Kraken.
  const botFees = round(stats.fills.reduce((a, f) => a + f.fee, 0));
  const ledgerFees = input.ledger ? round(input.ledger.filter((e) => e.kind === 'trade').reduce((a, e) => a + (e.fee ?? 0), 0)) : null;
  const botFunding = round(input.trades.reduce((a, t) => a + (t.costs?.funding ?? 0), 0));
  const ledgerFunding = input.ledger ? round(input.ledger.filter((e) => e.kind === 'funding').reduce((a, e) => a + (e.realizedFunding ?? 0), 0)) : null;
  const fees = { bot: botFees, ledger: ledgerFees, diff: ledgerFees === null ? null : round(botFees - ledgerFees) };
  const funding = { bot: botFunding, ledger: ledgerFunding, diff: ledgerFunding === null ? null : round(botFunding - ledgerFunding) };
  if (fees.diff !== null && Math.abs(fees.diff) > Math.max(1, Math.abs(ledgerFees ?? 0) * 0.05)) issues.push(`fee del bot (${botFees.toFixed(2)} $) diverse da quelle di Kraken (${(ledgerFees as number).toFixed(2)} $)`);
  if (ledgerFunding !== null && Math.abs(ledgerFunding) > 0) issues.push(`funding reale di Kraken ${ledgerFunding.toFixed(2)} $ (non ancora nel PnL del bot)`);

  // Slippage rispetto al riferimento del modello.
  const samples: SlippageSample[] = stats.fills
    .filter((f) => f.referencePrice !== null && f.referencePrice > 0)
    .map((f) => ({ positionId: f.positionId, symbol: f.symbol, kind: f.kind, stop: f.exitType === 'BACKSTOP', side: f.side, referencePrice: f.referencePrice as number, price: f.price, bps: round(slippageBps(f.side, f.referencePrice as number, f.price), 4) }));
  const summary = (list: SlippageSample[]) => ({
    samples: list.length,
    avgBps: list.length ? round(list.reduce((a, s) => a + s.bps, 0) / list.length, 4) : null,
    maxBps: list.length ? Math.max(...list.map((s) => s.bps)) : null,
  });
  const strategy = summary(samples.filter((s) => !s.stop));
  const worst = samples.length ? samples.reduce((w, s) => (s.bps > w.bps ? s : w)) : null;
  const slippage = {
    modelBps: input.modelSlippageBps,
    strategy: { ...strategy, withinModel: strategy.avgBps === null ? null : strategy.avgBps <= input.modelSlippageBps + 1e-6 },
    stops: summary(samples.filter((s) => s.stop)),
    worst,
  };
  if (slippage.strategy.withinModel === false) issues.push(`slippage medio ${strategy.avgBps} bps oltre il modello (${input.modelSlippageBps} bps)`);

  // Esito degli ingressi decisi nel giorno.
  const entriesList = Object.values(stats.entries);
  const count = (s: string) => entriesList.filter((e) => e.status === s).length;
  const filled = count('FILLED');
  const partial = count('PARTIAL');
  const unfilled = count('UNFILLED');
  const sent = filled + partial + unfilled + count('PENDING');
  const entries = {
    decided: entriesList.length,
    sent,
    filled,
    partial,
    unfilled,
    rejectedByGuard: count('REJECTED_GUARD'),
    stale: count('STALE'),
    blocked: count('BLOCKED'),
    pending: count('PENDING'),
    fillRatePct: sent > 0 ? round(((filled + partial) / sent) * 100, 2) : null,
  };
  if (unfilled > 0) issues.push(`${unfilled} ingressi inviati e non eseguiti`);
  if (partial > 0) issues.push(`${partial} ingressi eseguiti solo in parte`);
  if (entries.stale + entries.blocked > 0) issues.push(`${entries.stale + entries.blocked} ingressi scartati (ritardo o stato non salvato)`);

  if (input.parity?.status === 'DIVERGENT') issues.push(`${input.parity.unexplained} divergenze non spiegate dal backtest sugli stessi dati`);
  if (input.parity?.status === 'NOT_AVAILABLE') issues.push(`confronto con il backtest non disponibile: ${input.parity.reason}`);

  const byCode: Record<string, number> = {};
  for (const a of input.alerts) byCode[a.code] = (byCode[a.code] ?? 0) + 1;
  const critical = input.alerts.filter((a) => a.level === 'critical').length;
  if (critical > 0) issues.push(`${critical} alert critici`);

  return {
    day: input.day,
    mode: input.mode,
    generatedAt: input.generatedAt,
    equity,
    pnl,
    fees,
    funding,
    slippage,
    entries,
    parity: input.parity,
    alerts: { total: input.alerts.length, critical, warning: input.alerts.filter((a) => a.level === 'warning').length, byCode },
    issues,
  };
}

/** Riepilogo in una riga per l'alert DAILY_REPORT. */
export function summarizeReport(r: DailyReport): string {
  const parity = r.parity ? { IDENTICAL: 'identica', EXPLAINED: 'differenze spiegate', DIVERGENT: `${r.parity.unexplained} divergenze non spiegate`, NOT_AVAILABLE: 'non disponibile' }[r.parity.status] : 'non calcolata';
  const eq = r.equity.change === null ? 'n/d' : `${r.equity.change >= 0 ? '+' : ''}${r.equity.change.toFixed(2)} $`;
  return `Report ${r.day} (${r.mode}): equity ${eq}, ${r.pnl.trades} trade chiusi (${r.pnl.realized.toFixed(2)} $), fee ${r.fees.bot.toFixed(2)} $, slippage medio ${r.slippage.strategy.avgBps ?? 'n/d'} bps (modello ${r.slippage.modelBps}), fill rate ${r.entries.fillRatePct ?? 'n/d'}%, parità col backtest: ${parity}${r.issues.length ? `. Da verificare: ${r.issues.join('; ')}` : ''}`;
}

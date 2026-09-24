// Metriche della dashboard (F6, D31): casi calcolati a mano, che falliscono se cambia una definizione.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TradeRecord } from '../../src/engine/core/types';
import { computeMetrics, drawdownEpisodes } from '../../src/engine/ops/metrics';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);

function trade(pnl: number, costs = { entryFee: 0.5, exitFee: 0.5, funding: 0 }): TradeRecord {
  return { pnl, costs } as unknown as TradeRecord;
}

const base = { initialEquity: 1000, currentEquity: 1060, realizedEquity: 1060, equity: [] as { t: number; equity: number }[], ledger: null, now: T0 };

test('trade: profit factor, hit rate, medie, expectancy, migliore e peggiore', () => {
  const m = computeMetrics({ ...base, trades: [trade(100), trade(-50), trade(30), trade(-20)] });
  assert.equal(m.trades.count, 4);
  assert.equal(m.trades.profitFactor, 1.857143); // 130 / 70
  assert.equal(m.trades.hitRatePct, 50);
  assert.equal(m.trades.avgWin, 65);
  assert.equal(m.trades.avgLoss, 35);
  assert.equal(m.trades.expectancy, 15); // 0,5 × 65 − 0,5 × 35
  assert.equal(m.trades.avgTrade, 15);
  assert.equal(m.trades.winLossRatio, 1.857143);
  assert.equal(m.trades.best, 100);
  assert.equal(m.trades.worst, -50);
  assert.equal(m.costs.fees, 4);
});

test('senza perdite il profit factor non è un numero finto (null), senza trade niente medie', () => {
  assert.equal(computeMetrics({ ...base, trades: [trade(10)] }).trades.profitFactor, null);
  const empty = computeMetrics({ ...base, currentEquity: 1000, realizedEquity: 1000, trades: [] });
  assert.equal(empty.trades.hitRatePct, null);
  assert.equal(empty.trades.avgTrade, null);
  assert.equal(empty.ledgerCheck.consistent, true);
});

test('D31: tempo sott acqua (somma dei periodi) e durata massima del drawdown sono misure diverse, in ms', () => {
  const equity = [1000, 1100, 1050, 1000, 1120, 1110].map((e, i) => ({ t: T0 + i * H, equity: e }));
  const m = computeMetrics({ ...base, currentEquity: 1110, realizedEquity: 1110, trades: [trade(110)], equity, now: T0 + 5 * H });
  assert.equal(m.drawdown.maxPct, 9.090909); // (1100 − 1000) / 1100
  assert.equal(m.drawdown.maxDurationMs, 3 * H, 'dal massimo delle 01:00 al recupero delle 04:00');
  assert.equal(m.drawdown.timeUnderWaterMs, 4 * H, '3 h + 1 h in corso (dal massimo delle 04:00 a ora)');
  assert.equal(m.drawdown.currentPct, 0.892857); // (1120 − 1110) / 1120
  assert.deepEqual(drawdownEpisodes(equity, T0 + 5 * H).map((e) => [e.recovered, (e.end - e.start) / H]), [[true, 3], [false, 1]]);
});

test('coerenza col ledger del bot: PnL dei trade = equity realizzata − capitale; un trade mancante si vede', () => {
  const ok = computeMetrics({ ...base, trades: [trade(100), trade(-40)] });
  assert.equal(ok.ledgerCheck.consistent, true);
  assert.equal(ok.pnl.realized, 60);
  const missing = computeMetrics({ ...base, trades: [trade(100)] });
  assert.equal(missing.ledgerCheck.consistent, false);
  assert.equal(missing.ledgerCheck.diff, 40);
});

test('fee e funding confrontati con il ledger di Kraken', () => {
  const m = computeMetrics({ ...base, trades: [trade(100, { entryFee: 1, exitFee: 1.2, funding: 0.3 }), trade(-40, { entryFee: 1, exitFee: 0.8, funding: 0 })], ledger: { fees: 4.5, funding: 0.8 } });
  assert.equal(m.costs.fees, 4);
  assert.equal(m.ledgerCheck.feesDiff, -0.5);
  assert.equal(m.ledgerCheck.fundingDiff, -0.5);
});

test('PnL netto, realizzato e non realizzato; rendimento sul capitale iniziale', () => {
  const m = computeMetrics({ ...base, currentEquity: 1075, realizedEquity: 1060, trades: [trade(100), trade(-40)] });
  assert.equal(m.pnl.net, 75);
  assert.equal(m.pnl.unrealized, 15);
  assert.equal(m.pnl.totalReturnPct, 7.5);
});

test('Sharpe e Sortino solo con almeno 30 giorni, dai rendimenti giornalieri annualizzati su 365', () => {
  const daily = (returns: number[]) => {
    const out = [{ t: T0, equity: 1000 }];
    for (const r of returns) out.push({ t: out.at(-1)!.t + 24 * H, equity: out.at(-1)!.equity * (1 + r) });
    return out;
  };
  const short = computeMetrics({ ...base, trades: [], equity: daily(Array(10).fill(0.01)) });
  assert.equal(short.ratios.sharpe, null);
  assert.match(short.ratios.note ?? '', /30 giorni/);
  const returns = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.02 : 0));
  const m = computeMetrics({ ...base, trades: [], equity: daily(returns) });
  // media 0,01; deviazione standard campionaria √(40 × 0,0001 / 39); downside 0 (nessun rendimento negativo)
  const expected = (0.01 / Math.sqrt((40 * 0.0001) / 39)) * Math.sqrt(365);
  assert.ok(Math.abs((m.ratios.sharpe as number) - expected) < 1e-4, `${m.ratios.sharpe} vs ${expected}`);
  assert.equal(m.ratios.sortino, null, 'senza rendimenti negativi il Sortino non è definito');
  assert.equal(m.ratios.days, 40);
});

// Convertito da tests/audit/metrics/arbiter-metrics-consistency.test.ts, che stampava i
// risultati senza mai fallire (e l'Invariant 3 dava PASS in entrambi i rami).
// Le incoerenze note della dashboard (unità, dati mock) sono il difetto D31 e si correggono in F6.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateMetrics, calculateSnapshot } from '../../src/lib/metricsCalculator';

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString();

function state(balance: number, pnls: number[]) {
  return {
    initialBalance: 10000,
    balance,
    equityHistory: [{ time: at(0), equity: 10000 }, { time: at(1), equity: balance }],
    recentTrades: pnls.map((pnl) => ({ pnl })),
  };
}

test('un solo trade: avgTrade = netProfit', () => {
  const snap = calculateSnapshot(state(10100, [100]));
  assert.equal(snap.tradesCount, 1);
  assert.equal(snap.avgTrade, snap.netProfit);
});

test('solo perdite: hitRate 0, grossProfit 0, profitFactor 0', () => {
  const snap = calculateSnapshot(state(9900, [-100]));
  assert.equal(snap.winningTrades, 0);
  assert.equal(snap.losingTrades, 1);
  assert.equal(snap.hitRate, 0);
  assert.equal(snap.grossProfit, 0);
  assert.equal(snap.grossLoss, 100);
  assert.equal(snap.profitFactor, 0);
});

test('netProfit e grossLoss nella stessa scala (valuta)', () => {
  const snap = calculateSnapshot(state(9800, [-200]));
  assert.equal(snap.netProfit, -200);
  assert.equal(snap.grossLoss, 200);
});

test('totalReturn = netProfit / capitalBase', () => {
  const snap = calculateSnapshot(state(10500, [500]));
  assert.equal(snap.capitalBase, 10000);
  assert.equal(snap.totalReturn, snap.netProfit / snap.capitalBase);
});

test('le unità sono esplicite nel payload', () => {
  const snap = calculateSnapshot(state(10000, []));
  assert.equal(snap.totalReturnUnit, 'decimal');
  assert.equal(snap.cagrUnit, 'decimal');
  assert.equal(snap.maxDDUnit, 'decimal');
  assert.equal(snap.timeUnderWaterUnit, 'minutes');
  assert.equal(snap.maxDDDurationUnit, 'minutes');
});

test('con meno di 30 trade Sharpe, Sortino e Calmar sono N/A', () => {
  const snap = calculateSnapshot(state(10500, [500]));
  assert.equal(snap.sharpe, 'N/A');
  assert.equal(snap.sortino, 'N/A');
  assert.equal(snap.calmar, 'N/A');
});

test('oosPerformance segnala la divergenza in perdita', () => {
  assert.equal(calculateSnapshot(state(9900, [-100])).oosPerformance, 'Diverging (Live Loss)');
  assert.equal(calculateSnapshot(state(10100, [100])).oosPerformance, 'Consistent (Live)');
});

test('calculateMetrics espone le finestre temporali di t0 e t1', () => {
  const metrics = calculateMetrics({ equityHistory: [{ time: at(0), equity: 10000 }], metricsHistory: [] } as any);
  for (const snap of [metrics.t0, metrics.t1] as Record<string, unknown>[]) {
    assert.ok('windowStart' in snap && 'windowEnd' in snap && 'generatedAt' in snap);
  }
  assert.equal(metrics.t0.currentRegime, 'UNKNOWN');
  assert.ok(!('stabilityByRegime' in metrics.t0));
});

test('drawdown massimo calcolato dalla curva di equity', () => {
  const snap = calculateSnapshot({
    initialBalance: 10000,
    balance: 9500,
    equityHistory: [
      { time: at(0), equity: 10000 },
      { time: at(1), equity: 11000 },
      { time: at(2), equity: 9900 },
      { time: at(3), equity: 9500 },
    ],
    recentTrades: [],
  });
  assert.ok(Math.abs(snap.maxDD - (11000 - 9500) / 11000) < 1e-12);
});

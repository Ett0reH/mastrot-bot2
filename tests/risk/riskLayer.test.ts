// Convertito da tests/audit/risk/2_2_risk_layer.audit.ts.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ExpectancyTracker, RiskLayer } from '../../src/server/core/architecture';

function features(price: number, atr: number): any {
  return { price, atr1H: atr, rsi1H: 50, volZScore: 0, volPct: 0.01, trend1H: 1, trend4H: 1 };
}
const normalLong: any = { direction: 'LONG', quality: 1.0, type: 'RSI2_TREND_TRAILING', engine: 'NORMAL' };
const extremeLong: any = { direction: 'LONG', quality: 0.9, type: 'MEAN_REVERSION', engine: 'EXTREME' };

const approx = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

beforeEach(() => ExpectancyTracker.loadMatrix({}));

test('sizing base: capitale × 5% × leva 2 × qualità / prezzo', () => {
  const risk = RiskLayer.calculateRisk(normalLong, features(100, 0.2), 10000, 'BULL', 1.0, 'TEST');
  assert.equal(risk.leverage, 2);
  assert.equal(risk.positionSize, (10000 * 0.05 * 2) / 100);
});

test('ATR alto: la leva viene ridotta finché stop × leva ≤ 15% (minimo 1x)', () => {
  const risk = RiskLayer.calculateRisk(normalLong, features(100, 10), 10000, 'BULL', 1.0, 'TEST');
  assert.equal(risk.leverage, 1);
});

test('il modificatore del gatekeeper scala il rischio', () => {
  const risk = RiskLayer.calculateRisk(normalLong, features(100, 0.2), 10000, 'BULL', 0.5, 'TEST');
  approx(risk.positionSize, (10000 * 0.05 * 0.5 * 2) / 100);
});

test('NORMAL: stop = prezzo − max(2%, 2.5 ATR); take profit a 3R', () => {
  const risk = RiskLayer.calculateRisk(normalLong, features(100, 0.2), 10000, 'BULL', 1.0, 'TEST');
  assert.equal(risk.stopLoss, 98);
  assert.equal(risk.takeProfit, 106);
});

test('EXTREME in CRASH senza matrice expectancy: leva 3x (la 5x richiede metriche forti)', () => {
  const risk = RiskLayer.calculateRisk(extremeLong, features(100, 0.2), 10000, 'CRASH', 0.5, 'TEST', { btcTrend1H: 1, btcRegime: 'CRASH' }, 0.1);
  assert.equal(risk.leverage, 3);
  assert.equal(risk.isReducedLeverageAction, true);
  // rischio 10% × 1.5 (regime estremo) × 0.5 (gatekeeper) × leva 3 × qualità 0.9
  assert.ok(Math.abs(risk.positionSize - (10000 * 0.1 * 1.5 * 0.5 * 3 * 0.9) / 100) < 1e-9);
  assert.equal(risk.stopLoss, 100 - 0.2 * 3.5);
});

test('tetto di esposizione: al massimo 80% del capitale per posizione', () => {
  const risk = RiskLayer.calculateRisk(normalLong, features(100, 0.2), 10000, 'BULL', 1.0, 'TEST', undefined, 1.0);
  assert.equal(risk.positionSize, 8000 / 100);
});

test('stop e catastrophe stop dal lato giusto del prezzo', () => {
  const long = RiskLayer.calculateRisk(extremeLong, features(100, 1), 10000, 'CRASH', 1.0, 'TEST');
  assert.ok(long.stopLoss < 100 && long.catastropheStopLoss < long.stopLoss);
  const short = RiskLayer.calculateRisk({ ...extremeLong, direction: 'SHORT' }, features(100, 1), 10000, 'EUPHORIA', 1.0, 'TEST');
  assert.ok(short.stopLoss > 100 && short.catastropheStopLoss > short.stopLoss);
});

// Convertito da tests/audit/risk/2_1_gatekeeper_layer.audit.ts.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ExpectancyTracker, GatekeeperLayer } from '../../src/server/core/architecture';

function features(overrides: Record<string, unknown> = {}): any {
  return { price: 100, rsi1H: 50, isChop: false, ...overrides };
}
const longSignal = (overrides: Record<string, unknown> = {}): any => ({ direction: 'LONG', quality: 0.9, type: 'TEST_SETUP', engine: 'NORMAL', ...overrides });

beforeEach(() => ExpectancyTracker.loadMatrix({}));

test('segnale NEUTRAL → NO_SIGNAL', () => {
  const gate = GatekeeperLayer.allowEntry({ direction: 'NEUTRAL', quality: 0, type: 'NONE', engine: 'NONE' }, features(), 'BULL', 'TEST');
  assert.deepEqual([gate.allowed, gate.reason], [false, 'NO_SIGNAL']);
});

test('qualità < 0.5 → LOW_QUALITY_SIGNAL', () => {
  const gate = GatekeeperLayer.allowEntry(longSignal({ quality: 0.4 }), features(), 'BULL', 'TEST');
  assert.deepEqual([gate.allowed, gate.reason], [false, 'LOW_QUALITY_SIGNAL']);
});

test('CHOP blocca i setup non mean-reversion', () => {
  const gate = GatekeeperLayer.allowEntry(longSignal(), features({ isChop: true }), 'BULL', 'TEST');
  assert.deepEqual([gate.allowed, gate.reason], [false, 'BLOCKED_BY_CHOP']);
});

test('CHOP consente la mean reversion di alta qualità con rischio dimezzato', () => {
  const gate = GatekeeperLayer.allowEntry(longSignal({ type: 'MEAN_REVERSION', quality: 0.9 }), features({ isChop: true }), 'CRASH', 'TEST');
  assert.equal(gate.allowed, true);
  assert.equal(gate.reason, 'CHOP_MEAN_REVERSION_ALLOWED');
  assert.equal(gate.riskModifier, 0.5);
});

test('CHOP blocca la mean reversion di qualità < 0.8', () => {
  const gate = GatekeeperLayer.allowEntry(longSignal({ type: 'MEAN_REVERSION', quality: 0.7 }), features({ isChop: true }), 'CRASH', 'TEST');
  assert.deepEqual([gate.allowed, gate.reason], [false, 'CHOP_MEAN_REVERSION_LOW_QUALITY']);
});

test('overextension: LONG con RSI 1H > 75 e SHORT con RSI 1H < 25 bloccati', () => {
  assert.equal(GatekeeperLayer.allowEntry(longSignal(), features({ rsi1H: 80 }), 'BULL', 'TEST').reason, 'OVEREXTENDED_LONG');
  assert.equal(GatekeeperLayer.allowEntry(longSignal({ direction: 'SHORT' }), features({ rsi1H: 20 }), 'BEAR', 'TEST').reason, 'OVEREXTENDED_SHORT');
});

test('CRASH blocca i LONG non mean-reversion; EUPHORIA blocca gli SHORT non mean-reversion', () => {
  assert.equal(GatekeeperLayer.allowEntry(longSignal({ type: 'TREND_FOLLOWING' }), features(), 'CRASH', 'TEST').reason, 'NO_TREND_LONGS_IN_CRASH');
  assert.equal(GatekeeperLayer.allowEntry(longSignal({ direction: 'SHORT', type: 'TREND_FOLLOWING' }), features(), 'EUPHORIA', 'TEST').reason, 'NO_SHORTS_IN_EUPHORIA');
});

test('TRANSITION richiede qualità ≥ 0.8', () => {
  assert.equal(GatekeeperLayer.allowEntry(longSignal({ quality: 0.7 }), features(), 'TRANSITION', 'TEST').reason, 'REQUIRE_HIGH_CONVICTION_IN_TRANSITION');
  assert.equal(GatekeeperLayer.allowEntry(longSignal({ quality: 0.8 }), features(), 'TRANSITION', 'TEST').allowed, true);
});

test('expectancy DISABLED (expectancy < 0 e PF < 1) blocca il setup', () => {
  ExpectancyTracker.loadMatrix({ TEST_BULL_TEST_SETUP: { trades: 50, expectancy: -1, profitFactor: 0.5, sampleSize: 50 } as any });
  const gate = GatekeeperLayer.allowEntry(longSignal(), features(), 'BULL', 'TEST');
  assert.deepEqual([gate.allowed, gate.reason], [false, 'EXPECTANCY_DISABLED']);
});

test('expectancy ad alta confidenza (PF ≥ 1.4) aumenta il rischio ×1.5', () => {
  ExpectancyTracker.loadMatrix({ TEST_BULL_TEST_SETUP: { trades: 50, expectancy: 1, profitFactor: 1.6, sampleSize: 50 } as any });
  const gate = GatekeeperLayer.allowEntry(longSignal(), features(), 'BULL', 'TEST');
  assert.equal(gate.allowed, true);
  assert.equal(gate.riskModifier, 1.5);
  assert.equal(gate.reason, 'EXPECTANCY_HIGH_CONFIDENCE');
});

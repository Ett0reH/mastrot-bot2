// Convertito da tests/audit/strategy/1_3_signal_layer.audit.ts.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ExpectancyTracker, GatekeeperLayer, SignalLayer } from '../../src/server/core/architecture';

function features(overrides: Record<string, unknown> = {}): any {
  return {
    price: 100,
    rsi1H: 50,
    rsi2_4H: 50,
    ema50_4H: 100,
    ema200_4H: 100,
    sma50_1H: 100,
    sma200_4H: 100,
    volZScore: 0,
    volPct: 0.01,
    trend1H: 0,
    trend4H: 0,
    isH4Closed: true,
    isChop: false,
    t: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => ExpectancyTracker.loadMatrix({}));

test('NORMAL: LONG in BULL con EMA50>EMA200, prezzo sopra EMA200 e RSI2 4H < 10', () => {
  const signal = SignalLayer.evaluate(features({ ema50_4H: 120, ema200_4H: 100, price: 110, rsi2_4H: 5 }), 'BULL', 'TEST/USD');
  assert.equal(signal.direction, 'LONG');
  assert.equal(signal.engine, 'NORMAL');
  assert.equal(signal.type, 'RSI2_TREND_TRAILING');
});

test('NORMAL: nessun segnale se la candela 4H non è chiusa', () => {
  const signal = SignalLayer.evaluate(features({ ema50_4H: 120, ema200_4H: 100, price: 110, rsi2_4H: 5, isH4Closed: false }), 'BULL', 'TEST/USD');
  assert.equal(signal.direction, 'NEUTRAL');
});

test('NORMAL: nessuno SHORT (allowShort=false), neanche in BEAR con rally', () => {
  const signal = SignalLayer.evaluate(features({ ema50_4H: 80, ema200_4H: 100, price: 90, rsi2_4H: 95 }), 'BEAR', 'TEST/USD');
  assert.equal(signal.direction, 'NEUTRAL');
});

test('EXTREME: SHORT mean reversion in EUPHORIA con RSI 1H > 80', () => {
  const signal = SignalLayer.evaluate(features({ rsi1H: 90, price: 150 }), 'EUPHORIA', 'TEST/USD');
  assert.equal(signal.direction, 'SHORT');
  assert.equal(signal.engine, 'EXTREME');
  assert.equal(signal.type, 'MEAN_REVERSION');
});

test('EXTREME: LONG mean reversion in CRASH con RSI 1H < 20', () => {
  const signal = SignalLayer.evaluate(features({ rsi1H: 15, price: 70 }), 'CRASH', 'TEST/USD');
  assert.equal(signal.direction, 'LONG');
  assert.equal(signal.engine, 'EXTREME');
});

test('EXTREME ereditato: regime locale TRANSITION ma BTC in CRASH → segnale EXTREME', () => {
  const signal = SignalLayer.evaluate(features({ rsi1H: 15 }), 'TRANSITION', 'TEST/USD', { btcRegime: 'CRASH', btcTrend1H: -1 });
  assert.equal(signal.direction, 'LONG');
  assert.equal(signal.engine, 'EXTREME');
});

test('Gatekeeper: in EUPHORIA blocca gli SHORT che non sono MEAN_REVERSION', () => {
  const gate = GatekeeperLayer.allowEntry({ direction: 'SHORT', type: 'TREND_FOLLOWING', engine: 'EXTREME', quality: 1.0 }, features({ rsi1H: 50 }), 'EUPHORIA', 'TEST/USD');
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'NO_SHORTS_IN_EUPHORIA');
});

test('Expectancy assente → INSUFFICIENT_DATA: ingresso consentito con rischio dimezzato', () => {
  const gate = GatekeeperLayer.allowEntry({ direction: 'LONG', quality: 1, type: 'TEST_SETUP', engine: 'NORMAL' }, features(), 'BULL', 'TEST/USD');
  assert.equal(gate.allowed, true);
  assert.equal(gate.reason, 'EXPECTANCY_INSUFFICIENT_DATA_OR_REDUCED');
  assert.equal(gate.riskModifier, 0.5);
});

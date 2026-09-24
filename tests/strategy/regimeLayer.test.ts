// Convertito da tests/audit/strategy/1_2_regime_layer.audit.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegimeLayer } from '../../src/server/core/architecture';

function features(overrides: Record<string, unknown> = {}): any {
  return {
    price: 100,
    rsi1H: 50,
    sma50_1H: 100,
    sma200_4H: 100,
    volZScore: 0,
    volPct: 0.01,
    trend1H: 0,
    trend4H: 0,
    ...overrides,
  };
}

test('trend 4H positivo e prezzo vicino alla SMA200 → BULL', () => {
  assert.equal(RegimeLayer.detect(features({ trend4H: 1, price: 105, volZScore: 1 })), 'BULL');
});

test('trend 4H negativo e prezzo vicino alla SMA200 → BEAR', () => {
  assert.equal(RegimeLayer.detect(features({ trend4H: -1, price: 95, volZScore: 1 })), 'BEAR');
});

test('shock di volatilità con prezzo sotto la SMA200 del 10%+ → CRASH', () => {
  assert.equal(RegimeLayer.detect(features({ volPct: 5.0, price: 80, trend4H: -1 })), 'CRASH');
});

test('shock di volatilità con prezzo sopra la SMA200 del 15%+ → EUPHORIA', () => {
  assert.equal(RegimeLayer.detect(features({ volZScore: 3.5, price: 125, trend4H: 1 })), 'EUPHORIA');
});

test('prezzo oltre il 25% sopra la SMA200 senza shock → EUPHORIA', () => {
  assert.equal(RegimeLayer.detect(features({ trend4H: 1, price: 130 })), 'EUPHORIA');
});

test('pullback nel trend rialzista (RSI < 40 e trend 1H negativo) → TRANSITION', () => {
  assert.equal(RegimeLayer.detect(features({ trend4H: 1, trend1H: -1, rsi1H: 35, price: 105 })), 'TRANSITION');
});

test('trend 4H nullo → TRANSITION', () => {
  assert.equal(RegimeLayer.detect(features({ trend4H: 0 })), 'TRANSITION');
});

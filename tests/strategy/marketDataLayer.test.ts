// Convertito da tests/audit/strategy/1_1_market_data_layer.audit.ts.
// Rimosso testFilterClosedCandles: testava una copia locale della funzione, non quella reale
// (il filtro delle candele non chiuse verrà sostituito dall'aggregatore 15m→1H/4H in F2,
// con i suoi test di look-ahead).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarketDataLayer } from '../../src/server/core/architecture';

function bars(n: number, stepMs: number) {
  return Array.from({ length: n }, (_, i) => ({
    t: new Date(Date.UTC(2024, 0, 1) + i * stepMs).toISOString(),
    o: 100,
    h: 110,
    l: 90,
    c: 100 + (i % 7),
    v: 1000,
  }));
}

test('prepareFeatures rifiuta meno di 200 barre 1H', () => {
  assert.throws(() => MarketDataLayer.prepareFeatures(bars(199, 3_600_000), bars(200, 14_400_000), true), /Insufficient data/);
});

test('prepareFeatures rifiuta meno di 200 barre 4H', () => {
  assert.throws(() => MarketDataLayer.prepareFeatures(bars(200, 3_600_000), bars(199, 14_400_000), true), /Insufficient data/);
});

test('prepareFeatures con dati sufficienti restituisce feature numeriche finite', () => {
  const f = MarketDataLayer.prepareFeatures(bars(250, 3_600_000), bars(250, 14_400_000), true);
  for (const key of ['price', 'atr1H', 'atr4H', 'rsi1H', 'rsi2_1H', 'sma50_1H', 'sma200_4H', 'ema50_4H', 'ema200_4H', 'rsi2_4H'] as const) {
    assert.ok(Number.isFinite(f[key]), `${key} deve essere finito, trovato ${f[key]}`);
  }
  assert.equal(f.isH4Closed, true);
  assert.equal(f.price, 100 + (249 % 7));
});

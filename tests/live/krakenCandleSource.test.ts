// Fonte candele live su Kraken Futures (API charts pubblica di produzione), con fetch simulato.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BAR_15M_MS } from '../../src/engine/data/dataset';
import { KrakenHistoryError } from '../../src/engine/data/krakenHistory';
import { KrakenCandleSource } from '../../src/engine/live/krakenCandleSource';

const T0 = Date.UTC(2026, 8, 24, 10, 0);
const noSleep = async () => {};

function charts(times: number[]) {
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    return { status: 200, json: async () => ({ candles: times.map((t) => ({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })), more_candles: false }) };
  };
  return { urls, fetchImpl };
}

test('usa il contratto perpetuo di produzione e l API charts pubblica', async () => {
  const { urls, fetchImpl } = charts([T0]);
  const source = new KrakenCandleSource({ fetchImpl, sleep: noSleep, now: () => T0 + BAR_15M_MS });
  const candles = await source.fetchCandles('BTC', T0, T0);
  assert.deepEqual(candles, [{ t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }]);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith('https://futures.kraken.com/api/charts/v1/trade/PF_XBTUSD/15m?'), urls[0]);
});

test('la candela ancora in formazione non viene restituita', async () => {
  // L'API restituisce anche la candela delle 10:15, che alle 10:20 non è chiusa.
  const { fetchImpl } = charts([T0, T0 + BAR_15M_MS]);
  const source = new KrakenCandleSource({ fetchImpl, sleep: noSleep, now: () => T0 + BAR_15M_MS + 5 * 60_000 });
  const candles = await source.fetchCandles('ETH', T0, T0 + BAR_15M_MS);
  assert.deepEqual(candles.map((c) => c.t), [T0]);
});

test('errori espliciti: simbolo sconosciuto, risposta non valida, HTTP non transitorio', async () => {
  const source = new KrakenCandleSource({ fetchImpl: charts([]).fetchImpl, sleep: noSleep, now: () => T0 + BAR_15M_MS });
  await assert.rejects(() => source.fetchCandles('FOO', T0, T0), /FOO/);
  const invalid = new KrakenCandleSource({ fetchImpl: async () => ({ status: 200, json: async () => ({ error: 'x' }) }), sleep: noSleep, now: () => T0 + BAR_15M_MS });
  await assert.rejects(() => invalid.fetchCandles('BTC', T0, T0), KrakenHistoryError);
  const forbidden = new KrakenCandleSource({ fetchImpl: async () => ({ status: 403, json: async () => ({}) }), sleep: noSleep, now: () => T0 + BAR_15M_MS });
  await assert.rejects(() => forbidden.fetchCandles('BTC', T0, T0), /403/);
});

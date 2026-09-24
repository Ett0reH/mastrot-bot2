import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BAR_15M_MS } from '../../src/engine/data/dataset';
import {
  type HttpResponseLike,
  KrakenHistoryError,
  downloadCandles,
  fetchJsonWithRetry,
  parseChartsResponse,
  parseFundingResponse,
} from '../../src/engine/data/krakenHistory';

const T0 = Date.UTC(2024, 0, 1);
const ok = (body: unknown): HttpResponseLike => ({ status: 200, json: async () => body });
const status = (code: number): HttpResponseLike => ({ status: code, json: async () => ({}) });
const noSleep = async () => {};

/** Finto endpoint charts: serve candele da `available`, al massimo `pageSize` per risposta. */
function fakeCharts(available: number[], pageSize: number) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const q = new URL(url).searchParams;
    const from = Number(q.get('from')) * 1000;
    const to = Number(q.get('to')) * 1000;
    const inRange = available.filter((t) => t >= from && t <= to);
    const page = inRange.slice(0, pageSize);
    return ok({
      candles: page.map((t) => ({ time: t, open: '10', high: '11', low: '9', close: '10.5', volume: 3 })),
      more_candles: inRange.length > pageSize,
    });
  };
  return { fetchImpl, calls };
}

test('parseChartsResponse converte i prezzi in numeri e valida la forma', () => {
  const { candles, more } = parseChartsResponse({ candles: [{ time: T0, open: '1.5', high: '2', low: '1', close: '1.8', volume: '7' }], more_candles: true });
  assert.deepEqual(candles, [{ t: T0, o: 1.5, h: 2, l: 1, c: 1.8, v: 7 }]);
  assert.equal(more, true);
  assert.throws(() => parseChartsResponse({ result: [] }), KrakenHistoryError);
  assert.throws(() => parseChartsResponse({ candles: [{ time: T0, open: 'abc', high: 1, low: 1, close: 1, volume: 1 }] }), /open non numerico/);
});

test('downloadCandles pagina, salta le finestre vuote e restituisce candele ordinate e uniche', async () => {
  const times = [
    ...Array.from({ length: 30 }, (_, i) => T0 + i * BAR_15M_MS),
    ...Array.from({ length: 10 }, (_, i) => T0 + (60 + i) * BAR_15M_MS), // buco di 30 candele
  ];
  const { fetchImpl, calls } = fakeCharts(times, 7);
  const out = await downloadCandles('PF_TESTUSD', T0, T0 + 69 * BAR_15M_MS, { fetchImpl, sleep: noSleep, windowBars: 20, now: () => T0 + 1000 * BAR_15M_MS });
  assert.deepEqual(out.map((c) => c.t), times);
  assert.ok(calls.length > 4, 'deve servire più di una richiesta');
});

test('downloadCandles esclude la candela non ancora chiusa', async () => {
  const times = Array.from({ length: 10 }, (_, i) => T0 + i * BAR_15M_MS);
  const { fetchImpl } = fakeCharts(times, 100);
  const now = T0 + 9 * BAR_15M_MS + 60_000; // la candela delle T0+9 è ancora aperta
  const out = await downloadCandles('PF_TESTUSD', T0, T0 + 9 * BAR_15M_MS, { fetchImpl, sleep: noSleep, now: () => now });
  assert.equal(out.length, 9);
});

test('fetchJsonWithRetry ritenta 429 e 5xx con backoff crescente', async () => {
  const responses = [status(429), status(503), ok({ fine: true })];
  const sleeps: number[] = [];
  const body = await fetchJsonWithRetry('https://x', { fetchImpl: async () => responses.shift()!, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(body, { fine: true });
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('fetchJsonWithRetry non ritenta un 4xx non transitorio', async () => {
  let calls = 0;
  await assert.rejects(fetchJsonWithRetry('https://x', { fetchImpl: async () => { calls++; return status(400); }, sleep: noSleep }), /non transitorio/);
  assert.equal(calls, 1);
});

test('fetchJsonWithRetry si arrende dopo maxAttempts errori di rete (niente cicli infiniti)', async () => {
  let calls = 0;
  await assert.rejects(
    fetchJsonWithRetry('https://x', { fetchImpl: async () => { calls++; throw new Error('ECONNRESET'); }, sleep: noSleep, maxAttempts: 4 }),
    /fallito dopo 4 tentativi/,
  );
  assert.equal(calls, 4);
});

test('parseFundingResponse ordina i record e rifiuta forme inattese', () => {
  const rates = parseFundingResponse({
    rates: [
      { timestamp: '2024-01-01T01:00:00.000Z', fundingRate: 0.2, relativeFundingRate: 0.00001 },
      { timestamp: '2024-01-01T00:00:00.000Z', fundingRate: 0.1, relativeFundingRate: 0.000005 },
    ],
  });
  assert.deepEqual(rates.map((r) => r.t), [Date.UTC(2024, 0, 1, 0), Date.UTC(2024, 0, 1, 1)]);
  assert.throws(() => parseFundingResponse({ data: [] }), KrakenHistoryError);
  assert.throws(() => parseFundingResponse({ rates: [{ timestamp: 'x', fundingRate: 1, relativeFundingRate: 1 }] }), /timestamp non valido/);
});

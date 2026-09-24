// KrakenAdapter: classificazione degli errori, retry, rate limiter, circuit breaker, timeout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CircuitBreaker } from '../../src/engine/exchange/circuitBreaker';
import { classifyKrakenError, KrakenCallError } from '../../src/engine/exchange/errors';
import { floorToStep, InstrumentError, InstrumentRegistry, roundToTick, toSpec } from '../../src/engine/exchange/instruments';
import { KrakenAdapter } from '../../src/engine/exchange/krakenAdapter';
import { TokenBucket } from '../../src/engine/exchange/rateLimiter';
import { FAKE_INSTRUMENTS } from '../../src/engine/sim/fakeKraken';
import { exchangeEnv, T0 } from './helpers';

const sieblyError = (code: number, body: unknown) => ({ code, message: 'x', body, headers: {}, requestOptions: {}, requestParams: {} });

test('classificazione degli errori nella forma lanciata da siebly', () => {
  assert.equal(classifyKrakenError(sieblyError(429, {})).kind, 'rate_limit');
  assert.equal(classifyKrakenError(sieblyError(200, { result: 'error', error: 'apiLimitExceeded' })).kind, 'rate_limit');
  assert.equal(classifyKrakenError(sieblyError(200, { result: 'error', error: 'authenticationError' })).kind, 'auth');
  assert.equal(classifyKrakenError(sieblyError(401, {})).kind, 'auth');
  assert.equal(classifyKrakenError(sieblyError(503, {})).kind, 'transient');
  assert.equal(classifyKrakenError(sieblyError(400, {})).kind, 'rejected');
  assert.equal(classifyKrakenError(sieblyError(200, { result: 'error', error: 'somethingNew' })).kind, 'unknown');
  assert.equal(classifyKrakenError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).kind, 'network');
  assert.equal(classifyKrakenError(Object.assign(new Error('x'), { code: 'ECONNABORTED' })).kind, 'timeout');
  assert.equal(classifyKrakenError('getaddrinfo failed').kind, 'network');
  // Esito di una scrittura: incerto solo se la richiesta può essere arrivata.
  assert.equal(classifyKrakenError(sieblyError(503, {})).mayHaveReachedExchange, true);
  assert.equal(classifyKrakenError(sieblyError(429, {})).mayHaveReachedExchange, false);
  assert.equal(classifyKrakenError(sieblyError(200, { result: 'error', error: 'somethingNew' })).mayHaveReachedExchange, true);
});

test('letture: ritentate sugli errori transitori, non su quelli di autenticazione', async () => {
  const env = exchangeEnv();
  env.fake.failNext('getOpenPositions', { kind: 'http', status: 503 }, 2);
  assert.deepEqual(await env.adapter.openPositions(), []);
  assert.equal(env.fake.calls.filter((c) => c.method === 'getOpenPositions').length, 3);
  env.fake.failNext('getOpenOrders', { kind: 'api_error', error: 'authenticationError' });
  await assert.rejects(() => env.adapter.openOrders(), (e: KrakenCallError) => e.kind === 'auth');
  assert.equal(env.fake.calls.filter((c) => c.method === 'getOpenOrders').length, 1);
});

test('scritture: mai ritentate dall adapter (un retry cieco potrebbe duplicare un ordine)', async () => {
  const env = exchangeEnv();
  env.fake.failNext('submitOrder', { kind: 'http', status: 503 });
  const r = await env.adapter.sendOrder({ orderType: 'ioc', symbol: 'PF_XBTUSD', side: 'buy', size: 0.01, limitPrice: 60_500, cliOrdId: 'x' });
  assert.equal(r.outcome, 'failed');
  assert.equal(env.fake.calls.filter((c) => c.method === 'submitOrder').length, 1);
});

test('rate limiter: aspetta la ricarica del budget invece di superarlo', async () => {
  const clock = { t: T0 };
  const bucket = new TokenBucket({ capacity: 20, refillIntervalMs: 10_000 }, () => clock.t);
  assert.equal(bucket.waitFor(10), 0);
  bucket.take(10);
  bucket.take(10);
  assert.equal(bucket.waitFor(10), 5_000);
  clock.t += 5_000;
  assert.equal(bucket.waitFor(10), 0);
  bucket.drain();
  assert.equal(bucket.available(), 0);
  assert.throws(() => bucket.waitFor(21), /oltre la capacità/);
});

test('adapter: con il budget esaurito le chiamate attendono (tempo virtuale), non falliscono', async () => {
  const env = exchangeEnv();
  const adapter = new KrakenAdapter(env.fake, { now: env.now, sleep: env.sleep, rateLimit: { capacity: 4, refillIntervalMs: 10_000 } });
  const start = env.clock.t;
  for (let i = 0; i < 4; i++) await adapter.openPositions();
  assert.ok(env.clock.t - start >= 10_000, `attesa ${env.clock.t - start} ms`);
});

test('circuit breaker: si apre dopo errori ripetuti, blocca le chiamate normali ma non quelle di protezione', async () => {
  const env = exchangeEnv();
  const adapter = new KrakenAdapter(env.fake, { now: env.now, sleep: env.sleep, readAttempts: 1, circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 } });
  env.fake.failNext('getOpenOrders', { kind: 'http', status: 503 }, 3);
  for (let i = 0; i < 3; i++) await assert.rejects(() => adapter.openOrders());
  assert.equal(adapter.breaker.state, 'open');
  const callsBefore = env.fake.calls.length;
  await assert.rejects(() => adapter.openPositions(), (e: KrakenCallError) => e.kind === 'circuit_open');
  assert.equal(env.fake.calls.length, callsBefore, 'nessuna chiamata partita');
  assert.deepEqual(await adapter.openPositions('protective'), [], 'la protezione passa comunque');
  env.clock.t += 60_000;
  assert.equal(adapter.breaker.state, 'closed', 'il successo della chiamata di protezione ha richiuso il circuito');
});

test('circuit breaker: dopo il cooldown una sola chiamata di prova (half-open)', () => {
  const clock = { t: T0 };
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000 }, () => clock.t);
  breaker.onFailure('transient');
  breaker.onFailure('network');
  assert.equal(breaker.state, 'open');
  assert.equal(breaker.allow(), false);
  clock.t += 1_000;
  assert.equal(breaker.state, 'half_open');
  assert.equal(breaker.allow(), true);
  assert.equal(breaker.allow(), false, 'una sola prova alla volta');
  breaker.onFailure('transient');
  assert.equal(breaker.state, 'open', 'la prova fallita riapre');
  breaker.onFailure('auth');
  clock.t += 1_000;
  assert.equal(breaker.allow(), true);
  breaker.onSuccess();
  assert.equal(breaker.state, 'closed');
});

test('timeout: una chiamata che non risponde fallisce con kind timeout', async () => {
  const env = exchangeEnv();
  const hanging = { ...env.fake, getOpenPositions: () => new Promise<never>(() => {}) } as unknown as typeof env.fake;
  const adapter = new KrakenAdapter(hanging, { now: env.now, sleep: env.sleep, timeoutMs: 30, readAttempts: 1 });
  await assert.rejects(() => adapter.openPositions(), (e: KrakenCallError) => e.kind === 'timeout');
});

test('strumenti: tick, passo della size e massimi letti da Kraken (D19)', async () => {
  const xbt = toSpec(FAKE_INSTRUMENTS[0]);
  assert.deepEqual(xbt, { symbol: 'PF_XBTUSD', tradeable: true, tickSize: 0.5, sizeDecimals: 4, sizeStep: 0.0001, maxPositionSize: 1_000_000 });
  assert.equal(roundToTick(60_000.3, 0.5, 'down'), 60_000);
  assert.equal(roundToTick(60_000.3, 0.5, 'up'), 60_000.5);
  assert.equal(roundToTick(0.30000000000000004, 0.1, 'up'), 0.3, 'nessun errore di virgola mobile');
  assert.equal(roundToTick(0.123456, 0.00001, 'down'), 0.12345);
  assert.equal(floorToStep(0.123456, xbt), 0.1234);
  const doge = toSpec(FAKE_INSTRUMENTS[4]);
  assert.equal(doge.sizeStep, 10);
  assert.equal(floorToStep(1234, doge), 1230);
  assert.equal(floorToStep(5, doge), 0, 'sotto il passo minimo');
  assert.throws(() => toSpec({ ...FAKE_INSTRUMENTS[0], tickSize: undefined }), InstrumentError);
});

test('registro strumenti: cache con scadenza, contratti sconosciuti o non tradabili sono errori', async () => {
  const env = exchangeEnv();
  const registry = new InstrumentRegistry(() => env.adapter.instruments(), env.now, 60_000);
  await registry.requireAll(['PF_XBTUSD', 'PF_ETHUSD']);
  const calls = () => env.fake.calls.filter((c) => c.method === 'getInstruments').length;
  assert.equal(calls(), 1);
  await registry.get('PF_XBTUSD');
  assert.equal(calls(), 1, 'dalla cache');
  env.clock.t += 60_001;
  await registry.get('PF_XBTUSD');
  assert.equal(calls(), 2, 'cache scaduta');
  await assert.rejects(() => registry.get('PF_NOPEUSD'), /sconosciuto/);
  await assert.rejects(() => registry.get('PF_OLDUSD'), /non tradabile/);
});

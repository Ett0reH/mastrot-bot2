// Test di contratto dell'OrderManager (F3, D17, D18, I8, I9) su Kraken simulato.
// Forme delle risposte: tipi di @siebly/kraken-api (types/response/derivatives.types.d.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTransition, isOwnCliOrdId, makeCliOrdId, OrderStateError } from '../../src/engine/exchange/orders';
import type { OrderRequest } from '../../src/engine/exchange/orderManager';
import { exchangeEnv } from './helpers';

const entry = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({
  intentKey: 'BTC-2026-09-24T11:45:00.000Z',
  purpose: 'ENTRY',
  symbol: 'PF_XBTUSD',
  side: 'buy',
  orderType: 'ioc',
  size: 0.01,
  limitPrice: 60_300,
  reduceOnly: false,
  ...overrides,
});

test('cliOrdId deterministico, breve e riconoscibile; un tentativo nuovo cambia id', () => {
  const a = makeCliOrdId('BTC-2026-09-24T11:45:00.000Z', 'ENTRY', 1);
  assert.equal(a, makeCliOrdId('BTC-2026-09-24T11:45:00.000Z', 'ENTRY', 1));
  assert.notEqual(a, makeCliOrdId('BTC-2026-09-24T11:45:00.000Z', 'ENTRY', 2));
  assert.notEqual(a, makeCliOrdId('BTC-2026-09-24T11:45:00.000Z', 'STOP', 1));
  assert.ok(a.length <= 24 && /^[a-z0-9-]+$/.test(a), a);
  assert.ok(isOwnCliOrdId(a));
  assert.ok(!isOwnCliOrdId('manual-order') && !isOwnCliOrdId(null));
});

test('la macchina a stati rifiuta le transizioni non ammesse', () => {
  assertTransition('SUBMITTED', 'UNKNOWN');
  assertTransition('UNKNOWN', 'FILLED');
  assert.throws(() => assertTransition('FILLED', 'CANCELED'), OrderStateError);
  assert.throws(() => assertTransition('INTENT_CREATED', 'FILLED'), OrderStateError);
  assert.throws(() => assertTransition('REJECTED', 'SUBMITTED'), OrderStateError);
});

test('il record è salvato (INTENT_CREATED → SUBMITTED) prima che l ordine parta', async () => {
  const env = exchangeEnv();
  const seen: { state: string; sendCalls: number }[] = [];
  const save = env.store.save.bind(env.store);
  env.store.save = async (r) => {
    seen.push({ state: r.state, sendCalls: env.fake.calls.filter((c) => c.method === 'submitOrder').length });
    await save(r);
  };
  await env.orders.submit(entry());
  assert.deepEqual(seen.slice(0, 2), [{ state: 'INTENT_CREATED', sendCalls: 0 }, { state: 'SUBMITTED', sendCalls: 0 }]);
  assert.equal(seen[2].sendCalls, 1);
});

test('ordine accettato: IOC eseguito per intero → FILLED con i fill della risposta', async () => {
  const env = exchangeEnv();
  const r = await env.orders.submit(entry());
  assert.equal(r.state, 'FILLED');
  assert.equal(r.filledSize, 0.01);
  assert.equal(r.fills[0].price, 60_000);
  assert.ok(r.exchangeOrderId);
  const sent = env.fake.calls.find((c) => c.method === 'submitOrder')!.params as Record<string, unknown>;
  assert.equal(sent.cliOrdId, r.cliOrdId);
  assert.equal(sent.processBefore, r.processBefore);
});

test('ordine limite a riposo → ACKNOWLEDGED; stop → ACKNOWLEDGED', async () => {
  const env = exchangeEnv();
  const lmt = await env.orders.submit(entry({ orderType: 'lmt', limitPrice: 59_000 }));
  assert.equal(lmt.state, 'ACKNOWLEDGED');
  const stp = await env.orders.submit(entry({ purpose: 'STOP', orderType: 'stp', side: 'sell', size: 0.01, limitPrice: undefined, stopPrice: 55_000, reduceOnly: false }));
  assert.equal(stp.state, 'ACKNOWLEDGED');
});

test('ordine rifiutato da Kraken → REJECTED con il motivo; un retry è ammesso', async () => {
  const env = exchangeEnv();
  env.fake.failNext('submitOrder', { kind: 'send_status', status: 'insufficientAvailableFunds' });
  const r = await env.orders.submit(entry());
  assert.equal(r.state, 'REJECTED');
  assert.equal(r.lastError, 'insufficientAvailableFunds');
  const again = await env.orders.retry(r, entry());
  assert.equal(again.attempt, 2);
  assert.equal(again.state, 'FILLED');
});

test('size fuori dal passo del contratto → rifiutato da Kraken (invalidSize)', async () => {
  const env = exchangeEnv();
  const r = await env.orders.submit(entry({ size: 0.00001 }));
  assert.equal(r.state, 'REJECTED');
  assert.equal(r.lastError, 'invalidSize');
});

test('fill parziale: IOC eseguito in parte → CANCELED con la size eseguita', async () => {
  const env = exchangeEnv();
  env.fake.liquidity.set('PF_XBTUSD', 0.004);
  const r = await env.orders.submit(entry());
  assert.equal(r.state, 'CANCELED');
  assert.equal(r.filledSize, 0.004);
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0.004);
});

test('IOC senza liquidità al limite → CANCELED senza fill', async () => {
  const env = exchangeEnv();
  const r = await env.orders.submit(entry({ limitPrice: 59_000 }));
  assert.equal(r.state, 'CANCELED');
  assert.equal(r.filledSize, 0);
});

test('timeout DOPO l invio: UNKNOWN, riconciliato come eseguito, zero ordini duplicati', async () => {
  const env = exchangeEnv();
  env.fake.failNext('submitOrder', { kind: 'timeout_after_processing' });
  const r = await env.orders.submit(entry());
  assert.equal(r.state, 'UNKNOWN', 'mai considerato eseguito o fallito per default');
  await assert.rejects(() => env.orders.retry(r, entry()), /Retry non ammesso/);
  const reconciled = await env.orders.reconcile(r.cliOrdId);
  assert.equal(reconciled.state, 'FILLED');
  assert.equal(reconciled.filledSize, 0.01);
  assert.equal(env.fake.ordersWithCliOrdId(r.cliOrdId).length, 1);
  assert.equal(env.fake.calls.filter((c) => c.method === 'submitOrder').length, 1);
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0.01, 'una sola posizione, non due');
});

test('errore di rete prima dell elaborazione: UNKNOWN fino a processBefore, poi REJECTED e retry sicuro', async () => {
  const env = exchangeEnv();
  env.fake.failNext('submitOrder', { kind: 'network' });
  const r = await env.orders.submit(entry());
  assert.equal(r.state, 'UNKNOWN');
  const early = await env.orders.reconcile(r.cliOrdId);
  assert.equal(early.state, 'UNKNOWN', 'prima della scadenza l assenza di tracce non prova nulla');
  env.clock.t = Date.parse(r.processBefore) + 5_001;
  const late = await env.orders.reconcile(r.cliOrdId);
  assert.equal(late.state, 'REJECTED');
  const retried = await env.orders.retry(late, entry());
  assert.equal(retried.state, 'FILLED');
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0.01);
});

test('un ordine inviato in ritardo oltre processBefore non viene eseguito da Kraken', async () => {
  const env = exchangeEnv();
  const r = await env.orders.submit(entry());
  assert.equal(r.state, 'FILLED');
  // Stessa richiesta consegnata a Kraken dopo la scadenza (es. rimasta in coda nella rete).
  const late = await env.fake.submitOrder({ orderType: 'ioc', symbol: 'PF_XBTUSD', side: 'buy', size: 0.01, limitPrice: 60_300, cliOrdId: 'mt-e-0000000000000000-9', processBefore: new Date(env.clock.t - 1).toISOString() });
  assert.equal(late.sendStatus.status, 'wouldProcessAfterSpecifiedTime');
});

test('429 e apiLimitExceeded: non elaborato → REJECTED subito; il rate limiter si svuota', async () => {
  const env = exchangeEnv();
  env.fake.failNext('submitOrder', { kind: 'http', status: 429 });
  const r = await env.orders.submit(entry());
  assert.equal(r.state, 'REJECTED');
  assert.match(r.lastError ?? '', /rate_limit/);
  assert.equal(env.adapter.bucket.available(), 0);
  env.fake.failNext('submitOrder', { kind: 'api_error', error: 'apiLimitExceeded' });
  const r2 = await env.orders.submit(entry({ intentKey: 'other' }));
  assert.equal(r2.state, 'REJECTED');
  assert.equal(env.fake.orders.size, 0);
});

test('503: esito incerto → UNKNOWN, poi riconciliato (qui non elaborato) → REJECTED dopo la scadenza', async () => {
  const env = exchangeEnv();
  env.fake.failNext('submitOrder', { kind: 'http', status: 503 });
  const r = await env.orders.submit(entry());
  assert.equal(r.state, 'UNKNOWN');
  env.clock.t = Date.parse(r.processBefore) + 6_000;
  assert.equal((await env.orders.reconcile(r.cliOrdId)).state, 'REJECTED');
});

test('D17: un ordine che Kraken non conosce non diventa mai "closed" o "filled"', async () => {
  const env = exchangeEnv();
  env.fake.failNext('submitOrder', { kind: 'timeout_after_processing' });
  const r = await env.orders.submit(entry({ orderType: 'lmt', limitPrice: 59_000 }));
  assert.equal(r.state, 'UNKNOWN');
  // L'ordine è a riposo sul book: la riconciliazione lo trova aperto.
  assert.equal((await env.orders.reconcile(r.cliOrdId)).state, 'ACKNOWLEDGED');
  // Viene cancellato a mano e sparisce dallo stato dopo 5 secondi: senza fill è CANCELED, non FILLED.
  env.fake.dropOrder(r.cliOrdId);
  env.clock.t += 60_000;
  const gone = await env.orders.reconcile(r.cliOrdId);
  assert.equal(gone.state, 'CANCELED');
  assert.equal(gone.filledSize, 0);
});

test('clientOrderIdAlreadyExist: l ordine esiste già su Kraken → UNKNOWN e riconciliazione', async () => {
  const env = exchangeEnv();
  env.fake.failNext('submitOrder', { kind: 'send_status', status: 'clientOrderIdAlreadyExist' });
  const r = await env.orders.submit(entry());
  assert.equal(r.state, 'UNKNOWN');
});

test('un cliOrdId già registrato non viene mai reinviato', async () => {
  const env = exchangeEnv();
  await env.orders.submit(entry());
  await assert.rejects(() => env.orders.submit(entry()), /già usato/);
});

test('reconcileAll risolve più ordini con una sola lettura di stato, ordini aperti e fill', async () => {
  const env = exchangeEnv();
  env.fake.failNext('submitOrder', { kind: 'timeout_after_processing' }, 2);
  await env.orders.submit(entry({ intentKey: 'a' }));
  await env.orders.submit(entry({ intentKey: 'b', symbol: 'PF_ETHUSD', limitPrice: 3_100, size: 0.1 }));
  const before = env.fake.calls.length;
  const out = await env.orders.reconcileAll();
  assert.deepEqual(out.map((r) => r.state), ['FILLED', 'FILLED']);
  const methods = env.fake.calls.slice(before).map((c) => c.method).sort();
  assert.deepEqual(methods, ['getFills', 'getOpenOrders', 'getOrderStatus']);
});

// StopManager e leva isolated (F3: I7, D13, D20) su Kraken simulato.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InstrumentRegistry } from '../../src/engine/exchange/instruments';
import { ensureIsolatedLeverage, exchangeLeverage } from '../../src/engine/exchange/leverage';
import { StopManager, type StopTarget } from '../../src/engine/exchange/stopManager';
import { MemoryAlertSink } from '../../src/engine/ops/alerts';
import { exchangeEnv } from './helpers';

function stopEnv() {
  const env = exchangeEnv();
  const alerts = new MemoryAlertSink();
  const instruments = new InstrumentRegistry(() => env.adapter.instruments(), env.now);
  const stops = new StopManager(env.orders, env.adapter, instruments, alerts, { now: env.now, maxConsecutiveFailures: 3 });
  env.fake.externalOpen('PF_XBTUSD', 'buy', 0.01);
  const target: StopTarget = { positionId: 'BTC-p1', symbol: 'PF_XBTUSD', direction: 'LONG', size: 0.01, level: 55_123.4 };
  const sends = () => env.fake.calls.filter((c) => c.method === 'submitOrder').length;
  return { ...env, alerts, stops, target, sends };
}

test('stop nativo: stp reduceOnly sul mark price, size della posizione, livello arrotondato lontano dal prezzo', async () => {
  const env = stopEnv();
  const res = await env.stops.ensure(env.target);
  assert.equal(res.status, 'PROTECTED');
  const [stop] = env.fake.openOrdersFor('PF_XBTUSD');
  assert.equal(stop.type, 'stp');
  assert.equal(stop.side, 'sell');
  assert.equal(stop.reduceOnly, true);
  assert.equal(stop.triggerSignal, 'mark');
  assert.equal(stop.size, 0.01);
  assert.equal(stop.stopPrice, 55_123, 'LONG: arrotondato per difetto al tick 0,5');
});

test('ensure è idempotente: una posizione protetta non genera nuovi ordini', async () => {
  const env = stopEnv();
  await env.stops.ensure(env.target);
  const before = env.sends();
  const again = await env.stops.ensure(env.target);
  assert.equal(again.status, 'PROTECTED');
  assert.equal(env.sends(), before);
  assert.equal(env.fake.openOrdersFor('PF_XBTUSD').length, 1);
});

test('aggiornamento alla chiusura 1H: editorder e verifica sugli ordini aperti', async () => {
  const env = stopEnv();
  await env.stops.ensure(env.target);
  const res = await env.stops.ensure({ ...env.target, level: 57_000.2 });
  assert.equal(res.status, 'PROTECTED');
  assert.equal(env.fake.calls.filter((c) => c.method === 'editOrder').length, 1);
  const [stop] = env.fake.openOrdersFor('PF_XBTUSD');
  assert.equal(stop.stopPrice, 57_000);
  assert.equal(env.fake.openOrdersFor('PF_XBTUSD').length, 1);
});

test('modifica fallita: lo stop viene sostituito (cancel + nuovo), mai due stop attivi', async () => {
  const env = stopEnv();
  await env.stops.ensure(env.target);
  env.fake.failNext('editOrder', { kind: 'http', status: 503 });
  const res = await env.stops.ensure({ ...env.target, level: 57_000 });
  assert.equal(res.status, 'PROTECTED');
  const open = env.fake.openOrdersFor('PF_XBTUSD');
  assert.equal(open.length, 1);
  assert.equal(open[0].stopPrice, 57_000);
  assert.match(open[0].cliOrdId ?? '', /-2$/, 'nuovo tentativo, nuovo cliOrdId');
});

test('stop mancante (cancellato a mano): alert e ripristino', async () => {
  const env = stopEnv();
  const first = await env.stops.ensure(env.target);
  assert.equal(first.status, 'PROTECTED');
  env.fake.dropOrder(first.status === 'PROTECTED' ? first.stop.cliOrdId : '');
  env.clock.t += 30_000;
  const res = await env.stops.ensure(env.target);
  assert.equal(res.status, 'PROTECTED');
  assert.deepEqual(env.alerts.codes(), ['STOP_MISSING', 'STOP_RESTORED']);
  assert.equal(env.fake.openOrdersFor('PF_XBTUSD').length, 1);
});

test('stop rifiutato più volte: FAILED; la chiusura d emergenza azzera la posizione', async () => {
  const env = stopEnv();
  env.fake.failNext('submitOrder', { kind: 'send_status', status: 'invalidPrice' }, 3);
  assert.equal((await env.stops.ensure(env.target)).status, 'PENDING');
  assert.equal((await env.stops.ensure(env.target)).status, 'PENDING');
  const res = await env.stops.ensure(env.target);
  assert.equal(res.status, 'FAILED');
  const close = await env.stops.emergencyClose(env.target, 'stop non piazzabile');
  assert.equal(close.state, 'FILLED');
  assert.equal(close.reduceOnly, true);
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0);
  assert.ok(env.alerts.codes().includes('EMERGENCY_CLOSE'));
});

test('prezzo già oltre il livello: lo stop scatta subito e la posizione si chiude', async () => {
  const env = stopEnv();
  const res = await env.stops.ensure({ ...env.target, level: 61_000 });
  assert.equal(res.status, 'PENDING');
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0);
});

test('nessuna posizione su Kraken: NO_POSITION, non uno stop che aprirebbe una posizione', async () => {
  const env = stopEnv();
  env.fake.externalClose('PF_XBTUSD');
  const res = await env.stops.ensure(env.target);
  assert.equal(res.status, 'NO_POSITION');
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0);
});

test('SHORT: stop buy sopra il prezzo, arrotondato per eccesso', async () => {
  const env = stopEnv();
  env.fake.externalOpen('PF_ETHUSD', 'sell', 0.5);
  const res = await env.stops.ensure({ positionId: 'ETH-p1', symbol: 'PF_ETHUSD', direction: 'SHORT', size: 0.5, level: 3_150.04 });
  assert.equal(res.status, 'PROTECTED');
  const [stop] = env.fake.openOrdersFor('PF_ETHUSD');
  assert.equal(stop.side, 'buy');
  assert.equal(stop.stopPrice, 3_150.1);
});

test('dopo la chiusura della posizione lo stop viene cancellato', async () => {
  const env = stopEnv();
  await env.stops.ensure(env.target);
  await env.stops.remove(env.target.positionId);
  assert.equal(env.fake.openOrdersFor('PF_XBTUSD').length, 0);
});

test('leva: intero superiore della leva della strategia, mai sotto 1x', () => {
  assert.equal(exchangeLeverage(1), 1);
  assert.equal(exchangeLeverage(1.7), 2);
  assert.equal(exchangeLeverage(3), 3);
  assert.equal(exchangeLeverage(0.4), 1);
  assert.throws(() => exchangeLeverage(0));
});

test('D20: la leva isolated viene impostata e riletta; se non è applicata, niente ingresso', async () => {
  const env = exchangeEnv();
  const ok = await ensureIsolatedLeverage(env.adapter, 'PF_XBTUSD', 1.7);
  assert.deepEqual(ok, { outcome: 'ok', leverage: 2, changed: true });
  assert.deepEqual(await ensureIsolatedLeverage(env.adapter, 'PF_XBTUSD', 2), { outcome: 'ok', leverage: 2, changed: false });
  env.fake.ignoreLeverageFor.add('PF_ETHUSD');
  const ignored = await ensureIsolatedLeverage(env.adapter, 'PF_ETHUSD', 3);
  assert.equal(ignored.outcome, 'failed');
  assert.match(ignored.outcome === 'failed' ? ignored.reason : '', /cross margin/);
  env.fake.failNext('setLeverageSettings', { kind: 'http', status: 503 });
  const failed = await ensureIsolatedLeverage(env.adapter, 'PF_SOLUSD', 2);
  assert.equal(failed.outcome, 'failed');
});

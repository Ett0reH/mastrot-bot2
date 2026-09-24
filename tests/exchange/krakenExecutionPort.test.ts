// KrakenExecutionPort su Kraken simulato: casi del gate F3 (accettato, rifiutato, fill parziale,
// timeout dopo l'invio, stop mancante, posizione chiusa dall'esterno) più leva, backstop,
// posizioni sconosciute (D22) e chiusura d'emergenza (I7).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloseIntent, OpenIntent } from '../../src/engine/core/types';
import { InstrumentRegistry } from '../../src/engine/exchange/instruments';
import { DEFAULT_KRAKEN_PORT_CONFIG, FundingFromLedgerPending, KrakenExecutionPort, type KrakenPortConfig } from '../../src/engine/exchange/krakenExecutionPort';
import { StopManager } from '../../src/engine/exchange/stopManager';
import { MemoryAlertSink } from '../../src/engine/ops/alerts';
import { exchangeEnv, T0 } from './helpers';

const POSITION = 'BTC-2026-09-24T11:45:00.000Z';

function portEnv(config: Partial<KrakenPortConfig> = {}) {
  const env = exchangeEnv();
  const alerts = new MemoryAlertSink();
  const instruments = new InstrumentRegistry(() => env.adapter.instruments(), env.now);
  const stops = new StopManager(env.orders, env.adapter, instruments, alerts, { now: env.now });
  const port = new KrakenExecutionPort(
    { mode: 'demo', adapter: env.adapter, orders: env.orders, stops, instruments, alerts, funding: new FundingFromLedgerPending(), now: env.now },
    { ...DEFAULT_KRAKEN_PORT_CONFIG, ...config },
  );
  const sends = () => env.fake.calls.filter((c) => c.method === 'submitOrder').length;
  const stopsOn = (symbol: string) => env.fake.openOrdersFor(symbol).filter((o) => o.type === 'stp');
  return { ...env, alerts, stops, port, sends, stopsOn };
}

const openIntent = (o: Partial<OpenIntent> = {}): OpenIntent => ({
  kind: 'OPEN', symbol: 'BTC', slotTime: T0 - 15 * 60_000, positionId: POSITION, direction: 'LONG', size: 0.01234, leverage: 1.7,
  referencePrice: 60_000, stopLoss: 57_000, catastropheStopLoss: 51_000, backstop: 55_290, engine: 'EXTREME', setup: 'MEAN_REVERSION',
  regime: 'CRASH', tierLabel: 'EXTREME_10', quality: 0.9, isChopEntry: false, isReducedLeverageAction: false, ...o,
});

const closeIntent = (o: Partial<CloseIntent> = {}): CloseIntent => ({
  kind: 'CLOSE', symbol: 'BTC', slotTime: T0 + 45 * 60_000, positionId: POSITION, direction: 'LONG', size: 0.0123, referencePrice: 61_000, exitType: 'PROFIT_STOP', ...o,
});

test('in shadow la porta Kraken non si può costruire', () => {
  const env = exchangeEnv();
  const instruments = new InstrumentRegistry(() => env.adapter.instruments(), env.now);
  const alerts = new MemoryAlertSink();
  const stops = new StopManager(env.orders, env.adapter, instruments, alerts, { now: env.now });
  assert.throws(() => new KrakenExecutionPort({ mode: 'shadow', adapter: env.adapter, orders: env.orders, stops, instruments, alerts, funding: new FundingFromLedgerPending(), now: env.now }), /shadow/);
});

test('ingresso accettato: leva isolated, IOC con buffer, size sul passo del contratto, stop sulla size eseguita', async () => {
  const env = portEnv();
  const report = await env.port.execute([openIntent()]);
  assert.deepEqual(report.rejected, []);
  const [fill] = report.fills;
  assert.equal(fill.kind, 'OPEN');
  assert.equal(fill.size, 0.0123, 'size arrotondata per difetto al passo 0,0001');
  assert.equal(fill.price, 60_000);
  assert.equal(fill.feeEstimated, true);
  assert.equal(env.fake.leverage.get('PF_XBTUSD'), 2, 'leva 1,7x della strategia → 2x isolated su Kraken');
  const sent = env.fake.calls.find((c) => c.method === 'submitOrder')!.params as Record<string, unknown>;
  assert.equal(sent.orderType, 'ioc');
  assert.equal(sent.limitPrice, 60_300, 'buffer 0,5% sul prezzo della decisione');
  const [stop] = env.stopsOn('PF_XBTUSD');
  assert.equal(stop.size, 0.0123);
  assert.equal(stop.stopPrice, 55_290);
  assert.equal(stop.reduceOnly, true);
  assert.ok(env.port.state.positions[POSITION]);
  assert.equal(env.port.state.positions[POSITION].unprotectedSince, null);
});

test('fill parziale: la posizione e lo stop hanno la size eseguita', async () => {
  const env = portEnv();
  env.fake.liquidity.set('PF_XBTUSD', 0.005);
  const report = await env.port.execute([openIntent()]);
  assert.equal(report.fills[0].size, 0.005);
  assert.equal(env.stopsOn('PF_XBTUSD')[0].size, 0.005);
  assert.ok(env.alerts.alerts.some((a) => a.code === 'ENTRY' && /parziale/.test(a.message)));
});

test('D20: se la leva isolated non viene applicata, nessun ordine d ingresso', async () => {
  const env = portEnv();
  env.fake.ignoreLeverageFor.add('PF_XBTUSD');
  const report = await env.port.execute([openIntent()]);
  assert.equal(report.rejected.length, 1);
  assert.equal(env.sends(), 0);
  assert.ok(env.alerts.codes().includes('LEVERAGE_NOT_SET'));
});

test('ingresso rifiutato: prezzo oltre il buffer (IOC non eseguito) o size sotto il minimo', async () => {
  const env = portEnv();
  env.fake.setMark('PF_XBTUSD', 61_000);
  const moved = await env.port.execute([openIntent()]);
  assert.equal(moved.fills.length, 0);
  assert.match(moved.rejected[0].reason, /CANCELED/);
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0);
  const tiny = await env.port.execute([openIntent({ positionId: 'BTC-tiny', size: 0.00001 })]);
  assert.match(tiny.rejected[0].reason, /passo minimo/);
});

test('timeout dopo l invio dell ingresso: in sospeso, poi risolto dalla riconciliazione; zero duplicati', async () => {
  const env = portEnv();
  env.fake.failNext('submitOrder', { kind: 'timeout_after_processing' });
  const report = await env.port.execute([openIntent()]);
  assert.deepEqual(report, { fills: [], rejected: [] });
  assert.ok(env.port.state.pendingEntries[POSITION]);
  const settled = await env.port.settle();
  assert.equal(settled.fills.length, 1);
  assert.equal(settled.fills[0].kind, 'OPEN');
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0.0123, 'una sola posizione');
  const entryOrders = [...env.fake.orders.values()].filter((o) => o.type === 'ioc');
  assert.equal(entryOrders.length, 1, 'un solo ordine d ingresso su Kraken');
  assert.equal(env.stopsOn('PF_XBTUSD').length, 1, 'e protetto dallo stop');
});

test('ingresso senza traccia su Kraken dopo processBefore: rifiutato, nessuna posizione', async () => {
  const env = portEnv();
  env.fake.failNext('submitOrder', { kind: 'network' });
  await env.port.execute([openIntent()]);
  env.clock.t += 60_000;
  const settled = await env.port.settle();
  assert.equal(settled.rejected.length, 1);
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0);
});

test('UPDATE_STOP alla chiusura oraria: lo stop viene spostato e verificato', async () => {
  const env = portEnv();
  await env.port.execute([openIntent()]);
  await env.port.execute([{ kind: 'UPDATE_STOP', symbol: 'BTC', slotTime: T0 + 45 * 60_000, positionId: POSITION, direction: 'LONG', size: 0.0123, strategyStop: 58_000, backstop: 56_260 }]);
  const [stop] = env.stopsOn('PF_XBTUSD');
  assert.equal(stop.stopPrice, 56_260);
  assert.equal(env.stopsOn('PF_XBTUSD').length, 1);
});

test('uscita: mercato reduceOnly, chiusura al core col motivo della strategia, stop cancellato', async () => {
  const env = portEnv();
  await env.port.execute([openIntent()]);
  env.fake.setMark('PF_XBTUSD', 61_000);
  const report = await env.port.execute([closeIntent()]);
  const [fill] = report.fills;
  assert.equal(fill.kind, 'CLOSE');
  assert.equal(fill.exitType, 'PROFIT_STOP');
  assert.equal(fill.price, 61_000);
  assert.equal(fill.size, 0.0123);
  const exit = env.fake.calls.filter((c) => c.method === 'submitOrder').map((c) => c.params as Record<string, unknown>).find((p) => p.orderType === 'mkt');
  assert.equal(exit?.reduceOnly, true);
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0);
  assert.equal(env.stopsOn('PF_XBTUSD').length, 0);
  assert.deepEqual(env.port.state.positions, {});
});

test('uscita parziale: prosegue nel ciclo di protezione; il core riceve un unica chiusura al prezzo medio', async () => {
  const env = portEnv();
  await env.port.execute([openIntent()]);
  env.fake.liquidity.set('PF_XBTUSD', 0.01);
  env.fake.setMark('PF_XBTUSD', 61_000);
  const first = await env.port.execute([closeIntent()]);
  assert.deepEqual(first.fills, []);
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0.0023);
  env.fake.setMark('PF_XBTUSD', 60_000);
  const settled = await env.port.settle();
  const [fill] = settled.fills;
  assert.equal(fill.kind, 'CLOSE');
  assert.equal(fill.size, 0.0123);
  assert.ok(Math.abs(fill.price - (0.01 * 61_000 + 0.0023 * 60_000) / 0.0123) < 1e-6);
  assert.equal(fill.exitType, 'PROFIT_STOP');
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0);
});

test('backstop scattato su Kraken: il core riceve la chiusura BACKSTOP al prezzo del fill', async () => {
  const env = portEnv();
  await env.port.execute([openIntent()]);
  env.clock.t += 60_000;
  env.fake.setMark('PF_XBTUSD', 54_000);
  const settled = await env.port.settle();
  assert.equal(settled.fills.length, 1);
  assert.equal(settled.fills[0].exitType, 'BACKSTOP');
  assert.equal(settled.fills[0].price, 54_000);
  assert.deepEqual(env.port.state.positions, {});
});

test('posizione chiusa dall esterno (a mano): chiusura EXTERNAL_CLOSE al core e alert di desync', async () => {
  const env = portEnv();
  await env.port.execute([openIntent()]);
  env.clock.t += 60_000;
  env.fake.externalClose('PF_XBTUSD');
  const settled = await env.port.settle();
  assert.equal(settled.fills[0].exitType, 'EXTERNAL_CLOSE');
  assert.ok(env.alerts.codes().includes('DESYNC'));
  assert.equal(env.stopsOn('PF_XBTUSD').length, 0, 'lo stop residuo viene cancellato');
});

test('stop mancante: il ciclo di protezione lo ripristina e lo segnala', async () => {
  const env = portEnv();
  await env.port.execute([openIntent()]);
  const [stop] = env.stopsOn('PF_XBTUSD');
  env.fake.dropOrder(stop.cliOrdId as string);
  env.clock.t += 30_000;
  const settled = await env.port.settle();
  assert.deepEqual(settled, { fills: [], rejected: [] });
  assert.equal(env.stopsOn('PF_XBTUSD').length, 1);
  assert.ok(env.alerts.codes().includes('STOP_MISSING'));
});

test('I7: stop impossibile da piazzare → chiusura d emergenza reduceOnly e chiusura PROTECTION_FAILURE al core', async () => {
  const env = portEnv();
  const isStop = (p: unknown) => (p as { orderType?: string }).orderType === 'stp';
  env.fake.failNext('submitOrder', { kind: 'send_status', status: 'invalidPrice' }, 3, isStop);
  const opened = await env.port.execute([openIntent()]);
  assert.equal(opened.fills.length, 1, 'l ingresso è eseguito');
  assert.equal(env.stopsOn('PF_XBTUSD').length, 0);
  const fills = [];
  for (let i = 0; i < 3 && fills.length === 0; i++) {
    env.clock.t += 20_000;
    fills.push(...(await env.port.settle()).fills);
  }
  assert.equal(fills.length, 1);
  assert.equal(fills[0].exitType, 'PROTECTION_FAILURE');
  assert.equal(fills[0].size, 0.0123);
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0);
  assert.ok(env.alerts.codes().includes('EMERGENCY_CLOSE'));
  const emergency = env.fake.calls.map((c) => c.params as Record<string, unknown>).filter((p) => p?.orderType === 'mkt');
  assert.equal(emergency.length, 1);
  assert.equal(emergency[0].reduceOnly, true);
});

test('I7: posizione senza stop verificato oltre il tempo massimo → chiusura d emergenza', async () => {
  const env = portEnv({ stopTimeoutMs: 60_000 });
  // Tutti gli stop falliscono per errori di rete (esito incerto, poi mai elaborati).
  const report = await env.port.execute([openIntent()]);
  assert.equal(report.fills.length, 1);
  const [stop] = env.stopsOn('PF_XBTUSD');
  env.fake.dropOrder(stop.cliOrdId as string);
  const isStop = (p: unknown) => (p as { orderType?: string }).orderType === 'stp';
  env.fake.failNext('submitOrder', { kind: 'network' }, 50, isStop);
  const closes = [];
  let emergencyAt = null;
  const start = env.clock.t;
  for (let i = 0; i < 10 && closes.length === 0; i++) {
    env.clock.t += 20_000;
    closes.push(...(await env.port.settle()).fills);
    if (emergencyAt === null && env.alerts.codes().includes('EMERGENCY_CLOSE')) emergencyAt = env.clock.t;
  }
  assert.equal(closes.length, 1);
  assert.equal(closes[0].exitType, 'PROTECTION_FAILURE');
  assert.equal(env.fake.positionSize('PF_XBTUSD'), 0);
  assert.ok(emergencyAt !== null && emergencyAt - start <= 60_000 + 20_000 + 20_000, 'entro il tempo massimo senza protezione (+ un ciclo)');
});

test('D22: posizione sconosciuta su Kraken → alert e stop protettivo, nessuna gestione e nessun fill al core', async () => {
  const env = portEnv();
  env.fake.externalOpen('PF_ETHUSD', 'buy', 0.5);
  const first = await env.port.settle();
  assert.deepEqual(first, { fills: [], rejected: [] });
  assert.ok(env.alerts.codes().includes('UNKNOWN_POSITION'));
  const [stop] = env.stopsOn('PF_ETHUSD');
  assert.equal(stop.stopPrice, 2_850, '5% sotto il prezzo d ingresso');
  assert.equal(stop.reduceOnly, true);
  await env.port.settle();
  assert.equal(env.alerts.codes().filter((c) => c === 'UNKNOWN_POSITION').length, 1, 'un solo alert');
  assert.equal(env.stopsOn('PF_ETHUSD').length, 1, 'un solo stop');
  env.fake.externalClose('PF_ETHUSD');
  env.clock.t += 30_000;
  await env.port.settle();
  assert.deepEqual(env.port.state.unknownPositions, {});
  assert.equal(env.stopsOn('PF_ETHUSD').length, 0, 'lo stop protettivo viene rimosso');
});

test('ordini propri rimasti senza posizione vengono cancellati; quelli altrui solo segnalati', async () => {
  const env = portEnv();
  await env.port.execute([openIntent()]);
  env.fake.failNext('cancelOrder', { kind: 'http', status: 503 });
  await env.port.execute([closeIntent()]);
  assert.equal(env.stopsOn('PF_XBTUSD').length, 1, 'cancellazione fallita: stop residuo');
  await env.fake.submitOrder({ orderType: 'lmt', symbol: 'PF_SOLUSD', side: 'buy', size: 1, limitPrice: 100, cliOrdId: 'manual-1' });
  env.clock.t += 30_000;
  await env.port.settle();
  assert.equal(env.stopsOn('PF_XBTUSD').length, 0);
  assert.equal(env.fake.openOrdersFor('PF_SOLUSD').length, 1, 'l ordine manuale non viene toccato');
  assert.ok(env.alerts.codes().includes('UNKNOWN_ORDER'));
});

// Scenari di caos automatizzati (gate F7) sul percorso completo: runtime in demo, Kraken simulato,
// dati reali del 21-23 gennaio 2022 (13 trade nel run di riferimento, fino a 7 posizioni aperte).
// Ogni scenario inietta un guasto e poi verifica gli invarianti (invariants.ts) a metà del periodo,
// con le posizioni aperte, e alla fine. Dove il guasto non deve cambiare l'esito, i trade devono
// essere identici a quelli del run senza guasti.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeCliOrdId } from '../../src/engine/exchange/orders';
import { Logger } from '../../src/engine/ops/logger';
import { makeInstance, makeWorld, MIN, step, SYMBOLS, tickTimes, type Instance, type World } from '../runtime/world';
import { assertInvariants, persistedTrades } from './invariants';

const MID = Date.parse('2022-01-22T08:30:00Z'); // 6 posizioni aperte nel run di riferimento
const END = Date.parse('2022-01-23T03:00:00Z'); // tutte chiuse

type Hook = (world: World, t: number) => void | Promise<void>;

async function run(world: World, instances: Instance[], until: number, options: { from?: number; everyProtection?: boolean; hooks?: Record<string, Hook> } = {}): Promise<void> {
  const hooks = new Map(Object.entries(options.hooks ?? {}).map(([k, fn]) => [Date.parse(k), fn] as const));
  for (const t of tickTimes(options.from ?? world.startMs, until)) {
    for (const [at, fn] of hooks) {
      if (at <= t && at > t - 15 * MIN) await fn(world, t);
    }
    await step(world, instances, t, options.everyProtection);
  }
}

let referenceTrades: string[] | null = null;
async function reference(): Promise<string[]> {
  if (referenceTrades) return referenceTrades;
  const world = makeWorld();
  const a = makeInstance(world, 'R');
  await a.runtime.ensureRunning();
  await run(world, [a], MID);
  await assertInvariants(world, a, 'riferimento a metà');
  await run(world, [a], END, { from: world.clock.t });
  await assertInvariants(world, a, 'riferimento alla fine');
  referenceTrades = await persistedTrades(world);
  assert.equal(referenceTrades.length, 13);
  return referenceTrades;
}

test('riferimento senza guasti: invarianti rispettati con 6 posizioni aperte e alla fine', async () => {
  assert.equal((await reference()).length, 13);
});

test('raffiche di errori 503 su letture e scritture: il bot resta in controllo, niente duplicati', async () => {
  const world = makeWorld();
  const lines: string[] = [];
  const a = makeInstance(world, 'A', { logger: new Logger({ write: (l) => lines.push(l), now: world.now }) });
  await a.runtime.ensureRunning();
  const burst: Hook = (w) => {
    for (const method of ['submitOrder', 'editOrder', 'cancelOrder', 'getOpenPositions', 'getOpenOrders', 'getOrderStatus', 'getFills', 'getAccounts'] as const) {
      w.fake.failNext(method, { kind: 'http', status: 503 }, 6);
    }
  };
  // Raffiche sull'ingresso SOL, a metà mattina e sul ciclo con 4 ingressi e 3 uscite del 22.
  await run(world, [a], MID, { everyProtection: true, hooks: { '2022-01-21T02:01:00Z': burst, '2022-01-22T06:01:00Z': burst } });
  await assertInvariants(world, a, '503 a metà');
  await run(world, [a], END, { from: world.clock.t, everyProtection: true, hooks: { '2022-01-22T10:01:00Z': burst } });
  await assertInvariants(world, a, '503 alla fine');
  const errors503 = lines.filter((l) => l.includes('HTTP 503'));
  assert.ok(errors503.length >= 10, `errori 503 visti dal bot: ${errors503.length}`);
  const trades = await persistedTrades(world);
  assert.ok(trades.length > 0 && trades.length <= 13, `trade: ${trades.length}`);
});

test('timeout dopo l invio su ogni ingresso e uscita: esito riconciliato, trade identici al riferimento', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  world.fake.failNext('submitOrder', { kind: 'timeout_after_processing' }, 100, (p) => ['ioc', 'mkt'].includes((p as { orderType: string }).orderType));
  await a.runtime.ensureRunning();
  await run(world, [a], MID);
  await assertInvariants(world, a, 'timeout a metà');
  await run(world, [a], END, { from: world.clock.t });
  await assertInvariants(world, a, 'timeout alla fine');
  assert.deepEqual(await persistedTrades(world), await reference());
  assert.ok(a.alerts.codes().includes('ORDER_UNKNOWN_STATE') || world.calls.filter((c) => c.method === 'getOrderStatus').length > 0, 'gli esiti incerti sono stati riconciliati');
});

test('fill parziali in ingresso e in uscita: posizione, stop e chiusura seguono la size reale', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  world.fake.liquidity.set('PF_SOLUSD', 5); // l'ingresso SOL (9,44) si esegue solo per 5
  await run(world, [a], Date.parse('2022-01-21T05:00:00Z'));
  const sol = (a.runtime.statusPayload().openPositions as { symbol: string; size: number }[]).find((p) => p.symbol === 'SOL');
  assert.equal(sol?.size, 5, 'la posizione nel core è quella eseguita');
  assert.ok(a.alerts.alerts.some((x) => x.code === 'ENTRY' && /parziale/.test(x.message)));
  await assertInvariants(world, a, 'parziale in ingresso');
  // L'uscita di XRP (1.920) del 22 alle 06:01 trova liquidità solo per 1.000: il resto si chiude dopo.
  await run(world, [a], Date.parse('2022-01-22T05:50:00Z'), { from: world.clock.t });
  world.fake.liquidity.set('PF_XRPUSD', 1_000);
  await run(world, [a], Date.parse('2022-01-22T06:02:00Z'), { from: world.clock.t, everyProtection: true });
  world.fake.liquidity.delete('PF_XRPUSD');
  await run(world, [a], END, { from: world.clock.t, everyProtection: true });
  await assertInvariants(world, a, 'parziale in uscita');
  const xrp = (await world.docs.query<{ symbol: string; entryTime: string; size: number; reason: string }>('trades', [])).map((d) => d.data).find((t) => t.symbol.startsWith('XRP') && t.entryTime === '2022-01-21T21:45:00.000Z');
  assert.ok(xrp, 'il trade XRP è chiuso per intero');
  assert.equal(xrp.size, 1920);
  const exitIntent = makeCliOrdId('XRP-2022-01-21T21:45:00.000Z', 'EXIT', 1).replace(/-1$/, '');
  const xrpExits = [...world.fake.orders.values()].filter((o) => (o.cliOrdId ?? '').startsWith(`${exitIntent}-`) && o.filled > 0);
  assert.deepEqual(xrpExits.map((o) => o.filled), [1000, 920], 'due ordini di uscita: il secondo per il resto');
});

test('stop rifiutato da Kraken: la posizione scoperta viene chiusa entro il timeout, con alert', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  world.fake.failNext('submitOrder', { kind: 'send_status', status: 'outsidePriceCollar' }, 1_000, (p) => (p as { orderType: string; symbol: string }).orderType === 'stp' && (p as { symbol: string }).symbol === 'PF_SOLUSD');
  await a.runtime.ensureRunning();
  await run(world, [a], Date.parse('2022-01-21T03:00:00Z'), { everyProtection: true });
  assert.ok(!world.fake.positions.get('PF_SOLUSD')?.size, 'SOL chiusa: senza stop non resta aperta');
  const sol = (await world.docs.query<{ symbol: string; reason: string; exitTime: string }>('trades', [])).map((d) => d.data).find((t) => t.symbol.startsWith('SOL'));
  assert.equal(sol?.reason, 'PROTECTION_FAILURE');
  const openedAt = Date.parse('2022-01-21T02:01:00Z');
  assert.ok(Date.parse(sol!.exitTime) - openedAt <= 60_000 + 40_000, `scoperta per ${(Date.parse(sol!.exitTime) - openedAt) / 1000} s`);
  for (const code of ['STOP_PLACEMENT_FAILED', 'EMERGENCY_CLOSE'] as const) assert.ok(a.alerts.codes().includes(code), code);
  await assertInvariants(world, a, 'stop rifiutato');
});

test('posizione chiusa a mano su Kraken: il bot la registra come chiusura esterna e rimuove lo stop', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  await run(world, [a], Date.parse('2022-01-21T05:00:00Z'));
  world.fake.externalClose('PF_SOLUSD');
  await run(world, [a], Date.parse('2022-01-21T06:00:00Z'), { from: world.clock.t });
  const sol = (await world.docs.query<{ symbol: string; reason: string }>('trades', [])).map((d) => d.data).find((t) => t.symbol.startsWith('SOL'));
  assert.equal(sol?.reason, 'EXTERNAL_CLOSE');
  assert.equal(world.fake.openOrdersFor('PF_SOLUSD').length, 0, 'stop rimosso');
  await assertInvariants(world, a, 'chiusura a mano');
  await run(world, [a], END, { from: world.clock.t });
  await assertInvariants(world, a, 'chiusura a mano, fine');
});

test('crash del processo a metà ciclo (3 uscite e 4 ingressi): il nuovo processo completa il ciclo, trade identici', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  await run(world, [a], Date.parse('2022-01-22T09:50:00Z'));
  let processed = 0;
  let disk: ReturnType<typeof world.docs.clone> | null = null;
  world.fake.onProcessed = (method) => {
    // Il processo muore subito dopo che Kraken ha eseguito il terzo ordine del ciclo: il suo disco
    // resta com'era in quell'istante e nessun'altra sua chiamata arriva a Kraken.
    if (method === 'submitOrder' && ++processed === 3 && !disk) {
      disk = world.docs.clone();
      a.state.alive = false;
    }
  };
  await run(world, [a], Date.parse('2022-01-22T10:02:00Z'), { from: world.clock.t });
  world.fake.onProcessed = null;
  assert.ok(disk, 'crash avvenuto dentro il ciclo delle 10:01');
  world.clock.t += 70_000;
  const lines: string[] = [];
  const b = makeInstance(world, 'B', { docs: disk as unknown as ReturnType<typeof world.docs.clone>, logger: new Logger({ write: (l) => lines.push(l), now: world.now }) });
  // Il servizio riavvia subito il processo (qui dopo la scadenza del lease: 70 s).
  assert.equal(await b.runtime.ensureRunning(), 'RUNNING');
  await run(world, [b], MID + 2 * 60 * MIN, { from: world.clock.t });
  await run(world, [b], END, { from: world.clock.t });
  await assertInvariants(world, b, 'crash a metà ciclo');
  assert.deepEqual(await persistedTrades(world, b.docs), await reference());
  assert.ok(lines.some((l) => /Recovery: invio di \d+ intenti decisi prima del riavvio/.test(l)), 'gli intenti decisi e mai inviati partono dal nuovo processo (D49)');
});

test('dati 15m mancanti, candela in ritardo e fonte ferma: il bot continua, segnala e resta protetto', async () => {
  const world = makeWorld();
  // BTC senza candele per due ore; SOL delle 07:45 del 22 pubblicata con 8 minuti di ritardo.
  world.data.BTC = world.data.BTC.filter((c) => c.t < Date.parse('2022-01-21T10:00:00Z') || c.t >= Date.parse('2022-01-21T12:00:00Z'));
  const late = Date.parse('2022-01-22T07:45:00Z');
  const a = makeInstance(world, 'A', { publishDelay: (s, t) => (s === 'SOL' && t === late ? 8 * 60_000 : 20_000) });
  await a.runtime.ensureRunning();
  await run(world, [a], MID);
  await assertInvariants(world, a, 'dati mancanti a metà');
  const noData = a.runtime.recentJournal.filter((r) => r.action === 'NO_DATA');
  assert.ok(noData.some((r) => r.symbol === 'BTC'), 'ore senza BTC nel journal');
  // Fonte del tutto ferma per 45 minuti: alert STALE_DATA e ritorno alla normalità.
  const source = (a.runtime as unknown as { deps: { source: { fetchCandles: (...x: unknown[]) => Promise<unknown> } } }).deps.source;
  const fetch = source.fetchCandles.bind(source);
  source.fetchCandles = async () => {
    throw new Error('charts API non raggiungibile');
  };
  await run(world, [a], world.clock.t + 45 * MIN, { from: world.clock.t });
  assert.ok(a.alerts.alerts.some((x) => x.code === 'STALE_DATA' && x.level === 'warning'));
  await assertInvariants(world, a, 'fonte ferma: posizioni ancora protette');
  source.fetchCandles = fetch;
  await run(world, [a], END, { from: world.clock.t });
  assert.ok(a.alerts.alerts.some((x) => x.code === 'STALE_DATA' && x.level === 'info'), 'dati di nuovo aggiornati');
  await assertInvariants(world, a, 'dati mancanti alla fine');
});

test('Kraken non raggiungibile per 45 minuti con posizioni aperte: alert, nessuna decisione né ingresso, protezione ripresa al ritorno (D54)', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  // Il guasto copre il ciclo delle 10:01 del 22 (3 uscite e 4 ingressi nel run di riferimento):
  // dalle 09:46 ogni ciclo di protezione (ogni 20 s) trova Kraken irraggiungibile.
  const down = Date.parse('2022-01-22T09:46:00Z');
  await run(world, [a], down - MIN);
  const openBefore = (a.runtime.statusPayload().openPositions as unknown[]).length;
  assert.ok(openBefore >= 3, `posizioni aperte all inizio del guasto: ${openBefore}`);
  a.state.alive = false; // ogni chiamata a Kraken fallisce: connessione interrotta
  await run(world, [a], down + 30 * MIN, { from: world.clock.t, everyProtection: true });
  const alarm = a.alerts.alerts.find((x) => x.code === 'PROTECTION_FAILING' && x.level === 'critical');
  assert.ok(alarm, 'alert critico: protezione ferma');
  assert.ok(Date.parse(alarm.at) - down <= 2 * MIN + 30_000, `alert dopo ${(Date.parse(alarm.at) - down) / 1000} s`);
  const health = a.runtime.health();
  assert.equal(health.healthy, false);
  assert.ok(health.issues.some((i) => /protezione ferma/.test(i)), health.issues.join(' | '));
  // Senza riconciliazione il ciclo decisionale non avanza (I10): nessuna decisione, nessun ingresso (I13).
  assert.ok(a.runtime.recentJournal.every((r) => r.slotTime < down), 'nessuna decisione durante il guasto');
  a.state.alive = true;
  await run(world, [a], END, { from: world.clock.t, everyProtection: true });
  const codes = a.alerts.alerts.filter((x) => x.code === 'PROTECTION_FAILING');
  assert.deepEqual(codes.map((x) => x.level), ['critical', 'info'], 'un alert per il guasto e uno per il ritorno');
  await assertInvariants(world, a, 'dopo il ritorno di Kraken');
  // Al ritorno il ciclo recupera gli slot: le uscite partono, gli ingressi delle 10:00 sono ormai tardivi.
  const late = a.alerts.alerts.filter((x) => x.code === 'EXECUTION_ERROR' && /deciso in ritardo/.test(x.message));
  assert.ok(late.length > 0, 'ingressi decisi durante il guasto respinti perché tardivi');
  const entryIds = SYMBOLS.map((s) => makeCliOrdId(`${s}-2022-01-22T09:45:00.000Z`, 'ENTRY', 1));
  assert.deepEqual([...world.fake.orders.values()].filter((o) => entryIds.includes(o.cliOrdId ?? '')).map((o) => o.cliOrdId), [], 'nessun ingresso della chiusura delle 10:00');
});

test('Kraken non raggiungibile all avvio: niente RUNNING senza riconciliazione, alert, poi recovery (D54)', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  await run(world, [a], Date.parse('2022-01-21T05:00:00Z'));
  await a.runtime.stop();
  const b = makeInstance(world, 'B');
  b.state.alive = false;
  // Avvio del processo: primo tentativo di recovery subito, poi uno a ogni ciclo di protezione.
  const from = world.clock.t + 20_000;
  world.clock.t = from;
  assert.equal(await b.runtime.ensureRunning(), 'RECOVERING');
  for (let t = from + 20_000; t <= from + 3 * MIN; t += 20_000) {
    world.clock.t = t;
    await b.runtime.protectionTick(t);
  }
  const alarm = b.alerts.alerts.find((x) => x.code === 'PROTECTION_FAILING' && x.level === 'critical');
  assert.ok(alarm, 'alert critico: recovery bloccato');
  assert.ok(Date.parse(alarm.at) - from <= 2 * MIN, `alert dopo ${(Date.parse(alarm.at) - from) / 1000} s`);
  assert.ok(!b.runtime.health().healthy);
  await run(world, [b], from + 20 * MIN, { from: world.clock.t, everyProtection: true });
  assert.equal(b.runtime.status, 'RECOVERING', 'senza riconciliazione il bot non riparte');
  b.state.alive = true;
  await run(world, [b], END, { from: world.clock.t, everyProtection: true });
  assert.equal(b.runtime.status, 'RUNNING');
  assert.deepEqual(b.alerts.alerts.filter((x) => x.code === 'PROTECTION_FAILING').map((x) => x.level), ['critical', 'info']);
  await assertInvariants(world, b, 'recovery dopo il ritorno di Kraken');
});

test('due istanze attive per tutto il periodo: opera solo chi ha il lease, trade identici al riferimento', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  const b = makeInstance(world, 'B');
  await a.runtime.ensureRunning();
  await b.runtime.ensureRunning();
  assert.equal(b.runtime.status, 'STANDBY');
  await run(world, [a, b], END);
  const writers = new Set(world.calls.filter((c) => ['submitOrder', 'editOrder', 'cancelOrder'].includes(c.method)).map((c) => c.instance));
  assert.deepEqual([...writers], ['A'], 'solo A invia ordini');
  await assertInvariants(world, a, 'due istanze');
  assert.deepEqual(await persistedTrades(world), await reference());
});

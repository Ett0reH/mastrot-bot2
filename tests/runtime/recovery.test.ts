// Gate F4: crash e restart, archivio non disponibile, due istanze (D23, D26, D27, I10, I11).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeCliOrdId } from '../../src/engine/exchange/orders';
import { KRAKEN_NATIVE_SYMBOLS } from '../../src/engine/data/dataset';
import type { TradeRecord } from '../../src/engine/core/types';
import { type Instance, makeInstance, makeWorld, MIN, ordersSentBy, step, stopsOn, tickTimes, type World } from './world';

const SOL_OPEN_TICK = Date.parse('2022-01-21T02:01:00Z'); // tick della chiusura oraria 01:45 (SOL apre, golden)

async function runUntil(world: World, instances: Instance[], until: number, from = world.startMs, everyProtection = false): Promise<void> {
  for (const t of tickTimes(from, until)) await step(world, instances, t, everyProtection);
}

function tradeKey(t: TradeRecord): string {
  return `${t.symbol}|${t.entryTime}|${t.type}|${t.reason}|${t.size}|${t.entryPrice}|${t.exitPrice}`;
}

async function persistedTrades(inst: Instance): Promise<string[]> {
  return (await inst.docs.query<TradeRecord>('trades', [])).map((d) => tradeKey(d.data)).sort();
}

test('avvio in demo: recovery, apertura come nel golden, stop nativo e stato persistito', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  assert.equal(await a.runtime.ensureRunning(), 'RUNNING');
  await runUntil(world, [a], SOL_OPEN_TICK + 30 * MIN);
  const sol = a.runtime.statusPayload().openPositions as { symbol: string; protection: string; size: number }[];
  const pos = sol.find((p) => p.symbol === 'SOL');
  assert.ok(pos, 'SOL aperta');
  assert.equal(pos.protection, 'NATIVE_STOP_OK');
  assert.equal(stopsOn(world, 'PF_SOLUSD').length, 1);
  assert.ok(world.docs.paths('bot_runtime/').includes('bot_runtime/state'));
  assert.ok(world.docs.paths('orders/').length >= 2, 'ordini persistiti');
});

test('crash tra l invio di un ordine e il suo salvataggio: il nuovo processo lo ritrova e non lo duplica', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  let disk: ReturnType<typeof world.docs.clone> | null = null;
  world.fake.onProcessed = (method, params) => {
    const p = params as { orderType?: string; symbol?: string };
    if (!disk && method === 'submitOrder' && p.orderType === 'ioc' && p.symbol === 'PF_SOLUSD') {
      disk = world.docs.clone(); // il "disco" nell'istante in cui Kraken ha eseguito l'ordine
      a.state.alive = false; // il processo muore: nessuna altra chiamata arriva a Kraken
    }
  };
  await runUntil(world, [a], SOL_OPEN_TICK);
  assert.ok(disk, 'crash avvenuto durante l ingresso SOL');
  world.fake.onProcessed = null;
  const cliOrdId = makeCliOrdId(`SOL-2022-01-21T01:45:00.000Z`, 'ENTRY', 1);
  const onDisk = await (disk as ReturnType<typeof world.docs.clone>).get<{ state: string }>(`orders/${cliOrdId}`);
  assert.equal(onDisk?.state, 'SUBMITTED', 'su disco l ordine risulta inviato ma senza esito');

  // Nuovo processo (nuova istanza) sullo stesso disco, dopo la scadenza del lease del vecchio.
  const b = makeInstance(world, 'B', { docs: disk as unknown as ReturnType<typeof world.docs.clone> });
  world.clock.t = SOL_OPEN_TICK + 70_000;
  assert.equal(await b.runtime.ensureRunning(), 'RUNNING');
  await runUntil(world, [b], SOL_OPEN_TICK + 60 * MIN, SOL_OPEN_TICK);

  assert.equal(world.fake.ordersWithCliOrdId(cliOrdId).length, 1, 'un solo ordine d ingresso su Kraken');
  const sol = (b.runtime.statusPayload().openPositions as { symbol: string; size: number }[]).find((p) => p.symbol === 'SOL');
  assert.ok(sol, 'la posizione è tornata nel core con il fill reale');
  assert.equal(world.fake.positionSize('PF_SOLUSD'), sol.size);
  assert.equal(stopsOn(world, 'PF_SOLUSD').length, 1, 'e protetta dallo stop');
  assert.ok(!b.alerts.codes().includes('UNKNOWN_POSITION'), 'riconosciuta come posizione del bot');
});

test('crash con un trade aperto: dopo il riavvio la gestione continua come senza crash', async () => {
  const end = Date.parse('2022-01-23T00:00:00Z');
  const crashAt = SOL_OPEN_TICK + 4 * 15 * MIN + 20_000; // dopo il ciclo di protezione delle 03:01

  const reference = makeWorld();
  const r = makeInstance(reference, 'R');
  await r.runtime.ensureRunning();
  await runUntil(reference, [r], end);

  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  await runUntil(world, [a], crashAt - 20_000);
  assert.ok(world.fake.positions.size > 0, 'al crash ci sono posizioni aperte');
  const disk = world.docs.clone();
  a.state.alive = false;
  const b = makeInstance(world, 'B', { docs: disk });
  world.clock.t = crashAt + 70_000;
  assert.equal(await b.runtime.ensureRunning(), 'RUNNING');
  await runUntil(world, [b], end, crashAt);

  assert.deepEqual(await persistedTrades(b), await persistedTrades(r), 'stessi trade (ingressi, uscite, prezzi) del run senza crash');
  assert.ok((await persistedTrades(b)).length >= 5);
  const ids = [...world.fake.orders.values()].map((o) => o.cliOrdId).filter((x): x is string => x !== null);
  assert.equal(new Set(ids).size, ids.length, 'nessun ordine duplicato');
  assert.ok(!b.alerts.codes().includes('UNKNOWN_POSITION') && !b.alerts.codes().includes('DESYNC'));
});

test('riavvio con uno stop mancante: ripristinato durante il recovery, prima di riprendere', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  await runUntil(world, [a], SOL_OPEN_TICK + 30 * MIN);
  const disk = world.docs.clone();
  a.state.alive = false;
  const [stop] = stopsOn(world, 'PF_SOLUSD');
  world.fake.dropOrder(stop.cliOrdId as string); // cancellato a mano mentre il bot è fermo
  assert.equal(stopsOn(world, 'PF_SOLUSD').length, 0);
  const b = makeInstance(world, 'B', { docs: disk });
  world.clock.t += 90_000;
  assert.equal(await b.runtime.ensureRunning(), 'RUNNING');
  assert.equal(stopsOn(world, 'PF_SOLUSD').length, 1, 'stop ripristinato');
  assert.ok(b.alerts.codes().includes('STOP_MISSING'));
});

test('archivio non disponibile all avvio (demo): SAFE_MODE, nessun ordine; al ritorno riparte', async () => {
  const world = makeWorld();
  world.docs.unavailable = true;
  const a = makeInstance(world, 'A');
  assert.equal(await a.runtime.ensureRunning(), 'SAFE_MODE');
  await runUntil(world, [a], SOL_OPEN_TICK + 30 * MIN);
  assert.equal(ordersSentBy(world, 'A'), 0, 'nessun ordine senza persistenza');
  assert.equal(a.runtime.statusPayload().runtimeStatus, 'SAFE_MODE');
  world.docs.unavailable = false;
  world.clock.t += 20_000;
  await a.runtime.protectionTick(world.clock.t);
  assert.equal(a.runtime.status, 'RUNNING');
});

test('archivio non disponibile durante l operatività: niente nuovi ordini, stop esistenti attivi, poi recovery', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  await runUntil(world, [a], SOL_OPEN_TICK + 30 * MIN);
  assert.equal(stopsOn(world, 'PF_SOLUSD').length, 1);
  const outageStart = world.clock.t;
  world.docs.unavailable = true;
  const sentBefore = ordersSentBy(world, 'A');
  await runUntil(world, [a], outageStart + 3 * 60 * MIN, outageStart);
  assert.equal(ordersSentBy(world, 'A'), sentBefore, 'senza archivio nessun ordine viene inviato');
  assert.equal(a.runtime.status, 'STANDBY', 'lease non rinnovabile: l istanza smette di operare');
  assert.ok(a.alerts.codes().includes('LEASE_LOST'));
  assert.ok(world.fake.positionSize('PF_SOLUSD') === 0 || stopsOn(world, 'PF_SOLUSD').length === 1, 'la posizione resta protetta dallo stop nativo');
  world.docs.unavailable = false;
  await runUntil(world, [a], outageStart + 4 * 60 * MIN, outageStart + 3 * 60 * MIN);
  assert.equal(a.runtime.status, 'RUNNING', 'al ritorno dell archivio il recovery riprende');
  for (const pos of Object.values((a.runtime.statusPayload().openPositions as { symbol: string }[]))) {
    assert.equal(stopsOn(world, KRAKEN_NATIVE_SYMBOLS[pos.symbol]).length, 1, `${pos.symbol} protetta dopo il recovery`);
  }
});

test('due istanze attive: solo chi ha il lease invia ordini; alla scadenza subentra l altra e la prima si ferma', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  const b = makeInstance(world, 'B');
  assert.equal(await a.runtime.ensureRunning(), 'RUNNING');
  assert.equal(await b.runtime.ensureRunning(), 'STANDBY');
  await runUntil(world, [a, b], SOL_OPEN_TICK + 30 * MIN, world.startMs, true);
  assert.ok(ordersSentBy(world, 'A') > 0);
  assert.equal(ordersSentBy(world, 'B'), 0, 'B in standby non invia nulla');

  // A si blocca (freeze): smette di rinnovare. B subentra dopo la scadenza del lease.
  const freezeAt = world.clock.t;
  await runUntil(world, [b], freezeAt + 3 * 15 * MIN, freezeAt, true);
  assert.equal(b.runtime.status, 'RUNNING');
  const bSolStops = stopsOn(world, 'PF_SOLUSD').length;
  assert.equal(bSolStops, 1, 'B ha ricostruito posizioni e stop dallo stato persistito');

  // A si risveglia e prova a lavorare: il lease non è più suo, nessuna scrittura parte.
  const aSent = ordersSentBy(world, 'A');
  await runUntil(world, [a, b], world.clock.t + 60 * MIN, world.clock.t, true);
  assert.equal(ordersSentBy(world, 'A'), aSent, 'A non invia più ordini');
  assert.equal(a.runtime.status, 'STANDBY');
  assert.ok(a.alerts.codes().includes('LEASE_LOST'));
  const ids = [...world.fake.orders.values()].map((o) => o.cliOrdId).filter((x): x is string => x !== null);
  assert.equal(new Set(ids).size, ids.length, 'nessun ordine duplicato tra le due istanze');
});

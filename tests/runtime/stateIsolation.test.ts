// Stato di un bot e istanze di un'altra modalità sullo stesso database (D51, D52, D53).
// Il database Firestore viene dal file di configurazione del repository: shadow, demo e live lo
// condividono se non si sceglie un database per ciascuno. Un'istanza non deve mai usare, prendere
// in carico o cancellare lo stato di un bot di un'altra modalità.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Instance, makeInstance, makeWorld, MIN, step, stopsOn, tickTimes, type World } from './world';

const SOL_OPEN_TICK = Date.parse('2022-01-21T02:01:00Z'); // tick della chiusura oraria 01:45 (SOL apre, golden)

async function runUntil(world: World, instances: Instance[], until: number, from = world.startMs): Promise<void> {
  for (const t of tickTimes(from, until)) await step(world, instances, t);
}

function refusals(inst: Instance) {
  return inst.alerts.alerts.filter((a) => a.code === 'STATE_REFUSED');
}

test('D51: un\'istanza live non usa lo stato salvato dal bot demo: SAFE_MODE, nessun lease, nessuna chiamata a Kraken', async () => {
  const world = makeWorld();
  const demo = makeInstance(world, 'D');
  await demo.runtime.ensureRunning();
  await runUntil(world, [demo], SOL_OPEN_TICK + 30 * MIN);
  assert.equal(stopsOn(world, 'PF_SOLUSD').length, 1, 'il bot demo ha una posizione aperta e protetta');
  await demo.runtime.stop(); // arresto ordinato: stato salvato, lease rilasciato
  const saved = await world.docs.get<{ mode: string }>('bot_runtime/state');
  assert.equal(saved?.mode, 'demo');

  const live = makeInstance(world, 'L', { mode: 'live' });
  world.clock.t += 20_000;
  const writes = world.docs.writes;
  assert.equal(await live.runtime.ensureRunning(), 'SAFE_MODE');
  assert.match(live.runtime.lastError ?? '', /demo/, 'il motivo nomina la modalità dello stato trovato');
  assert.equal(refusals(live).length, 1);
  assert.equal(refusals(live)[0].level, 'critical');
  // Un'ora di cicli dopo: sempre fermo, un solo alert, nessuna chiamata a Kraken, lease e stato intatti.
  await runUntil(world, [live], world.clock.t + 60 * MIN, world.clock.t);
  assert.equal(live.runtime.status, 'SAFE_MODE');
  assert.equal(refusals(live).length, 1, 'l alert non si ripete a ogni ciclo');
  assert.deepEqual(world.calls.filter((c) => c.instance === 'L').map((c) => c.method), [], 'nessuna chiamata a Kraken');
  const lease = await world.docs.get<{ holder: string }>('bot_runtime/lease');
  assert.notEqual(lease?.holder, 'L', 'lease mai preso');
  assert.deepEqual(await world.docs.get('bot_runtime/state'), saved, 'stato del bot demo intatto');
  assert.equal(world.docs.writes, writes, 'nessuna scrittura nell archivio del bot demo (nemmeno gli alert)');
  assert.ok(!live.runtime.health(null).healthy, 'health non sano');

  // Il bot demo riparte e ritrova la sua posizione.
  const demo2 = makeInstance(world, 'D2');
  assert.equal(await demo2.runtime.ensureRunning(), 'RUNNING');
  assert.ok((demo2.runtime.statusPayload().openPositions as { symbol: string }[]).some((p) => p.symbol === 'SOL'));
  assert.equal(stopsOn(world, 'PF_SOLUSD').length, 1);
});

test('D51: un\'istanza shadow sul database del bot demo non subentra nemmeno quando il lease si libera', async () => {
  const world = makeWorld();
  const demo = makeInstance(world, 'D');
  await demo.runtime.ensureRunning();
  await runUntil(world, [demo], SOL_OPEN_TICK + 30 * MIN);
  const shadow = makeInstance(world, 'S', { mode: 'shadow' });
  assert.equal(await shadow.runtime.ensureRunning(), 'SAFE_MODE');
  assert.equal(refusals(shadow).length, 1);

  // Il bot demo si ferma per un deploy: il lease è libero, lo shadow resta fermo.
  await demo.runtime.stop();
  const writes = world.docs.writes;
  await runUntil(world, [shadow], world.clock.t + 30 * MIN, world.clock.t);
  assert.equal(shadow.runtime.status, 'SAFE_MODE');
  assert.equal(world.docs.writes, writes, 'nessuna scrittura nell archivio del bot demo');
  const state = await world.docs.get<{ mode: string; port: { kind: string } }>('bot_runtime/state');
  assert.equal(state?.mode, 'demo');
  assert.equal(state?.port.kind, 'kraken', 'lo stato della porta Kraken non è stato sovrascritto');

  const demo2 = makeInstance(world, 'D2');
  assert.equal(await demo2.runtime.ensureRunning(), 'RUNNING');
  assert.ok((demo2.runtime.statusPayload().openPositions as { symbol: string }[]).some((p) => p.symbol === 'SOL'));
  assert.equal(stopsOn(world, 'PF_SOLUSD').length, 1, 'posizione ancora protetta');
});

test('D51: un\'istanza demo non usa lo stato di uno shadow: SAFE_MODE con alert (prima restava in RECOVERING in silenzio)', async () => {
  const world = makeWorld();
  const shadow = makeInstance(world, 'S', { mode: 'shadow' });
  await shadow.runtime.ensureRunning();
  await runUntil(world, [shadow], SOL_OPEN_TICK + 30 * MIN);
  await shadow.runtime.stop();
  const demo = makeInstance(world, 'D');
  world.clock.t += 20_000;
  assert.equal(await demo.runtime.ensureRunning(), 'SAFE_MODE');
  assert.match(demo.runtime.lastError ?? '', /shadow/);
  assert.equal(refusals(demo).length, 1);
  assert.deepEqual(world.calls.filter((c) => c.instance === 'D').map((c) => c.method), []);
  assert.notEqual((await world.docs.get<{ holder: string }>('bot_runtime/lease'))?.holder, 'D', 'lease mai preso');
});

test('D52: il reset di un\'istanza shadow non cancella stato e storico di un bot che non è suo', async () => {
  const world = makeWorld();
  const demo = makeInstance(world, 'D');
  await demo.runtime.ensureRunning();
  await runUntil(world, [demo], Date.parse('2022-01-22T06:00:00Z'));
  const trades = world.docs.paths('trades/').length;
  assert.ok(trades > 0, 'il bot demo ha già dei trade chiusi');
  const shadow = makeInstance(world, 'S', { mode: 'shadow' });
  await shadow.runtime.ensureRunning();
  const before = {
    state: await world.docs.get('bot_runtime/state'),
    trades,
    decisions: world.docs.paths('decisions/').length,
    equity: world.docs.paths('equity/').length,
  };
  await assert.rejects(shadow.runtime.reset(), /Reset rifiutato/);
  assert.deepEqual(await world.docs.get('bot_runtime/state'), before.state, 'stato del bot demo intatto');
  assert.equal(world.docs.paths('trades/').length, before.trades, 'trade intatti');
  assert.equal(world.docs.paths('decisions/').length, before.decisions, 'journal intatto');
  assert.equal(world.docs.paths('equity/').length, before.equity, 'equity intatta');
  await runUntil(world, [demo], world.clock.t + 60 * MIN, world.clock.t);
  assert.equal(demo.runtime.status, 'RUNNING', 'il bot demo continua');
});

test('D52: il reset dello shadow resta possibile sul proprio stato (con il lease)', async () => {
  const world = makeWorld();
  const shadow = makeInstance(world, 'S', { mode: 'shadow' });
  await shadow.runtime.ensureRunning();
  await runUntil(world, [shadow], SOL_OPEN_TICK + 30 * MIN);
  await shadow.runtime.reset();
  assert.equal(await world.docs.get('bot_runtime/state'), null);
  // Uno shadow in standby (lease di un altro shadow) non può azzerare lo stato di chi opera.
  const other = makeInstance(world, 'S2', { mode: 'shadow' });
  assert.equal(await shadow.runtime.ensureRunning(), 'RUNNING');
  assert.equal(await other.runtime.ensureRunning(), 'STANDBY');
  await assert.rejects(other.runtime.reset(), /Reset rifiutato/);
});

test('D53: stato salvato non ricostruibile: SAFE_MODE con alert critico e lease rilasciato (prima RECOVERING in silenzio)', async () => {
  const world = makeWorld();
  const demo = makeInstance(world, 'D');
  await demo.runtime.ensureRunning();
  await runUntil(world, [demo], SOL_OPEN_TICK + 30 * MIN);
  await demo.runtime.stop();
  // Stato della modalità giusta ma con la porta di un altro tipo (es. scritto da una versione diversa).
  const saved = (await world.docs.get<Record<string, unknown>>('bot_runtime/state'))!;
  await world.docs.set('bot_runtime/state', { ...saved, port: { kind: 'sim', state: { stops: [] } } });
  const next = makeInstance(world, 'N');
  world.clock.t += 20_000;
  assert.equal(await next.runtime.ensureRunning(), 'SAFE_MODE');
  assert.match(next.runtime.lastError ?? '', /stato salvato non utilizzabile/);
  assert.equal(refusals(next).length, 1);
  const lease = await world.docs.get<{ holder: string; expiresAt: number }>('bot_runtime/lease');
  assert.ok(lease?.holder !== 'N' || lease.expiresAt <= world.clock.t, 'lease rilasciato');
  await runUntil(world, [next], world.clock.t + 30 * MIN, world.clock.t);
  assert.equal(next.runtime.status, 'SAFE_MODE');
  assert.equal(refusals(next).length, 1);
  assert.deepEqual(world.calls.filter((c) => c.instance === 'N' && ['submitOrder', 'editOrder', 'cancelOrder', 'cancelAllOrders'].includes(c.method)), [], 'nessun ordine');
});

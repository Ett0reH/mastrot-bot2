// Heartbeat (F6): alert HEARTBEAT_MISSING quando i cicli del runtime smettono di girare.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AlertCode, AlertLevel } from '../../src/engine/ops/alerts';
import { lastClosedSlot } from '../../src/engine/live/decisionCycle';
import { HeartbeatMonitor } from '../../src/engine/runtime/heartbeat';
import { RuntimeScheduler, type Timers } from '../../src/engine/runtime/scheduler';
import { makeInstance, makeWorld } from './world';

const T = Date.UTC(2026, 8, 24, 10);

function monitor() {
  const raised: { level: AlertLevel; code: AlertCode; message: string }[] = [];
  const hb = new HeartbeatMonitor(T, async (level, code, message) => {
    raised.push({ level, code, message });
  });
  return { hb, raised };
}

test('cicli regolari: sano, nessun alert', async () => {
  const { hb, raised } = monitor();
  for (let t = T; t <= T + 30 * 60_000; t += 20_000) {
    hb.beatProtection(t);
    if ((t - T) % (15 * 60_000) === 0) hb.beatDecision(t);
    assert.equal((await hb.check(t + 10_000)).healthy, true);
  }
  assert.deepEqual(raised, []);
});

test('protezione ferma oltre 90 s: un solo alert critico, poi il ritorno alla normalità', async () => {
  const { hb, raised } = monitor();
  hb.beatProtection(T);
  hb.beatDecision(T);
  assert.equal((await hb.check(T + 90_000)).healthy, true, '90 s esatti: ancora sano');
  const down = await hb.check(T + 91_000);
  assert.equal(down.healthy, false);
  assert.deepEqual(down.issues, ['ciclo di protezione fermo da 91 s']);
  await hb.check(T + 120_000);
  await hb.check(T + 300_000);
  assert.equal(raised.length, 1, 'nessun alert ripetuto a ogni controllo');
  assert.equal(raised[0].level, 'critical');
  assert.equal(raised[0].code, 'HEARTBEAT_MISSING');
  hb.beatProtection(T + 310_000);
  assert.equal((await hb.check(T + 311_000)).healthy, true);
  assert.equal(raised.length, 2);
  assert.equal(raised[1].level, 'info');
});

test('decisione ferma oltre 20 minuti anche con la protezione regolare', async () => {
  const { hb, raised } = monitor();
  hb.beatDecision(T);
  hb.beatProtection(T + 21 * 60_000);
  const s = await hb.check(T + 21 * 60_000);
  assert.equal(s.healthy, false);
  assert.match(s.issues[0], /ciclo decisionale fermo da 21 min/);
  assert.equal(raised.length, 1);
});

test('nessun ciclo dall avvio: il riferimento è l avvio del monitor', async () => {
  const { hb } = monitor();
  assert.equal((await hb.check(T + 60_000)).healthy, true);
  assert.equal((await hb.check(T + 100_000)).healthy, false);
});

test('lo scheduler registra ogni ciclo; se si ferma il controllo esterno se ne accorge', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  const queue: { at: number; fn: () => void }[] = [];
  const timers: Timers = {
    now: () => world.clock.t,
    setTimeout: (fn, ms) => {
      const item = { at: world.clock.t + ms, fn };
      queue.push(item);
      return item;
    },
    clearTimeout: (h) => {
      const i = queue.indexOf(h as (typeof queue)[number]);
      if (i >= 0) queue.splice(i, 1);
    },
  };
  const raised: string[] = [];
  const hb = new HeartbeatMonitor(world.clock.t, async (_l, code) => {
    raised.push(code);
  });
  const scheduler = new RuntimeScheduler(a.runtime, timers, { heartbeat: hb });
  scheduler.start();
  const until = world.clock.t + 20 * 60_000;
  while (queue.length) {
    queue.sort((x, y) => x.at - y.at);
    const next = queue.shift()!;
    if (next.at > until) break;
    world.clock.t = next.at;
    world.drive(lastClosedSlot(next.at));
    next.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  const alive = await hb.check(world.clock.t);
  assert.equal(alive.healthy, true, JSON.stringify(alive));
  assert.ok(alive.lastProtectionAt && alive.lastDecisionAt);
  scheduler.stop(); // lo scheduler si ferma (es. eccezione non gestita)
  const dead = await hb.check(world.clock.t + 120_000);
  assert.equal(dead.healthy, false);
  assert.deepEqual(raised, ['HEARTBEAT_MISSING']);
});

// Shadow run di 4 giorni (gate F7: almeno 72 ore senza divergenze non spiegate), in simulazione:
// lo scheduler vero del runtime con timer simulati, dati reali del 20-24 gennaio 2022, candele
// pubblicate con ritardi variabili (2-90 s) e qualcuna oltre l'attesa massima del ciclo (3 minuti).
// Ogni giorno concluso ha il suo report con il confronto con il backtest sugli stessi dati.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hash32, mulberry32 } from '../../src/engine/util/prng';
import { HeartbeatMonitor } from '../../src/engine/runtime/heartbeat';
import { RuntimeScheduler, type Timers } from '../../src/engine/runtime/scheduler';
import { makeInstance, makeWorld } from '../runtime/world';

test('shadow run di 96 ore con lo scheduler reale: report di ogni giorno, nessuna divergenza non spiegata', async () => {
  const world = makeWorld('2022-01-20T00:00:00Z', '2022-01-25T23:45:00Z');
  const rand = mulberry32(hash32('shadow-run-f7'));
  const late = new Set<string>();
  const delays = new Map<string, number>();
  const publishDelay = (symbol: string, t: number) => {
    const key = `${symbol}|${t}`;
    if (!delays.has(key)) {
      const r = rand();
      // ~0,3% delle candele arriva dopo l'attesa massima del ciclo: il bot decide senza.
      const d = r < 0.003 ? 4 * 60_000 + Math.floor(rand() * 120_000) : 2_000 + Math.floor(rand() * 88_000);
      if (d > 3 * 60_000) late.add(key);
      delays.set(key, d);
    }
    return delays.get(key) as number;
  };
  const s = makeInstance(world, 'S', { mode: 'shadow', publishDelay });
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
  const heartbeat = new HeartbeatMonitor(world.clock.t, async () => undefined);
  const scheduler = new RuntimeScheduler(s.runtime, timers, { heartbeat });
  scheduler.start();
  const until = Date.parse('2022-01-24T00:40:00Z');
  let unhealthy = 0;
  let nextCheck = world.clock.t + 3_600_000;
  while (queue.length) {
    queue.sort((x, y) => x.at - y.at);
    const next = queue.shift()!;
    if (next.at > until) break;
    world.clock.t = next.at;
    next.fn();
    // Il tick lanciato dal timer è asincrono: si lascia completare prima del successivo.
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    if (world.clock.t >= nextCheck) {
      nextCheck += 3_600_000;
      if (!(await heartbeat.check(world.clock.t)).healthy) unhealthy++;
    }
  }
  scheduler.stop();
  await s.runtime.flushReports();

  assert.ok(late.size > 0, 'alcune candele pubblicate oltre l attesa del ciclo');
  assert.equal(unhealthy, 0, 'heartbeat sempre regolare');
  assert.ok(!s.alerts.codes().includes('STALE_DATA'), 'mai dati fermi');
  const reports = await s.runtime.dailyReports();
  assert.deepEqual(reports.map((r) => r.day), ['2022-01-23', '2022-01-22', '2022-01-21', '2022-01-20'], '4 giorni conclusi, 96 ore');
  for (const r of reports) {
    assert.ok(r.parity && (r.parity.status === 'IDENTICAL' || r.parity.status === 'EXPLAINED'), `${r.day}: ${r.parity?.status} ${JSON.stringify(r.parity?.divergences.filter((d) => !d.explanation).slice(0, 3))}`);
    assert.equal(r.parity.unexplained, 0);
    assert.ok(r.parity.compared.decisions >= 8 * 24 * 0.95, `${r.day}: decisioni confrontate ${r.parity.compared.decisions}`);
  }
  assert.ok(s.runtime.allTrades.length >= 10, `trade nel periodo: ${s.runtime.allTrades.length}`);
  // Una candela delle :45 arrivata tardi cambia la decisione di quell'ora (NO_DATA): differenza spiegata.
  // (La fonte calcola il ritardo anche delle candele storiche del warm-up: contano solo quelle del periodo.)
  const lateAtHourClose = [...late].filter((k) => {
    const t = Number(k.split('|')[1]);
    return new Date(t).getUTCMinutes() === 45 && t >= Date.parse('2022-01-20T00:00:00Z') && t < Date.parse('2022-01-24T00:00:00Z');
  });
  const explained = reports.reduce((a, r) => a + (r.parity?.explained ?? 0), 0);
  assert.ok(explained >= lateAtHourClose.length, `differenze spiegate ${explained} per ${lateAtHourClose.length} candele delle :45 tardive`);
  console.log(`# candele tardive: ${late.size} (di cui alle :45 ${lateAtHourClose.length}); report: ${reports.map((r) => `${r.day} ${r.parity?.status} (${r.parity?.explained} spiegate)`).join(', ')}`);
  if (lateAtHourClose.length > 0) assert.ok(reports.some((r) => r.parity?.status === 'EXPLAINED'), 'le candele in ritardo producono differenze spiegate');
});

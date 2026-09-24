// Osservabilità del runtime (F6): correlation id nei log, health, journal completo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHourCloseSlot } from '../../src/engine/core/aggregator';
import type { DecisionRecord } from '../../src/engine/core/types';
import { BAR_15M_MS } from '../../src/engine/data/dataset';
import { CycleContext, Logger } from '../../src/engine/ops/logger';
import { makeInstance, makeWorld, MIN, step, SYMBOLS, tickTimes, type World } from './world';

const SOL_OPEN_TICK = Date.parse('2022-01-21T02:01:00Z');

function withLogs(world: World, mode?: 'shadow') {
  const lines: string[] = [];
  const cycle = new CycleContext();
  const logger = new Logger({ write: (l) => lines.push(l), now: world.now, cycle });
  const inst = makeInstance(world, mode ? 'S' : 'A', { logger, cycle, ...(mode ? { mode } : {}) });
  return { inst, lines, records: () => lines.map((l) => JSON.parse(l) as Record<string, string>) };
}

async function runUntil(world: World, inst: ReturnType<typeof makeInstance>, until: number, from = world.startMs): Promise<void> {
  for (const t of tickTimes(from, until)) await step(world, [inst], t);
}

test('correlation id: dall intento all ordine allo stop, stesso positionId e stesso cycleId; cliOrdId su ogni ordine', async () => {
  const world = makeWorld();
  const { inst, records } = withLogs(world);
  await inst.runtime.ensureRunning();
  await runUntil(world, inst, SOL_OPEN_TICK);
  const all = records();
  assert.ok(all.every((r) => r.type === 'log' && typeof r.at === 'string' && typeof r.message === 'string'));
  const intent = all.find((r) => r.message.startsWith('Intento OPEN SOL'));
  assert.ok(intent, 'intento registrato');
  assert.match(intent.cycleId, /^D-20220121T0201\d\dZ$/, 'nato nel ciclo decisionale');
  const positionId = intent.positionId;
  assert.equal(positionId, 'SOL-2022-01-21T01:45:00.000Z');
  const orders = all.filter((r) => r.positionId === positionId && r.message.startsWith('Ordine'));
  const entry = orders.filter((r) => r.cliOrdId.startsWith('mt-e-'));
  const stop = orders.filter((r) => r.cliOrdId.startsWith('mt-s-'));
  assert.ok(entry.some((r) => r.state === 'FILLED'), 'ingresso eseguito, con cliOrdId');
  assert.ok(stop.some((r) => r.state === 'ACKNOWLEDGED'), 'stop nativo piazzato, con cliOrdId');
  const placed = [...entry, ...stop].filter((r) => !r.message.includes('riconciliato'));
  assert.ok(placed.length >= 4 && placed.every((r) => r.cycleId === intent.cycleId), 'invio ed esito nello stesso ciclo dell intento');
  // Ogni riga scritta durante un ciclo porta il suo cycleId.
  assert.ok(all.filter((r) => r.message.startsWith('Ordine')).every((r) => /^[DPKRC]-\d{8}T\d{6}Z$/.test(r.cycleId)));
});

test('health in demo: posizioni protette con il livello dello stop su Kraken; stop impossibile da piazzare → non sano', async () => {
  const world = makeWorld();
  const { inst } = withLogs(world);
  await inst.runtime.ensureRunning();
  await runUntil(world, inst, SOL_OPEN_TICK);
  const ok = inst.runtime.health();
  assert.equal(ok.healthy, true, ok.issues.join('; '));
  assert.equal(ok.mode, 'demo');
  assert.equal(ok.lease.valid, true);
  assert.equal(ok.data.stale, false);
  assert.equal(ok.allProtected, true);
  const sol = ok.positions.find((p) => p.symbol === 'SOL');
  assert.ok(sol);
  assert.equal(sol.protection, 'NATIVE_STOP_OK');
  const onKraken = [...world.fake.orders.values()].find((o) => o.symbol === 'PF_SOLUSD' && o.type === 'stp' && o.status === 'open');
  assert.equal(sol.stopLevel, onKraken?.stopPrice, 'livello dello stop quello presente su Kraken');

  // Lo stop sparisce e Kraken rifiuta di rimetterlo: la posizione è scoperta.
  world.fake.dropOrder(onKraken!.cliOrdId as string);
  world.fake.failNext('submitOrder', { kind: 'http', status: 500 }, 20, (p) => (p as { orderType?: string }).orderType === 'stp');
  world.clock.t += 20_000;
  await inst.runtime.protectionTick(world.clock.t);
  const bad = inst.runtime.health();
  assert.equal(bad.healthy, false);
  assert.equal(bad.allProtected, false);
  assert.equal(bad.positions.find((p) => p.symbol === 'SOL')?.protection, 'UNPROTECTED');
  assert.ok(bad.issues.some((i) => /SOL-2022-01-21T01:45:00.000Z senza stop nativo/.test(i)), bad.issues.join('; '));
  assert.ok(bad.recentErrors.some((e) => e.source === 'alert' && /STOP/.test(String(e.code))), 'errori recenti con gli alert');
});

test('health: dati fermi e lease perso compaiono tra i problemi', async () => {
  const world = makeWorld();
  const { inst } = withLogs(world);
  await inst.runtime.ensureRunning();
  await runUntil(world, inst, world.startMs + 60 * MIN);
  (inst.runtime as unknown as { deps: { source: { fetchCandles: () => Promise<never> } } }).deps.source.fetchCandles = async () => {
    throw new Error('Kraken non raggiungibile');
  };
  await runUntil(world, inst, world.clock.t + 45 * MIN, world.clock.t);
  const h = inst.runtime.health();
  assert.equal(h.data.stale, true);
  assert.ok(h.issues.some((i) => /dati fermi da \d+ min/.test(i)));
  assert.ok(h.recentErrors.some((e) => /Kraken non raggiungibile/.test(e.message)), 'l errore del ciclo tra gli errori recenti');
  world.clock.t += 10 * MIN; // il lease scade senza rinnovi
  const expired = inst.runtime.health();
  assert.equal(expired.lease.valid, false);
  assert.ok(expired.issues.some((i) => i.startsWith('lease:')));
});

test('journal: a ogni chiusura oraria un record per ogni simbolo, con il motivo (anche NEUTRAL e senza dati)', async () => {
  const world = makeWorld('2022-01-21T00:00:00Z', '2022-01-22T23:45:00Z');
  // Una candela mancante: SOL alle 05:45 del 21 gennaio.
  const missing = Date.parse('2022-01-21T05:45:00Z');
  world.data.SOL = world.data.SOL.filter((c) => c.t !== missing);
  const { inst } = withLogs(world, 'shadow');
  await inst.runtime.ensureRunning();
  await runUntil(world, inst, Date.parse('2022-01-22T12:05:00Z'));
  const docs = await world.docs.query<{ slotTime: number; records: DecisionRecord[] }>('decisions', []);
  const bySlot = new Map(docs.map((d) => [d.data.slotTime, d.data.records]));
  let hours = 0;
  for (let slot = world.startMs; slot <= Date.parse('2022-01-22T11:45:00Z'); slot += BAR_15M_MS) {
    if (!isHourCloseSlot(slot)) continue;
    hours++;
    const records = bySlot.get(slot) ?? [];
    const symbols = new Set(records.map((r) => r.symbol));
    assert.deepEqual([...symbols].sort(), [...SYMBOLS].sort(), `ora ${new Date(slot).toISOString()}`);
    for (const r of records) assert.ok(r.reason && r.reason.length > 0, `motivo presente: ${JSON.stringify(r)}`);
  }
  assert.ok(hours >= 35);
  const neutral = [...bySlot.values()].flat().filter((r) => r.action === 'NO_SIGNAL');
  assert.ok(neutral.length > 0, 'le decisioni neutre sono registrate');
  const noData = bySlot.get(missing)?.find((r) => r.symbol === 'SOL');
  assert.equal(noData?.action, 'NO_DATA');
  assert.match(noData?.reason ?? '', /candela 2022-01-21T05:45:00.000Z mancante/);
});

// Runtime F4: scritture giornaliere misurate in shadow, pausa, tetto del sizing (D28), scheduler.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastClosedSlot } from '../../src/engine/live/decisionCycle';
import { MemoryAlertSink } from '../../src/engine/ops/alerts';
import { BotStore, WriteBudget } from '../../src/engine/persistence/botStore';
import { MemoryDocumentStore } from '../../src/engine/persistence/documentStore';
import { ReplayCandleSource } from '../../src/engine/replay/replay';
import { BotRuntime } from '../../src/engine/runtime/botRuntime';
import { LeaseManager } from '../../src/engine/runtime/lease';
import { RuntimeScheduler, type Timers } from '../../src/engine/runtime/scheduler';
import { makeInstance, makeWorld, MIN, SHADOW_CONFIG, step, stopsOn, tickTimes } from './world';

test('scritture Firestore in shadow su 24 ore (parametri di produzione): sotto il budget di default', async () => {
  const world = makeWorld();
  const docs = new MemoryDocumentStore();
  const budget = new WriteBudget(SHADOW_CONFIG.persistence.dailyWriteBudget, world.now);
  let counted = 0;
  const record = budget.recordWrite.bind(budget);
  budget.recordWrite = () => {
    counted++;
    record();
  };
  const store = new BotStore(docs, budget, world.now);
  const lease = new LeaseManager(docs, 'shadow-1', { now: world.now, onWrite: () => budget.recordWrite() }); // TTL e rinnovo di produzione
  const runtime = new BotRuntime(
    { config: SHADOW_CONFIG, now: world.now, store, lease, source: new ReplayCandleSource(world.data, world.now, () => 20_000), alerts: new MemoryAlertSink() },
    { startMs: world.startMs },
  );
  await runtime.ensureRunning();
  const writesAtStart = docs.writes;
  const start = world.startMs;
  // Protezione ogni 20 s e decisione a ogni slot, come lo scheduler reale, per 24 ore.
  for (let t = start + MIN; t < start + 24 * 60 * MIN; t += 20_000) {
    world.clock.t = t;
    if ((t - start) % (15 * MIN) === MIN) await runtime.decisionTick(t);
    else await runtime.protectionTick(t);
  }
  const writes = docs.writes - writesAtStart;
  assert.ok(runtime.recentTrades.length + (runtime.statusPayload().openPositions as unknown[]).length > 0, 'lo shadow ha operato');
  assert.ok(writes <= SHADOW_CONFIG.persistence.dailyWriteBudget, `scritture in 24 h: ${writes}`);
  assert.ok(writes >= 96, 'almeno un salvataggio dello stato per slot');
  assert.equal(counted, docs.writes, 'ogni scrittura sull archivio è contata dal budget (lease compreso)');
  console.log(`# scritture Firestore misurate in shadow su 24 h: ${writes} (budget ${SHADOW_CONFIG.persistence.dailyWriteBudget})`);
});

test('pausa: nessun nuovo ingresso, uscite e stop nativi restano attivi; ripresa', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  for (const t of tickTimes(world.startMs, Date.parse('2022-01-21T02:30:00Z'))) await step(world, [a], t);
  const openBefore = (a.runtime.statusPayload().openPositions as { symbol: string }[]).map((p) => p.symbol);
  assert.ok(openBefore.length > 0);
  await a.runtime.pause();
  assert.equal(a.runtime.statusPayload().isActive, false);
  assert.equal(a.runtime.entryBlockReason(), 'bot in pausa');
  const entryOrdersBefore = [...world.fake.orders.values()].filter((o) => o.type === 'ioc').length;
  for (const t of tickTimes(world.clock.t, world.clock.t + 24 * 60 * MIN)) await step(world, [a], t);
  const entryOrdersAfter = [...world.fake.orders.values()].filter((o) => o.type === 'ioc').length;
  assert.equal(entryOrdersAfter, entryOrdersBefore, 'nessun ingresso in pausa');
  assert.ok(a.runtime.recentTrades.length > 0, 'le posizioni aperte continuano a essere gestite e chiuse');
  for (const p of a.runtime.statusPayload().openPositions as { symbol: string; protection: string }[]) assert.equal(p.protection, 'NATIVE_STOP_OK');
  await a.runtime.resume();
  assert.equal(a.runtime.entryBlockReason(), null);
});

test('reset consentito solo in shadow (con ordini reali lo stato non si azzera mai: D28, D34)', async () => {
  const world = makeWorld();
  const demo = makeInstance(world, 'A');
  await demo.runtime.ensureRunning();
  await assert.rejects(() => demo.runtime.reset(), /non consentito/);
  const shadow = makeInstance(makeWorld(), 'S', { mode: 'shadow' });
  await shadow.runtime.ensureRunning();
  await shadow.runtime.reset();
  assert.equal(await shadow.runtime.ensureRunning(), 'RUNNING');
});

test('D28: la size si calcola sull equity limitata dal collateral del conto (senza toccare drawdown e massimo)', async () => {
  const sizesWith = async (collateral: number | null) => {
    const world = makeWorld();
    const a = makeInstance(world, 'A');
    if (collateral !== null) {
      const accounts = world.fake.getAccounts.bind(world.fake);
      world.fake.getAccounts = async () => {
        const r = await accounts();
        return { ...r, accounts: { ...r.accounts, flex: { ...r.accounts.flex!, marginEquity: collateral } } };
      };
    }
    await a.runtime.ensureRunning();
    for (const t of tickTimes(world.startMs, Date.parse('2022-01-21T02:30:00Z'))) await step(world, [a], t);
    const opens = world.calls.filter((c) => c.method === 'submitOrder' && (c.params as { orderType?: string }).orderType === 'ioc');
    return { sizes: opens.map((c) => (c.params as { size: number }).size), status: a.runtime.statusPayload() };
  };
  const full = await sizesWith(null);
  const capped = await sizesWith(2_500);
  assert.equal(capped.status.sizingEquityCap, 2_500);
  assert.equal(full.sizes.length, capped.sizes.length);
  assert.ok(full.sizes.length > 0);
  for (let i = 0; i < full.sizes.length; i++) assert.ok(capped.sizes[i] < full.sizes[i], `size con collateral 2.500 $: ${capped.sizes[i]} vs ${full.sizes[i]}`);
  assert.equal(capped.status.maxDrawdown, full.status.maxDrawdown, 'il tetto non tocca il drawdown del bot');
});

test('scheduler: decisione a fine slot + margine, nuovi tentativi se il ciclo aspetta, protezione ogni 20 s', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  const calls: string[] = [];
  const runtime = a.runtime;
  const original = { d: runtime.decisionTick.bind(runtime), p: runtime.protectionTick.bind(runtime) };
  let waitOnce = true;
  runtime.decisionTick = async (t: number) => {
    calls.push(`D ${new Date(t).toISOString().slice(11, 19)}`);
    const r = await original.d(t);
    if (r && waitOnce) {
      waitOnce = false;
      return { ...r, waiting: true };
    }
    return r;
  };
  runtime.protectionTick = async (t: number) => {
    calls.push(`P ${new Date(t).toISOString().slice(11, 19)}`);
    return original.p(t);
  };
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
  world.clock.t = Date.parse('2022-01-21T00:05:00Z');
  const scheduler = new RuntimeScheduler(runtime, timers, { protectionIntervalMs: 20_000, decisionMarginMs: 45_000, retryMs: 20_000 });
  assert.equal(scheduler.nextDecisionAt(world.clock.t), Date.parse('2022-01-21T00:15:45Z'));
  scheduler.start();
  const until = Date.parse('2022-01-21T00:32:00Z');
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
  scheduler.stop();
  const decisions = calls.filter((c) => c.startsWith('D'));
  assert.deepEqual(decisions, ['D 00:15:45', 'D 00:16:05', 'D 00:30:45'], 'decisione, un nuovo tentativo dopo 20 s, poi lo slot successivo');
  const protections = calls.filter((c) => c.startsWith('P'));
  assert.ok(protections.length >= 75, `cicli di protezione: ${protections.length}`);
  assert.throws(() => new RuntimeScheduler(runtime, timers, { protectionIntervalMs: 60_000 }), /15-30 s/);
  assert.ok(stopsOn(world, 'PF_SOLUSD').length <= 1);
});


test('D28: fee dei trade e depositi/prelievi letti dall account log e registrati; l equity del bot non cambia', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  for (const t of tickTimes(world.startMs, Date.parse('2022-01-21T02:30:00Z'))) await step(world, [a], t);
  const equityBefore = a.runtime.statusPayload().realizedEquity as number;
  const tradesBefore = a.runtime.recentTrades.length;
  world.fake.externalTransfer(-2_000);
  for (const t of tickTimes(world.clock.t, world.clock.t + 30 * MIN)) await step(world, [a], t, true);
  const ledger = a.runtime.statusPayload().ledger as { fees: number; transfers: { amount: number }[] };
  assert.ok(ledger.fees > 0, 'fee reali dei trade nel ledger');
  assert.deepEqual(ledger.transfers.map((x) => x.amount), [-2_000]);
  assert.ok(a.alerts.codes().includes('ACCOUNT_TRANSFER'));
  const closedPnL = a.runtime.recentTrades.slice(0, a.runtime.recentTrades.length - tradesBefore).reduce((x, t) => x + t.pnl, 0);
  assert.ok(Math.abs((a.runtime.statusPayload().realizedEquity as number) - (equityBefore + closedPnL)) < 1e-9, 'il prelievo non cambia l equity del bot (solo il PnL dei trade)');
  assert.ok(world.docs.paths('ledger/').length > 0, 'voci del ledger persistite');
});

test('dati fermi: alert STALE_DATA anche se dall avvio non è mai arrivata una candela (I13)', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  (a.runtime as unknown as { deps: { source: { fetchCandles: () => Promise<never> } } }).deps.source.fetchCandles = async () => {
    throw new Error('Kraken non raggiungibile');
  };
  await a.runtime.ensureRunning();
  for (const t of tickTimes(world.startMs, world.startMs + 45 * MIN)) await step(world, [a], t);
  assert.ok(a.alerts.codes().includes('STALE_DATA'));
  assert.equal(world.fake.orders.size, 0, 'nessun ingresso senza dati');
  assert.match(String(a.runtime.statusPayload().lastError), /Kraken non raggiungibile/);
});

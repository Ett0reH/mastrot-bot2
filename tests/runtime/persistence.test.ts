// Persistenza (F4: D23, D24, D27): scritture solo su modifica, budget, ordini, Firestore.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialCoreState } from '../../src/engine/core/decisionCore';
import type { OrderRecord } from '../../src/engine/exchange/orders';
import { BotStore, WriteBudget } from '../../src/engine/persistence/botStore';
import { MemoryDocumentStore, StoreUnavailableError } from '../../src/engine/persistence/documentStore';
import { FirestoreDocumentStore, type FirestoreLike } from '../../src/engine/persistence/firestoreStore';

const T = Date.UTC(2026, 8, 24, 10);

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    cliOrdId: 'mt-e-0000000000000000-1', intentKey: 'BTC-x', purpose: 'ENTRY', attempt: 1, symbol: 'PF_XBTUSD', side: 'buy', orderType: 'ioc',
    size: 0.01, limitPrice: 60_000, stopPrice: null, reduceOnly: false, state: 'SUBMITTED', exchangeOrderId: null, filledSize: 0, fills: [],
    processBefore: new Date(T + 15_000).toISOString(), createdAt: new Date(T).toISOString(), updatedAt: new Date(T).toISOString(), lastError: null, history: [],
    ...overrides,
  };
}

test('stato: scritto solo se cambia', async () => {
  const docs = new MemoryDocumentStore();
  const budget = new WriteBudget(1000, () => T);
  const store = new BotStore(docs, budget, () => T);
  const core = initialCoreState({ symbols: ['BTC'], initialEquity: 1000, feeRate: 0.0005, backstop: { model: 'none', bufferPct: 0 } });
  const snap = { mode: 'shadow', core, port: { kind: 'sim', state: { stops: [] } }, runtime: { paused: false, startedAt: 'x', lastDecisionAt: null } };
  assert.equal(await store.saveSnapshot(snap), true);
  assert.equal(await store.saveSnapshot(snap), false);
  core.lastSlot = T;
  assert.equal(await store.saveSnapshot(snap), true);
  assert.equal(docs.writes, 2);
  assert.deepEqual(budget.snapshot(), { day: '2026-09-24', writes: 2, skippedUnchanged: 1, skippedOverBudget: 0, budget: 1000 });
  const reloaded = await new BotStore(docs, budget, () => T).loadSnapshot();
  assert.equal(reloaded?.core.lastSlot, T);
});

test('ordini: un documento per cliOrdId, scritto solo se cambia; query per stato e intento', async () => {
  const docs = new MemoryDocumentStore();
  const store = new BotStore(docs, new WriteBudget(1000, () => T), () => T);
  await store.orders.save(order());
  await store.orders.save(order());
  assert.equal(docs.writes, 1);
  await store.orders.save(order({ cliOrdId: 'mt-s-0000000000000000-1', purpose: 'STOP', state: 'FILLED' }));
  assert.deepEqual((await store.orders.active()).map((o) => o.cliOrdId), ['mt-e-0000000000000000-1']);
  assert.equal((await store.orders.byIntent('BTC-x')).length, 2);
  assert.equal((await store.orders.get('mt-e-0000000000000000-1'))?.state, 'SUBMITTED');
});

test('budget giornaliero: oltre la soglia journal ed equity si sospendono, stato e ordini no', async () => {
  const docs = new MemoryDocumentStore();
  const clock = { t: T };
  const budget = new WriteBudget(200, () => clock.t);
  const store = new BotStore(docs, budget, () => clock.t);
  for (let i = 0; i < 200; i++) await store.orders.save(order({ cliOrdId: `mt-e-${String(i).padStart(16, '0')}-1` }));
  assert.equal(await store.appendDecisions(T, [{ slotTime: T, symbol: 'BTC', action: 'NO_SIGNAL', reason: 'x' }]), false);
  assert.equal(await store.appendEquity({ t: T, equity: 1, realized: 1, drawdown: 0 }), false);
  await store.orders.save(order({ cliOrdId: 'mt-e-9999999999999999-1' }));
  assert.equal(budget.snapshot().skippedOverBudget, 2);
  assert.equal(budget.snapshot().writes, 201, 'gli ordini si scrivono sempre');
  clock.t += 86_400_000;
  assert.equal(budget.snapshot().writes, 0, 'nuovo giorno UTC, contatore azzerato');
});

test('retention del journal: le decisioni più vecchie vengono eliminate', async () => {
  const docs = new MemoryDocumentStore();
  const store = new BotStore(docs, new WriteBudget(1000, () => T), () => T);
  await store.appendDecisions(T - 40 * 86_400_000, [{ slotTime: T - 40 * 86_400_000, symbol: 'BTC', action: 'NO_SIGNAL', reason: 'x' }]);
  await store.appendDecisions(T - 3_600_000, [{ slotTime: T - 3_600_000, symbol: 'BTC', action: 'NO_SIGNAL', reason: 'x' }]);
  assert.equal(await store.pruneDecisions(30), 1);
  assert.equal(docs.paths('decisions/').length, 1);
});

/** Firestore simulato con la stessa superficie di firebase-admin usata dallo store. */
function fakeFirestore() {
  const data = new Map<string, Record<string, unknown>>();
  let failing = false;
  const guard = () => {
    if (failing) throw new Error('UNAVAILABLE: 14');
  };
  const ref = (path: string) => ({
    get: async () => (guard(), { exists: data.has(path), data: () => data.get(path) }),
    set: async (d: Record<string, unknown>) => (guard(), data.set(path, d)),
    delete: async () => (guard(), data.delete(path)),
  });
  const query = (collection: string, filters: [string, string, unknown][] = [], limit = Infinity) => ({
    where: (f: string, op: string, v: unknown) => query(collection, [...filters, [f, op, v]], limit),
    limit: (n: number) => query(collection, filters, n),
    get: async () => {
      guard();
      const docs = [...data.entries()]
        .filter(([p]) => p.startsWith(`${collection}/`))
        .filter(([, d]) => filters.every(([f, op, v]) => (op === '==' ? d[f] === v : op === 'in' ? (v as unknown[]).includes(d[f]) : (d[f] as number) < (v as number))))
        .slice(0, limit)
        .map(([p, d]) => ({ id: p.slice(collection.length + 1), data: () => d }));
      return { docs };
    },
  });
  const db: FirestoreLike = {
    doc: ref,
    collection: (c: string) => query(c),
    runTransaction: async (fn) => {
      guard();
      return fn({ get: (r) => r.get(), set: (r, d) => r.set(d) });
    },
  };
  return { db, data, fail: (v: boolean) => (failing = v) };
}

test('Firestore: payload JSON più campi indice; query sui campi indicizzati; errori → archivio non disponibile', async () => {
  const fs = fakeFirestore();
  const store = new FirestoreDocumentStore(fs.db);
  await store.set('orders/mt-e-1', order({ cliOrdId: 'mt-e-1', fills: [{ fillId: 'f', price: 1, size: 1, time: 't' }] }));
  const raw = fs.data.get('orders/mt-e-1')!;
  assert.equal(typeof raw.payload, 'string');
  assert.equal(raw.state, 'SUBMITTED');
  assert.equal(raw.intentKey, 'BTC-x');
  assert.equal(raw.fills, undefined, 'solo i campi indice fuori dal payload');
  assert.equal((await store.get<OrderRecord>('orders/mt-e-1'))?.fills[0].fillId, 'f');
  assert.equal((await store.query('orders', [{ field: 'state', op: 'in', value: ['SUBMITTED'] }])).length, 1);
  assert.throws(() => store.query('orders', [{ field: 'fills', op: '==', value: 1 }]), /non indicizzato/);
  const lease = await store.transact<{ holder: string }>('bot_runtime/lease', (cur) => (cur ? null : { holder: 'A' }));
  assert.deepEqual(lease, { holder: 'A' });
  assert.deepEqual(await store.transact<{ holder: string }>('bot_runtime/lease', () => null), { holder: 'A' });
  fs.fail(true);
  await assert.rejects(() => store.get('orders/mt-e-1'), StoreUnavailableError);
  await assert.rejects(() => store.set('orders/x', {}), StoreUnavailableError);
});

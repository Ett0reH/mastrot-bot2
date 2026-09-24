// Lease d'istanza (F4: D26, I11).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryDocumentStore } from '../../src/engine/persistence/documentStore';
import { LeaseManager } from '../../src/engine/runtime/lease';

function setup() {
  const clock = { t: Date.UTC(2026, 8, 24) };
  const docs = new MemoryDocumentStore();
  const make = (id: string) => new LeaseManager(docs, id, { now: () => clock.t, ttlMs: 60_000, safetyMarginMs: 20_000 });
  return { clock, docs, a: make('A'), b: make('B') };
}

test('un solo detentore: B non acquisisce finché il lease di A è valido', async () => {
  const { a, b } = setup();
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  assert.equal(a.canWrite(), null);
  assert.match(b.canWrite() ?? '', /non detenuto/);
});

test('scadenza: senza rinnovo il lease passa a B con epoch nuova; A non può più rinnovare', async () => {
  const { clock, a, b } = setup();
  await a.acquire();
  clock.t += 61_000;
  assert.equal(await b.acquire(), true);
  assert.equal(b.lease?.epoch, 2);
  assert.equal(await a.renew(), false, 'il lease di A è passato di mano');
  assert.notEqual(a.canWrite(), null);
});

test('rinnovo: estende la scadenza; il margine di sicurezza blocca le scritture prima della scadenza', async () => {
  const { clock, a } = setup();
  await a.acquire();
  clock.t += 30_000;
  assert.equal(await a.renew(), true);
  assert.equal(a.lease?.expiresAt, clock.t + 60_000);
  clock.t += 39_000;
  assert.equal(a.canWrite(), null, '21 s alla scadenza: ancora valido');
  clock.t += 2_000;
  assert.match(a.canWrite() ?? '', /scadenza/, 'sotto i 20 s di margine si smette di scrivere');
});

test('stessa istanza: la riacquisizione non cambia epoch', async () => {
  const { a } = setup();
  await a.acquire();
  const epoch = a.lease?.epoch;
  assert.equal(await a.acquire(), true);
  assert.equal(a.lease?.epoch, epoch);
});

test('archivio non raggiungibile durante il rinnovo: valido solo fino alla scadenza locale', async () => {
  const { clock, docs, a } = setup();
  await a.acquire();
  docs.unavailable = true;
  clock.t += 10_000;
  assert.equal(await a.renew(), true, 'ancora dentro la finestra sicura');
  clock.t += 35_000;
  assert.equal(await a.renew(), false);
  assert.notEqual(a.canWrite(), null);
});

test('rilascio: il lease torna subito disponibile', async () => {
  const { a, b } = setup();
  await a.acquire();
  await a.release();
  assert.equal(await b.acquire(), true);
  assert.notEqual(a.canWrite(), null);
});

test('margine non valido rifiutato', () => {
  assert.throws(() => new LeaseManager(new MemoryDocumentStore(), 'X', { now: () => 0, ttlMs: 10_000, safetyMarginMs: 10_000 }), /margine/);
});

// Gate F5: kill switch idempotente (API, dashboard, flag su Firestore), anche quando l'API di
// Kraken fallisce a metà o il processo muore durante la procedura (D30, D34).
// Ordine richiesto: 1. ordini non protettivi cancellati; 2. posizioni chiuse reduceOnly con
// cliOrdId; 3. conto flat verificato; 4. stop residui rimossi; 5. HALTED e alert.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESUME_CONFIRMATION } from '../../src/engine/runtime/botRuntime';
import { type Instance, makeInstance, makeWorld, MIN, step, tickTimes, type World } from './world';

const WITH_POSITIONS = Date.parse('2022-01-22T08:30:00Z'); // 6 posizioni aperte nel run di riferimento

async function runUntil(world: World, instances: Instance[], until: number, from = world.startMs): Promise<void> {
  for (const t of tickTimes(from, until)) await step(world, instances, t);
}

type SubmitParams = { orderType?: string; symbol?: string; size?: number; reduceOnly?: boolean; cliOrdId?: string };

const openOnKraken = (world: World) => [...world.fake.positions.entries()].filter(([, p]) => p.size !== 0).map(([s]) => s);
const openOrders = (world: World) => [...world.fake.orders.values()].filter((o) => o.status === 'open');
const entryOrders = (world: World) => world.calls.filter((c) => c.method === 'submitOrder' && (c.params as SubmitParams).orderType === 'ioc').length;
const isKillClose = (p: unknown) => ((p as SubmitParams).cliOrdId ?? '').startsWith('mt-k-');

/** Ordini di chiusura del kill switch eseguiti su Kraken, per simbolo. */
function filledKillCloses(world: World): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of world.fake.orders.values()) if ((o.cliOrdId ?? '').startsWith('mt-k-') && o.filled > 0) out[o.symbol] = (out[o.symbol] ?? 0) + 1;
  return out;
}

async function persistedOpState(world: World): Promise<string | undefined> {
  return (await world.docs.get<{ runtime: { risk?: { opState: string } } }>('bot_runtime/state'))?.runtime.risk?.opState;
}

async function withPositions(world: World, id = 'A', mode?: 'shadow') {
  const inst = makeInstance(world, id, mode ? { mode } : {});
  await inst.runtime.ensureRunning();
  await runUntil(world, [inst], WITH_POSITIONS);
  const open = inst.runtime.statusPayload().openPositions as { id: string; symbol: string }[];
  assert.ok(open.length >= 3, `posizioni aperte: ${open.length}`);
  return { inst, open };
}

test('kill switch da API: ordini non protettivi, chiusure reduceOnly con cliOrdId, conto flat, stop rimossi, HALTED; idempotente (D30, D34)', async () => {
  const world = makeWorld();
  const { inst: a, open } = await withPositions(world);
  const natives = openOnKraken(world).sort();
  // Ordine limite non protettivo lasciato sul conto (es. inserito a mano).
  const mark = world.fake.marks.get('PF_XBTUSD') as number;
  await world.fake.submitOrder({ orderType: 'lmt', symbol: 'PF_XBTUSD', side: 'buy', size: 0.001, limitPrice: Math.round(mark / 2) });
  const from = world.calls.length;
  const tradesBefore = a.runtime.recentTrades.length;

  const result = await a.runtime.killSwitch('api');
  assert.equal(result.opState, 'HALTED');
  const calls = world.calls.slice(from);
  const idx = (pred: (c: (typeof calls)[number]) => boolean) => calls.findIndex(pred);
  const closes = calls.map((c, i) => ({ c, i })).filter(({ c }) => c.method === 'submitOrder');
  const cancelIdx = idx((c) => c.method === 'cancelOrder');
  assert.ok(cancelIdx >= 0 && cancelIdx < closes[0].i, '1. prima si cancellano gli ordini non protettivi');
  assert.deepEqual(closes.map(({ c }) => (c.params as SubmitParams).symbol).sort(), natives, '2. una chiusura per posizione');
  for (const { c } of closes) {
    const p = c.params as SubmitParams;
    assert.equal(p.orderType, 'mkt');
    assert.equal(p.reduceOnly, true);
    assert.match(p.cliOrdId ?? '', /^mt-k-[0-9a-f]{16}-1$/);
  }
  assert.ok(idx((c) => c.method === 'cancelAllOrders') > closes.at(-1)!.i, '4. stop residui rimossi dopo le chiusure');
  assert.deepEqual(openOnKraken(world), [], '3. conto flat');
  assert.deepEqual(openOrders(world), [], 'nessun ordine residuo (né stop né ordini esterni)');

  // Il core registra le chiusure con i fill reali e motivo KILL_SWITCH; l'equity non si azzera (D34).
  assert.equal((a.runtime.statusPayload().openPositions as unknown[]).length, 0);
  const killed = a.runtime.recentTrades.slice(0, a.runtime.recentTrades.length - tradesBefore);
  assert.deepEqual(killed.map((t) => t.reason), open.map(() => 'KILL_SWITCH'));
  const pnl = a.runtime.recentTrades.reduce((x, t) => x + t.pnl, 0);
  assert.ok(Math.abs((a.runtime.statusPayload().realizedEquity as number) - (10_000 + pnl)) < 1e-6, 'equity del bot = cap + PnL, mai azzerata');

  // 5. HALTED persistito e alert critici (attivazione e completamento).
  const alerts = a.alerts.alerts.filter((x) => x.code === 'KILL_SWITCH');
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every((x) => x.level === 'critical'));
  assert.match(alerts[1].message, /completato.*flat/);
  assert.equal(await persistedOpState(world), 'HALTED');
  assert.equal(a.runtime.statusPayload().status, 'HALTED');
  assert.equal(a.runtime.statusPayload().isActive, false);

  // Idempotente: una seconda richiesta (es. dal pulsante) non invia nulla.
  const n = world.calls.length;
  const again = await a.runtime.killSwitch('dashboard');
  assert.equal(again.opState, 'HALTED');
  assert.match(again.steps[0], /già fermo/);
  assert.equal(world.calls.length, n);

  // Da fermo: la strategia continua a decidere ma nessun ingresso parte.
  const entries = entryOrders(world);
  await runUntil(world, [a], world.clock.t + 24 * 60 * MIN, world.clock.t);
  assert.equal(entryOrders(world), entries);
  assert.ok(a.runtime.recentJournal.some((r) => r.action === 'REJECTED' && /HALTED/.test(r.reason)), 'segnali respinti con il motivo');
  assert.deepEqual(openOnKraken(world), []);
});

test('kill switch con l API che fallisce a metà (esito perso e cancellazione fallita): completato ai cicli successivi, nessun duplicato', async () => {
  const world = makeWorld();
  const { inst: a, open } = await withPositions(world);
  // Stop di protezione aggiunto a mano sul conto: resta fino al passo 4 (cancellazione finale).
  const eth = world.fake.positions.get('PF_ETHUSD')!;
  const ethMark = world.fake.marks.get('PF_ETHUSD') as number;
  await world.fake.submitOrder({ orderType: 'stp', symbol: 'PF_ETHUSD', side: eth.size > 0 ? 'sell' : 'buy', size: Math.abs(eth.size), stopPrice: Math.round(ethMark * (eth.size > 0 ? 5 : 15)) / 10, reduceOnly: true });
  let matching = 0;
  // La seconda chiusura viene eseguita da Kraken ma la risposta si perde (timeout).
  world.fake.failNext('submitOrder', { kind: 'timeout_after_processing' }, 1, (p) => isKillClose(p) && ++matching === 2);
  world.fake.failNext('cancelAllOrders', { kind: 'http', status: 503 });

  const first = await a.runtime.killSwitch('api');
  assert.equal(first.opState, 'HALTING', 'non ancora completato: resta lo stop esterno');
  assert.ok(first.steps.some((s) => /cancellazione degli stop residui fallita/.test(s)), first.steps.join(' | '));
  assert.deepEqual(openOnKraken(world), [], 'posizioni già chiuse al primo passaggio');
  assert.equal(openOrders(world).length, 1);
  assert.equal(await persistedOpState(world), 'HALTING');
  assert.equal(await a.runtime.decisionTick(world.clock.t + 15 * MIN), null, 'nessuna decisione durante il kill switch');

  for (const t of tickTimes(world.clock.t, world.clock.t + 15 * MIN)) await step(world, [a], t);
  assert.equal(a.runtime.operationalState, 'HALTED');
  assert.deepEqual(openOnKraken(world), []);
  assert.deepEqual(openOrders(world), []);
  const perSymbol = filledKillCloses(world);
  assert.equal(Object.keys(perSymbol).length, open.length);
  assert.ok(Object.values(perSymbol).every((n) => n === 1), `una sola chiusura eseguita per simbolo: ${JSON.stringify(perSymbol)}`);
  assert.deepEqual(await a.orders!.store.active(), [], 'nessun ordine con esito incerto rimasto');
});

test('kill switch interrotto da un crash del processo: il nuovo processo lo riprende e lo completa senza duplicare ordini', async () => {
  const world = makeWorld();
  const { inst: a, open } = await withPositions(world);
  world.fake.onProcessed = (method, params) => {
    if (method === 'submitOrder' && isKillClose(params)) a.state.alive = false; // muore dopo la prima chiusura
  };
  const outcome = await a.runtime.killSwitch('api').then(
    (r) => r.opState,
    (err: Error) => err.message,
  );
  world.fake.onProcessed = null;
  assert.notEqual(outcome, 'HALTED');
  assert.equal(await persistedOpState(world), 'HALTING', 'la richiesta è salvata prima di toccare Kraken');
  assert.equal(openOnKraken(world).length, open.length - 1, 'una sola posizione chiusa prima del crash');

  world.clock.t += 70_000; // il lease del processo morto scade
  const b = makeInstance(world, 'B');
  assert.equal(await b.runtime.ensureRunning(), 'RUNNING');
  assert.equal(b.runtime.operationalState, 'HALTING', 'il nuovo processo sa che il kill switch è in corso');
  for (const t of tickTimes(world.clock.t, world.clock.t + 15 * MIN)) await step(world, [b], t);
  assert.equal(b.runtime.operationalState, 'HALTED');
  assert.deepEqual(openOnKraken(world), []);
  assert.deepEqual(openOrders(world), []);
  assert.ok(Object.values(filledKillCloses(world)).every((n) => n === 1), JSON.stringify(filledKillCloses(world)));
  assert.equal(Object.keys(filledKillCloses(world)).length, open.length);
  assert.equal((b.runtime.statusPayload().openPositions as unknown[]).length, 0, 'il core del nuovo processo è allineato');
  assert.deepEqual(b.runtime.recentTrades.map((t) => t.reason), open.map(() => 'KILL_SWITCH'), 'chiusure attribuite al kill switch');
  assert.ok(!b.alerts.codes().includes('DESYNC') && !b.alerts.codes().includes('UNKNOWN_POSITION'));
});

test('esito incerto non ancora riconciliabile: nessun secondo ordine per quel simbolo, le altre posizioni si chiudono', async () => {
  const world = makeWorld();
  const { inst: a, open } = await withPositions(world);
  world.fake.liquidity.set('PF_ETHUSD', 0); // l'ordine arriva ma non trova liquidità
  world.fake.failNext('submitOrder', { kind: 'timeout_after_processing' }, 1, (p) => isKillClose(p) && (p as SubmitParams).symbol === 'PF_ETHUSD');
  world.fake.failNext('getOrderStatus', { kind: 'network' }, 1_000); // stato degli ordini illeggibile
  const first = await a.runtime.killSwitch('api');
  assert.equal(first.opState, 'HALTING');
  for (const t of tickTimes(world.clock.t, world.clock.t + 30 * MIN)) await step(world, [a], t, true);
  assert.equal(a.runtime.operationalState, 'HALTING');
  assert.deepEqual(openOnKraken(world), ['PF_ETHUSD'], 'le altre posizioni sono chiuse');
  const ethKill = () => [...world.fake.orders.values()].filter((o) => o.symbol === 'PF_ETHUSD' && (o.cliOrdId ?? '').startsWith('mt-k-'));
  assert.equal(ethKill().length, 1, 'nessun secondo ordine finché il primo ha esito incerto');

  world.fake.clearFaults('getOrderStatus');
  world.fake.liquidity.delete('PF_ETHUSD');
  for (const t of tickTimes(world.clock.t, world.clock.t + 30 * MIN)) await step(world, [a], t);
  assert.equal(a.runtime.operationalState, 'HALTED');
  assert.deepEqual(openOnKraken(world), []);
  assert.deepEqual(openOrders(world), []);
  assert.deepEqual(ethKill().map((o) => [o.cliOrdId?.slice(-2), o.filled > 0]), [['-1', false], ['-2', true]], 'secondo tentativo solo dopo la prova che il primo non ha eseguito nulla');
  assert.equal(Object.keys(filledKillCloses(world)).length, open.length);
});

test('flag su Firestore (scritto a mano): kill switch dal ciclo di protezione; ripresa rifiutata finché il flag è attivo', async () => {
  const world = makeWorld();
  const { inst: a } = await withPositions(world);
  await world.docs.set('bot_runtime/control', { killSwitch: 'TRUE ' });
  await runUntil(world, [a], world.clock.t + 15 * MIN, world.clock.t);
  assert.equal(a.runtime.operationalState, 'HALTED');
  assert.ok(a.alerts.alerts.some((x) => x.code === 'KILL_SWITCH' && /flag/.test(x.message)));
  assert.deepEqual(openOnKraken(world), []);
  assert.deepEqual(openOrders(world), []);

  await assert.rejects(() => a.runtime.resumeRisk(RESUME_CONFIRMATION), /flag/);
  await world.docs.set('bot_runtime/control', { killSwitch: false });
  await assert.rejects(() => a.runtime.resumeRisk('confermo'), /CONFERMO_RIPRESA/);
  assert.equal(await a.runtime.resumeRisk(RESUME_CONFIRMATION), 'RUNNING');
  assert.equal(a.runtime.statusPayload().killSwitch, null);
  assert.equal(a.runtime.statusPayload().entryBlock, null);
  await runUntil(world, [a], world.clock.t + 30 * MIN, world.clock.t);
  assert.equal(a.runtime.operationalState, 'RUNNING', 'il flag disattivato non riattiva il kill switch');
});

test('lettura del flag fallita: la protezione (stop e riconciliazione) continua', async () => {
  const world = makeWorld();
  const { inst: a } = await withPositions(world);
  const docs = world.docs as unknown as { get: (path: string) => Promise<unknown> };
  const get = docs.get.bind(world.docs);
  docs.get = async (path: string) => {
    if (path === 'bot_runtime/control') throw new Error('UNAVAILABLE');
    return get(path);
  };
  for (const stop of openOrders(world).filter((o) => o.type === 'stp')) world.fake.dropOrder(stop.cliOrdId as string); // stop spariti
  const t = world.clock.t + 20_000;
  world.clock.t = t;
  await a.runtime.protectionTick(t);
  const unprotected = openOnKraken(world).filter((s) => !openOrders(world).some((o) => o.type === 'stp' && o.symbol === s));
  assert.ok(openOnKraken(world).length > 0);
  assert.deepEqual(unprotected, [], 'ogni posizione ha di nuovo il suo stop');
  assert.equal(a.runtime.operationalState, 'RUNNING');
  assert.match(String(a.runtime.statusPayload().lastError), /flag del kill switch non letto/);
});

test('kill switch in shadow: posizioni simulate chiuse all ultimo prezzo, stop simulati cancellati, nessuna chiamata a Kraken', async () => {
  const world = makeWorld();
  const { inst: s, open } = await withPositions(world, 'S', 'shadow');
  const result = await s.runtime.killSwitch('api');
  assert.equal(result.opState, 'HALTED');
  assert.equal((s.runtime.statusPayload().openPositions as unknown[]).length, 0);
  const killed = s.runtime.recentTrades.filter((t) => t.reason === 'KILL_SWITCH');
  assert.equal(killed.length, open.length);
  const saved = await world.docs.get<{ port: { kind: string; state: { stops: unknown[] } } }>('bot_runtime/state');
  assert.equal(saved?.port.kind, 'sim');
  assert.deepEqual(saved?.port.state.stops, [], 'stop simulati cancellati');
  assert.equal(world.calls.length, 0, 'lo shadow non tocca Kraken');
  assert.equal(world.fake.orders.size, 0);
  // Solo in shadow il reset riparte da uno stato nuovo, anche operativo.
  await s.runtime.reset();
  assert.equal(await s.runtime.ensureRunning(), 'RUNNING');
  assert.equal(s.runtime.operationalState, 'RUNNING');
});

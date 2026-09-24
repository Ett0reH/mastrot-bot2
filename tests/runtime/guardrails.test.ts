// Gate F5: ogni limite della sezione 2 applicato dal runtime prima dell'invio degli ordini, su
// Kraken simulato con i dati reali del 21-25 gennaio 2022 (13 ingressi nel run senza limiti).
// In caso di violazione: intento respinto (nessun ordine), journal REJECTED con il motivo e alert.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESUME_CONFIRMATION } from '../../src/engine/runtime/botRuntime';
import { type Instance, makeInstance, makeWorld, MIN, step, tickTimes, type World } from './world';

async function runUntil(world: World, instances: Instance[], until: number, from = world.startMs): Promise<void> {
  for (const t of tickTimes(from, until)) await step(world, instances, t);
}

type SubmitParams = { orderType?: string; symbol?: string; size?: number; limitPrice?: number };

function entryOrders(world: World): SubmitParams[] {
  return world.calls.filter((c) => c.method === 'submitOrder' && (c.params as SubmitParams).orderType === 'ioc').map((c) => c.params as SubmitParams);
}

function rejectedJournal(inst: Instance, code: string) {
  return inst.runtime.recentJournal.filter((r) => r.action === 'REJECTED' && r.reason.includes(code));
}

function riskAlerts(inst: Instance, code: string) {
  return inst.alerts.alerts.filter((a) => a.code === 'RISK_REJECTED' && a.message.includes(code));
}

const END = Date.parse('2022-01-23T03:00:00Z');

test('MAX_LEVERAGE: ingressi con leva isolated oltre il limite respinti prima dell invio', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A', { limits: { maxLeverage: 1 } });
  await a.runtime.ensureRunning();
  await runUntil(world, [a], END);
  const leverages = world.calls.filter((c) => c.method === 'setLeverageSettings').map((c) => (c.params as { maxLeverage: number }).maxLeverage);
  assert.ok(entryOrders(world).length > 0, 'gli ingressi a 1x passano');
  assert.ok(leverages.length > 0 && leverages.every((l) => l === 1), `leve impostate: ${leverages}`);
  assert.ok([...world.fake.leverage.values()].every((l) => l === 1));
  assert.ok(riskAlerts(a, 'MAX_LEVERAGE').length > 0, 'alert per ogni rifiuto');
  assert.ok(rejectedJournal(a, 'MAX_LEVERAGE').some((r) => r.symbol === 'SOL'), 'SOL a 1,7x respinta, con il motivo nel journal');
});

test('MAX_POSITION_NOTIONAL_USD: nessun ordine d ingresso oltre il nozionale massimo', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A', { limits: { maxPositionNotionalUsd: 900 } });
  await a.runtime.ensureRunning();
  await runUntil(world, [a], END);
  const entries = entryOrders(world);
  assert.ok(entries.length > 0);
  // Il prezzo limite dell'IOC include il buffer dello 0,5% sul prezzo di riferimento.
  for (const o of entries) assert.ok((o.size as number) * (o.limitPrice as number) <= 900 * 1.005 + 1e-6, `${o.symbol}: ${(o.size as number) * (o.limitPrice as number)}`);
  assert.ok(riskAlerts(a, 'MAX_NOTIONAL').length > 0);
  assert.ok(rejectedJournal(a, 'MAX_NOTIONAL').some((r) => r.symbol === 'SOL'), 'SOL (1.147 $) respinta il 21 gennaio');
});

test('MAX_OPEN_POSITIONS: mai più posizioni aperte del limite, né su Kraken né nel core', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A', { limits: { maxOpenPositions: 2 } });
  await a.runtime.ensureRunning();
  let maxOpen = 0;
  for (const t of tickTimes(world.startMs, END)) {
    await step(world, [a], t);
    const onKraken = [...world.fake.positions.values()].filter((p) => p.size !== 0).length;
    maxOpen = Math.max(maxOpen, onKraken, (a.runtime.statusPayload().openPositions as unknown[]).length);
  }
  assert.equal(maxOpen, 2, 'il limite viene raggiunto e mai superato');
  assert.ok(riskAlerts(a, 'MAX_OPEN_POSITIONS').length > 0);
  assert.ok(rejectedJournal(a, 'MAX_OPEN_POSITIONS').length > 0);
});

test('CAPITAL: con il collateral del conto sceso sotto il margine in uso, nessun nuovo ingresso', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  await runUntil(world, [a], Date.parse('2022-01-22T05:30:00Z'));
  assert.ok((a.runtime.statusPayload().marginUsed as number) > 1_000, 'margine in uso > 1.000 $');
  // Prelievo dal conto: il collateral scende a 1.000 $ con le posizioni aperte.
  const accounts = world.fake.getAccounts.bind(world.fake);
  world.fake.getAccounts = async () => {
    const r = await accounts();
    return { ...r, accounts: { ...r.accounts, flex: { ...r.accounts.flex!, marginEquity: 1_000 } } };
  };
  for (const t of tickTimes(world.clock.t, END)) {
    const entries = entryOrders(world).length;
    await step(world, [a], t);
    // Ogni ingresso eseguito dopo il prelievo lascia il margine totale entro il collateral.
    if (entryOrders(world).length > entries) assert.ok((a.runtime.statusPayload().marginUsed as number) <= 1_000 + 1e-6);
  }
  assert.equal(a.runtime.statusPayload().sizingEquityCap, 1_000);
  assert.ok(riskAlerts(a, 'CAPITAL').length > 0, 'ingresso respinto: margine totale oltre il collateral');
  assert.ok(rejectedJournal(a, 'CAPITAL').length > 0);
});

test('MAX_DAILY_LOSS_PCT: oltre il limite nessun nuovo ingresso fino alla mezzanotte UTC; blocco persistito; uscite attive', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A', { limits: { maxDailyLossPct: 1 } });
  await a.runtime.ensureRunning();
  let blockedAt: number | null = null;
  for (const t of tickTimes(world.startMs, Date.parse('2022-01-22T09:00:00Z'))) {
    await step(world, [a], t);
    if (blockedAt === null && a.runtime.statusPayload().dailyLossBlockUntil !== null) blockedAt = t;
  }
  assert.ok(blockedAt !== null, 'il 22 gennaio la perdita supera l 1%');
  assert.equal(a.runtime.statusPayload().dailyLossBlockUntil, '2022-01-23T00:00:00.000Z');
  const limitAlerts = a.alerts.alerts.filter((x) => x.code === 'RISK_LIMIT');
  assert.equal(limitAlerts.length, 1, 'un solo alert critico, non uno per ingresso');
  assert.equal(limitAlerts[0].level, 'critical');
  const entriesAtBlock = entryOrders(world).length;
  const openAtBlock = (a.runtime.statusPayload().openPositions as unknown[]).length;
  assert.ok(openAtBlock > 0);

  // Riavvio (nuova istanza sullo stesso archivio): il blocco resta.
  a.state.alive = false;
  world.clock.t += 70_000;
  const b = makeInstance(world, 'B', { limits: { maxDailyLossPct: 1 } });
  await runUntil(world, [b], Date.parse('2022-01-22T23:50:00Z'), world.clock.t);
  assert.equal(b.runtime.statusPayload().dailyLossBlockUntil, '2022-01-23T00:00:00.000Z', 'blocco ripristinato dallo stato persistito');
  assert.equal(entryOrders(world).length, entriesAtBlock, 'nessun nuovo ingresso durante il blocco');
  assert.ok(rejectedJournal(b, 'DAILY_LOSS').length > 0, 'gli ingressi decisi sono respinti con il motivo');
  assert.ok(b.runtime.recentTrades.length > 0, 'le posizioni aperte continuano a essere gestite e chiuse');

  await runUntil(world, [b], Date.parse('2022-01-23T00:30:00Z'), world.clock.t);
  assert.equal(b.runtime.statusPayload().dailyLossBlockUntil, null, 'nuovo giorno UTC: blocco rimosso');
  assert.equal(b.runtime.statusPayload().entryBlock, null);
  assert.equal(b.runtime.operationalState, 'RUNNING');
});

test('DRAWDOWN_REDUCE_ONLY_PCT: REDUCE_ONLY con alert; le uscite e gli stop continuano (D29); ripresa solo con conferma', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A', { limits: { drawdownReduceOnlyPct: 2 } });
  await a.runtime.ensureRunning();
  let reducedAt: number | null = null;
  let openAtReduce: string[] = [];
  let entriesAtReduce = 0;
  for (const t of tickTimes(world.startMs, Date.parse('2022-01-23T03:00:00Z'))) {
    await step(world, [a], t);
    if (reducedAt === null && a.runtime.operationalState === 'REDUCE_ONLY') {
      reducedAt = t;
      entriesAtReduce = entryOrders(world).length;
      openAtReduce = (a.runtime.statusPayload().openPositions as { id: string; symbol: string }[]).map((p) => p.id);
      assert.equal(a.runtime.statusPayload().status, 'REDUCE_ONLY');
      for (const p of a.runtime.statusPayload().openPositions as { symbol: string; protection: string }[]) assert.equal(p.protection, 'NATIVE_STOP_OK');
    }
  }
  assert.ok(reducedAt !== null, 'drawdown oltre il 2% il 22 gennaio');
  const alert = a.alerts.alerts.find((x) => x.code === 'RISK_LIMIT');
  assert.ok(alert && alert.level === 'critical' && /REDUCE_ONLY/.test(alert.message));
  assert.equal(entryOrders(world).length, entriesAtReduce, 'nessun ingresso in REDUCE_ONLY');
  assert.ok(rejectedJournal(a, 'REDUCE_ONLY').length > 0, 'gli ingressi decisi dopo sono respinti con il motivo');
  // D29: le posizioni aperte al passaggio vengono chiuse dalla strategia (non dal guardrail).
  const closedAfter = a.runtime.recentTrades.filter((t) => Date.parse(t.exitTime) >= (reducedAt as number) - 15 * MIN);
  assert.ok(openAtReduce.length > 0 && closedAfter.length >= openAtReduce.length, `chiusure dopo REDUCE_ONLY: ${closedAfter.map((t) => `${t.symbol} ${t.reason}`)}`);
  assert.ok(closedAfter.some((t) => t.reason === 'TRAILING_STOP_LOSS' || t.reason.startsWith('EDGE_DECAY')), 'uscite di strategia eseguite');
  assert.equal(a.runtime.operationalState, 'REDUCE_ONLY', 'resta REDUCE_ONLY finché una persona non riprende');
  assert.equal((a.runtime.statusPayload().openPositions as unknown[]).length, 0);
  assert.equal([...world.fake.orders.values()].filter((o) => o.status === 'open').length, 0, 'nessuno stop orfano dopo le chiusure');

  await assert.rejects(() => a.runtime.resumeRisk('ok'), /CONFERMO_RIPRESA/);
  assert.equal(a.runtime.operationalState, 'REDUCE_ONLY');
  assert.equal(await a.runtime.resumeRisk(RESUME_CONFIRMATION), 'RUNNING');
  await assert.rejects(() => a.runtime.resumeRisk(RESUME_CONFIRMATION), /già in RUNNING/, 'una seconda ripresa non sposta il riferimento del drawdown');
  await runUntil(world, [a], world.clock.t + 60 * MIN, world.clock.t);
  assert.equal(a.runtime.operationalState, 'RUNNING', 'il riferimento del drawdown riparte dall equity attuale');
  assert.ok(a.alerts.alerts.some((x) => x.code === 'MODE_CHANGE' && /Ripresa manuale/.test(x.message)));
});

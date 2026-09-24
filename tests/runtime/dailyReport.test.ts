// Report giornaliero nel runtime (F6): generato a fine giorno UTC, con il confronto con il backtest
// sugli stessi dati (dal checkpoint del core di inizio giorno). Dati reali del 21-23 gennaio 2022.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGoLive } from '../../src/engine/ops/goLive';
import { makeInstance, makeWorld, step, tickTimes, type World } from './world';

const END = '2022-01-23T23:45:00Z';

async function runUntil(world: World, inst: ReturnType<typeof makeInstance>, until: number, from = world.startMs, everyProtection = false): Promise<void> {
  for (const t of tickTimes(from, until)) await step(world, [inst], t, everyProtection);
}

test('shadow: report di ogni giorno concluso, parità IDENTICA con il backtest, slippage come il modello', async () => {
  const world = makeWorld('2022-01-21T00:00:00Z', END);
  const s = makeInstance(world, 'S', { mode: 'shadow' });
  await s.runtime.ensureRunning();
  await runUntil(world, s, Date.parse('2022-01-23T00:30:00Z'));
  await s.runtime.flushReports();
  const reports = await s.runtime.dailyReports();
  assert.deepEqual(reports.map((r) => r.day), ['2022-01-22', '2022-01-21']);
  for (const r of reports) {
    assert.equal(r.parity?.status, 'IDENTICAL', `${r.day}: ${JSON.stringify(r.parity?.divergences.slice(0, 3))} ${r.parity?.reason}`);
    assert.ok((r.parity?.compared.decisions ?? 0) >= 8 * 20, `${r.day}: decisioni confrontate ${r.parity?.compared.decisions}`);
  }
  const day22 = reports[0];
  const closed = s.runtime.allTrades.filter((t) => t.exitTime.startsWith('2022-01-22'));
  assert.ok(closed.length >= 5);
  assert.equal(day22.pnl.trades, closed.length);
  assert.equal(day22.parity?.compared.trades, closed.length + 0, 'trade confrontati uno per uno');
  assert.equal(day22.slippage.strategy.withinModel, true);
  assert.equal(day22.slippage.strategy.avgBps, 5, 'in shadow i fill sono quelli del modello: 5 bps');
  assert.equal(day22.entries.fillRatePct, 100);
  assert.equal(day22.fees.ledger, null, 'in shadow non esiste un ledger di Kraken');
  assert.ok(day22.equity.start !== null && day22.equity.end !== null);
  assert.equal(s.runtime.latestReport?.day, '2022-01-22');
  assert.ok(s.alerts.alerts.some((a) => a.code === 'DAILY_REPORT' && /Report 2022-01-22 \(shadow\)/.test(a.message)));
  assert.ok(world.docs.paths('reports/').includes('reports/checkpoint-2022-01-22'));
});

test('shadow con una candela pubblicata in ritardo: il bot decide senza, il confronto la trova e la spiega', async () => {
  const world = makeWorld('2022-01-21T00:00:00Z', END);
  const late = Date.parse('2022-01-22T05:45:00Z');
  // BTC delle 05:45 pubblicata 10 minuti dopo: oltre l'attesa di 3 minuti del ciclo.
  const s = makeInstance(world, 'S', { mode: 'shadow', publishDelay: (symbol, t) => (symbol === 'BTC' && t === late ? 10 * 60_000 : 20_000) });
  await s.runtime.ensureRunning();
  await runUntil(world, s, Date.parse('2022-01-22T06:02:00Z'));
  // Come lo scheduler reale, un nuovo tentativo dopo l'attesa massima (3 minuti): si procede senza BTC.
  world.clock.t = Date.parse('2022-01-22T06:04:00Z');
  await s.runtime.decisionTick(world.clock.t);
  await runUntil(world, s, Date.parse('2022-01-23T00:30:00Z'), world.clock.t);
  await s.runtime.flushReports();
  const day22 = (await s.runtime.dailyReport('2022-01-22'))!;
  const noData = s.runtime.recentJournal.find((r) => r.slotTime === late && r.symbol === 'BTC');
  assert.equal(noData?.action, 'NO_DATA', 'il bot ha deciso senza la candela di BTC');
  assert.ok(day22.parity && day22.parity.divergences.length > 0, 'il replay sui dati definitivi ha la candela');
  assert.equal(day22.parity.unexplained, 0, JSON.stringify(day22.parity.divergences.filter((d) => !d.explanation)));
  assert.equal(day22.parity.status, 'EXPLAINED');
  assert.ok(day22.parity.divergences.some((d) => d.symbol === 'BTC' && /candela non disponibile/.test(d.explanation ?? '')));
  assert.equal((await s.runtime.dailyReport('2022-01-21'))?.parity?.status, 'IDENTICAL', 'il giorno prima non è toccato');
});

test('demo: report dopo la lettura del ledger, parità con i fill reali, fee coerenti con Kraken; sopravvive al riavvio', async () => {
  const world = makeWorld('2022-01-21T00:00:00Z', END);
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  await runUntil(world, a, Date.parse('2022-01-22T12:00:00Z'), world.startMs, true);
  // Riavvio a metà giornata: le statistiche del giorno restano nello stato persistito.
  a.state.alive = false;
  world.clock.t += 70_000;
  const b = makeInstance(world, 'B');
  await runUntil(world, b, Date.parse('2022-01-23T00:45:00Z'), world.clock.t, true);
  await b.runtime.flushReports();
  const day22 = (await b.runtime.dailyReport('2022-01-22'))!;
  assert.ok(day22, 'report del 22 generato dopo la lettura del ledger di mezzanotte');
  assert.equal(day22.mode, 'demo');
  assert.equal(day22.parity?.mode, 'actual_fills');
  assert.equal(day22.parity?.status, 'IDENTICAL', JSON.stringify(day22.parity?.divergences.slice(0, 3)));
  assert.ok(day22.entries.decided >= 4, `ingressi del 22 compresi quelli prima del riavvio: ${day22.entries.decided}`);
  assert.equal(day22.entries.fillRatePct, 100);
  assert.ok(day22.fees.ledger !== null && day22.fees.ledger > 0);
  assert.ok(Math.abs(day22.fees.diff as number) < 1e-6, `fee del bot ${day22.fees.bot} vs Kraken ${day22.fees.ledger}`);
  assert.ok(day22.slippage.strategy.samples > 0);
  const metrics = b.runtime.metrics();
  assert.equal(metrics.ledgerCheck.consistent, true, 'PnL dei trade = equity realizzata − capitale anche dopo il riavvio');
  assert.equal(metrics.trades.count, b.runtime.allTrades.length);
});

test('D55: il report conta gli alert di tutto il giorno anche dopo un riavvio (alert salvati su Firestore)', async () => {
  const world = makeWorld('2022-01-21T00:00:00Z', END);
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  await runUntil(world, a, Date.parse('2022-01-22T08:40:00Z'), world.startMs, true);
  // Stop cancellato a mano la mattina del 22: STOP_MISSING e poi STOP_RESTORED.
  const stop = [...world.fake.orders.values()].find((o) => o.status === 'open' && o.type === 'stp');
  assert.ok(stop?.cliOrdId, 'uno stop aperto da cancellare');
  world.fake.dropOrder(stop.cliOrdId);
  await runUntil(world, a, Date.parse('2022-01-22T12:00:00Z'), world.clock.t, true);
  assert.ok(a.alerts.codes().includes('STOP_MISSING'));
  // Riavvio a metà giornata: il nuovo processo non ha in memoria gli alert della mattina.
  a.state.alive = false;
  world.clock.t += 70_000;
  const b = makeInstance(world, 'B');
  await runUntil(world, b, Date.parse('2022-01-23T00:45:00Z'), world.clock.t, true);
  await b.runtime.flushReports();
  const day22 = (await b.runtime.dailyReport('2022-01-22'))!;
  assert.ok(day22, 'report del 22');
  assert.equal(day22.alerts.byCode.STOP_MISSING, 1, `alert del 22: ${JSON.stringify(day22.alerts.byCode)}`);
  assert.equal(day22.alerts.byCode.STOP_RESTORED, 1);
  assert.ok(day22.alerts.critical >= 1);
  assert.ok(day22.issues.some((i) => /alert critici/.test(i)));
  // I criteri del go-live, calcolati sui report veri, trovano lo stop mancante del 22 (prima del riavvio).
  const e = evaluateGoLive(await b.runtime.dailyReports(), '2022-01-21', '2022-01-22', 2);
  const byId = Object.fromEntries(e.criteria.map((c) => [c.id, c]));
  assert.equal(byId.days.ok, true, byId.days.detail);
  assert.equal(byId.protection.ok, false);
  assert.match(byId.protection.detail, /2022-01-22 STOP_MISSING×1/);
  assert.equal(byId.desync.ok, true, byId.desync.detail);
  assert.equal(byId.parity.ok, true, byId.parity.detail);
  assert.equal(e.ok, false);
});

// Percorso live completo su Kraken simulato (F3): DecisionCycle + KrakenExecutionPort sui dati
// reali del crollo di gennaio 2022. Il mercato del fake segue le candele 15m chiuse (apertura,
// minimo/massimo, chiusura), così gli stop nativi scattano come su Kraken. A ogni ciclo si
// verificano le invarianti I7 (stop su ogni posizione), I8 (nessun ordine duplicato), I10
// (libro della porta = posizioni su Kraken = posizioni del core) e I12 (trade = fill reali).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalHourCloseSlot, loadBacktestData } from '../../src/engine/backtest/runner';
import { REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import type { TradeRecord } from '../../src/engine/core/types';
import { BAR_15M_MS, KRAKEN_NATIVE_SYMBOLS } from '../../src/engine/data/dataset';
import { InstrumentRegistry } from '../../src/engine/exchange/instruments';
import { DEFAULT_KRAKEN_PORT_CONFIG, FundingFromLedgerPending, KrakenExecutionPort } from '../../src/engine/exchange/krakenExecutionPort';
import { KrakenAdapter } from '../../src/engine/exchange/krakenAdapter';
import { OrderManager } from '../../src/engine/exchange/orderManager';
import { averagePrice, InMemoryOrderStore, makeCliOrdId } from '../../src/engine/exchange/orders';
import { StopManager } from '../../src/engine/exchange/stopManager';
import { DecisionCycle, lastClosedSlot } from '../../src/engine/live/decisionCycle';
import { MemoryAlertSink } from '../../src/engine/ops/alerts';
import { ReplayCandleSource } from '../../src/engine/replay/replay';
import { FAKE_INSTRUMENTS, FakeKrakenFutures } from '../../src/engine/sim/fakeKraken';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

test('percorso live su Kraken simulato: invarianti di esecuzione su una settimana di crollo reale', async () => {
  const symbols = GOLDEN_WINDOWS.find((w) => w.id === '2022H1')!.symbols;
  const start = '2022-01-20T00:00:00Z';
  const end = '2022-01-26T23:45:00Z';
  const startMs = Date.parse(start);
  const finalSlot = finalHourCloseSlot(Date.parse(end));
  const data = loadBacktestData({ symbols, start, end, warmupDays: 50, initialEquity: 10000, execution: REALISTIC_PROFILE.execution, backstop: REALISTIC_PROFILE.backstop, funding: { kind: 'none' } });
  const bySymbol = Object.fromEntries(symbols.map((s) => [s, new Map(data[s].map((c) => [c.t, c]))]));

  const clock = { t: startMs };
  const now = () => clock.t;
  const sleep = async (ms: number) => {
    clock.t += ms;
  };
  const marks: Record<string, number> = {};
  for (const s of symbols) marks[KRAKEN_NATIVE_SYMBOLS[s]] = data[s].filter((c) => c.t < startMs).at(-1)!.c;
  const fake = new FakeKrakenFutures({ now, instruments: FAKE_INSTRUMENTS, marks });
  const adapter = new KrakenAdapter(fake, { now, sleep });
  const store = new InMemoryOrderStore();
  const orders = new OrderManager(adapter, store, { now });
  const alerts = new MemoryAlertSink();
  const instruments = new InstrumentRegistry(() => adapter.instruments(), now);
  const stops = new StopManager(orders, adapter, instruments, alerts, { now });
  const port = new KrakenExecutionPort({ mode: 'demo', adapter, orders, stops, instruments, alerts, funding: new FundingFromLedgerPending(), now }, DEFAULT_KRAKEN_PORT_CONFIG);
  const source = new ReplayCandleSource(data, now, () => 20_000);
  const cycle = new DecisionCycle(
    { core: { symbols, initialEquity: 10000, feeRate: 0.0005, backstop: REALISTIC_PROFILE.backstop }, startMs, warmupMs: 50 * 24 * 3_600_000, candleWaitMs: 180_000, maxEntryDelayMs: 600_000, finalSlot },
    { source, port },
  );
  await cycle.start();

  // Il mercato del fake avanza solo con candele già chiuse (niente look-ahead).
  let applied = startMs - BAR_15M_MS;
  const driveMarket = (upTo: number) => {
    for (let slot = applied + BAR_15M_MS; slot <= upTo; slot += BAR_15M_MS) {
      for (const s of symbols) {
        const c = bySymbol[s].get(slot);
        if (!c) continue;
        const path = c.c >= c.o ? [c.o, c.l, c.h, c.c] : [c.o, c.h, c.l, c.c];
        for (const p of path) fake.setMark(KRAKEN_NATIVE_SYMBOLS[s], p);
      }
      applied = slot;
    }
  };

  const trades: TradeRecord[] = [];
  let opens = 0;
  let checks = 0;
  for (let t = startMs + 60_000; ; t += BAR_15M_MS) {
    clock.t = t;
    driveMarket(Math.min(lastClosedSlot(t), finalSlot));
    const r = await cycle.tick(t);
    trades.push(...r.trades);
    opens += r.intents.filter((i) => i.kind === 'OPEN').length;
    assert.ok(!r.events.some((e) => e.type === 'INTENT_PENDING'), 'nessun ordine rimasto in stato incerto');

    // I10 subito dopo il ciclo: core e libro della porta coincidono.
    const core = cycle.openPositions().map((p) => `${p.id}:${p.trade.size}`).sort();
    const book = Object.values(port.state.positions).map((p) => `${p.positionId}:${p.entrySize}`).sort();
    assert.deepEqual(book, core, `libro ≠ core alle ${new Date(t).toISOString()}`);

    // Ciclo di protezione (30 s dopo) e invarianti sull'exchange.
    clock.t = t + 30_000;
    await port.protect();
    for (const pos of Object.values(port.state.positions)) {
      const sign = pos.direction === 'LONG' ? 1 : -1;
      assert.equal(fake.positionSize(pos.native), sign * pos.size, `${pos.native}: Kraken ≠ libro`);
      const protective = fake.openOrdersFor(pos.native).filter((o) => o.type === 'stp' && o.reduceOnly);
      assert.equal(protective.length, 1, `${pos.native}: stop nativi attivi ${protective.length}`);
      assert.equal(protective[0].size, pos.size, `${pos.native}: size dello stop ≠ posizione`);
      checks++;
    }
    if (cycle.state.lastSlot === finalSlot) break;
  }

  // Fine dei dati: tutto chiuso su Kraken, nessun ordine residuo.
  clock.t += 30_000;
  await port.protect();
  assert.equal(fake.positions.size, 0, 'conto flat');
  assert.equal([...fake.orders.values()].filter((o) => o.status === 'open').length, 0, 'nessun ordine aperto');

  // I8: nessun cliOrdId usato per due ordini su Kraken.
  const ids = [...fake.orders.values()].map((o) => o.cliOrdId).filter((id): id is string => id !== null);
  assert.equal(new Set(ids).size, ids.length);

  // I12: ogni trade del core corrisponde ai fill reali su Kraken.
  assert.ok(trades.length >= 10, `trade: ${trades.length}`);
  assert.equal(trades.length, opens, 'ogni ingresso deciso è stato eseguito e chiuso');
  for (const trade of trades) {
    const positionId = `${trade.symbol.split('/')[0]}-${trade.entryTime}`;
    const entry = await store.get(makeCliOrdId(positionId, 'ENTRY', 1));
    assert.ok(entry, `ordine d'ingresso di ${positionId}`);
    assert.equal(trade.size, entry.filledSize);
    assert.equal(trade.entryPrice, averagePrice(entry.fills));
    const closing = (await store.byIntent(positionId)).filter((r) => r.purpose !== 'ENTRY').flatMap((r) => r.fills);
    assert.ok(Math.abs(trade.exitPrice - (averagePrice(closing) as number)) < 1e-9 * trade.exitPrice, `${positionId}: prezzo d'uscita ≠ fill`);
    assert.equal(closing.reduce((a, f) => a + f.size, 0), trade.size);
  }
  assert.ok(checks > 50, `controlli di protezione: ${checks}`);
  assert.ok(!alerts.codes().includes('DESYNC') && !alerts.codes().includes('EMERGENCY_CLOSE'), `alert inattesi: ${alerts.codes().join(', ')}`);
});

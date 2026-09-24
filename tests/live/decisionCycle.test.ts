// Ciclo decisionale del live (F2 Fase C): tempi, candele, riavvii ed esecuzione.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { loadBacktestData } from '../../src/engine/backtest/runner';
import { initialCoreState } from '../../src/engine/core/decisionCore';
import type { Fill, Intent } from '../../src/engine/core/types';
import { BAR_15M_MS, type Candle } from '../../src/engine/data/dataset';
import { DecisionCycle, type DecisionCycleConfig, lastClosedSlot } from '../../src/engine/live/decisionCycle';
import type { ExecutionPort, ExecutionReport, FundingCharge } from '../../src/engine/live/ports';
import { ReplayCandleSource, SimExecutionPort } from '../../src/engine/replay/replay';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

const W = GOLDEN_WINDOWS.find((w) => w.id === '2022H1')!;
const MIN = 60_000;
// Nel golden SOL apre una EXTREME alla chiusura oraria dello slot 01:45 del 21/01/2022.
const START = Date.parse('2022-01-21T00:00:00Z');
const SOL_SLOT = Date.parse('2022-01-21T01:45:00Z');
const HOUR_END = SOL_SLOT + 15 * MIN; // 02:00

let cached: Record<string, Candle[]> | null = null;
function data(): Record<string, Candle[]> {
  cached ??= loadBacktestData({ symbols: W.symbols, start: '2022-01-21T00:00:00Z', end: '2022-01-23T00:00:00Z', warmupDays: 50, initialEquity: 10000, execution: REALISTIC_PROFILE.execution, backstop: REALISTIC_PROFILE.backstop, funding: { kind: 'none' } });
  return cached;
}

function cycleConfig(overrides: Partial<DecisionCycleConfig> = {}): DecisionCycleConfig {
  return {
    core: { symbols: W.symbols, initialEquity: 10000, feeRate: 0.0005, backstop: REALISTIC_PROFILE.backstop },
    startMs: START,
    warmupMs: 50 * 24 * 3_600_000,
    candleWaitMs: 3 * MIN,
    maxEntryDelayMs: 10 * MIN,
    ...overrides,
  };
}

/** Fonte con orologio controllabile e ritardo di pubblicazione per candela (default 30 s). */
function setup(delay: (symbol: string, t: number) => number = () => 30_000, forming = true) {
  const clock = { now: START };
  const source = new ReplayCandleSource(data(), () => clock.now, delay, forming);
  const port = new SimExecutionPort(REALISTIC_PROFILE.execution, { kind: 'none' });
  return { clock, source, port };
}

test('lastClosedSlot: l ultimo slot la cui candela è chiusa', () => {
  assert.equal(lastClosedSlot(HOUR_END), SOL_SLOT);
  assert.equal(lastClosedSlot(HOUR_END - 1), SOL_SLOT - BAR_15M_MS);
});

test('la candela in formazione restituita dalla fonte viene scartata e mai usata', async () => {
  const { clock, source, port } = setup();
  const cycle = new DecisionCycle(cycleConfig(), { source, port });
  await cycle.start();
  clock.now = HOUR_END + 7 * MIN; // candela 02:00 in formazione
  const r = await cycle.tick(clock.now);
  assert.equal(r.lastSlot, SOL_SLOT);
  assert.ok(r.events.some((e) => e.type === 'CANDLE_DISCARDED' && e.reason === 'NOT_CLOSED' && e.t === HOUR_END));
  assert.equal(cycle.state.lastClose.SOL, data().SOL.find((c) => c.t === SOL_SLOT)!.c);
});

test('la decisione oraria aspetta la candela delle :45 di tutti i simboli', async () => {
  // La candela SOL delle 01:45 viene pubblicata 2 minuti dopo la chiusura.
  const { clock, source, port } = setup((s, t) => (s === 'SOL' && t === SOL_SLOT ? 2 * MIN : 20_000));
  const cycle = new DecisionCycle(cycleConfig(), { source, port });
  await cycle.start();
  clock.now = HOUR_END + MIN;
  const early = await cycle.tick(clock.now);
  assert.equal(early.waiting, true);
  assert.equal(early.lastSlot, SOL_SLOT - BAR_15M_MS, 'lo slot delle 01:45 non viene elaborato senza SOL');
  assert.deepEqual(early.intents, []);
  assert.ok(early.events.some((e) => e.type === 'WAITING_CANDLES' && e.slot === SOL_SLOT && e.symbols.includes('SOL')));
  clock.now = HOUR_END + 2 * MIN + 1;
  const later = await cycle.tick(clock.now);
  assert.equal(later.waiting, false);
  assert.equal(later.lastSlot, SOL_SLOT);
  const open = later.intents.find((i) => i.kind === 'OPEN' && i.symbol === 'SOL');
  assert.ok(open, 'SOL apre come nel golden');
  assert.ok(cycle.state.positions.SOL, 'posizione aperta dopo il fill simulato');
});

test('candela oltre l attesa massima: si procede senza e la candela arrivata dopo viene ignorata', async () => {
  const { clock, source, port } = setup((s, t) => (s === 'SOL' && t === SOL_SLOT ? 20 * MIN : 20_000));
  const cycle = new DecisionCycle(cycleConfig(), { source, port });
  await cycle.start();
  clock.now = HOUR_END + 3 * MIN; // fine dell'attesa (candleWaitMs = 3 min)
  const r = await cycle.tick(clock.now);
  assert.equal(r.lastSlot, SOL_SLOT);
  assert.ok(r.events.some((e) => e.type === 'CANDLE_MISSING' && e.slot === SOL_SLOT && e.symbols.includes('SOL')));
  assert.ok(!r.intents.some((i) => i.symbol === 'SOL'), 'senza la sua candela SOL non viene valutato');
  assert.equal(cycle.state.positions.SOL, null);
  clock.now = HOUR_END + 25 * MIN; // ora la candela è pubblicata, ma lo slot è già stato elaborato
  const after = await cycle.tick(clock.now);
  assert.ok(after.events.every((e) => !(e.type === 'CANDLE_DISCARDED' && e.symbol === 'SOL' && e.t === SOL_SLOT)), 'non viene nemmeno richiesta');
  assert.equal(cycle.state.positions.SOL, null);
});

test('ingresso deciso troppo tardi (processo fermo): non eseguito', async () => {
  const { clock, source, port } = setup();
  const cycle = new DecisionCycle(cycleConfig(), { source, port });
  await cycle.start();
  clock.now = HOUR_END + 25 * MIN; // ripartenza 25 minuti dopo la chiusura dell'ora
  const r = await cycle.tick(clock.now);
  const open = r.intents.find((i) => i.kind === 'OPEN' && i.symbol === 'SOL');
  assert.ok(open, 'il core decide comunque (stesso stato del backtest)');
  assert.ok(r.events.some((e) => e.type === 'STALE_ENTRY_REJECTED' && e.positionId === open.positionId && e.delayMs === 25 * MIN));
  assert.equal(cycle.state.positions.SOL, null);
  assert.deepEqual(cycle.state.pendingOpens, {}, 'l intento rifiutato non resta pendente');
  assert.equal(port.executed, 0);
});

test('uscita decisa in ritardo: viene eseguita comunque (riduce il rischio)', async () => {
  // SOL aperta alle 01:45; nel golden esce con PROFIT_STOP alla chiusura oraria delle 09:45.
  const exitSlot = Date.parse('2022-01-21T09:45:00Z');
  const { clock, source, port } = setup();
  const cycle = new DecisionCycle(cycleConfig(), { source, port });
  await cycle.start();
  for (let t = HOUR_END + MIN; t < exitSlot; t += 60 * MIN) await cycle.tick((clock.now = t));
  assert.ok(cycle.state.positions.SOL, 'SOL aperta in orario');
  clock.now = exitSlot + 15 * MIN + 25 * MIN;
  const r = await cycle.tick(clock.now);
  const close = r.intents.find((i) => i.kind === 'CLOSE' && i.symbol === 'SOL');
  assert.ok(close && close.kind === 'CLOSE' && close.exitType === 'PROFIT_STOP');
  assert.equal(cycle.state.positions.SOL, null);
  const trade = r.trades.find((t) => t.symbol === 'SOL/USD:USD');
  assert.ok(trade && trade.reason === 'PROFIT_STOP');
  assert.ok(!r.events.some((e) => e.type === 'STALE_ENTRY_REJECTED' && e.positionId === close.positionId));
});

test('intento rifiutato dall exchange: il core lo annulla e lo segnala', async () => {
  const { clock, source } = setup();
  const rejecting: ExecutionPort = {
    protectiveFills: async (): Promise<Fill[]> => [],
    funding: async (): Promise<FundingCharge[]> => [],
    execute: async (intents: readonly Intent[]): Promise<ExecutionReport> => ({ fills: [], rejected: intents.filter((i) => i.kind !== 'UPDATE_STOP').map((i) => ({ positionId: i.positionId, reason: 'insufficient margin' })) }),
  };
  const cycle = new DecisionCycle(cycleConfig(), { source, port: rejecting });
  await cycle.start();
  clock.now = HOUR_END + MIN;
  const r = await cycle.tick(clock.now);
  assert.ok(r.events.some((e) => e.type === 'INTENT_REJECTED' && e.reason === 'insufficient margin'));
  assert.equal(cycle.state.positions.SOL, null);
  assert.deepEqual(cycle.state.pendingOpens, {});
});

test('intento senza esito (ordine in stato sconosciuto): resta pendente nello stato persistito', async () => {
  const { clock, source } = setup();
  const silent: ExecutionPort = {
    protectiveFills: async () => [],
    funding: async () => [],
    execute: async () => ({ fills: [], rejected: [] }),
  };
  const cycle = new DecisionCycle(cycleConfig(), { source, port: silent });
  await cycle.start();
  clock.now = HOUR_END + MIN;
  const r = await cycle.tick(clock.now);
  const open = r.intents.find((i) => i.kind === 'OPEN' && i.symbol === 'SOL');
  assert.ok(open);
  assert.ok(r.events.some((e) => e.type === 'INTENT_PENDING' && e.positionId === open.positionId));
  const persisted = JSON.parse(JSON.stringify(cycle.snapshot()));
  assert.ok(persisted.pendingOpens[open.positionId], 'l intento sopravvive a un riavvio');
});

test('riavvio: il ciclo ricostruisce lo storico dalla fonte e continua con le stesse decisioni', async () => {
  const run = async (restartAt: number | null) => {
    const { clock, source, port } = setup();
    let cycle = new DecisionCycle(cycleConfig(), { source, port });
    await cycle.start();
    const intents: Intent[] = [];
    for (let t = START + 2 * MIN; t < START + 30 * 3_600_000; t += 15 * MIN) {
      clock.now = t;
      intents.push(...(await cycle.tick(t)).intents);
      if (restartAt !== null && t >= restartAt && t < restartAt + 15 * MIN) {
        cycle = new DecisionCycle(cycleConfig(), { source, port }, JSON.parse(JSON.stringify(cycle.snapshot())));
        await cycle.start();
      }
    }
    return { intents, state: cycle.snapshot() };
  };
  const straight = await run(null);
  const restarted = await run(HOUR_END + 5 * 3_600_000);
  assert.ok(straight.intents.length > 5);
  assert.deepEqual(restarted.intents, straight.intents);
  assert.deepEqual(restarted.state, straight.state);
});

test('configurazione e stato non validi vengono rifiutati', () => {
  const { source, port } = setup();
  assert.throws(() => new DecisionCycle(cycleConfig({ startMs: START + 1 }), { source, port }), /allineato/);
  assert.throws(() => new DecisionCycle(cycleConfig({ candleWaitMs: 10 * MIN }), { source, port }), /candleWaitMs/);
  const state = initialCoreState(cycleConfig().core) as unknown as Record<string, unknown>;
  delete state.pendingCloses;
  assert.throws(() => new DecisionCycle(cycleConfig(), { source, port }, state as never), /mancano pendingCloses/);
  const bad = initialCoreState(cycleConfig().core);
  bad.positions.XYZ = null;
  assert.throws(() => new DecisionCycle(cycleConfig(), { source, port }, bad), /XYZ/);
});

test('tick prima di start e start ripetuto sono errori', async () => {
  const { source, port } = setup();
  const cycle = new DecisionCycle(cycleConfig(), { source, port });
  await assert.rejects(() => cycle.tick(START), /non avviato/);
  await cycle.start();
  await assert.rejects(() => cycle.start(), /già avviato/);
});

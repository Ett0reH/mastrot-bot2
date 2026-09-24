// Invariante I3: sugli stessi dati 15m il percorso live (DecisionCycle in replay, con orologio
// simulato, pubblicazione ritardata delle candele, tick irregolari e riavvii) produce le stesse
// decisioni del backtest: stessi intenti, stesso journal, stessi trade, stessa equity.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONSTANT_FUNDING_HOURLY, LEGACY_PROFILE, REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { type BacktestConfig, legacyView, loadBacktestData, runBacktest } from '../../src/engine/backtest/runner';
import { compareParity, DEFAULT_REPLAY_OPTIONS, runReplay } from '../../src/engine/replay/replay';
import { SYNTHETIC_PARITY_WINDOW, syntheticParityData } from '../../src/engine/sim/syntheticMarket';
import { canonicalHash } from '../../src/engine/util/canonical';
import { readGolden } from '../../scripts/golden/legacyGolden';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

const realistic = (w: { symbols: readonly string[]; start: string; end: string }): BacktestConfig => ({
  symbols: [...w.symbols],
  start: w.start,
  end: w.end,
  warmupDays: 50,
  initialEquity: 10000,
  execution: REALISTIC_PROFILE.execution,
  backstop: REALISTIC_PROFILE.backstop,
  funding: { kind: 'constant', hourlyRate: CONSTANT_FUNDING_HOURLY },
  collectJournal: true,
});

test('parità 2022H1 (dati reali, modello realistico + funding): replay live = backtest', async () => {
  const config = realistic(GOLDEN_WINDOWS.find((w) => w.id === '2022H1')!);
  const data = loadBacktestData(config);
  const replay = await runReplay(config, DEFAULT_REPLAY_OPTIONS, data);
  const report = compareParity(runBacktest(config, data), replay);
  assert.ok(report.identical, report.differences.join('\n'));
  assert.ok(replay.restarts >= 10 && replay.trades.length === 52);
  assert.ok(replay.events.some((e) => e.type === 'CANDLE_DISCARDED' && e.reason === 'NOT_CLOSED'), 'la candela in formazione viene offerta e scartata');
  assert.ok(replay.events.some((e) => e.type === 'WAITING_CANDLES'), 'il ciclo ha dovuto aspettare candele non ancora pubblicate');
});

test('parità 2026Q2 con il modello legacy: il percorso live riproduce il golden legacy', async () => {
  const w = GOLDEN_WINDOWS.find((x) => x.id === '2026Q2')!;
  const config: BacktestConfig = { ...realistic(w), execution: LEGACY_PROFILE.execution, backstop: LEGACY_PROFILE.backstop, funding: LEGACY_PROFILE.funding };
  const data = loadBacktestData(config);
  const replay = await runReplay(config, { ...DEFAULT_REPLAY_OPTIONS, seed: 7, restartEveryMs: 2 * 24 * 3_600_000 + 13 * 60_000 }, data);
  const report = compareParity(runBacktest(config, data), replay);
  assert.ok(report.identical, report.differences.join('\n'));
  assert.equal(canonicalHash(replay.trades.map(legacyView)), readGolden(w.id)!.summary.tradesSha256);
});

test('parità su 13 mesi di mercato sintetico (EXTREME, NORMAL, backstop, buchi nei dati, riavvii)', async () => {
  const w = SYNTHETIC_PARITY_WINDOW;
  const config = realistic(w);
  const data = syntheticParityData();
  const replay = await runReplay(config, DEFAULT_REPLAY_OPTIONS, data);
  const backtest = runBacktest(config, data);
  const report = compareParity(backtest, replay);
  assert.ok(report.identical, report.differences.join('\n'));
  assert.ok(Date.parse(w.end) - Date.parse(w.start) >= 365 * 24 * 3_600_000, 'almeno 12 mesi');
  const reasons = new Set(replay.trades.map((t) => t.reason));
  const engines = new Set(replay.trades.map((t) => t.engine));
  assert.ok(replay.trades.length >= 200, `trade: ${replay.trades.length}`);
  for (const r of ['BACKSTOP', 'INVALIDATED_DATA_GAP', 'TRAILING_STOP', 'TRAILING_STOP_LOSS', 'PROFIT_STOP', 'EDGE_DECAY_EXTREME_UNCHANGED'] as const) assert.ok(reasons.has(r), `uscita ${r} esercitata`);
  assert.ok(engines.has('EXTREME') && engines.has('NORMAL'));
  assert.ok(replay.events.some((e) => e.type === 'CANDLE_MISSING'), 'buchi nei dati attraversati dal percorso live');
  assert.ok(replay.restarts >= 40);
});

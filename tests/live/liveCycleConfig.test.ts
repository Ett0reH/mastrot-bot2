// Il ciclo live usa le decisioni della sezione 2 del prompt e la configurazione validata.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/engine/config/config';
import { LIVE_CYCLE_DEFAULTS } from '../../src/engine/live/decisionCycle';
import { coreConfigFromEngine, liveCycleConfig } from '../../src/engine/live/liveCycleConfig';

test('default (shadow): universo del backtest, equity = cap, backstop 3%, matrice vuota', () => {
  const { config } = loadConfig({});
  const core = coreConfigFromEngine(config);
  assert.deepEqual(core.symbols, ['BTC', 'ETH', 'SOL', 'AVAX', 'XRP', 'DOGE', 'LINK', 'ADA']);
  assert.equal(core.initialEquity, 1000);
  assert.deepEqual(core.backstop, { model: 'close_based_plus_native_backstop', bufferPct: 3 });
  assert.deepEqual(core.expectancyMatrix, {});
  assert.equal(core.feeRate, 0.0005);
});

test('STOP_MODEL, BACKSTOP_BUFFER_PCT e CAPITAL_CAP_USD dalla configurazione', () => {
  const { config } = loadConfig({ STOP_MODEL: 'native_intrabar', BACKSTOP_BUFFER_PCT: '2', CAPITAL_CAP_USD: '500' });
  const core = coreConfigFromEngine(config);
  assert.deepEqual(core.backstop, { model: 'native_intrabar', bufferPct: 2 });
  assert.equal(core.initialEquity, 500);
});

test('ciclo live: 50 giorni di storico, attesa candele < ritardo massimo degli ingressi', () => {
  const start = Date.UTC(2026, 8, 24, 12, 0);
  const cycle = liveCycleConfig(loadConfig({}).config, start);
  assert.equal(cycle.startMs, start);
  assert.equal(cycle.warmupMs, 50 * 24 * 3_600_000);
  assert.ok(cycle.candleWaitMs < cycle.maxEntryDelayMs);
  assert.deepEqual({ ...LIVE_CYCLE_DEFAULTS }, { warmupMs: cycle.warmupMs, candleWaitMs: cycle.candleWaitMs, maxEntryDelayMs: cycle.maxEntryDelayMs });
  assert.equal(cycle.finalSlot, undefined, 'nessuna chiusura END_OF_DATA nel live');
});

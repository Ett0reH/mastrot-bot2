// F2 Fase A: il DecisionCore, con il modello di esecuzione legacy, riproduce il golden
// del backtest legacy bit per bit (stessi trade in ogni campo, stessa equity finale).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyView, runBacktest } from '../../src/engine/backtest/runner';
import { LEGACY_EXECUTION } from '../../src/engine/sim/simExchange';
import { canonicalHash } from '../../src/engine/util/canonical';
import { firstDifference, readGolden } from '../../scripts/golden/legacyGolden';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

for (const window of GOLDEN_WINDOWS) {
  test(`DecisionCore riproduce il golden ${window.id}`, () => {
    const golden = readGolden(window.id)!;
    const result = runBacktest({
      symbols: window.symbols,
      start: window.start,
      end: window.end,
      warmupDays: 50,
      initialEquity: 10000,
      execution: LEGACY_EXECUTION,
      backstop: { model: 'none', bufferPct: 0 },
      funding: { kind: 'none' },
    });
    const trades = result.trades.map(legacyView);
    assert.equal(canonicalHash(trades), golden.summary.tradesSha256, firstDifference(golden.trades, trades));
    assert.equal(result.finalEquity, golden.summary.finalEquity);
  });
}

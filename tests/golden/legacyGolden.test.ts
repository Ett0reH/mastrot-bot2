// Golden backtest del codice legacy (sostituisce i vecchi test "costs-and-slippage",
// "symbol-comparability" e "no-lookahead", che non potevano fallire).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalStringify } from '../../src/engine/util/canonical';
import { firstDifference, readGolden } from '../../scripts/golden/legacyGolden';
import { runLegacyBacktest } from '../../scripts/golden/legacyRunner';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

const FEE_RATE = 0.0005;

for (const window of GOLDEN_WINDOWS) {
  test(`golden ${window.id}: il backtest legacy produce esattamente i trade del golden`, () => {
    const golden = readGolden(window.id);
    assert.ok(golden, `golden mancante per ${window.id}`);
    const result = runLegacyBacktest(window);
    assert.equal(result.tradesSha256, golden.summary.tradesSha256, firstDifference(golden.trades, result.trades));
    assert.equal(result.finalEquity, golden.summary.finalEquity);
  });
}

test('golden: ogni trade paga la fee 0,05% su ingresso e uscita (nozionale)', () => {
  for (const window of GOLDEN_WINDOWS) {
    const golden = readGolden(window.id)!;
    for (const t of golden.trades as any[]) {
      assert.equal(t.isHarvestExecuted, false);
      const entry = t.size * t.entryPrice;
      const exit = t.size * t.exitPrice;
      const expected = t.type === 'LONG' ? exit - exit * FEE_RATE - (entry + entry * FEE_RATE) : entry - entry * FEE_RATE - (exit + exit * FEE_RATE);
      assert.ok(Math.abs(expected - t.pnl) < 1e-9, `${t.symbol} ${t.entryTime}: pnl ${t.pnl} ≠ ${expected}`);
    }
  }
});

test('golden 2022H1: i trade coincidono con quelli del report di riferimento nello stesso periodo', () => {
  // I dati 2022 recuperati sono il prefisso esatto dei dati del run di riferimento: ogni trade
  // chiuso prima della fine della finestra deve essere identico in tutti i campi.
  const window = GOLDEN_WINDOWS.find((w) => w.id === '2022H1')!;
  const golden = readGolden(window.id)!;
  const reference = (JSON.parse(readFileSync('backtest_report_latest.json', 'utf8')) as { trades: any[] }).trades;
  const endIso = new Date(window.end).toISOString();
  const refInWindow = reference.filter((t) => t.exitTime < endIso);
  const goldenClosed = golden.trades.filter((t: any) => t.reason !== 'END_OF_DATA');
  assert.ok(refInWindow.length >= 50);
  assert.equal(goldenClosed.length, refInWindow.length);
  for (let i = 0; i < refInWindow.length; i++) {
    assert.equal(canonicalStringify(goldenClosed[i]), canonicalStringify(refInWindow[i]), `trade #${i} diverso dal riferimento`);
  }
});

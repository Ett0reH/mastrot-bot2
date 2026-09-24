// Golden del nuovo motore con il modello di esecuzione realistico (F2 Fase B).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { firstDifference } from '../../scripts/golden/legacyGolden';
import { readEngineGolden, runEngineGolden } from '../../scripts/golden/engineGolden';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

for (const window of GOLDEN_WINDOWS) {
  test(`golden del motore ${window.id}: il profilo realistico produce esattamente i trade del golden`, () => {
    const golden = readEngineGolden(window.id);
    assert.ok(golden, `golden del motore mancante per ${window.id}`);
    const { summary, trades } = runEngineGolden(window);
    assert.equal(summary.tradesSha256, golden.summary.tradesSha256, firstDifference(golden.trades, trades as unknown as Record<string, unknown>[]));
    assert.equal(summary.finalEquity, golden.summary.finalEquity);
    assert.deepEqual(summary.datasetChunks, golden.summary.datasetChunks, 'golden calcolato sugli stessi chunk del dataset');
  });
}

test('golden del motore: ogni trade ha fee su ingresso e uscita e le uscite BACKSTOP sono oltre lo stop', () => {
  for (const window of GOLDEN_WINDOWS) {
    const golden = readEngineGolden(window.id)!;
    for (const t of golden.trades as any[]) {
      assert.ok(t.costs.entryFee > 0 && t.costs.exitFee > 0, `${t.symbol} ${t.entryTime}: fee`);
      assert.ok(Math.abs(t.costs.entryFee - t.size * t.entryPrice * 0.0005) < 1e-9);
      assert.ok(Math.abs(t.costs.exitFee - t.size * t.exitPrice * 0.0005) < 1e-9);
      if (t.reason === 'BACKSTOP') assert.ok(t.pnl < 0, 'un backstop chiude sempre in perdita');
    }
  }
});

test('I15/D07: il nuovo motore dà lo stesso golden con qualsiasi fuso del processo', () => {
  for (const tz of ['Europe/Rome', 'Asia/Kolkata']) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/golden/engineGolden.ts', 'check', '--window', '2026Q2'], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(child.status, 0, `TZ=${tz}: ${child.stdout}${child.stderr}`);
    assert.match(child.stdout, /identico al golden/);
  }
});

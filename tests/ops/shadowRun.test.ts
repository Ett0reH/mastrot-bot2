// Valutazione del periodo di shadow dai report giornalieri (gate F7).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DailyReport } from '../../src/engine/ops/dailyReport';
import { evaluateShadowRun, formatShadowRun } from '../../src/engine/ops/shadowRun';

function report(day: string, status: string, unexplained = 0, explained = 0): DailyReport {
  return { day, pnl: { trades: 2 }, issues: [], parity: { status, unexplained, explained, compared: { decisions: 200, trades: 2 } } } as unknown as DailyReport;
}

test('3 giorni completi, identici o spiegati: superato (72 ore)', () => {
  const e = evaluateShadowRun([report('2026-09-21', 'IDENTICAL'), report('2026-09-22', 'EXPLAINED', 0, 2), report('2026-09-23', 'IDENTICAL'), report('2026-09-20', 'DIVERGENT', 5)], '2026-09-21', '2026-09-23');
  assert.equal(e.ok, true, e.problems.join('; '));
  assert.equal(e.hours, 72);
  assert.match(formatShadowRun(e), /OK \(72 ore con report\)/);
});

test('un giorno senza report, un confronto non disponibile o una divergenza non spiegata: non superato', () => {
  const missing = evaluateShadowRun([report('2026-09-21', 'IDENTICAL'), report('2026-09-23', 'IDENTICAL')], '2026-09-21', '2026-09-23');
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingDays, ['2026-09-22']);
  const na = evaluateShadowRun([report('2026-09-21', 'NOT_AVAILABLE')], '2026-09-21', '2026-09-21');
  assert.equal(na.ok, false);
  assert.match(na.problems[0], /non disponibile/);
  const div = evaluateShadowRun([report('2026-09-21', 'DIVERGENT', 1)], '2026-09-21', '2026-09-21');
  assert.equal(div.ok, false);
  assert.match(formatShadowRun(div), /NON SUPERATO[\s\S]*1 divergenze non spiegate/);
});

test('nessun report nel periodo: non superato', () => {
  assert.equal(evaluateShadowRun([], '2026-09-21', '2026-09-23').ok, false);
});

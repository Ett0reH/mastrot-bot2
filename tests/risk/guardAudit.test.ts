// Principio della sezione 2 (F5): i guardrail non devono scattare nel golden backtest. L'audit
// gira il golden con equity iniziale = CAPITAL_CAP_USD e i limiti di default, e conta ogni limite
// che sarebbe scattato. Unica eccezione, riportata nel report F5 come decisione per l'utente: il
// 22/01/2022 la perdita giornaliera arriva al 5,18% (limite 5%) dopo l'ultimo ingresso del giorno,
// quindi il blocco non ferma nessun ingresso e i trade del golden non cambiano.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { DEFAULT_LIMITS } from '../../src/engine/config/config';
import { auditGuardrails } from '../../src/engine/risk/guardAudit';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

const base = { warmupDays: 50, initialEquity: DEFAULT_LIMITS.capitalCapUsd, execution: REALISTIC_PROFILE.execution, backstop: REALISTIC_PROFILE.backstop, funding: { kind: 'none' as const } };

for (const w of GOLDEN_WINDOWS) {
  test(`golden ${w.id}: nessun ingresso respinto dai limiti di default, niente REDUCE_ONLY`, () => {
    const a = auditGuardrails({ ...base, symbols: w.symbols, start: w.start, end: w.end }, DEFAULT_LIMITS);
    assert.ok(a.entries > 0);
    assert.deepEqual(a.blocked, [], JSON.stringify(a.examples));
    assert.ok(Object.values(a.violations).every((n) => n === 0));
    assert.equal(a.drawdownBreached, false, `drawdown max ${a.maxDrawdownPct}%`);
    assert.ok(a.maxOpenPositions <= DEFAULT_LIMITS.maxOpenPositions);
    assert.ok(a.maxLeverage <= DEFAULT_LIMITS.maxLeverage);
    assert.ok(a.maxNotional < DEFAULT_LIMITS.maxPositionNotionalUsd);
    // Perdita giornaliera: l'unico superamento noto (vedi intestazione), senza effetti sui trade.
    assert.deepEqual(a.breachDays, w.id === '2022H1' ? ['2022-01-22'] : []);
  });
}

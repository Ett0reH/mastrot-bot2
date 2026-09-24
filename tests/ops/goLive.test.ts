// Criteri misurabili di GO_LIVE_CHECKLIST.md valutati dai report giornalieri della demo (F8).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DailyReport } from '../../src/engine/ops/dailyReport';
import { evaluateGoLive, formatGoLive } from '../../src/engine/ops/goLive';

const FROM = '2026-09-01';
const TO = '2026-09-14';

function day(i: number): string {
  return new Date(Date.parse(`${FROM}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
}

/** Giorno di demo regolare: confronto identico, 1 campione di slippage a 3 bps, nessun alert. */
function report(d: string, over: { mode?: string; status?: string; unexplained?: number; byCode?: Record<string, number>; slip?: { samples: number; avgBps: number | null }; critical?: number; issues?: string[] } = {}): DailyReport {
  const slip = over.slip ?? { samples: 1, avgBps: 3 };
  return {
    day: d,
    mode: over.mode ?? 'demo',
    pnl: { realized: 0, trades: 1, wins: 1, losses: 0 },
    slippage: { modelBps: 5, strategy: { ...slip, maxBps: slip.avgBps, withinModel: slip.avgBps === null ? null : slip.avgBps <= 5 }, stops: { samples: 0, avgBps: null, maxBps: null }, worst: null },
    entries: { decided: 1, sent: 1, filled: 1, partial: 0, unfilled: 0, rejectedByGuard: 0, stale: 0, blocked: 0, pending: 0, fillRatePct: 100 },
    parity: { status: over.status ?? 'IDENTICAL', reason: null, mode: 'actual_fills', fromSlot: null, toSlot: null, compared: { decisions: 190, trades: 1 }, explained: 0, unexplained: over.unexplained ?? 0, divergences: [] },
    alerts: { total: 0, critical: over.critical ?? 0, warning: 0, byCode: over.byCode ?? {} },
    issues: over.issues ?? [],
  } as unknown as DailyReport;
}

function clean(): DailyReport[] {
  return Array.from({ length: 14 }, (_, i) => report(day(i)));
}

function criterion(e: ReturnType<typeof evaluateGoLive>, id: string) {
  const c = e.criteria.find((x) => x.id === id);
  assert.ok(c, `criterio ${id}`);
  return c;
}

test('14 giorni di demo regolari: tutti i criteri misurabili superati', () => {
  const e = evaluateGoLive(clean(), FROM, TO);
  assert.equal(e.ok, true, formatGoLive(e));
  assert.deepEqual(e.criteria.map((c) => c.id), ['days', 'protection', 'desync', 'parity', 'slippage']);
  assert.match(formatGoLive(e), /SUPERATI/);
});

test('meno di 14 giorni, un giorno mancante o un giorno non in demo: criterio dei giorni non superato', () => {
  const short = evaluateGoLive(clean().slice(0, 13), FROM, day(12));
  assert.equal(criterion(short, 'days').ok, false);
  const gap = evaluateGoLive(clean().filter((r) => r.day !== day(5)), FROM, TO);
  assert.equal(criterion(gap, 'days').ok, false);
  assert.match(criterion(gap, 'days').detail, new RegExp(day(5)));
  const shadow = clean();
  shadow[3] = report(day(3), { mode: 'shadow' });
  assert.equal(criterion(evaluateGoLive(shadow, FROM, TO), 'days').ok, false);
});

test('uno stop mancante o una chiusura d emergenza in un giorno qualsiasi: posizioni senza stop, non superato', () => {
  for (const code of ['STOP_MISSING', 'STOP_PLACEMENT_FAILED', 'EMERGENCY_CLOSE', 'PROTECTION_FAILING', 'HEARTBEAT_MISSING']) {
    const reports = clean();
    reports[9] = report(day(9), { byCode: { [code]: 1, ENTRY: 2 } });
    const c = criterion(evaluateGoLive(reports, FROM, TO), 'protection');
    assert.equal(c.ok, false, code);
    assert.match(c.detail, new RegExp(`${day(9)}.*${code}`));
  }
});

test('desync, posizione o ordine sconosciuto su Kraken: non superato', () => {
  for (const code of ['DESYNC', 'UNKNOWN_POSITION', 'UNKNOWN_ORDER']) {
    const reports = clean();
    reports[2] = report(day(2), { byCode: { [code]: 2 } });
    assert.equal(criterion(evaluateGoLive(reports, FROM, TO), 'desync').ok, false, code);
  }
});

test('parità: una divergenza non spiegata o un confronto non disponibile bastano a non superare', () => {
  const divergent = clean();
  divergent[7] = report(day(7), { status: 'DIVERGENT', unexplained: 1 });
  assert.equal(criterion(evaluateGoLive(divergent, FROM, TO), 'parity').ok, false);
  const na = clean();
  na[0] = report(day(0), { status: 'NOT_AVAILABLE' });
  assert.equal(criterion(evaluateGoLive(na, FROM, TO), 'parity').ok, false);
  const explained = clean();
  explained[4] = report(day(4), { status: 'EXPLAINED' });
  assert.equal(criterion(evaluateGoLive(explained, FROM, TO), 'parity').ok, true, 'differenze spiegate da candele mancanti: ammesse');
});

test('slippage: media pesata sui campioni di tutto il periodo contro il modello (5 bps)', () => {
  const over = clean().map((r, i) => report(r.day, { slip: i === 0 ? { samples: 4, avgBps: 12 } : { samples: 0, avgBps: null } }));
  over[1] = report(day(1), { slip: { samples: 1, avgBps: 2 } });
  const c = criterion(evaluateGoLive(over, FROM, TO), 'slippage');
  assert.equal(c.ok, false);
  assert.match(c.detail, /10 bps/, '(4×12 + 1×2) / 5 = 10');
  const fine = clean().map((r, i) => report(r.day, { slip: i === 0 ? { samples: 1, avgBps: 6 } : i === 1 ? { samples: 9, avgBps: 4 } : { samples: 0, avgBps: null } }));
  assert.equal(criterion(evaluateGoLive(fine, FROM, TO), 'slippage').ok, true, 'un giorno sopra il modello, la media del periodo sotto: (6 + 36) / 10 = 4,2');
  const none = clean().map((r) => report(r.day, { slip: { samples: 0, avgBps: null } }));
  const empty = criterion(evaluateGoLive(none, FROM, TO), 'slippage');
  assert.equal(empty.ok, false, 'senza trade il criterio non si può verificare');
  assert.match(empty.detail, /nessun/);
});

test('alert critici e punti da verificare fuori dai criteri: elencati da rivedere, non bloccano', () => {
  const reports = clean();
  reports[6] = report(day(6), { byCode: { RISK_LIMIT: 1 }, critical: 1, issues: ['funding reale di Kraken -0.12 $ (non ancora nel PnL del bot)'] });
  const e = evaluateGoLive(reports, FROM, TO);
  assert.equal(e.ok, true);
  assert.ok(e.review.some((r) => r.includes(day(6)) && r.includes('RISK_LIMIT')));
  assert.ok(e.review.some((r) => r.includes('funding')));
});

// Report giornaliero (F6): slippage rispetto al modello, fill rate, fee e funding contro il ledger,
// equity del giorno, divergenze e alert. Casi calcolati a mano.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TradeRecord } from '../../src/engine/core/types';
import type { LedgerEntry } from '../../src/engine/exchange/accountLedger';
import type { ExecutedFill } from '../../src/engine/live/decisionCycle';
import { makeAlert } from '../../src/engine/ops/alerts';
import { buildDailyReport, slippageBps, summarizeReport } from '../../src/engine/ops/dailyReport';
import { notAvailable, type ParityResult } from '../../src/engine/ops/dayParity';
import { type DayStats, emptyDay, type EntryOutcome } from '../../src/engine/ops/dayTracker';

const DAY = '2026-09-24';
const T = Date.parse(`${DAY}T10:00:00Z`);

function fill(p: Partial<ExecutedFill>): ExecutedFill {
  return { kind: 'OPEN', symbol: 'SOL', positionId: 'SOL-x', price: 100, size: 1, fee: 0.05, time: T, source: 'exchange', side: 'buy', referencePrice: 100, appliedAtSlot: T, phase: 'execute', ...p };
}

function entry(positionId: string, status: EntryOutcome['status']): EntryOutcome {
  return { positionId, symbol: 'SOL', slotTime: T, requestedSize: 1, referencePrice: 100, filledSize: status === 'FILLED' ? 1 : status === 'PARTIAL' ? 0.4 : 0, status, reason: null };
}

function ledger(kind: LedgerEntry['kind'], p: Partial<LedgerEntry>): LedgerEntry {
  return { id: 1, kind, date: `${DAY}T10:00:00.000Z`, info: kind, asset: 'usd', contract: null, fee: null, realizedPnl: null, realizedFunding: null, balanceChange: 0, execution: null, ...p };
}

test('slippage in punti base, positivo quando è sfavorevole (acquisto più caro, vendita più cara)', () => {
  assert.equal(slippageBps('buy', 100, 101), 100);
  assert.equal(slippageBps('sell', 100, 99), 100);
  assert.equal(slippageBps('buy', 100, 99.5), -50);
});

function stats(): DayStats {
  const s = emptyDay(DAY);
  s.fills.push(fill({ price: 100.05, fee: 0.05 })); // 5 bps
  s.fills.push(fill({ kind: 'CLOSE', side: 'sell', price: 99.9, referencePrice: 100, fee: 0.04995, positionId: 'ETH-x', symbol: 'ETH' })); // 10 bps
  s.fills.push(fill({ kind: 'CLOSE', side: 'sell', price: 97, referencePrice: null, fee: 0.0485, phase: 'external', positionId: 'XRP-x', symbol: 'XRP' })); // kill switch: fuori dal modello
  for (const [id, st] of [['a', 'FILLED'], ['b', 'PARTIAL'], ['c', 'UNFILLED'], ['d', 'REJECTED_GUARD'], ['e', 'STALE'], ['f', 'PENDING']] as const) s.entries[id] = entry(id, st);
  return s;
}

const parityDivergent: ParityResult = { ...notAvailable('', 'actual_fills'), status: 'DIVERGENT', reason: null, unexplained: 2, explained: 1 };

test('report: slippage oltre il modello, fill rate, fee e funding contro Kraken, equity, alert, problemi', () => {
  const r = buildDailyReport({
    day: DAY,
    mode: 'demo',
    generatedAt: `${DAY}T23:59:00Z`,
    stats: stats(),
    trades: [{ pnl: 12 } as TradeRecord, { pnl: -4 } as TradeRecord],
    equity: [
      { t: T - 11 * 3_600_000, equity: 1000 },
      { t: T, equity: 1010 },
      { t: T + 3_600_000, equity: 990 },
      { t: T + 2 * 3_600_000, equity: 1005 },
    ],
    ledger: [ledger('trade', { fee: 0.05 }), ledger('trade', { fee: 0.05 }), ledger('trade', { fee: 0.0485 }), ledger('funding', { realizedFunding: -0.3 })],
    modelSlippageBps: 5,
    parity: parityDivergent,
    alerts: [makeAlert(T, 'critical', 'STOP_MISSING', 'x'), makeAlert(T, 'info', 'ENTRY', 'y'), makeAlert(T, 'info', 'ENTRY', 'z')],
  });
  assert.equal(r.slippage.strategy.samples, 2, 'il fill del kill switch non ha un riferimento del modello');
  assert.equal(r.slippage.strategy.avgBps, 7.5);
  assert.equal(r.slippage.strategy.maxBps, 10);
  assert.equal(r.slippage.worst?.symbol, 'ETH');
  assert.equal(r.slippage.strategy.withinModel, false);
  assert.equal(r.slippage.stops.samples, 0);
  assert.deepEqual(
    { ...r.entries },
    { decided: 6, sent: 4, filled: 1, partial: 1, unfilled: 1, rejectedByGuard: 1, stale: 1, blocked: 0, pending: 1, fillRatePct: 50 },
  );
  assert.equal(r.fees.bot, 0.14845);
  assert.equal(r.fees.ledger, 0.1485);
  assert.equal(r.fees.diff, -0.00005);
  assert.equal(r.funding.ledger, -0.3);
  assert.deepEqual(r.pnl, { realized: 8, trades: 2, wins: 1, losses: 1 });
  assert.deepEqual(r.equity, { start: 1000, end: 1005, change: 5, changePct: 0.5, maxDrawdownPct: 1.9802 }); // (1010 − 990) / 1010, 4 decimali
  assert.deepEqual(r.alerts, { total: 3, critical: 1, warning: 0, byCode: { STOP_MISSING: 1, ENTRY: 2 } });
  for (const pattern of [/slippage medio 7.5 bps oltre il modello/, /1 ingressi inviati e non eseguiti/, /1 ingressi eseguiti solo in parte/, /funding reale di Kraken -0.30/, /2 divergenze non spiegate/, /1 alert critici/, /1 ingressi scartati/]) {
    assert.ok(r.issues.some((i) => pattern.test(i)), `${pattern}: ${r.issues.join(' | ')}`);
  }
  assert.ok(!r.issues.some((i) => /fee del bot/.test(i)), 'fee coerenti con Kraken: nessun problema');
  const text = summarizeReport(r);
  assert.match(text, /Report 2026-09-24 \(demo\): equity \+5.00 \$, 2 trade chiusi \(8.00 \$\)/);
  assert.match(text, /fill rate 50%/);
  assert.match(text, /parità col backtest: 2 divergenze non spiegate/);
});

test('stop nativi: slippage dal livello dello stop riportato a parte, senza giudizio sul modello (gap)', () => {
  const s = emptyDay(DAY);
  s.fills.push(fill({ kind: 'CLOSE', side: 'sell', exitType: 'BACKSTOP', referencePrice: 100, price: 98 })); // gap: 200 bps
  s.fills.push(fill({ price: 100.03 })); // 3 bps
  const r = buildDailyReport({ day: DAY, mode: 'live', generatedAt: 'x', stats: s, trades: [], equity: [], ledger: [], modelSlippageBps: 5, parity: null, alerts: [] });
  assert.deepEqual(r.slippage.stops, { samples: 1, avgBps: 200, maxBps: 200 });
  assert.equal(r.slippage.strategy.avgBps, 3);
  assert.equal(r.slippage.strategy.withinModel, true);
  assert.ok(!r.issues.some((i) => /slippage/.test(i)));
});

test('fee del bot diverse da quelle di Kraken oltre la tolleranza: segnalate', () => {
  const s = emptyDay(DAY);
  s.fills.push(fill({ fee: 5 }));
  const r = buildDailyReport({ day: DAY, mode: 'live', generatedAt: 'x', stats: s, trades: [], equity: [], ledger: [ledger('trade', { fee: 3 })], modelSlippageBps: 5, parity: null, alerts: [] });
  assert.equal(r.fees.diff, 2);
  assert.ok(r.issues.some((i) => /fee del bot \(5.00 \$\) diverse da quelle di Kraken \(3.00 \$\)/.test(i)));
});

test('giornata regolare in shadow: nessun problema, slippage uguale al modello, nessun ledger', () => {
  const s = emptyDay(DAY);
  s.fills.push(fill({ price: 100.05, source: 'sim' }));
  s.entries.a = entry('a', 'FILLED');
  const identical: ParityResult = { ...notAvailable('', 'simulated'), status: 'IDENTICAL', reason: null };
  const r = buildDailyReport({ day: DAY, mode: 'shadow', generatedAt: 'x', stats: s, trades: [], equity: [{ t: T, equity: 1000 }], ledger: null, modelSlippageBps: 5, parity: identical, alerts: [] });
  assert.equal(r.slippage.strategy.withinModel, true);
  assert.equal(r.fees.ledger, null);
  assert.equal(r.entries.fillRatePct, 100);
  assert.deepEqual(r.issues, []);
});

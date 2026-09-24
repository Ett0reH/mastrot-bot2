// Confronto del giorno tra il bot e il replay del backtest (F6): quando è identico, spiegato o divergente.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecisionRecord, TradeRecord } from '../../src/engine/core/types';
import { compareDay } from '../../src/engine/ops/dayParity';

const S = Date.parse('2026-09-24T00:45:00Z');
const H = 3_600_000;

function rec(slot: number, symbol: string, action: DecisionRecord['action'], reason = 'x'): DecisionRecord {
  return { slotTime: slot, symbol, action, reason };
}

const journal = [rec(S, 'BTC', 'NO_SIGNAL'), rec(S, 'SOL', 'OPEN', 'RSI'), rec(S + H, 'BTC', 'NO_SIGNAL'), rec(S + H, 'SOL', 'HOLD', 'stop 95')];

test('stesse decisioni: IDENTICAL; i record REJECTED del runtime non entrano nel confronto', () => {
  const r = compareDay({ mode: 'simulated', fromSlot: S, toSlot: S + H, actualJournal: [...journal, rec(S, 'XRP', 'REJECTED', 'guard')], replayJournal: journal, missing: [] });
  assert.equal(r.status, 'IDENTICAL');
  assert.equal(r.compared.decisions, 4);
  assert.deepEqual(r.divergences, []);
});

test('decisione diversa su una candela mancante al momento della decisione: EXPLAINED', () => {
  const actual = [journal[0], rec(S, 'SOL', 'NO_DATA', 'candela mancante'), journal[2]];
  const replay = [journal[0], journal[1], journal[2]];
  const r = compareDay({ mode: 'simulated', fromSlot: S, toSlot: S + H, actualJournal: actual, replayJournal: replay, missing: [`${S}|SOL`] });
  assert.equal(r.status, 'EXPLAINED');
  assert.equal(r.explained, 1);
  assert.equal(r.divergences[0].symbol, 'SOL');
  assert.match(r.divergences[0].explanation ?? '', /candela non disponibile/);
});

test('candela mancante nei giorni precedenti (del simbolo o di BTC): divergenza spiegata dallo storico diverso', () => {
  const actual = [rec(S, 'SOL', 'NO_SIGNAL', 'Nessun setup')];
  const replay = [rec(S, 'SOL', 'OPEN', 'RSI')];
  const base = { mode: 'actual_fills' as const, fromSlot: S, toSlot: S, actualJournal: actual, replayJournal: replay, missing: [], btcSymbol: 'BTC' };
  assert.equal(compareDay({ ...base, recentMissing: [`${S - 30 * H}|SOL`] }).status, 'EXPLAINED');
  assert.equal(compareDay({ ...base, recentMissing: [`${S - 30 * H}|BTC`] }).status, 'EXPLAINED', 'il regime di BTC vale per tutti i simboli');
  assert.equal(compareDay({ ...base, recentMissing: [`${S - 30 * H}|XRP`] }).status, 'DIVERGENT', 'un altro simbolo non spiega nulla');
  assert.equal(compareDay({ ...base, recentMissing: [`${S + H}|SOL`] }).status, 'DIVERGENT', 'una candela mancante dopo la decisione non la spiega');
});

test('decisione diversa senza spiegazione: DIVERGENT, con il dettaglio di entrambe le parti', () => {
  const actual = [journal[0], rec(S, 'SOL', 'NO_SIGNAL', 'RSI 25')];
  const replay = [journal[0], journal[1]];
  const r = compareDay({ mode: 'actual_fills', fromSlot: S, toSlot: S, actualJournal: actual, replayJournal: replay, missing: [] });
  assert.equal(r.status, 'DIVERGENT');
  assert.equal(r.unexplained, 1);
  assert.deepEqual([r.divergences[0].actual, r.divergences[0].replay], ['NO_SIGNAL: RSI 25', 'OPEN: RSI']);
});

test('fuori dall intervallo del replay non si confronta; in shadow si confrontano anche i trade', () => {
  const t = (exitPrice: number) => ({ symbol: 'SOL/USD:USD', entryTime: 'e', exitTime: '2026-09-24T05:00:00.000Z', type: 'LONG', entryPrice: 100, exitPrice, reason: 'TRAILING_STOP_LOSS', size: 1, pnl: exitPrice - 100 }) as TradeRecord;
  const r = compareDay({ mode: 'simulated', fromSlot: S + H, toSlot: S + H, actualJournal: journal, replayJournal: journal.slice(2), actualTrades: [t(105)], replayTrades: [t(104)], missing: [] });
  assert.equal(r.compared.decisions, 2);
  assert.equal(r.status, 'DIVERGENT');
  assert.equal(r.divergences[0].kind, 'trade');
  assert.match(r.divergences[0].actual ?? '', /→ 105/);
});

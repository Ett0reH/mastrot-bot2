import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyView, runBacktest } from '../../src/engine/backtest/runner';
import { DecisionCore } from '../../src/engine/core/decisionCore';
import type { CloseIntent, CorePosition } from '../../src/engine/core/types';
import { BAR_15M_MS, type Candle } from '../../src/engine/data/dataset';
import { LEGACY_EXECUTION } from '../../src/engine/sim/simExchange';
import { canonicalHash } from '../../src/engine/util/canonical';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

const T0 = Date.UTC(2024, 0, 1);
const NORMAL_OPEN_AT = '2022-01-02T23:15:00.000Z'; // AVAX NORMAL aperta dalle 19:45 alle 03:45
const flat = (i: number): Candle => ({ t: T0 + i * BAR_15M_MS, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 });

/** Core con BTC riscaldato (≥ 250 candele 4H) su un mercato piatto, senza segnali. */
function warmCore(): { core: DecisionCore; nextSlot: number } {
  const core = new DecisionCore({ symbols: ['BTC'], initialEquity: 10000, feeRate: 0.0005, backstop: { model: 'close_based_plus_native_backstop', bufferPct: 3 } });
  const slots = 250 * 16 + 8;
  for (let i = 0; i < slots; i++) core.processSlot(T0 + i * BAR_15M_MS, { BTC: flat(i) });
  return { core, nextSlot: slots };
}

function normalLong(overrides: Partial<CorePosition['trade']> = {}): CorePosition {
  return {
    id: 'BTC-test',
    symbol: 'BTC',
    entryTime: new Date(T0).toISOString(),
    entrySlot: T0,
    trade: {
      id: new Date(T0).toISOString(), symbol: 'BTC/USD:USD', direction: 'LONG', entryPrice: 90, size: 1, leverage: 2,
      stopLoss: 101, initialStopLoss: 88, currentStopLoss: 101, catastropheStopLoss: 80, highWaterMark: 103, lowWaterMark: 90,
      barsHeld: 3, entryRegime: 'BULL', setup: 'RSI2_TREND_TRAILING', engine: 'NORMAL', ...overrides,
    },
    entryFee: 90 * 0.0005,
    fundingPaid: 0,
    tierLabel: 'NORMAL_5',
    isChopEntry: false,
    isReducedLeverageAction: false,
    quality: 0.9,
    backstop: null,
  };
}

/** Avanza fino alla prossima chiusura oraria e restituisce gli intenti. */
function toNextHourClose(core: DecisionCore, from: number) {
  let i = from;
  for (;;) {
    const res = core.processSlot(T0 + i * BAR_15M_MS, { BTC: flat(i) });
    i++;
    if (res.hourClose) return { res, next: i };
  }
}

test('processSlot rifiuta slot già elaborati', () => {
  const core = new DecisionCore({ symbols: ['BTC'], initialEquity: 10000, feeRate: 0.0005, backstop: { model: 'none', bufferPct: 0 } });
  core.processSlot(T0, { BTC: flat(0) });
  assert.throws(() => core.processSlot(T0, { BTC: flat(0) }), /già elaborato/);
});

test('backstop: sotto lo stop per i LONG, sopra per gli SHORT; con native_intrabar coincide con lo stop', () => {
  const core = new DecisionCore({ symbols: ['BTC'], initialEquity: 10000, feeRate: 0.0005, backstop: { model: 'close_based_plus_native_backstop', bufferPct: 3 } });
  assert.equal(core.backstopLevel('LONG', 100), 97);
  assert.equal(core.backstopLevel('SHORT', 100), 103);
  const intrabar = new DecisionCore({ symbols: ['BTC'], initialEquity: 10000, feeRate: 0.0005, backstop: { model: 'native_intrabar', bufferPct: 3 } });
  assert.equal(intrabar.backstopLevel('LONG', 100), 100);
  const none = new DecisionCore({ symbols: ['BTC'], initialEquity: 10000, feeRate: 0.0005, backstop: { model: 'none', bufferPct: 0 } });
  assert.equal(none.backstopLevel('LONG', 100), null);
});

test('una posizione aperta riceve UPDATE_STOP con il backstop a ogni chiusura oraria', () => {
  const { core, nextSlot } = warmCore();
  core.state.positions.BTC = normalLong({ currentStopLoss: 95, highWaterMark: 90 });
  const { res } = toNextHourClose(core, nextSlot);
  const update = res.intents.find((i) => i.kind === 'UPDATE_STOP');
  assert.ok(update && update.kind === 'UPDATE_STOP');
  assert.equal(update.strategyStop, 98); // trailing 2% dal massimo (100)
  assert.equal(update.backstop, 98 * 0.97);
});

test('chiusura: statistiche NORMAL e cooldown aggiornati alla decisione, poi riconciliati col fill reale', () => {
  const { core, nextSlot } = warmCore();
  core.state.positions.BTC = normalLong();
  const { res } = toNextHourClose(core, nextSlot);
  const close = res.intents.find((i): i is CloseIntent => i.kind === 'CLOSE');
  assert.ok(close);
  assert.equal(close.exitType, 'TRAILING_STOP');
  const provisional = 100 - 100 * 0.0005 - (90 + 90 * 0.0005);
  assert.ok(Math.abs(core.state.normalClean.grossProfit - provisional) < 1e-12);
  assert.equal(core.state.lastExit4HStart.BTC, core.aggregators.BTC.lastClosed4HStart);
  assert.ok(core.normalCooldownActive('BTC'));
  // Il fill reale è molto peggiore: il trade diventa in perdita e cambia bucket.
  const record = core.applyFill({ kind: 'CLOSE', symbol: 'BTC', positionId: 'BTC-test', price: 80, size: 1, fee: 80 * 0.0005, time: close.slotTime, source: 'exchange' });
  assert.ok(record && record.pnl < 0);
  assert.equal(core.state.normalClean.grossProfit, 0);
  assert.ok(Math.abs(core.state.normalClean.grossLoss - record.pnl) < 1e-12);
  assert.equal(core.state.positions.BTC, null);
});

test('chiusura rifiutata dall exchange: effetti provvisori annullati e posizione ancora gestita', () => {
  const { core, nextSlot } = warmCore();
  core.state.positions.BTC = normalLong();
  const { res, next } = toNextHourClose(core, nextSlot);
  const close = res.intents.find((i) => i.kind === 'CLOSE');
  assert.ok(close);
  core.rejectIntent('BTC-test');
  assert.equal(core.state.normalClean.grossProfit, 0);
  assert.equal(core.state.lastExit4HStart.BTC, undefined);
  assert.ok(core.state.positions.BTC);
  const again = toNextHourClose(core, next).res;
  assert.ok(again.intents.some((i) => i.kind === 'CLOSE'), 'la chiusura viene ridecisa all ora successiva');
});

test('un fill di apertura senza intento viene rifiutato', () => {
  const core = new DecisionCore({ symbols: ['BTC'], initialEquity: 10000, feeRate: 0.0005, backstop: { model: 'none', bufferPct: 0 } });
  assert.throws(() => core.applyFill({ kind: 'OPEN', symbol: 'BTC', positionId: 'x', price: 1, size: 1, fee: 0, time: T0, source: 'exchange' }), /senza intento/);
});

test('stato serializzato in JSON e core ricostruito a metà backtest: risultato identico', () => {
  const window = GOLDEN_WINDOWS.find((w) => w.id === '2022H1')!;
  const base = {
    symbols: window.symbols,
    start: window.start,
    end: window.end,
    warmupDays: 50,
    initialEquity: 10000,
    execution: LEGACY_EXECUTION,
    backstop: { model: 'none' as const, bufferPct: 0 },
    funding: { kind: 'none' as const },
  };
  const full = runBacktest(base);
  const fullHash = canonicalHash(full.trades.map(legacyView));
  // Punti di ripresa con posizioni aperte: 7 EXTREME durante il crollo di gennaio 2022 e una NORMAL.
  for (const [at, minOpen] of [['2022-01-22T12:15:00.000Z', 7], [NORMAL_OPEN_AT, 1]] as const) {
    const openAtResume = full.trades.filter((t) => t.entryTime < at && at < t.exitTime);
    assert.ok(openAtResume.length >= minOpen, `al punto di ripresa ${at} servono posizioni aperte`);
    const resumed = runBacktest({ ...base, resumeFromSnapshotAt: Date.parse(at) });
    assert.equal(canonicalHash(resumed.trades.map(legacyView)), fullHash, `ripresa a ${at}`);
    assert.equal(resumed.finalEquity, full.finalEquity);
  }
});

test('ripresa con storico ridotto (come il live dopo un riavvio) subito dopo uscite NORMAL: risultato identico', () => {
  // Il 2022-02-11 alle 18:45 escono le NORMAL su BTC e XRP; entrambe rientrano più avanti
  // (XRP il 20 febbraio, BTC il 20 marzo). Il cooldown NORMAL deve sopravvivere al riavvio
  // anche se gli aggregatori vengono ricostruiti solo con gli ultimi 50 giorni di candele.
  const window = GOLDEN_WINDOWS.find((w) => w.id === '2022H1')!;
  const base = {
    symbols: window.symbols,
    start: window.start,
    end: window.end,
    warmupDays: 50,
    initialEquity: 10000,
    execution: LEGACY_EXECUTION,
    backstop: { model: 'none' as const, bufferPct: 0 },
    funding: { kind: 'none' as const },
  };
  const full = runBacktest(base);
  const at = '2022-02-11T19:00:00.000Z';
  assert.ok(full.trades.some((t) => t.engine === 'NORMAL' && t.symbol === 'XRP/USD:USD' && t.entryTime > at), 'serve un rientro NORMAL dopo la ripresa');
  const resumed = runBacktest({ ...base, resumeFromSnapshotAt: Date.parse(at), resumeWarmupDays: 50 });
  assert.equal(canonicalHash(resumed.trades.map(legacyView)), canonicalHash(full.trades.map(legacyView)));
  assert.equal(resumed.finalEquity, full.finalEquity);
});

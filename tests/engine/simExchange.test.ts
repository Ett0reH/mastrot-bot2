// Modello di esecuzione realistico del backtest (F2 Fase B: D14, D16).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONSTANT_FUNDING_HOURLY, REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { fundingRateAt, runBacktest } from '../../src/engine/backtest/runner';
import type { CloseIntent, OpenIntent, UpdateStopIntent } from '../../src/engine/core/types';
import type { Candle } from '../../src/engine/data/dataset';
import { LEGACY_EXECUTION, SimExchange } from '../../src/engine/sim/simExchange';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

const T = Date.UTC(2024, 0, 1, 10, 45);
const model = { feeRate: 0.0005, slippageBps: 5, simulateBackstop: true };

function open(direction: 'LONG' | 'SHORT', backstop: number, overrides: Partial<OpenIntent> = {}): OpenIntent {
  return {
    kind: 'OPEN', symbol: 'BTC', slotTime: T, positionId: 'p1', direction, size: 2, leverage: 3, referencePrice: 100,
    stopLoss: direction === 'LONG' ? 95 : 105, catastropheStopLoss: direction === 'LONG' ? 85 : 115, backstop,
    engine: 'EXTREME', setup: 'MEAN_REVERSION', regime: 'CRASH', tierLabel: 'EXTREME_10', quality: 0.9,
    isChopEntry: false, isReducedLeverageAction: false, ...overrides,
  };
}

const candle = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1 });

test('apertura e chiusura: slippage sfavorevole in punti base e fee sul nozionale eseguito', () => {
  const ex = new SimExchange(model);
  const [fillLong] = ex.execute([open('LONG', 92)]);
  assert.equal(fillLong.price, 100 * (1 + 5 / 10_000));
  assert.equal(fillLong.fee, 2 * fillLong.price * 0.0005);
  const close: CloseIntent = { kind: 'CLOSE', symbol: 'BTC', slotTime: T + 3_600_000, positionId: 'p1', direction: 'LONG', size: 2, referencePrice: 110, exitType: 'TRAILING_STOP' };
  const [fillClose] = ex.execute([close]);
  assert.equal(fillClose.price, 110 * (1 - 5 / 10_000));
  assert.equal(fillClose.exitType, 'TRAILING_STOP');
  const [fillShort] = new SimExchange(model).execute([open('SHORT', 108)]);
  assert.equal(fillShort.price, 100 * (1 - 5 / 10_000));
});

test('backstop LONG: scatta sul minimo della candela 15m al livello dello stop, con slippage', () => {
  const ex = new SimExchange(model);
  ex.execute([open('LONG', 92)]);
  assert.deepEqual(ex.onCandles(T + 900_000, { BTC: candle(T + 900_000, 99, 101, 93, 95) }), [], 'minimo sopra il livello: nessun fill');
  const [fill] = ex.onCandles(T + 1_800_000, { BTC: candle(T + 1_800_000, 95, 96, 90, 94) });
  assert.equal(fill.exitType, 'BACKSTOP');
  assert.equal(fill.price, 92 * (1 - 5 / 10_000));
  assert.equal(fill.fee, 2 * fill.price * 0.0005);
  assert.equal(fill.time, T + 1_800_000);
  assert.deepEqual(ex.onCandles(T + 2_700_000, { BTC: candle(T + 2_700_000, 80, 81, 70, 75) }), [], 'lo stop eseguito non scatta due volte');
});

test('backstop con gap: la candela apre già oltre il livello → fill all apertura (peggiore del livello)', () => {
  const long = new SimExchange(model);
  long.execute([open('LONG', 92)]);
  const [l] = long.onCandles(T + 900_000, { BTC: candle(T + 900_000, 88, 89, 85, 86) });
  assert.equal(l.price, 88 * (1 - 5 / 10_000));
  const short = new SimExchange(model);
  short.execute([open('SHORT', 108)]);
  const [s] = short.onCandles(T + 900_000, { BTC: candle(T + 900_000, 112, 115, 111, 114) });
  assert.equal(s.price, 112 * (1 + 5 / 10_000));
});

test('UPDATE_STOP sposta il backstop; una chiusura lo cancella', () => {
  const ex = new SimExchange(model);
  ex.execute([open('LONG', 92)]);
  const update: UpdateStopIntent = { kind: 'UPDATE_STOP', symbol: 'BTC', slotTime: T + 3_600_000, positionId: 'p1', direction: 'LONG', size: 2, strategyStop: 99, backstop: 96 };
  ex.execute([update]);
  assert.equal(ex.restingStop('p1'), 96);
  const [fill] = ex.onCandles(T + 3_600_000 + 900_000, { BTC: candle(T + 4_500_000, 97, 98, 95, 96) });
  assert.equal(fill.price, 96 * (1 - 5 / 10_000));

  const ex2 = new SimExchange(model);
  ex2.execute([open('LONG', 92)]);
  ex2.execute([{ kind: 'CLOSE', symbol: 'BTC', slotTime: T + 3_600_000, positionId: 'p1', direction: 'LONG', size: 2, referencePrice: 100, exitType: 'EDGE_DECAY' }]);
  assert.equal(ex2.restingStop('p1'), null);
  assert.deepEqual(ex2.onCandles(T + 4_500_000, { BTC: candle(T + 4_500_000, 80, 81, 70, 75) }), []);
});

test('modello legacy: nessuno slippage e nessuno stop nativo simulato', () => {
  const ex = new SimExchange(LEGACY_EXECUTION);
  const [fill] = ex.execute([open('LONG', 92)]);
  assert.equal(fill.price, 100);
  assert.equal(ex.restingStop('p1'), null);
  assert.deepEqual(ex.onCandles(T + 900_000, { BTC: candle(T + 900_000, 50, 50, 10, 20) }), []);
});

test('funding: tasso per ora secondo il modello; i LONG pagano un tasso positivo, gli SHORT lo incassano', () => {
  assert.equal(fundingRateAt({ kind: 'none' }, 'BTC', T), 0);
  assert.equal(fundingRateAt({ kind: 'constant', hourlyRate: 1e-5 }, 'BTC', T), 1e-5);
  const historical = { kind: 'historical' as const, rates: { BTC: new Map([[T, 2e-5]]) } };
  assert.equal(fundingRateAt(historical, 'BTC', T), 2e-5);
  const w = GOLDEN_WINDOWS.find((x) => x.id === '2022H1')!;
  const result = runBacktest({
    symbols: w.symbols, start: w.start, end: w.end, warmupDays: 50, initialEquity: 10000,
    execution: REALISTIC_PROFILE.execution, backstop: REALISTIC_PROFILE.backstop,
    funding: { kind: 'constant', hourlyRate: CONSTANT_FUNDING_HOURLY },
  });
  assert.ok(result.trades.some((t) => t.type === 'SHORT') && result.trades.some((t) => t.type === 'LONG'));
  for (const t of result.trades) {
    assert.ok(t.costs, 'costi dettagliati presenti');
    if (t.type === 'LONG') assert.ok(t.costs.funding > 0, `${t.symbol} ${t.entryTime} LONG paga`);
    else assert.ok(t.costs.funding < 0, `${t.symbol} ${t.entryTime} SHORT incassa`);
  }
  const tradesFunding = result.trades.reduce((a, t) => a + t.costs!.funding, 0);
  assert.ok(Math.abs(tradesFunding - result.fundingPaid) < 1e-9, 'tutto il funding è attribuito ai trade chiusi');
});

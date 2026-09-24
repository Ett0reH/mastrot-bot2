// Convertito da tests/audit/execution/3_1_position_exit_layer.audit.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ActiveTrade, PositionExitLayer } from '../../src/server/core/architecture';

function trade(overrides: Partial<ActiveTrade> = {}): ActiveTrade {
  return {
    id: 'TEST-1',
    symbol: 'TEST',
    direction: 'LONG',
    entryPrice: 100,
    size: 1,
    leverage: 2,
    stopLoss: 90,
    initialStopLoss: 90,
    currentStopLoss: 90,
    catastropheStopLoss: 85,
    takeProfit: 130,
    highWaterMark: 100,
    lowWaterMark: 100,
    barsHeld: 0,
    entryRegime: 'BULL',
    engine: 'NORMAL',
    ...overrides,
  };
}

test('senza entryTime barsHeld avanza di 1 a ogni valutazione e HWM/MFE si aggiornano', () => {
  const t = trade({ takeProfit: undefined });
  PositionExitLayer.monitorAndExit(t, { price: 105 } as any, 'BULL', true);
  assert.equal(t.barsHeld, 1);
  assert.equal(t.highWaterMark, 105);
  assert.equal(t.mfeR, 0.5);
  assert.equal(t.barsToHalfR, 1);
});

test('take profit raggiunto → TAKE_PROFIT', () => {
  const res = PositionExitLayer.monitorAndExit(trade(), { price: 135 } as any, 'BULL', true);
  assert.deepEqual(res, { shouldExit: true, exitType: 'TAKE_PROFIT' });
});

test('EXTREME: catastrophe stop', () => {
  const res = PositionExitLayer.monitorAndExit(trade({ engine: 'EXTREME', catastropheStopLoss: 80, takeProfit: undefined }), { price: 79 } as any, 'CRASH', true);
  assert.deepEqual(res, { shouldExit: true, exitType: 'CATASTROPHE_STOP' });
});

test('EXTREME: stop iniziale', () => {
  const res = PositionExitLayer.monitorAndExit(trade({ engine: 'EXTREME', catastropheStopLoss: 80, takeProfit: undefined }), { price: 89 } as any, 'CRASH', true);
  assert.deepEqual(res, { shouldExit: true, exitType: 'INITIAL_STOP_LOSS' });
});

test('NORMAL: il trailing al 2% dall HWM sostituisce subito uno stop più largo', () => {
  const t = trade({ takeProfit: undefined });
  const res = PositionExitLayer.monitorAndExit(t, { price: 100 } as any, 'BULL', true);
  assert.equal(res.shouldExit, false);
  assert.ok(Math.abs(t.currentStopLoss - 98) < 1e-9);
});

test('NORMAL: prezzo sotto lo stop corrente → TRAILING_STOP', () => {
  const res = PositionExitLayer.monitorAndExit(trade({ currentStopLoss: 100, highWaterMark: 110, takeProfit: undefined }), { price: 99 } as any, 'BULL', true);
  assert.deepEqual(res, { shouldExit: true, exitType: 'TRAILING_STOP' });
});

test('NORMAL: nessuna uscita per tempo, regime o edge decay', () => {
  const t = trade({ takeProfit: undefined, barsHeld: 200, currentStopLoss: 50 });
  const res = PositionExitLayer.monitorAndExit(t, { price: 101, rsi1H: 90, atr1H: 1 } as any, 'CRASH', true);
  assert.equal(res.shouldExit, false);
});

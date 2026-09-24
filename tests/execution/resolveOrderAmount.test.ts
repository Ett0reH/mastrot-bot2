// Convertito da tests/audit/execution/3_2_broker_reconciliation.audit.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveOrderAmount } from '../../src/server/liveEngineUtils';

const exchange = {
  markets: { 'TEST/USD': { limits: { amount: { min: 0.1 }, cost: { min: 10 } } } },
  amountToPrecision: (_symbol: string, amount: number) => amount.toFixed(2),
};

test('quantità valida: applica la precisione', () => {
  const res = resolveOrderAmount(exchange, 'TEST/USD', 1.555, 100);
  assert.equal(res.ok, true);
  assert.equal(res.amount, Number((1.555).toFixed(2)));
});

test('sotto la quantità minima → rifiutato', () => {
  const res = resolveOrderAmount(exchange, 'TEST/USD', 0.05, 1000);
  assert.equal(res.ok, false);
  assert.match(res.reason, /below min limits/);
});

test('sotto il nozionale minimo → rifiutato', () => {
  const res = resolveOrderAmount(exchange, 'TEST/USD', 0.1, 50);
  assert.equal(res.ok, false);
  assert.match(res.reason, /below min cost/);
});

test('troncato a zero dalla precisione → rifiutato', () => {
  const res = resolveOrderAmount(exchange, 'TEST/USD', 0.001, 100);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'Amount truncated to zero by precision');
});

test('quantità negativa → rifiutata', () => {
  const res = resolveOrderAmount(exchange, 'TEST/USD', -10, 100);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'Amount must be positive');
});

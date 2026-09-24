// Convertito da tests/audit/risk/2_3_capital_management_layer.audit.ts.
// Rimosso testExposureGlobalLogic: verificava aritmetica su dati locali, non il codice reale.
// Il limite di esposizione viene testato sul RiskGuard in F5.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapitalManagementLayer } from '../../src/server/core/architecture';

const health = (equity: number, peak: number) => CapitalManagementLayer.evaluateAccountHealth(equity, peak);

test('drawdown < 15%: capacità piena', () => {
  assert.deepEqual(health(10000, 10000), { isHalted: false, allowedCapacityMultiplier: 1 });
  assert.deepEqual(health(8600, 10000), { isHalted: false, allowedCapacityMultiplier: 1 });
});

test('drawdown tra 15% e 25%: capacità dimezzata', () => {
  assert.deepEqual(health(8500, 10000), { isHalted: false, allowedCapacityMultiplier: 0.5 });
  assert.deepEqual(health(7600, 10000), { isHalted: false, allowedCapacityMultiplier: 0.5 });
});

test('drawdown ≥ 25%: sistema fermo', () => {
  assert.deepEqual(health(7500, 10000), { isHalted: true, allowedCapacityMultiplier: 0 });
  assert.deepEqual(health(5000, 10000), { isHalted: true, allowedCapacityMultiplier: 0 });
});

test('il recupero sotto il 15% ripristina la capacità piena', () => {
  assert.equal(health(8900, 10500).allowedCapacityMultiplier, 0.5);
  assert.equal(health(9500, 10500).allowedCapacityMultiplier, 1);
});

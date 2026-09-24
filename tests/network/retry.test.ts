// Convertito da tests/audit/network/4_1_kraken_adapter.audit.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ccxt from 'ccxt';
import { ccxtWithRetry, withTimeout } from '../../src/server/liveEngineUtils';

test('withTimeout: risolve se la promessa arriva in tempo', async () => {
  assert.equal(await withTimeout(new Promise((r) => setTimeout(() => r('OK'), 10)), 100), 'OK');
});

test('withTimeout: rifiuta dopo il timeout', async () => {
  await assert.rejects(withTimeout(new Promise((r) => setTimeout(() => r('OK'), 200)), 50, 'TestOp'), /TestOp timed out/);
});

test('ccxtWithRetry: nessun retry se la prima chiamata riesce', async () => {
  let calls = 0;
  assert.equal(await ccxtWithRetry(async () => { calls++; return 'OK'; }, 3, 1), 'OK');
  assert.equal(calls, 1);
});

test('ccxtWithRetry: ritenta gli errori di rete', async () => {
  let calls = 0;
  const result = await ccxtWithRetry(async () => {
    calls++;
    if (calls < 3) throw new ccxt.NetworkError('ECONNRESET mock error');
    return 'NOW_OK';
  }, 4, 1);
  assert.equal(result, 'NOW_OK');
  assert.equal(calls, 3);
});

test('ccxtWithRetry: errore non transitorio (size non valida) rilanciato subito', async () => {
  let calls = 0;
  await assert.rejects(ccxtWithRetry(async () => { calls++; throw new ccxt.ExchangeError('Order size invalid'); }, 3, 1), /Order size invalid/);
  assert.equal(calls, 1);
});

test('ccxtWithRetry: dopo il numero massimo di tentativi rilancia l ultimo errore', async () => {
  let calls = 0;
  await assert.rejects(ccxtWithRetry(async () => { calls++; throw new ccxt.NetworkError(`timeout mock error ${calls}`); }, 3, 1), /timeout mock error 3/);
  assert.equal(calls, 3);
});

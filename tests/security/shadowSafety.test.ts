// Garanzie della modalità shadow nel motore legacy (F1, D01/D02).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync('src/server/liveEngine.ts', 'utf8');

test('il motore legacy non forza più LIVE_TRADING_ENABLED né usa variabili sandbox proprie', () => {
  assert.doesNotMatch(source, /process\.env\.LIVE_TRADING_ENABLED/);
  assert.doesNotMatch(source, /process\.env\.KRAKEN_SANDBOX/);
  assert.doesNotMatch(source, /process\.env\.KRAKEN_(API|SECRET)_KEY/);
});

test('il client Kraken del motore legacy prende ambiente e chiavi solo dalla configurazione', () => {
  assert.match(source, /new DerivativesClient\(krakenClientOptions\(\)\)/);
  assert.equal((source.match(/new DerivativesClient\(/g) ?? []).length, 1);
});

test('lo stato persistito non contiene più il segreto di scrittura', () => {
  assert.doesNotMatch(source, /BOT_SECRET/);
  assert.doesNotMatch(source, /botSecret:/);
});

test('nessuno script manuale con default sandbox divergenti resta in src/', () => {
  const offenders = ['server.ts', 'src/server/app.ts', 'src/server/krakenAdmin.ts']
    .filter((f) => /KRAKEN_SANDBOX|LIVE_TRADING_ENABLED/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

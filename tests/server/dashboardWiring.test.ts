// D30: il pulsante "Emergency Kill Switch" della dashboard deve avviare il kill switch (non solo
// fermare il bot). Nel progetto non c'è un ambiente DOM per i test: si verifica il collegamento
// nel sorgente; la rotta è coperta da app.test.ts e il comportamento da killSwitch.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/Dashboard.tsx', import.meta.url), 'utf8');

test('D30: il pulsante Emergency Kill Switch chiama il kill switch', () => {
  const label = source.indexOf('Emergency Kill Switch');
  assert.ok(label > 0, 'pulsante presente');
  const button = source.slice(source.lastIndexOf('<button', label), label);
  assert.match(button, /onClick=\{(?:\(\)\s*=>\s*\{?\s*)?handleKillSwitch\b/, 'il click avvia handleKillSwitch');
  assert.doesNotMatch(button, /handleStopLive/, 'non si limita più a fermare il bot');
});

test('D30: handleKillSwitch chiede conferma e chiama POST /api/kill-switch', () => {
  const start = source.indexOf('const handleKillSwitch');
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf('};', start));
  assert.match(body, /window\.confirm\(/);
  assert.match(body, /post\('\/api\/kill-switch'/);
  const helper = source.slice(source.indexOf('const post = async'), source.indexOf('const handleResume'));
  assert.match(helper, /apiFetch\(path,\s*\{\s*method:\s*'POST'/, 'le azioni di controllo sono POST autenticate');
});

test('D31: niente dati finti né endpoint mock nella dashboard', () => {
  assert.doesNotMatch(source, /\/api\/system\/state/);
  for (const fake of ['ARB_K_OMEGA_9', 'OPERATIONAL', 'Out-of-sample', 'SESSION:']) assert.ok(!source.includes(fake), fake);
  assert.doesNotMatch(source, /\)\}\\n/, 'nessun \\n letterale nel JSX');
  assert.match(source, /data-testid="mode-badge"/, 'badge della modalità');
  assert.match(source, /PROTECTION\[p\.protection\]/, 'stato dello stop nativo per posizione');
});

test('ripresa da REDUCE_ONLY/HALTED: la frase di conferma viene inviata a POST /api/risk/resume', () => {
  const start = source.indexOf('const handleResumeRisk');
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf('};', start));
  assert.match(body, /apiFetch\('\/api\/risk\/resume'/);
  assert.match(body, /JSON\.stringify\(\{ confirm: confirmation \}\)/);
});

// Nessun segreto nei file versionati (F1, D04/D05). Le chiavi già finite nella history git
// vanno comunque ruotate: questo test impedisce solo che ne entrino di nuove.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

const PATTERNS: [string, RegExp][] = [
  ['chiave Alpaca', /\bPK[A-Z0-9]{16,}\b/],
  ['chiave AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['chiave privata', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['token bot Telegram', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['vecchio segreto Firestore', /arbiter-secret-key/],
  ['segreto assegnato in chiaro', /(api[_-]?key|api[_-]?secret|secret[_-]?key|password)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{20,}["']/i],
];

// La API key web di Firebase è pubblica per costruzione (identifica il progetto, non autorizza nulla).
const ALLOWED_FILES = new Set(['firebase-applet-config.json']);

test('nessun segreto nei file versionati', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const findings: string[] = [];
  for (const file of files) {
    if (ALLOWED_FILES.has(file) || file.endsWith('.gz') || file === 'package-lock.json') continue;
    let text: string;
    try {
      if (statSync(file).size > 5_000_000) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // file rimosso dal working tree ma non ancora dal commit
    }
    for (const [label, pattern] of PATTERNS) {
      if (pattern.test(text)) findings.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(findings, []);
});

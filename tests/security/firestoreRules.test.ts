// Le regole Firestore negano ogni accesso dai client: il server usa l'Admin SDK (F1, D05).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('firestore.rules nega lettura e scrittura a tutti i client', () => {
  const rules = readFileSync('firestore.rules', 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(rules, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);
  assert.doesNotMatch(rules, /if true/);
  assert.doesNotMatch(rules, /allow (read|write|create|update)(?!, write: if false)[^;]*if (?!false)/);
  assert.doesNotMatch(rules, /botSecret/);
});

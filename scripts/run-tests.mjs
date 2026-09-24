#!/usr/bin/env node
// Launcher dei test: raccoglie i file `*.test.ts` sotto `tests/` e li esegue con il
// test runner nativo di Node (`node:test`) caricando TypeScript tramite tsx.
// Serve un launcher perché Node 20 non espande da solo i glob passati a `--test`.
//
// Uso:
//   npm test                      → tutti i test
//   npm test -- tests/data        → solo i file il cui percorso contiene "tests/data"
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const testsDir = join(root, 'tests');

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const filters = process.argv.slice(2).map((f) => f.split('/').join(sep));
const files = collect(testsDir)
  .sort()
  .filter((f) => filters.length === 0 || filters.some((flt) => relative(root, f).includes(flt)));

if (files.length === 0) {
  console.error(`Nessun file di test trovato${filters.length ? ` per il filtro: ${filters.join(', ')}` : ''}.`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-reporter=spec', ...files.map((f) => relative(root, f))],
  { stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } },
);
process.exit(result.status ?? 1);

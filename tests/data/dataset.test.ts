import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  BAR_15M_MS,
  type Candle,
  DatasetIntegrityError,
  MAX_CHUNK_BYTES,
  decodeChunk,
  defaultDatasetRoot,
  encodeChunk,
  loadCandles,
  longGaps,
  readManifest,
  validateCandles,
  verifyDataset,
  writeSymbolCandles,
} from '../../src/engine/data/dataset';

const T0 = Date.UTC(2024, 0, 1);
function series(n: number, start = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ t: start + i * BAR_15M_MS, o: 10 + i, h: 12 + i, l: 9 + i, c: 11 + i, v: 5 }));
}

test('il dataset nel repository è integro (checksum, candele, coverage e buchi coerenti col manifest)', () => {
  const result = verifyDataset(defaultDatasetRoot());
  assert.deepEqual(result.errors, []);
  assert.ok(Object.keys(readManifest(defaultDatasetRoot()).symbols).length >= 8);
});

test('ogni chunk del dataset resta sotto i 2 MB (limite oltre il quale il sync di AI Studio tronca)', () => {
  const root = defaultDatasetRoot();
  for (const symbol of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory())) {
    for (const file of readdirSync(join(root, symbol))) {
      assert.ok(statSync(join(root, symbol, file)).size < MAX_CHUNK_BYTES, `${symbol}/${file} troppo grande`);
    }
  }
});

test('validateCandles individua disordine, duplicati, valori non validi, disallineamenti e buchi', () => {
  const ok = series(10);
  assert.equal(validateCandles(ok).ok, true);
  const gap = [...series(3), ...series(3, T0 + 10 * BAR_15M_MS)];
  const g = validateCandles(gap);
  assert.equal(g.ok, true);
  assert.equal(g.gaps.length, 1);
  assert.equal(g.gaps[0].minutes, 8 * 15);
  assert.equal(validateCandles([ok[1], ok[0]]).unsorted, 1);
  assert.equal(validateCandles([ok[0], ok[0]]).duplicates, 1);
  assert.equal(validateCandles([{ ...ok[0], c: Number.NaN }]).invalidValues, 1);
  assert.equal(validateCandles([{ ...ok[0], h: 1 }]).invalidValues, 1);
  assert.equal(validateCandles([{ ...ok[0], t: T0 + 1000 }]).misaligned, 1);
});

test('encode/decode di un chunk è reversibile e il checksum è quello del JSON non compresso', () => {
  const candles = series(5);
  const { json, gz, sha256 } = encodeChunk('TEST', 'unit-test', candles);
  const decoded = decodeChunk(gz);
  assert.equal(decoded.json, json);
  assert.deepEqual(decoded.candles, candles);
  assert.equal(sha256.length, 64);
});

test('loadCandles rileva un chunk alterato', () => {
  const root = mkdtempSync(join(tmpdir(), 'dataset-'));
  try {
    writeSymbolCandles(root, 'TEST', series(20), 'unit-test', 'PF_TESTUSD');
    assert.equal(loadCandles(root, 'TEST').length, 20);
    const chunkFile = join(root, readManifest(root).symbols.TEST.chunks[0].file);
    const tampered = decodeChunk(readFileSync(chunkFile)).json.replace('"bars":[[', '"bars":[[1,');
    writeFileSync(chunkFile, gzipSync(tampered));
    assert.throws(() => loadCandles(root, 'TEST'), DatasetIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCandles filtra per intervallo, estremi inclusi', () => {
  const root = mkdtempSync(join(tmpdir(), 'dataset-'));
  try {
    writeSymbolCandles(root, 'TEST', series(20), 'unit-test');
    const out = loadCandles(root, 'TEST', T0 + 5 * BAR_15M_MS, T0 + 9 * BAR_15M_MS);
    assert.deepEqual(out.map((c) => (c.t - T0) / BAR_15M_MS), [5, 6, 7, 8, 9]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('riscrivere un simbolo rimuove i chunk degli anni non più presenti', () => {
  const root = mkdtempSync(join(tmpdir(), 'dataset-'));
  try {
    writeSymbolCandles(root, 'TEST', [...series(4, Date.UTC(2023, 11, 31, 23, 0)), ...series(4, Date.UTC(2024, 0, 1, 12))], 'unit-test');
    assert.deepEqual(readdirSync(join(root, 'TEST')).sort(), ['2023.json.gz', '2024.json.gz']);
    writeSymbolCandles(root, 'TEST', series(4, Date.UTC(2024, 0, 2)), 'unit-test');
    assert.deepEqual(readdirSync(join(root, 'TEST')), ['2024.json.gz']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeSymbolCandles rifiuta candele non valide', () => {
  const root = mkdtempSync(join(tmpdir(), 'dataset-'));
  try {
    const bad = series(3);
    bad[1] = { ...bad[1], o: Number.NaN };
    assert.throws(() => writeSymbolCandles(root, 'TEST', bad, 'unit-test'), /non valide/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buchi lunghi nella finestra: inizio e fine scoperti e buchi interni oltre la soglia (run sul dataset completo)', () => {
  const t0 = Date.parse('2022-01-01T00:00:00Z');
  const day = 86_400_000;
  const bars = (from: number, to: number) => {
    const out: Candle[] = [];
    for (let t = from; t <= to; t += BAR_15M_MS) out.push({ t, o: 1, h: 1, l: 1, c: 1, v: 1 });
    return out;
  };
  // Dati dal giorno 2 al 30, poi dal 60 al 90: scoperti l'inizio (2 giorni) e 30 giorni in mezzo.
  const candles = [...bars(t0 + 2 * day, t0 + 30 * day), ...bars(t0 + 60 * day, t0 + 90 * day)];
  assert.deepEqual(longGaps(candles, t0, t0 + 90 * day, 7 * day), [{ from: new Date(t0 + 30 * day + BAR_15M_MS).toISOString(), to: new Date(t0 + 60 * day - BAR_15M_MS).toISOString() }]);
  assert.equal(longGaps(candles, t0, t0 + 90 * day, day).length, 2, 'con soglia di un giorno anche l inizio scoperto');
  assert.equal(longGaps(candles, t0, t0 + 100 * day, 7 * day).length, 2, 'fine scoperta di 10 giorni');
  assert.deepEqual(longGaps([], t0, t0 + 10 * day, 7 * day), [{ from: new Date(t0).toISOString(), to: new Date(t0 + 10 * day).toISOString() }]);
  assert.deepEqual(longGaps(bars(t0, t0 + 20 * day), t0, t0 + 20 * day, 7 * day), [], 'dati continui: nessun buco');
});

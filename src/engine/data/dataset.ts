// Dataset storico di candele 15m di Kraken Futures.
//
// Formato su disco (radice di default: data/kraken-futures/15m):
//   manifest.json                     → indice con coverage, buchi e checksum di ogni chunk
//   <SYMBOL>/<YYYY>.json.gz           → un chunk per simbolo e anno UTC
//
// Ogni chunk è un JSON compatto `{"v":1,"symbol","resolution","source","bars":[[t,o,h,l,c,v],...]}`
// compresso con gzip. Il checksum SHA-256 è calcolato sul JSON NON compresso, così non dipende
// dalla versione della libreria di compressione. I chunk restano ben sotto i 2 MB: il sync di
// AI Studio verso GitHub tronca i file più grandi (è così che si è rotto il dataset precedente).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const BAR_15M_MS = 15 * 60 * 1000;
export const MAX_CHUNK_BYTES = 1_900_000;

/** Candela con tempo di apertura in millisecondi UTC. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface DatasetChunkMeta {
  file: string;
  from: string;
  to: string;
  bars: number;
  sha256: string;
  source: string;
}

export interface DatasetRange {
  from: string;
  to: string;
}

export interface DatasetGap {
  after: string;
  before: string;
  minutes: number;
}

export interface DatasetSymbolMeta {
  native: string;
  chunks: DatasetChunkMeta[];
  coverage: DatasetRange[];
  gaps: DatasetGap[];
}

export interface DatasetManifest {
  version: 1;
  exchange: 'kraken-futures';
  resolution: '15m';
  symbols: Record<string, DatasetSymbolMeta>;
}

/** Simboli nativi Kraken Futures (perpetual lineari multi-collateral). */
export const KRAKEN_NATIVE_SYMBOLS: Readonly<Record<string, string>> = {
  BTC: 'PF_XBTUSD',
  ETH: 'PF_ETHUSD',
  SOL: 'PF_SOLUSD',
  AVAX: 'PF_AVAXUSD',
  XRP: 'PF_XRPUSD',
  DOGE: 'PF_DOGEUSD',
  LINK: 'PF_LINKUSD',
  ADA: 'PF_ADAUSD',
  LTC: 'PF_LTCUSD',
};

/** Simbolo nel formato usato dal codice legacy (ccxt): "BTC/USD:USD". */
export function legacySymbol(symbol: string): string {
  return `${symbol}/USD:USD`;
}

export function defaultDatasetRoot(cwd: string = process.cwd()): string {
  return join(cwd, 'data', 'kraken-futures', '15m');
}

export function isoOf(t: number): string {
  return new Date(t).toISOString();
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// --- Validazione -----------------------------------------------------------------------

export interface CandleValidation {
  ok: boolean;
  count: number;
  unsorted: number;
  duplicates: number;
  invalidValues: number;
  misaligned: number;
  gaps: DatasetGap[];
  errors: string[];
}

/**
 * Controlla che le candele siano ordinate, uniche, allineate alla griglia dei 15 minuti,
 * con valori numerici finiti e coerenti (low ≤ open/close ≤ high, volume ≥ 0).
 * I buchi temporali non sono errori: vengono riportati in `gaps`.
 */
export function validateCandles(candles: readonly Candle[]): CandleValidation {
  const result: CandleValidation = {
    ok: true,
    count: candles.length,
    unsorted: 0,
    duplicates: 0,
    invalidValues: 0,
    misaligned: 0,
    gaps: [],
    errors: [],
  };
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const values = [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v];
    const finite = values.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!finite || bar.v < 0 || bar.l > Math.min(bar.o, bar.c) || bar.h < Math.max(bar.o, bar.c) || bar.l <= 0) {
      result.invalidValues++;
    }
    if (bar.t % BAR_15M_MS !== 0) result.misaligned++;
    if (i === 0) continue;
    const prev = candles[i - 1];
    if (bar.t === prev.t) result.duplicates++;
    else if (bar.t < prev.t) result.unsorted++;
    else if (bar.t - prev.t > BAR_15M_MS) {
      result.gaps.push({ after: isoOf(prev.t), before: isoOf(bar.t), minutes: (bar.t - prev.t) / 60000 });
    }
  }
  if (result.unsorted) result.errors.push(`${result.unsorted} candele fuori ordine`);
  if (result.duplicates) result.errors.push(`${result.duplicates} candele duplicate`);
  if (result.invalidValues) result.errors.push(`${result.invalidValues} candele con valori non validi`);
  if (result.misaligned) result.errors.push(`${result.misaligned} candele non allineate ai 15 minuti`);
  result.ok = result.errors.length === 0;
  return result;
}

/** Intervalli contigui (senza buchi oltre i 15 minuti) coperti dalle candele. */
export function computeCoverage(candles: readonly Candle[]): DatasetRange[] {
  const ranges: DatasetRange[] = [];
  if (candles.length === 0) return ranges;
  let start = candles[0].t;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].t - candles[i - 1].t > BAR_15M_MS) {
      ranges.push({ from: isoOf(start), to: isoOf(candles[i - 1].t) });
      start = candles[i].t;
    }
  }
  ranges.push({ from: isoOf(start), to: isoOf(candles[candles.length - 1].t) });
  return ranges;
}

/**
 * Tratti della finestra [fromMs, toMs] senza candele per più di `maxGapMs` (compresi l'inizio e la
 * fine non coperti). Con buchi così lunghi il backtest calcolerebbe le feature su barre vecchie di
 * mesi, mentre il bot dal vivo ricostruisce solo la storia recente: i run sul dataset completo li
 * rifiutano.
 */
export function longGaps(candles: readonly Candle[], fromMs: number, toMs: number, maxGapMs: number): DatasetRange[] {
  const inWindow = candles.filter((c) => c.t >= fromMs && c.t <= toMs);
  const out: DatasetRange[] = [];
  const hole = (from: number, to: number) => {
    if (to - from > maxGapMs) out.push({ from: isoOf(from), to: isoOf(to) });
  };
  if (inWindow.length === 0) {
    hole(fromMs, toMs);
    return out;
  }
  hole(fromMs, inWindow[0].t - BAR_15M_MS);
  for (let i = 1; i < inWindow.length; i++) hole(inWindow[i - 1].t + BAR_15M_MS, inWindow[i].t - BAR_15M_MS);
  hole(inWindow[inWindow.length - 1].t + BAR_15M_MS, toMs);
  return out;
}

// --- Serializzazione dei chunk -----------------------------------------------------------

interface ChunkFile {
  v: 1;
  symbol: string;
  resolution: '15m';
  source: string;
  bars: [number, number, number, number, number, number][];
}

export function encodeChunk(symbol: string, source: string, candles: readonly Candle[]): { json: string; gz: Buffer; sha256: string } {
  const body: ChunkFile = {
    v: 1,
    symbol,
    resolution: '15m',
    source,
    bars: candles.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]),
  };
  const json = JSON.stringify(body);
  return { json, gz: gzipSync(json, { level: 9 }), sha256: sha256(json) };
}

export function decodeChunk(gz: Buffer): { json: string; chunk: ChunkFile; candles: Candle[] } {
  const json = gunzipSync(gz).toString('utf8');
  const chunk = JSON.parse(json) as ChunkFile;
  if (chunk.v !== 1 || chunk.resolution !== '15m' || !Array.isArray(chunk.bars)) {
    throw new Error('Formato chunk non riconosciuto');
  }
  const candles = chunk.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  return { json, chunk, candles };
}

// --- Manifest ----------------------------------------------------------------------------

export function emptyManifest(): DatasetManifest {
  return { version: 1, exchange: 'kraken-futures', resolution: '15m', symbols: {} };
}

export function readManifest(root: string): DatasetManifest {
  const file = join(root, 'manifest.json');
  if (!existsSync(file)) return emptyManifest();
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as DatasetManifest;
  if (manifest.version !== 1 || manifest.resolution !== '15m') {
    throw new Error(`Manifest non supportato in ${file}`);
  }
  return manifest;
}

export function writeManifest(root: string, manifest: DatasetManifest): void {
  const sorted: DatasetManifest = { ...manifest, symbols: {} };
  for (const key of Object.keys(manifest.symbols).sort()) sorted.symbols[key] = manifest.symbols[key];
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(sorted, null, 2) + '\n');
}

/**
 * Scrive tutte le candele di un simbolo, spezzate per anno UTC, e aggiorna il manifest.
 * Sostituisce i dati già presenti per quel simbolo. Le candele devono superare `validateCandles`.
 */
export function writeSymbolCandles(
  root: string,
  symbol: string,
  candles: readonly Candle[],
  source: string,
  native: string = KRAKEN_NATIVE_SYMBOLS[symbol] ?? symbol,
): DatasetSymbolMeta {
  const validation = validateCandles(candles);
  if (!validation.ok) {
    throw new Error(`Candele non valide per ${symbol}: ${validation.errors.join('; ')}`);
  }
  const byYear = new Map<number, Candle[]>();
  for (const bar of candles) {
    const year = new Date(bar.t).getUTCFullYear();
    const bucket = byYear.get(year);
    if (bucket) bucket.push(bar);
    else byYear.set(year, [bar]);
  }
  const chunks: DatasetChunkMeta[] = [];
  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    const bars = byYear.get(year) ?? [];
    const encoded = encodeChunk(symbol, source, bars);
    if (encoded.gz.length > MAX_CHUNK_BYTES) {
      throw new Error(`Chunk ${symbol}/${year} troppo grande (${encoded.gz.length} byte)`);
    }
    const file = `${symbol}/${year}.json.gz`;
    const full = join(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, encoded.gz);
    chunks.push({
      file,
      from: isoOf(bars[0].t),
      to: isoOf(bars[bars.length - 1].t),
      bars: bars.length,
      sha256: encoded.sha256,
      source,
    });
  }
  const meta: DatasetSymbolMeta = { native, chunks, coverage: computeCoverage(candles), gaps: validation.gaps };
  const manifest = readManifest(root);
  // Rimuove i chunk del simbolo che non fanno più parte del dataset (es. anni non più presenti).
  const keep = new Set(chunks.map((c) => c.file));
  for (const old of manifest.symbols[symbol]?.chunks ?? []) {
    const full = join(root, old.file);
    if (!keep.has(old.file) && existsSync(full)) unlinkSync(full);
  }
  manifest.symbols[symbol] = meta;
  writeManifest(root, manifest);
  return meta;
}

export class DatasetIntegrityError extends Error {}

/**
 * Carica le candele di un simbolo nell'intervallo [fromMs, toMs] (estremi inclusi),
 * verificando il checksum di ogni chunk letto. Lancia DatasetIntegrityError se un chunk
 * manca, è corrotto o non corrisponde al manifest.
 */
export function loadCandles(root: string, symbol: string, fromMs = -Infinity, toMs = Infinity): Candle[] {
  const manifest = readManifest(root);
  const meta = manifest.symbols[symbol];
  if (!meta) throw new DatasetIntegrityError(`Simbolo ${symbol} assente dal dataset in ${root}`);
  const out: Candle[] = [];
  for (const chunk of meta.chunks) {
    const chunkFrom = Date.parse(chunk.from);
    const chunkTo = Date.parse(chunk.to);
    if (chunkTo < fromMs || chunkFrom > toMs) continue;
    const full = join(root, chunk.file);
    if (!existsSync(full)) throw new DatasetIntegrityError(`Chunk mancante: ${full}`);
    const { json, candles } = decodeChunk(readFileSync(full));
    if (sha256(json) !== chunk.sha256) {
      throw new DatasetIntegrityError(`Checksum non valido per ${chunk.file}`);
    }
    if (candles.length !== chunk.bars) {
      throw new DatasetIntegrityError(`Numero di candele diverso dal manifest per ${chunk.file}`);
    }
    for (const bar of candles) if (bar.t >= fromMs && bar.t <= toMs) out.push(bar);
  }
  return out;
}

/** Verifica completa del dataset: checksum, validità delle candele e coerenza con il manifest. */
export function verifyDataset(root: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const manifest = readManifest(root);
  for (const [symbol, meta] of Object.entries(manifest.symbols)) {
    try {
      const candles = loadCandles(root, symbol);
      const validation = validateCandles(candles);
      if (!validation.ok) errors.push(`${symbol}: ${validation.errors.join('; ')}`);
      if (JSON.stringify(computeCoverage(candles)) !== JSON.stringify(meta.coverage)) {
        errors.push(`${symbol}: coverage diversa dal manifest`);
      }
      if (JSON.stringify(validation.gaps) !== JSON.stringify(meta.gaps)) {
        errors.push(`${symbol}: buchi diversi dal manifest`);
      }
    } catch (err) {
      errors.push(`${symbol}: ${(err as Error).message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

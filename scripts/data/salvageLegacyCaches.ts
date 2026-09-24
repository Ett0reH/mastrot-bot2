// Recupera le candele valide dalle vecchie cache 15m del backtest, rimaste nella history git.
//
// Le cache `*_KRAKEN_v2_2022-01-01_2026-05-09.json` sono state troncate a ~2 MB dal sync di
// AI Studio: il JSON non è valido, ma il prefisso contiene ~7 mesi di dati integri
// (dal 2021-11-12 a giugno/luglio 2022). Le cache brevi `*_2026-04-23_2026-05-09.json` sono
// integre (dal 2026-03-04 al 2026-05-09, per il warm-up di 50 giorni).
//
// Questo script legge i file dal commit indicato (default 83148b1), recupera il prefisso
// valido, unisce le due finestre per simbolo e scrive il dataset in data/kraken-futures/15m.
// Il risultato è un dataset PARZIALE: la ricostruzione completa richiede
// `npm run data:download` con accesso di rete a futures.kraken.com.
//
// Uso: npm run data:salvage [-- --commit <sha>] [--root <dir>]
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type Candle,
  defaultDatasetRoot,
  validateCandles,
  writeSymbolCandles,
} from '../../src/engine/data/dataset';

const LEGACY_DIR = 'src/server/backtest/data_cache';
const DEFAULT_COMMIT = '83148b1';

interface LegacyBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Converte le barre legacy (t in ISO) nel formato del dataset (t in ms). */
export function fromLegacyBars(bars: readonly LegacyBar[]): Candle[] {
  return bars.map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

/**
 * Recupera l'array JSON da un testo eventualmente troncato: se il JSON è valido lo restituisce
 * intero, altrimenti tiene tutti gli oggetti completi fino all'ultimo `},`.
 */
export function salvageJsonArray(text: string): { bars: LegacyBar[]; truncated: boolean } {
  try {
    return { bars: JSON.parse(text) as LegacyBar[], truncated: false };
  } catch {
    const cut = text.lastIndexOf('},');
    if (cut < 0) throw new Error('Nessun oggetto completo recuperabile');
    return { bars: JSON.parse(text.slice(0, cut + 1) + ']') as LegacyBar[], truncated: true };
  }
}

function gitShow(commit: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${commit}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): { commit: string; root: string } {
  let commit = DEFAULT_COMMIT;
  let root = defaultDatasetRoot();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--commit') commit = argv[++i];
    else if (argv[i] === '--root') root = argv[++i];
  }
  return { commit, root };
}

function main(): void {
  const { commit, root } = parseArgs(process.argv.slice(2));
  const symbols = ['ADA', 'AVAX', 'BTC', 'DOGE', 'ETH', 'LINK', 'LTC', 'SOL', 'XRP'];
  const sources = [
    { name: 'long', file: (s: string) => `${LEGACY_DIR}/${s}_USD_USD_15Min_KRAKEN_v2_2022-01-01_2026-05-09.json` },
    { name: 'short', file: (s: string) => `${LEGACY_DIR}/${s}_USD_USD_15Min_KRAKEN_v2_2026-04-23_2026-05-09.json` },
  ];
  let failures = 0;
  for (const symbol of symbols) {
    const merged = new Map<number, Candle>();
    const used: string[] = [];
    for (const source of sources) {
      const path = source.file(symbol);
      const text = gitShow(commit, path);
      if (text === null) continue;
      const { bars, truncated } = salvageJsonArray(text);
      const candles = fromLegacyBars(bars);
      for (const c of candles) merged.set(c.t, c);
      used.push(`${path}@${commit}${truncated ? ' (troncato, prefisso recuperato)' : ''}`);
      console.log(`${symbol}: ${source.name} → ${candles.length} candele${truncated ? ' (file troncato)' : ''}`);
    }
    if (merged.size === 0) {
      console.log(`${symbol}: nessuna cache legacy trovata, salto`);
      continue;
    }
    const candles = [...merged.values()].sort((a, b) => a.t - b.t);
    const validation = validateCandles(candles);
    if (!validation.ok) {
      console.error(`${symbol}: candele non valide: ${validation.errors.join('; ')}`);
      failures++;
      continue;
    }
    const meta = writeSymbolCandles(root, symbol, candles, `legacy-cache-salvage: ${used.join(' + ')}`);
    console.log(`${symbol}: scritto ${meta.chunks.length} chunk, coverage ${meta.coverage.map((r) => `${r.from} → ${r.to}`).join(' | ')}`);
  }
  if (failures > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

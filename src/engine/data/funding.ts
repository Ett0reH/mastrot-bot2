// Storico dei funding rate dei perpetual Kraken Futures, usato dal backtest realistico.
//
// Formato su disco (radice di default: data/kraken-futures/funding):
//   manifest.json          → { version, symbols: { BTC: { file, from, to, rows, sha256, source } } }
//   <SYMBOL>.json.gz       → {"v":1,"symbol","source","rates":[[t, fundingRate, relativeFundingRate], ...]}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sha256 } from './dataset';
import type { FundingRate } from './krakenHistory';

export interface FundingFileMeta {
  file: string;
  from: string;
  to: string;
  rows: number;
  sha256: string;
  source: string;
}

export interface FundingManifest {
  version: 1;
  symbols: Record<string, FundingFileMeta>;
}

export function defaultFundingRoot(cwd: string = process.cwd()): string {
  return join(cwd, 'data', 'kraken-futures', 'funding');
}

function readFundingManifest(root: string): FundingManifest {
  const file = join(root, 'manifest.json');
  if (!existsSync(file)) return { version: 1, symbols: {} };
  return JSON.parse(readFileSync(file, 'utf8')) as FundingManifest;
}

export function writeFundingRates(root: string, symbol: string, rates: readonly FundingRate[], source: string): FundingFileMeta {
  if (rates.length === 0) throw new Error(`Nessun funding rate da salvare per ${symbol}`);
  const json = JSON.stringify({
    v: 1,
    symbol,
    source,
    rates: rates.map((r) => [r.t, r.fundingRate, r.relativeFundingRate]),
  });
  mkdirSync(root, { recursive: true });
  const file = `${symbol}.json.gz`;
  writeFileSync(join(root, file), gzipSync(json, { level: 9 }));
  const meta: FundingFileMeta = {
    file,
    from: new Date(rates[0].t).toISOString(),
    to: new Date(rates[rates.length - 1].t).toISOString(),
    rows: rates.length,
    sha256: sha256(json),
    source,
  };
  const manifest = readFundingManifest(root);
  manifest.symbols[symbol] = meta;
  const sorted: FundingManifest = { version: 1, symbols: {} };
  for (const key of Object.keys(manifest.symbols).sort()) sorted.symbols[key] = manifest.symbols[key];
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(sorted, null, 2) + '\n');
  return meta;
}

/** Carica i funding rate di un simbolo; restituisce null se non sono disponibili. */
export function loadFundingRates(root: string, symbol: string): FundingRate[] | null {
  const meta = readFundingManifest(root).symbols[symbol];
  if (!meta) return null;
  const json = gunzipSync(readFileSync(join(root, meta.file))).toString('utf8');
  if (sha256(json) !== meta.sha256) throw new Error(`Checksum non valido per i funding di ${symbol}`);
  const body = JSON.parse(json) as { rates: [number, number, number][] };
  return body.rates.map(([t, fundingRate, relativeFundingRate]) => ({ t, fundingRate, relativeFundingRate }));
}

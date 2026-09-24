// Esegue il backtest LEGACY (src/server/backtest/run_kraken.ts) su una finestra del dataset.
//
// Il codice legacy non viene modificato: se ne crea una copia temporanea in cui cambiano solo
// le costanti di finestra (start, end, SYMBOLS) e i percorsi di import (resi assoluti). La copia
// gira in una cartella temporanea con le cache materializzate dal dataset verificato, con
// TZ=UTC (il legacy aggrega le candele con getHours() nel fuso locale).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultDatasetRoot, loadCandles, readManifest } from '../../src/engine/data/dataset';
import { canonicalHash } from '../../src/engine/util/canonical';
import type { GoldenWindow } from './windows';

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..', '..');
const LEGACY_SOURCE = join(REPO_ROOT, 'src', 'server', 'backtest', 'run_kraken.ts');
const WARMUP_MS = 50 * 24 * 60 * 60 * 1000; // run_kraken.ts scarica 50 giorni prima di start

export interface LegacyRunResult {
  window: GoldenWindow;
  trades: Record<string, unknown>[];
  tradesSha256: string;
  finalEquity: number;
  netPnL: number;
  tradeCount: number;
  winRate: number;
  datasetChunks: Record<string, string[]>;
  logFile: string;
}

function replaceOnce(source: string, search: string | RegExp, replacement: string, label: string): string {
  const matches = typeof search === 'string' ? source.split(search).length - 1 : (source.match(new RegExp(search.source, 'g')) ?? []).length;
  if (matches !== 1) throw new Error(`Patch "${label}": attese 1 occorrenza, trovate ${matches}`);
  return source.replace(search, replacement);
}

/** Crea la copia di run_kraken.ts con le sole costanti di finestra sostituite. */
export function patchLegacySource(source: string, window: GoldenWindow): string {
  let out = source;
  out = replaceOnce(out, 'from "../core/architecture";', `from ${JSON.stringify(join(REPO_ROOT, 'src/server/core/architecture'))};`, 'import architecture');
  out = replaceOnce(out, 'from "./reportAggregator";', `from ${JSON.stringify(join(REPO_ROOT, 'src/server/backtest/reportAggregator'))};`, 'import reportAggregator');
  out = replaceOnce(out, 'const start = "2022-01-01T00:00:00Z";', `const start = ${JSON.stringify(window.start)};`, 'start');
  out = replaceOnce(out, 'const end = "2026-05-09T00:00:00Z";', `const end = ${JSON.stringify(window.end)};`, 'end');
  const symbols = window.symbols.map((s) => `  ${JSON.stringify(`${s}/USD:USD`)},`).join('\n');
  out = replaceOnce(out, /const SYMBOLS = \[[^\]]*\];/, `const SYMBOLS = [\n${symbols}\n];`, 'SYMBOLS');
  return out;
}

export interface LegacyRunOptions {
  datasetRoot?: string;
  workDir?: string;
  timeoutMs?: number;
}

export function runLegacyBacktest(window: GoldenWindow, options: LegacyRunOptions = {}): LegacyRunResult {
  const datasetRoot = options.datasetRoot ?? defaultDatasetRoot(REPO_ROOT);
  const workDir = options.workDir ?? join(REPO_ROOT, '.golden_tmp', `legacy-${window.id}-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });
  const cacheDir = join(workDir, 'src', 'server', 'backtest', 'data_cache');
  mkdirSync(cacheDir, { recursive: true });

  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const manifest = readManifest(datasetRoot);
  const datasetChunks: Record<string, string[]> = {};
  const startDay = window.start.split('T')[0];
  const endDay = window.end.split('T')[0];
  for (const symbol of window.symbols) {
    const candles = loadCandles(datasetRoot, symbol, startMs - WARMUP_MS, endMs);
    if (candles.length === 0) throw new Error(`Nessuna candela per ${symbol} nella finestra ${window.id}`);
    // Stesso formato delle vecchie cache: t in ISO, valori numerici invariati.
    const legacy = candles.map((c) => ({ t: new Date(c.t).toISOString(), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
    writeFileSync(join(cacheDir, `${symbol}_USD_USD_15Min_KRAKEN_v2_${startDay}_${endDay}.json`), JSON.stringify(legacy));
    datasetChunks[symbol] = (manifest.symbols[symbol]?.chunks ?? [])
      .filter((c) => Date.parse(c.to) >= startMs - WARMUP_MS && Date.parse(c.from) <= endMs)
      .map((c) => `${c.file}:${c.sha256}`);
  }

  const patched = join(workDir, 'run_kraken_patched.ts');
  writeFileSync(patched, patchLegacySource(readFileSync(LEGACY_SOURCE, 'utf8'), window));
  const logFile = join(workDir, 'run.log');
  const child = spawnSync(process.execPath, ['--import', 'tsx', patched], {
    cwd: workDir,
    env: { ...process.env, TZ: 'UTC', NODE_ENV: 'test' },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: options.timeoutMs ?? 15 * 60 * 1000,
  });
  writeFileSync(logFile, `${child.stdout ?? ''}\n--- stderr ---\n${child.stderr ?? ''}`);
  if (child.status !== 0) {
    throw new Error(`Backtest legacy ${window.id} fallito (exit ${child.status}). Log: ${logFile}\n${(child.stderr ?? '').slice(-2000)}`);
  }
  const reportFile = join(workDir, 'backtest_report_latest.json');
  if (!existsSync(reportFile)) throw new Error(`Report non prodotto per ${window.id}. Log: ${logFile}`);
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as {
    trades: Record<string, unknown>[];
    finalEquity: number;
    netPnL: number;
    tradeCount: number;
    winRate: number;
  };
  return {
    window,
    trades: report.trades,
    tradesSha256: canonicalHash(report.trades),
    finalEquity: report.finalEquity,
    netPnL: report.netPnL,
    tradeCount: report.tradeCount,
    winRate: report.winRate,
    datasetChunks,
    logFile,
  };
}

export function goldenDir(windowId: string): string {
  return join(REPO_ROOT, 'golden', 'legacy', windowId);
}

// Golden backtest del codice legacy.
//
//   npm run backtest        → esegue il backtest legacy sulle finestre del golden e stampa i risultati
//   npm run golden:check    → confronta con golden/legacy/<finestra>/ (exit 1 se diverso)
//   npm run golden:update   → riscrive il golden (solo con approvazione esplicita dell'utente)
//
// Opzioni: --window <id> per una sola finestra; --full per il backtest di riferimento completo
// (richiede il dataset 2022-2026 scaricato con `npm run data:download`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalStringify } from '../../src/engine/util/canonical';
import { goldenDir, type LegacyRunResult, runLegacyBacktest } from './legacyRunner';
import { FULL_REFERENCE_WINDOW, GOLDEN_WINDOWS, type GoldenWindow } from './windows';

export interface GoldenSummary {
  window: GoldenWindow;
  tradeCount: number;
  finalEquity: number;
  netPnL: number;
  winRate: number;
  tradesSha256: string;
  datasetChunks: Record<string, string[]>;
}

export function summaryOf(result: LegacyRunResult): GoldenSummary {
  return {
    window: result.window,
    tradeCount: result.tradeCount,
    finalEquity: result.finalEquity,
    netPnL: result.netPnL,
    winRate: result.winRate,
    tradesSha256: result.tradesSha256,
    datasetChunks: result.datasetChunks,
  };
}

export function readGolden(windowId: string): { summary: GoldenSummary; trades: Record<string, unknown>[] } | null {
  const dir = goldenDir(windowId);
  if (!existsSync(join(dir, 'summary.json'))) return null;
  return {
    summary: JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as GoldenSummary,
    trades: JSON.parse(readFileSync(join(dir, 'trades.json'), 'utf8')) as Record<string, unknown>[],
  };
}

function writeGolden(result: LegacyRunResult): void {
  const dir = goldenDir(result.window.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), canonicalStringify(summaryOf(result), 2) + '\n');
  writeFileSync(join(dir, 'trades.json'), canonicalStringify(result.trades, 2) + '\n');
}

/** Primo trade diverso tra due liste, per un messaggio d'errore leggibile. */
export function firstDifference(expected: Record<string, unknown>[], actual: Record<string, unknown>[]): string {
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const a = canonicalStringify(expected[i]);
    const b = canonicalStringify(actual[i]);
    if (a !== b) return `trade #${i}\n  atteso: ${a}\n  ottenuto: ${b}`;
  }
  return 'nessuna differenza nei trade (differiscono i metadati)';
}

function describe(result: LegacyRunResult): string {
  const pct = ((result.finalEquity / 10000 - 1) * 100).toFixed(2);
  return `${result.window.id}: ${result.tradeCount} trade, equity finale ${result.finalEquity.toFixed(2)} (${pct}%), win rate ${(result.winRate * 100).toFixed(1)}%, sha256 ${result.tradesSha256.slice(0, 16)}…`;
}

function main(): void {
  const [mode = 'run', ...rest] = process.argv.slice(2);
  if (!['run', 'check', 'update'].includes(mode)) throw new Error(`Modalità sconosciuta: ${mode}`);
  const only = rest.includes('--window') ? rest[rest.indexOf('--window') + 1] : undefined;
  const windows = rest.includes('--full') ? [FULL_REFERENCE_WINDOW] : GOLDEN_WINDOWS.filter((w) => !only || w.id === only);
  let failed = false;
  for (const window of windows) {
    const result = runLegacyBacktest(window);
    console.log(describe(result));
    if (mode === 'update') {
      writeGolden(result);
      console.log(`  golden aggiornato in ${goldenDir(window.id)}`);
    } else if (mode === 'check') {
      const golden = readGolden(window.id);
      if (!golden) {
        console.error(`  nessun golden per ${window.id}: esegui golden:update (con approvazione)`);
        failed = true;
      } else if (golden.summary.tradesSha256 !== result.tradesSha256) {
        console.error(`  DIVERSO dal golden (${golden.summary.tradesSha256.slice(0, 16)}…): ${firstDifference(golden.trades, result.trades)}`);
        failed = true;
      } else {
        console.log('  identico al golden');
      }
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

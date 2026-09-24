// Golden del nuovo motore (DecisionCore + exchange simulato) con il modello di esecuzione
// realistico della sezione 2 del prompt: stop della strategia alla chiusura 1H, backstop nativo
// al 3% oltre lo stop simulato sulle candele 15m, slippage 5 bps, fee 0,05%.
//
//   npm run golden:check           → verifica il golden legacy e questo
//   npm run golden:engine:update   → riscrive golden/engine/ (solo con approvazione dell'utente)
//
// Il golden legacy resta la prova che il refactor non ha cambiato la strategia; questo fissa i
// risultati del modello di esecuzione che userà il live (nuovo golden da approvare, F2 Fase B).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BacktestProfile, REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { computeMetrics } from '../../src/engine/backtest/report';
import { runBacktest } from '../../src/engine/backtest/runner';
import type { TradeRecord } from '../../src/engine/core/types';
import { defaultDatasetRoot, readManifest } from '../../src/engine/data/dataset';
import { canonicalHash, canonicalStringify } from '../../src/engine/util/canonical';
import { firstDifference } from './legacyGolden';
import { datasetChunksFor } from './legacyRunner';
import { GOLDEN_WINDOWS, type GoldenWindow } from './windows';

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..', '..');
const WARMUP_DAYS = 50;
const INITIAL_EQUITY = 10000;

export const ENGINE_GOLDEN_PROFILE: BacktestProfile = REALISTIC_PROFILE;

export interface EngineGoldenSummary {
  window: GoldenWindow;
  profile: { id: string; execution: BacktestProfile['execution']; backstop: BacktestProfile['backstop']; funding: string };
  tradeCount: number;
  finalEquity: number;
  netPnL: number;
  maxDrawdown: number;
  profitFactor: number | null;
  tradesSha256: string;
  datasetChunks: Record<string, string[]>;
}

export function engineGoldenDir(windowId: string): string {
  return join(REPO_ROOT, 'golden', 'engine', windowId);
}

export function runEngineGolden(window: GoldenWindow): { summary: EngineGoldenSummary; trades: TradeRecord[] } {
  const profile = ENGINE_GOLDEN_PROFILE;
  if (profile.funding.kind !== 'none') throw new Error('Il golden del motore non include il funding (storico non disponibile)');
  const result = runBacktest({
    symbols: window.symbols,
    start: window.start,
    end: window.end,
    warmupDays: WARMUP_DAYS,
    initialEquity: INITIAL_EQUITY,
    execution: profile.execution,
    backstop: profile.backstop,
    funding: profile.funding,
  });
  const metrics = computeMetrics(result, INITIAL_EQUITY, window.start, window.end);
  const startMs = Date.parse(window.start) - WARMUP_DAYS * 24 * 3_600_000;
  return {
    trades: result.trades,
    summary: {
      window,
      profile: { id: profile.id, execution: profile.execution, backstop: profile.backstop, funding: profile.funding.kind },
      tradeCount: result.trades.length,
      finalEquity: result.finalEquity,
      netPnL: result.finalEquity - INITIAL_EQUITY,
      maxDrawdown: result.maxDrawdown,
      profitFactor: metrics.profitFactor,
      tradesSha256: canonicalHash(result.trades),
      datasetChunks: datasetChunksFor(readManifest(defaultDatasetRoot(REPO_ROOT)), window.symbols, startMs, Date.parse(window.end)),
    },
  };
}

export function readEngineGolden(windowId: string): { summary: EngineGoldenSummary; trades: Record<string, unknown>[] } | null {
  const dir = engineGoldenDir(windowId);
  if (!existsSync(join(dir, 'summary.json'))) return null;
  return {
    summary: JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as EngineGoldenSummary,
    trades: JSON.parse(readFileSync(join(dir, 'trades.json'), 'utf8')) as Record<string, unknown>[],
  };
}

function main(): void {
  const [mode = 'check', ...rest] = process.argv.slice(2);
  if (!['check', 'update'].includes(mode)) throw new Error(`Modalità sconosciuta: ${mode}`);
  const only = rest.includes('--window') ? rest[rest.indexOf('--window') + 1] : undefined;
  let failed = false;
  for (const window of GOLDEN_WINDOWS.filter((w) => !only || w.id === only)) {
    const { summary, trades } = runEngineGolden(window);
    console.log(`engine ${window.id}: ${summary.tradeCount} trade, equity finale ${summary.finalEquity.toFixed(2)}, max DD ${(summary.maxDrawdown * 100).toFixed(2)}%, sha256 ${summary.tradesSha256.slice(0, 16)}…`);
    if (mode === 'update') {
      const dir = engineGoldenDir(window.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'summary.json'), canonicalStringify(summary, 2) + '\n');
      writeFileSync(join(dir, 'trades.json'), canonicalStringify(trades, 2) + '\n');
      console.log(`  golden aggiornato in ${dir}`);
      continue;
    }
    const golden = readEngineGolden(window.id);
    if (!golden) {
      console.error(`  nessun golden per ${window.id}: esegui golden:engine:update (con approvazione)`);
      failed = true;
    } else if (golden.summary.tradesSha256 !== summary.tradesSha256 || golden.summary.finalEquity !== summary.finalEquity) {
      console.error(`  DIVERSO dal golden: ${firstDifference(golden.trades, trades as unknown as Record<string, unknown>[])}`);
      failed = true;
    } else {
      console.log('  identico al golden');
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

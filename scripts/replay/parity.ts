// Parità backtest ↔ replay del percorso live (invariante I3, gate F2).
//
// Esegue il DecisionCycle in replay (orologio simulato, candele pubblicate in ritardo, candela
// in formazione offerta dalla fonte, tick irregolari, riavvii con stato via JSON) e confronta
// intenti, decisioni, trade ed equity con il backtest sugli stessi dati 15m.
// Uso: npm run replay:parity   (scrive docs/phase_reports/F2_replay_parity.md)
import { writeFileSync } from 'node:fs';
import { CONSTANT_FUNDING_HOURLY, LEGACY_PROFILE, REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { type BacktestConfig, loadBacktestData, runBacktest } from '../../src/engine/backtest/runner';
import type { Candle } from '../../src/engine/data/dataset';
import { compareParity, DEFAULT_REPLAY_OPTIONS, runReplay } from '../../src/engine/replay/replay';
import { SYNTHETIC_PARITY_WINDOW, syntheticParityData } from '../../src/engine/sim/syntheticMarket';
import { GOLDEN_WINDOWS } from '../golden/windows';

interface Scenario { id: string; label: string; config: BacktestConfig; data: () => Record<string, Candle[]> }

const base = (w: { symbols: readonly string[]; start: string; end: string }, legacy = false): BacktestConfig => ({
  symbols: [...w.symbols],
  start: w.start,
  end: w.end,
  warmupDays: 50,
  initialEquity: 10000,
  execution: legacy ? LEGACY_PROFILE.execution : REALISTIC_PROFILE.execution,
  backstop: legacy ? LEGACY_PROFILE.backstop : REALISTIC_PROFILE.backstop,
  funding: legacy ? LEGACY_PROFILE.funding : { kind: 'constant', hourlyRate: CONSTANT_FUNDING_HOURLY },
  collectJournal: true,
});

async function main(): Promise<void> {
  const scenarios: Scenario[] = [
    ...GOLDEN_WINDOWS.flatMap((w) => [
      { id: `${w.id}-realistic`, label: `${w.id} dati reali, modello realistico + funding`, config: base(w), data: () => loadBacktestData(base(w)) },
      { id: `${w.id}-legacy`, label: `${w.id} dati reali, modello legacy`, config: base(w, true), data: () => loadBacktestData(base(w, true)) },
    ]),
    { id: SYNTHETIC_PARITY_WINDOW.id, label: '13 mesi sintetici (seme 2), modello realistico + funding', config: base(SYNTHETIC_PARITY_WINDOW), data: syntheticParityData },
  ];
  const lines = [
    '# F2 — Parità backtest ↔ replay del percorso live (I3)',
    '',
    '> Generato da `npm run replay:parity`. Replay: candele pubblicate 2-90 s dopo la chiusura, candela in formazione offerta dalla fonte (e scartata dal ciclo), tick dopo ogni ora e a volte dopo gli slot intermedi con ritardo fino a 2 minuti, nuovi tentativi ogni 20 s se una candela manca, riavvio del processo ogni ~9 giorni con stato serializzato in JSON e storico ricostruito dalla fonte.',
    '',
    '| Scenario | Giorni | Trade | Intenti | Decisioni | Tick | Riavvii | Attese candele | Slot senza candela | Esito |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|',
  ];
  let failed = false;
  for (const s of scenarios) {
    const data = s.data();
    const backtest = runBacktest(s.config, data);
    const replay = await runReplay(s.config, DEFAULT_REPLAY_OPTIONS, data);
    const report = compareParity(backtest, replay);
    const days = Math.round((Date.parse(s.config.end) - Date.parse(s.config.start)) / 86_400_000);
    const count = (type: string) => replay.events.filter((e) => e.type === type).length;
    lines.push(`| ${s.label} | ${days} | ${report.counts.trades} | ${report.counts.intents} | ${report.counts.journal} | ${replay.ticks} | ${replay.restarts} | ${count('WAITING_CANDLES')} | ${count('CANDLE_MISSING')} | ${report.identical ? '✅ identico' : '❌'} |`);
    console.log(`${s.id}: ${report.identical ? 'IDENTICO' : 'DIVERSO'} (${report.counts.trades} trade, ${report.counts.intents} intenti, ${replay.restarts} riavvii)`);
    if (!report.identical) {
      failed = true;
      lines.push('', '```', ...report.differences, '```', '');
      console.error(report.differences.join('\n'));
    }
  }
  writeFileSync('docs/phase_reports/F2_replay_parity.md', lines.join('\n') + '\n');
  console.log('Report scritto in docs/phase_reports/F2_replay_parity.md');
  if (failed) process.exit(1);
}

await main();

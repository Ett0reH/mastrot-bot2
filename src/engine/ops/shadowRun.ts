// Valutazione di un periodo di shadow (o demo) dai report giornalieri (F7): serve al gate "almeno
// 72 ore senza divergenze non spiegate" e al passaggio shadow → demo → live (GO_LIVE_CHECKLIST).
import type { DailyReport } from './dailyReport';

export interface ShadowRunDay {
  day: string;
  status: string;
  unexplained: number;
  explained: number;
  decisions: number;
  trades: number;
  issues: string[];
}

export interface ShadowRunEvaluation {
  ok: boolean;
  fromDay: string;
  toDay: string;
  hours: number;
  days: ShadowRunDay[];
  missingDays: string[];
  problems: string[];
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Giorni completi da `fromDay` a `toDay` (inclusi): ognuno deve avere il report, con il confronto
 * calcolato (non "non disponibile") e zero divergenze non spiegate.
 */
export function evaluateShadowRun(reports: readonly DailyReport[], fromDay: string, toDay: string): ShadowRunEvaluation {
  const byDay = new Map(reports.map((r) => [r.day, r] as const));
  const expected = daysBetween(fromDay, toDay);
  const missingDays = expected.filter((d) => !byDay.has(d));
  const days: ShadowRunDay[] = expected
    .filter((d) => byDay.has(d))
    .map((d) => {
      const r = byDay.get(d) as DailyReport;
      return {
        day: d,
        status: r.parity?.status ?? 'NOT_AVAILABLE',
        unexplained: r.parity?.unexplained ?? 0,
        explained: r.parity?.explained ?? 0,
        decisions: r.parity?.compared.decisions ?? 0,
        trades: r.pnl.trades,
        issues: r.issues,
      };
    });
  const problems: string[] = [];
  if (missingDays.length) problems.push(`giorni senza report: ${missingDays.join(', ')}`);
  for (const d of days) {
    if (d.status === 'NOT_AVAILABLE') problems.push(`${d.day}: confronto con il backtest non disponibile`);
    if (d.unexplained > 0) problems.push(`${d.day}: ${d.unexplained} divergenze non spiegate`);
  }
  return { ok: problems.length === 0 && days.length > 0, fromDay, toDay, hours: days.length * 24, days, missingDays, problems };
}

export function formatShadowRun(e: ShadowRunEvaluation): string {
  const lines = [
    `# Shadow run ${e.fromDay} → ${e.toDay}: ${e.ok ? 'OK' : 'NON SUPERATO'} (${e.hours} ore con report)`,
    '',
    '| Giorno | Confronto col backtest | Spiegate | Non spiegate | Decisioni | Trade | Da verificare |',
    '|---|---|---:|---:|---:|---:|---|',
    ...e.days.map((d) => `| ${d.day} | ${d.status} | ${d.explained} | ${d.unexplained} | ${d.decisions} | ${d.trades} | ${d.issues.join('; ') || '—'} |`),
  ];
  if (e.problems.length) lines.push('', '**Problemi:**', ...e.problems.map((p) => `- ${p}`));
  return lines.join('\n');
}

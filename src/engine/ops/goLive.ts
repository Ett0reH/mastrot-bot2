// Criteri misurabili di GO_LIVE_CHECKLIST.md (F8), valutati dai report giornalieri della demo:
// giorni consecutivi in demo, posizioni sempre protette, nessun desync, parità col backtest,
// slippage entro il modello. Gli altri punti della checklist (limiti live, alert provati, kill
// switch in demo) si verificano a mano.
import type { DailyReport } from './dailyReport';

export const GO_LIVE_MIN_DAYS = 14;

/** Alert che indicano una posizione senza stop nativo verificato, anche solo per poco. */
export const PROTECTION_CODES = ['STOP_MISSING', 'STOP_PLACEMENT_FAILED', 'EMERGENCY_CLOSE', 'PROTECTION_FAILING', 'HEARTBEAT_MISSING'] as const;

/** Alert che indicano un conto diverso da quello atteso: ordini doppi, posizioni o ordini non del bot. */
export const DESYNC_CODES = ['DESYNC', 'UNKNOWN_POSITION', 'UNKNOWN_ORDER'] as const;

export interface GoLiveCriterion {
  id: 'days' | 'protection' | 'desync' | 'parity' | 'slippage';
  label: string;
  ok: boolean;
  detail: string;
}

export interface GoLiveEvaluation {
  ok: boolean;
  fromDay: string;
  toDay: string;
  criteria: GoLiveCriterion[];
  /** Da rivedere a mano: non bloccano, ma vanno spiegati prima del live. */
  review: string[];
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function alertCount(reports: readonly DailyReport[], codes: readonly string[]): { total: number; detail: string[] } {
  const detail: string[] = [];
  let total = 0;
  for (const r of reports) {
    for (const code of codes) {
      const n = r.alerts.byCode[code] ?? 0;
      if (n > 0) detail.push(`${r.day} ${code}×${n}`);
      total += n;
    }
  }
  return { total, detail };
}

export function evaluateGoLive(reports: readonly DailyReport[], fromDay: string, toDay: string, minDays = GO_LIVE_MIN_DAYS): GoLiveEvaluation {
  const byDay = new Map(reports.map((r) => [r.day, r] as const));
  const expected = daysBetween(fromDay, toDay);
  const inPeriod = expected.map((d) => byDay.get(d)).filter((r): r is DailyReport => r !== undefined);
  const missing = expected.filter((d) => !byDay.has(d));
  const notDemo = inPeriod.filter((r) => r.mode !== 'demo').map((r) => `${r.day} (${r.mode})`);
  const criteria: GoLiveCriterion[] = [];

  const demoDays = inPeriod.length - notDemo.length;
  criteria.push({
    id: 'days',
    label: `Almeno ${minDays} giorni consecutivi in demo, ognuno con il suo report`,
    ok: expected.length >= minDays && missing.length === 0 && notDemo.length === 0,
    detail: [`${demoDays} giorni di demo su ${expected.length}`, missing.length ? `senza report: ${missing.join(', ')}` : '', notDemo.length ? `non in demo: ${notDemo.join(', ')}` : ''].filter(Boolean).join('; '),
  });

  const protection = alertCount(inPeriod, PROTECTION_CODES);
  criteria.push({
    id: 'protection',
    label: 'Zero posizioni senza stop nativo verificato',
    ok: protection.total === 0,
    detail: protection.total === 0 ? `nessun alert ${PROTECTION_CODES.join(', ')}` : protection.detail.join(', '),
  });

  const desync = alertCount(inPeriod, DESYNC_CODES);
  criteria.push({
    id: 'desync',
    label: 'Zero ordini duplicati e zero desync con Kraken',
    ok: desync.total === 0,
    detail: desync.total === 0 ? `nessun alert ${DESYNC_CODES.join(', ')}` : desync.detail.join(', '),
  });

  const parityProblems = inPeriod.flatMap((r) => {
    const status = r.parity?.status ?? 'NOT_AVAILABLE';
    if (status === 'NOT_AVAILABLE') return [`${r.day}: confronto non disponibile`];
    if ((r.parity?.unexplained ?? 0) > 0 || status === 'DIVERGENT') return [`${r.day}: ${r.parity?.unexplained ?? 0} divergenze non spiegate`];
    return [];
  });
  const explained = inPeriod.reduce((a, r) => a + (r.parity?.explained ?? 0), 0);
  criteria.push({
    id: 'parity',
    label: 'Parità decisionale col backtest sugli stessi dati: zero divergenze non spiegate',
    ok: inPeriod.length > 0 && parityProblems.length === 0,
    detail: parityProblems.length ? parityProblems.join('; ') : `${inPeriod.length} giorni confrontati, ${explained} differenze spiegate da candele mancanti`,
  });

  const samples = inPeriod.reduce((a, r) => a + r.slippage.strategy.samples, 0);
  const weighted = inPeriod.reduce((a, r) => a + (r.slippage.strategy.avgBps ?? 0) * r.slippage.strategy.samples, 0);
  const model = inPeriod[0]?.slippage.modelBps ?? 5;
  const avg = samples > 0 ? weighted / samples : null;
  criteria.push({
    id: 'slippage',
    label: `Slippage medio delle decisioni entro il modello (${model} bps)`,
    ok: avg !== null && avg <= model + 1e-9,
    detail: avg === null ? 'nessun fill nel periodo: criterio non verificabile, prolunga la demo' : `${Math.round(avg * 100) / 100} bps su ${samples} fill`,
  });

  const review: string[] = [];
  const counted = new Set<string>([...PROTECTION_CODES, ...DESYNC_CODES]);
  for (const r of inPeriod) {
    const others = Object.entries(r.alerts.byCode).filter(([code]) => !counted.has(code));
    if (r.alerts.critical > 0) review.push(`${r.day}: ${r.alerts.critical} alert critici (${others.map(([c, n]) => `${c}×${n}`).join(', ') || 'vedi sopra'})`);
    for (const issue of r.issues) review.push(`${r.day}: ${issue}`);
  }

  return { ok: criteria.every((c) => c.ok), fromDay, toDay, criteria, review };
}

export function formatGoLive(e: GoLiveEvaluation): string {
  const lines = [
    `# Criteri misurabili del go-live ${e.fromDay} → ${e.toDay}: ${e.ok ? 'SUPERATI' : 'NON SUPERATI'}`,
    '',
    '| Criterio | Esito | Dettaglio |',
    '|---|---|---|',
    ...e.criteria.map((c) => `| ${c.label} | ${c.ok ? 'OK' : 'NO'} | ${c.detail} |`),
  ];
  if (e.review.length) lines.push('', '**Da rivedere (non bloccano, vanno spiegati):**', ...e.review.map((r) => `- ${r}`));
  lines.push('', 'Gli altri punti di GO_LIVE_CHECKLIST.md (limiti live, alert provati, kill switch in demo) si verificano a mano.');
  return lines.join('\n');
}

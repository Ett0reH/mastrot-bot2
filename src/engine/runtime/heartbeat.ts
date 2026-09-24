// Heartbeat dei cicli del runtime (F6): alert HEARTBEAT_MISSING se lo scheduler smette di girare.
//
// Lo scheduler registra la fine di ogni ciclo (protezione e decisione, qualunque ne sia l'esito:
// qui interessa che i cicli girino, i dati fermi hanno il loro alert STALE_DATA). Il controllo
// avviene in due modi indipendenti dallo scheduler:
// - il cron esterno chiama `/api/cron/tick`, che risponde 503 se l'heartbeat manca (così anche il
//   servizio di cron segnala il problema, e segnala da solo il processo morto o bloccato);
// - un watchdog con un proprio timer nel processo.
// L'alert parte al passaggio da sano a non sano (non a ogni controllo) e al ritorno alla normalità.
import type { AlertCode, AlertLevel } from '../ops/alerts';

export interface HeartbeatOptions {
  /** Oltre questa età del ciclo di protezione: heartbeat mancante (default 90 s, 4-5 cicli). */
  protectionStaleMs?: number;
  /** Oltre questa età del ciclo decisionale: heartbeat mancante (default 20 minuti). */
  decisionStaleMs?: number;
}

export interface HeartbeatStatus {
  healthy: boolean;
  issues: string[];
  lastProtectionAt: string | null;
  lastDecisionAt: string | null;
}

export type RaiseAlert = (level: AlertLevel, code: AlertCode, message: string) => Promise<void>;

export class HeartbeatMonitor {
  private lastProtection: number | null = null;
  private lastDecision: number | null = null;
  private healthy = true;
  readonly protectionStaleMs: number;
  readonly decisionStaleMs: number;

  constructor(private readonly startedAt: number, private readonly raise: RaiseAlert, options: HeartbeatOptions = {}) {
    this.protectionStaleMs = options.protectionStaleMs ?? 90_000;
    this.decisionStaleMs = options.decisionStaleMs ?? 20 * 60_000;
  }

  beatProtection(t: number): void {
    this.lastProtection = t;
  }

  beatDecision(t: number): void {
    this.lastDecision = t;
  }

  /** Stato dell'heartbeat; alla transizione sano ↔ non sano invia l'alert. */
  async check(now: number): Promise<HeartbeatStatus> {
    const issues: string[] = [];
    const protectionAge = now - (this.lastProtection ?? this.startedAt);
    const decisionAge = now - (this.lastDecision ?? this.startedAt);
    if (protectionAge > this.protectionStaleMs) issues.push(`ciclo di protezione fermo da ${Math.round(protectionAge / 1000)} s`);
    if (decisionAge > this.decisionStaleMs) issues.push(`ciclo decisionale fermo da ${Math.round(decisionAge / 60_000)} min`);
    const healthy = issues.length === 0;
    if (!healthy && this.healthy) await this.raise('critical', 'HEARTBEAT_MISSING', `Heartbeat mancante: ${issues.join('; ')}. Stop nativi su Kraken attivi, nessuna gestione del bot`);
    if (healthy && !this.healthy) await this.raise('info', 'HEARTBEAT_MISSING', 'Heartbeat di nuovo regolare: cicli del runtime attivi');
    this.healthy = healthy;
    return {
      healthy,
      issues,
      lastProtectionAt: this.lastProtection === null ? null : new Date(this.lastProtection).toISOString(),
      lastDecisionAt: this.lastDecision === null ? null : new Date(this.lastDecision).toISOString(),
    };
  }
}

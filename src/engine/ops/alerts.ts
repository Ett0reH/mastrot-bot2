// Alert operativi (F3; canali Telegram/webhook in F6: alertChannels.ts).
import type { CycleContext } from './logger';
export type AlertLevel = 'info' | 'warning' | 'critical';

export type AlertCode =
  | 'ENTRY'
  | 'EXIT'
  | 'EXECUTION_ERROR'
  | 'LEVERAGE_NOT_SET'
  | 'STOP_MISSING'
  | 'STOP_RESTORED'
  | 'STOP_PLACEMENT_FAILED'
  | 'EMERGENCY_CLOSE'
  | 'DESYNC'
  | 'UNKNOWN_POSITION'
  | 'UNKNOWN_ORDER'
  | 'ORDER_UNKNOWN_STATE'
  | 'STALE_DATA'
  | 'LEASE_LOST'
  | 'KILL_SWITCH'
  | 'HEARTBEAT_MISSING'
  | 'RISK_REJECTED'
  /** Limite di rischio superato: perdita giornaliera (blocco ingressi) o drawdown (REDUCE_ONLY). */
  | 'RISK_LIMIT'
  | 'MODE_CHANGE'
  | 'ACCOUNT_TRANSFER'
  /** Riepilogo giornaliero (F6). */
  | 'DAILY_REPORT'
  /** Alert di prova inviato a mano per verificare il canale. */
  | 'TEST';

export interface Alert {
  level: AlertLevel;
  code: AlertCode;
  message: string;
  context?: Record<string, unknown>;
  at: string;
}

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}

export class MemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];

  async send(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }

  codes(): AlertCode[] {
    return this.alerts.map((a) => a.code);
  }
}

export interface LogAlertOptions {
  /** Ciclo in corso (correlation id `cycleId`). */
  cycle?: CycleContext;
  /** Oscuramento dei segreti (Logger.redact). */
  redact?: (text: string) => string;
}

/**
 * Alert sul log strutturato (una riga JSON su stdout), sempre attivo accanto al canale esterno.
 * I correlation id del contesto (positionId, cliOrdId) e il ciclo in corso stanno in cima alla riga.
 */
export class LogAlertSink implements AlertSink {
  constructor(private readonly write: (line: string) => void = (line) => console.log(line), private readonly options: LogAlertOptions = {}) {}

  async send(alert: Alert): Promise<void> {
    const ids: Record<string, string> = {};
    const cycleId = this.options.cycle?.current;
    if (cycleId) ids.cycleId = cycleId;
    for (const key of ['positionId', 'cliOrdId'] as const) {
      const value = alert.context?.[key];
      if (typeof value === 'string') ids[key] = value;
    }
    const line = JSON.stringify({ type: 'alert', level: alert.level, code: alert.code, at: alert.at, message: alert.message, ...ids, ...(alert.context ? { context: alert.context } : {}) });
    this.write(this.options.redact ? this.options.redact(line) : line);
  }
}

/**
 * Tiene gli ultimi alert di tutti i componenti (runtime, porta Kraken, StopManager) per la
 * dashboard e l'health, e li inoltra al canale. Registra prima di inoltrare: anche se il canale
 * fallisce, l'alert resta visibile.
 */
export class RecordingAlertSink implements AlertSink {
  readonly recent: Alert[] = [];

  constructor(private readonly inner: AlertSink, private readonly limit = 100) {}

  async send(alert: Alert): Promise<void> {
    this.recent.push(alert);
    if (this.recent.length > this.limit) this.recent.splice(0, this.recent.length - this.limit);
    await this.inner.send(alert);
  }
}

export function makeAlert(now: number, level: AlertLevel, code: AlertCode, message: string, context?: Record<string, unknown>): Alert {
  return { level, code, message, at: new Date(now).toISOString(), ...(context ? { context } : {}) };
}

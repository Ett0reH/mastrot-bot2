// Alert operativi (F3; canali Telegram/webhook in F6).
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
  | 'MODE_CHANGE'
  | 'ACCOUNT_TRANSFER';

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

/** Alert sul log strutturato (JSON su stdout), finché i canali della F6 non sono attivi. */
export class LogAlertSink implements AlertSink {
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  async send(alert: Alert): Promise<void> {
    this.write(JSON.stringify({ type: 'alert', ...alert }));
  }
}

export function makeAlert(now: number, level: AlertLevel, code: AlertCode, message: string, context?: Record<string, unknown>): Alert {
  return { level, code, message, at: new Date(now).toISOString(), ...(context ? { context } : {}) };
}

// Log strutturati (F6): una riga JSON per evento, con i correlation id del bot.
//
//   {"type":"log","level":"warn","at":"…","message":"…","cycleId":"D-…","positionId":"…","cliOrdId":"…"}
//
// - `cycleId` identifica il ciclo in corso (D- decisionale, P- protezione, K- kill switch): lo
//   imposta il runtime in un `CycleContext` condiviso, così ogni riga scritta durante il ciclo
//   (runtime, ordini, adapter, alert) lo riporta senza passarlo a mano.
// - `positionId` e `cliOrdId` arrivano dal contesto di chi scrive (ordini, stop, posizioni).
// - I segreti della configurazione non finiscono mai nei log: ogni occorrenza diventa [REDACTED].
// - Gli ultimi warning ed errori restano in memoria per l'endpoint di health.
import type { EngineConfig } from '../config/config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  type: 'log';
  level: LogLevel;
  at: string;
  message: string;
  cycleId?: string;
  positionId?: string;
  cliOrdId?: string;
  [key: string]: unknown;
}

/** Ciclo in corso, condiviso tra tutti i logger dello stesso processo. */
export class CycleContext {
  current: string | null = null;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  now?: () => number;
  /** Valori da non scrivere mai (chiavi, token): sostituiti con [REDACTED]. */
  secrets?: readonly string[];
  cycle?: CycleContext;
  /** Warning ed errori recenti tenuti in memoria. */
  recentLimit?: number;
  /** Livello minimo scritto (default info). */
  minLevel?: LogLevel;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const CORRELATION_KEYS = ['cycleId', 'positionId', 'cliOrdId'] as const;
const RESERVED = new Set(['type', 'level', 'at', 'message']);
/** Segreti più corti non vengono cercati: sostituirebbero frammenti innocui. */
const MIN_SECRET_LENGTH = 6;

interface Shared {
  write: (line: string) => void;
  now: () => number;
  secrets: string[];
  cycle: CycleContext | null;
  recent: LogRecord[];
  recentLimit: number;
  minLevel: LogLevel;
}

function plain(value: unknown): unknown {
  if (value instanceof Error) return value.message;
  return value;
}

export class Logger {
  private readonly shared: Shared;

  constructor(options: LoggerOptions = {}, private readonly base: Record<string, unknown> = {}, shared?: Shared) {
    this.shared = shared ?? {
      write: options.write ?? ((line) => console.log(line)),
      now: options.now ?? (() => Date.now()),
      secrets: [...new Set((options.secrets ?? []).filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length),
      cycle: options.cycle ?? null,
      recent: [],
      recentLimit: options.recentLimit ?? 50,
      minLevel: options.minLevel ?? 'info',
    };
  }

  /** Logger che non scrive nulla (test e componenti senza log). */
  static silent(): Logger {
    return new Logger({ write: () => undefined });
  }

  /** Logger con un contesto fisso aggiunto a ogni riga. */
  child(context: Record<string, unknown>): Logger {
    return new Logger({}, { ...this.base, ...context }, this.shared);
  }

  get cycle(): CycleContext | null {
    return this.shared.cycle;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }

  log(level: LogLevel, message: string, context: Record<string, unknown> = {}): void {
    if (ORDER[level] < ORDER[this.shared.minLevel]) return;
    const merged: Record<string, unknown> = { ...this.base };
    for (const [k, v] of Object.entries(context)) if (v !== undefined) merged[k] = plain(v);
    const record: LogRecord = { type: 'log', level, at: new Date(this.shared.now()).toISOString(), message };
    const cycleId = merged.cycleId ?? this.shared.cycle?.current ?? undefined;
    if (cycleId !== undefined) record.cycleId = String(cycleId);
    for (const key of CORRELATION_KEYS) if (key !== 'cycleId' && merged[key] !== undefined) record[key] = String(merged[key]);
    for (const [k, v] of Object.entries(merged)) {
      if ((CORRELATION_KEYS as readonly string[]).includes(k)) continue;
      record[RESERVED.has(k) ? `ctx_${k}` : k] = v; // il contesto non sovrascrive i campi della riga
    }
    const line = this.redact(JSON.stringify(record));
    if (ORDER[level] >= ORDER.warn) {
      this.shared.recent.push(JSON.parse(line) as LogRecord);
      if (this.shared.recent.length > this.shared.recentLimit) this.shared.recent.splice(0, this.shared.recent.length - this.shared.recentLimit);
    }
    this.shared.write(line);
  }

  /** Ultimi warning ed errori, dal più recente. */
  recentProblems(limit = 20): LogRecord[] {
    return this.shared.recent.slice(-limit).reverse();
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.shared.secrets) {
      // Il segreto può comparire anche con l'escape JSON (es. una chiave privata con "\n").
      for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) out = out.split(form).join('[REDACTED]');
    }
    return out;
  }
}

/** Segreti della configurazione da oscurare nei log e negli alert. */
export function configSecrets(config: EngineConfig): string[] {
  const out: (string | null | undefined)[] = [
    config.kraken.credentials?.apiKey,
    config.kraken.credentials?.apiSecret,
    config.auth.adminToken,
    config.auth.cronToken,
    config.alerts.telegram?.botToken,
    config.alerts.webhookUrl,
    config.firebase.serviceAccountJson,
  ];
  if (config.firebase.serviceAccountJson) {
    try {
      const sa = JSON.parse(config.firebase.serviceAccountJson) as { private_key?: string; private_key_id?: string };
      out.push(sa.private_key, sa.private_key_id);
    } catch {
      // JSON non valido: resta oscurato per intero
    }
  }
  return out.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

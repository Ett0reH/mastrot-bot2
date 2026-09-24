// Scheduler interno del runtime (F4, D24): l'unica cosa che fa avanzare il motore.
// - ciclo decisionale alla fine di ogni slot 15m più un margine (le candele devono essere
//   pubblicate); se il ciclo aspetta una candela o fallisce, riprova dopo `retryMs`;
// - ciclo di protezione ogni `protectionIntervalMs` (15-30 s).
// Le richieste HTTP e il cron esterno leggono solo lo stato.
import { BAR_15M_MS } from '../data/dataset';
import type { BotRuntime } from './botRuntime';

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_TIMERS: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  protectionIntervalMs?: number;
  decisionMarginMs?: number;
  retryMs?: number;
}

export class RuntimeScheduler {
  private decisionHandle: unknown = null;
  private protectionHandle: unknown = null;
  private running = false;
  readonly protectionIntervalMs: number;
  readonly decisionMarginMs: number;
  readonly retryMs: number;
  lastHeartbeat: number | null = null;

  constructor(private readonly runtime: BotRuntime, private readonly timers: Timers = REAL_TIMERS, options: SchedulerOptions = {}) {
    this.protectionIntervalMs = options.protectionIntervalMs ?? 20_000;
    this.decisionMarginMs = options.decisionMarginMs ?? 45_000;
    this.retryMs = options.retryMs ?? 20_000;
    if (this.protectionIntervalMs < 15_000 || this.protectionIntervalMs > 30_000) throw new Error('Il ciclo di protezione deve girare ogni 15-30 s');
  }

  /** Prossimo istante di decisione: fine del prossimo slot 15m + margine. */
  nextDecisionAt(now: number): number {
    const next = Math.floor((now - this.decisionMarginMs) / BAR_15M_MS) * BAR_15M_MS + BAR_15M_MS + this.decisionMarginMs;
    return next > now ? next : next + BAR_15M_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleProtection(0);
    this.scheduleDecision(this.nextDecisionAt(this.timers.now()) - this.timers.now());
  }

  stop(): void {
    this.running = false;
    if (this.decisionHandle !== null) this.timers.clearTimeout(this.decisionHandle);
    if (this.protectionHandle !== null) this.timers.clearTimeout(this.protectionHandle);
    this.decisionHandle = this.protectionHandle = null;
  }

  private scheduleDecision(delay: number): void {
    if (!this.running) return;
    this.decisionHandle = this.timers.setTimeout(() => void this.runDecision(), Math.max(0, delay));
  }

  private scheduleProtection(delay: number): void {
    if (!this.running) return;
    this.protectionHandle = this.timers.setTimeout(() => void this.runProtection(), Math.max(0, delay));
  }

  private async runDecision(): Promise<void> {
    let retry = false;
    try {
      const result = await this.runtime.decisionTick(this.timers.now());
      retry = result === null || result.waiting;
    } catch {
      retry = true;
    }
    const now = this.timers.now();
    const next = this.nextDecisionAt(now);
    this.scheduleDecision(retry ? Math.min(this.retryMs, next - now) : next - now);
  }

  private async runProtection(): Promise<void> {
    try {
      await this.runtime.protectionTick(this.timers.now());
      this.lastHeartbeat = this.timers.now();
    } catch {
      // l'errore è già nello stato del runtime (lastError); il ciclo continua
    }
    this.scheduleProtection(this.protectionIntervalMs);
  }
}

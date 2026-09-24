// Circuit breaker sugli errori ripetuti di Kraken (F3).
//
// Dopo `failureThreshold` errori transitori consecutivi il circuito si apre: le chiamate
// "normali" (ingressi, letture non urgenti) falliscono subito per `cooldownMs`, senza
// martellare un'API in difficoltà. Le operazioni di protezione (stop, chiusure d'emergenza)
// passano comunque: ridurre il rischio ha la precedenza. Dopo il cooldown una chiamata di prova
// (half-open) decide se richiudere.
import type { KrakenErrorKind } from './errors';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = { failureThreshold: 5, cooldownMs: 60_000 };

const COUNTED: ReadonlySet<KrakenErrorKind> = new Set(['rate_limit', 'transient', 'network', 'timeout', 'unknown']);

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(private readonly config: CircuitBreakerConfig, private readonly now: () => number) {}

  get state(): CircuitState {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.config.cooldownMs ? 'half_open' : 'open';
  }

  /** true se una chiamata normale può partire. */
  allow(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'open') return false;
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  onFailure(kind: KrakenErrorKind): void {
    this.trialInFlight = false;
    if (!COUNTED.has(kind)) return;
    this.failures++;
    if (this.openedAt !== null || this.failures >= this.config.failureThreshold) this.openedAt = this.now();
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}

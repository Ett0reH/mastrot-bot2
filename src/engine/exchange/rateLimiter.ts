// Rate limiter a costi (token bucket) per le API private di Kraken Futures.
//
// Kraken assegna a ogni endpoint privato un costo e un budget che si ricarica nel tempo. I
// valori qui sotto vanno VERIFICATI sulla documentazione ufficiale (docs.kraken.com, "Futures
// rate limits"), non raggiungibile da questo ambiente: sono prudenti (budget dimezzato rispetto
// a quanto ricordato della documentazione) e sono configurabili. Un 429 / apiLimitExceeded
// reale fa comunque scattare il backoff dell'adapter.
export interface RateLimitConfig {
  /** Costo massimo accumulabile. */
  capacity: number;
  /** Intervallo in cui il budget si ricarica completamente. */
  refillIntervalMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { capacity: 250, refillIntervalMs: 10_000 };

/** Costo per endpoint (default prudenti, da verificare). Gli endpoint pubblici non consumano budget. */
export const ENDPOINT_COSTS: Readonly<Record<string, number>> = {
  sendorder: 10,
  editorder: 10,
  cancelorder: 10,
  cancelallorders: 25,
  openorders: 2,
  'orders/status': 2,
  openpositions: 2,
  fills: 2,
  accounts: 2,
  leveragepreferences: 2,
  'leveragepreferences:set': 10,
  transfer: 10,
  // Le API di storico hanno un budget separato su Kraken: si leggono di rado (ogni 10 minuti).
  accountlog: 10,
  instruments: 0,
  tickers: 0,
};

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly config: RateLimitConfig, private readonly now: () => number) {
    if (!(config.capacity > 0) || !(config.refillIntervalMs > 0)) throw new Error('Rate limit non valido');
    this.tokens = config.capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last);
    this.tokens = Math.min(this.config.capacity, this.tokens + (elapsed * this.config.capacity) / this.config.refillIntervalMs);
    this.last = t;
  }

  /** Millisecondi da attendere prima che `cost` sia disponibile (0 = disponibile ora). */
  waitFor(cost: number): number {
    if (cost > this.config.capacity) throw new Error(`Costo ${cost} oltre la capacità del rate limiter`);
    this.refill();
    if (this.tokens >= cost) return 0;
    return Math.ceil(((cost - this.tokens) * this.config.refillIntervalMs) / this.config.capacity);
  }

  /** Consuma `cost` (da chiamare quando waitFor ha restituito 0). */
  take(cost: number): void {
    this.refill();
    if (this.tokens < cost) throw new Error('Rate limiter: budget insufficiente');
    this.tokens -= cost;
  }

  /** Dopo un 429 reale: svuota il budget, così le richieste successive aspettano la ricarica. */
  drain(): void {
    this.refill();
    this.tokens = 0;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }
}

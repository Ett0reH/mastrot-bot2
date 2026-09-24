// KrakenAdapter: l'unico punto da cui il bot parla con Kraken Futures (F3, D33).
//
// - Letture: rate limiter a costi, timeout, retry con backoff esponenziale sugli errori
//   transitori, circuit breaker.
// - Scritture (ordini, modifiche, cancellazioni, leva, trasferimenti): UN SOLO tentativo. Se la
//   chiamata fallisce dopo che la richiesta potrebbe essere arrivata a Kraken, l'esito è
//   incerto e lo decide la riconciliazione (OrderManager). Un retry cieco potrebbe duplicare un
//   ordine (D18).
// - Le operazioni di protezione (stop, chiusure d'emergenza) passano anche col circuito aperto.
import type {
  FuturesAccounts,
  FuturesCancelAllOrdersStatus,
  FuturesCancelOrderParams,
  FuturesCancelOrderStatus,
  FuturesEditOrderParams,
  FuturesEditOrderStatus,
  FuturesFill,
  FuturesInitiateWalletTransferParams,
  FuturesInstrument,
  FuturesLeveragePreference,
  FuturesOpenOrder,
  FuturesOpenPosition,
  FuturesOrderStatusInfo,
  FuturesSendOrderParams,
  FuturesSendOrderStatus,
  FuturesTicker,
} from '@siebly/kraken-api';
import { CircuitBreaker, type CircuitBreakerConfig, DEFAULT_CIRCUIT_BREAKER } from './circuitBreaker';
import { classifyKrakenError, KrakenCallError } from './errors';
import type { KrakenFuturesApi } from './krakenApi';
import { DEFAULT_RATE_LIMIT, ENDPOINT_COSTS, type RateLimitConfig, TokenBucket } from './rateLimiter';

export type Priority = 'normal' | 'protective';

// Discriminante stringa: le union con discriminante booleano non si restringono senza
// strictNullChecks (tsconfig legacy), e questo modulo è importato anche dal codice legacy.
export type WriteResult<T> = { outcome: 'ok'; value: T } | { outcome: 'failed'; error: KrakenCallError };

export interface AdapterOptions {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Timeout di ogni chiamata (oltre a quello di rete del client). */
  timeoutMs?: number;
  /** Tentativi totali per le letture. */
  readAttempts?: number;
  rateLimit?: RateLimitConfig;
  circuitBreaker?: CircuitBreakerConfig;
  log?: (event: { level: 'info' | 'warn' | 'error'; message: string; context?: Record<string, unknown> }) => void;
}

export class KrakenAdapter {
  readonly bucket: TokenBucket;
  readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;
  private readonly readAttempts: number;

  constructor(private readonly api: KrakenFuturesApi, private readonly options: AdapterOptions) {
    this.bucket = new TokenBucket(options.rateLimit ?? DEFAULT_RATE_LIMIT, options.now);
    this.breaker = new CircuitBreaker(options.circuitBreaker ?? DEFAULT_CIRCUIT_BREAKER, options.now);
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.readAttempts = options.readAttempts ?? 3;
  }

  private log(level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>): void {
    this.options.log?.({ level, message, context });
  }

  private async withTimeout<T>(promise: Promise<T>, endpoint: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new KrakenCallError('timeout', `Kraken: timeout di ${this.timeoutMs} ms su ${endpoint}`)), this.timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Una singola chiamata: circuit breaker, rate limiter, timeout, classificazione dell'errore. */
  private async once<T>(endpoint: string, call: () => Promise<T>, priority: Priority): Promise<T> {
    if (priority === 'normal' && !this.breaker.allow()) {
      throw new KrakenCallError('circuit_open', `Kraken: circuit breaker aperto, ${endpoint} non inviato`);
    }
    const cost = ENDPOINT_COSTS[endpoint];
    if (cost === undefined) throw new Error(`Costo del rate limiter non definito per ${endpoint}`);
    for (let wait = this.bucket.waitFor(cost); wait > 0; wait = this.bucket.waitFor(cost)) await this.options.sleep(wait);
    this.bucket.take(cost);
    try {
      const value = await this.withTimeout(call(), endpoint);
      this.breaker.onSuccess();
      return value;
    } catch (err) {
      const error = classifyKrakenError(err);
      this.breaker.onFailure(error.kind);
      if (error.kind === 'rate_limit') this.bucket.drain();
      this.log('warn', `Kraken ${endpoint}: ${error.message}`, { kind: error.kind, httpStatus: error.httpStatus, apiError: error.apiError });
      throw error;
    }
  }

  private async read<T>(endpoint: string, call: () => Promise<T>, priority: Priority = 'normal'): Promise<T> {
    let last: KrakenCallError | null = null;
    for (let attempt = 1; attempt <= this.readAttempts; attempt++) {
      try {
        return await this.once(endpoint, call, priority);
      } catch (err) {
        last = err as KrakenCallError;
        if (!last.retryableRead || attempt === this.readAttempts) break;
        await this.options.sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)));
      }
    }
    throw last ?? new KrakenCallError('unknown', `Kraken ${endpoint}: nessun tentativo`);
  }

  private async write<T>(endpoint: string, call: () => Promise<T>, priority: Priority): Promise<WriteResult<T>> {
    try {
      return { outcome: 'ok', value: await this.once(endpoint, call, priority) };
    } catch (err) {
      return { outcome: 'failed', error: err as KrakenCallError };
    }
  }

  // --- Letture --------------------------------------------------------------------------

  async instruments(): Promise<FuturesInstrument[]> {
    return (await this.read('instruments', () => this.api.getInstruments())).instruments;
  }

  async tickers(): Promise<FuturesTicker[]> {
    return (await this.read('tickers', () => this.api.getTickers())).tickers;
  }

  async openOrders(priority: Priority = 'normal'): Promise<FuturesOpenOrder[]> {
    return (await this.read('openorders', () => this.api.getOpenOrders(), priority)).openOrders;
  }

  async orderStatus(params: { cliOrdIds?: string[]; orderIds?: string[] }, priority: Priority = 'normal'): Promise<FuturesOrderStatusInfo[]> {
    return (await this.read('orders/status', () => this.api.getOrderStatus(params), priority)).orders;
  }

  async openPositions(priority: Priority = 'normal'): Promise<FuturesOpenPosition[]> {
    return (await this.read('openpositions', () => this.api.getOpenPositions(), priority)).openPositions;
  }

  /** Ultimi fill (Kraken ne restituisce al massimo 100 per pagina, prima di `lastFillTime`). */
  async fills(lastFillTime?: string, priority: Priority = 'normal'): Promise<FuturesFill[]> {
    return (await this.read('fills', () => this.api.getFills(lastFillTime ? { lastFillTime } : undefined), priority)).fills;
  }

  async accounts(): Promise<FuturesAccounts> {
    return (await this.read('accounts', () => this.api.getAccounts())).accounts;
  }

  async leverageSettings(): Promise<FuturesLeveragePreference[]> {
    return (await this.read('leveragepreferences', () => this.api.getLeverageSettings())).leveragePreferences;
  }

  // --- Scritture (un solo tentativo) -----------------------------------------------------

  async sendOrder(params: FuturesSendOrderParams, priority: Priority = 'normal'): Promise<WriteResult<FuturesSendOrderStatus>> {
    const r = await this.write('sendorder', () => this.api.submitOrder(params), priority);
    return r.outcome === 'ok' ? { outcome: 'ok', value: r.value.sendStatus } : r;
  }

  async editOrder(params: FuturesEditOrderParams, priority: Priority = 'protective'): Promise<WriteResult<FuturesEditOrderStatus>> {
    const r = await this.write('editorder', () => this.api.editOrder(params), priority);
    return r.outcome === 'ok' ? { outcome: 'ok', value: r.value.editStatus } : r;
  }

  async cancelOrder(params: FuturesCancelOrderParams, priority: Priority = 'normal'): Promise<WriteResult<FuturesCancelOrderStatus>> {
    const r = await this.write('cancelorder', () => this.api.cancelOrder(params), priority);
    return r.outcome === 'ok' ? { outcome: 'ok', value: r.value.cancelStatus } : r;
  }

  async cancelAllOrders(symbol: string | undefined, priority: Priority = 'protective'): Promise<WriteResult<FuturesCancelAllOrdersStatus>> {
    const r = await this.write('cancelallorders', () => this.api.cancelAllOrders(symbol ? { symbol } : undefined), priority);
    return r.outcome === 'ok' ? { outcome: 'ok', value: r.value.cancelStatus } : r;
  }

  async setLeverage(symbol: string, maxLeverage: number): Promise<WriteResult<true>> {
    const r = await this.write('leveragepreferences:set', () => this.api.setLeverageSettings({ symbol, maxLeverage }), 'normal');
    return r.outcome === 'ok' ? { outcome: 'ok', value: true } : r;
  }

  async walletTransfer(params: FuturesInitiateWalletTransferParams): Promise<WriteResult<true>> {
    const r = await this.write('transfer', () => this.api.submitWalletTransfer(params), 'protective');
    return r.outcome === 'ok' ? { outcome: 'ok', value: true } : r;
  }
}

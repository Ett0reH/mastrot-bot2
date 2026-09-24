// Classificazione degli errori delle chiamate a Kraken Futures.
//
// Forma degli errori di @siebly/kraken-api (dist/mjs/lib/BaseRestClient.js, `_call` e
// `parseException`):
// - risposta HTTP 200 con `{ result: 'error', error: '<codice>' }` → viene lanciato
//   `{ code: 200, message, body: { result: 'error', error, serverTime }, headers, ... }`;
// - risposta HTTP non 2xx → `{ code: <status>, message, body, headers, ... }`;
// - nessuna risposta (rete, timeout di axios) → l'errore di axios (con `code`, es. ECONNRESET,
//   ECONNABORTED) oppure una stringa se la richiesta non è partita.
// La classificazione serve a decidere backoff e circuit breaker. NON decide l'esito di un
// ordine: dopo un errore su una scrittura l'ordine è in stato sconosciuto finché la
// riconciliazione non lo chiarisce (invariante I9).

export type KrakenErrorKind =
  | 'rate_limit' // 429 o apiLimitExceeded: richiesta rifiutata prima dell'elaborazione
  | 'transient' // 5xx: il server potrebbe averla elaborata
  | 'network' // nessuna risposta: potrebbe essere arrivata
  | 'timeout' // timeout del client: potrebbe essere arrivata
  | 'auth' // credenziali o nonce: rifiutata prima dell'elaborazione
  | 'rejected' // altri 4xx o errori applicativi noti: rifiutata
  | 'circuit_open' // non inviata: circuit breaker aperto
  | 'unknown';

export class KrakenCallError extends Error {
  constructor(
    readonly kind: KrakenErrorKind,
    message: string,
    readonly httpStatus: number | null = null,
    readonly apiError: string | null = null,
  ) {
    super(message);
    this.name = 'KrakenCallError';
  }

  /** true se la richiesta potrebbe essere stata elaborata da Kraken (esito di una scrittura incerto). */
  get mayHaveReachedExchange(): boolean {
    return this.kind === 'transient' || this.kind === 'network' || this.kind === 'timeout' || this.kind === 'unknown';
  }

  /** true se ha senso ritentare una LETTURA (le scritture non si ritentano mai alla cieca). */
  get retryableRead(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'transient' || this.kind === 'network' || this.kind === 'timeout';
  }
}

// Codici applicativi di Kraken Futures riconosciuti. Documentazione ufficiale non raggiungibile
// da questo ambiente: i codici non elencati restano 'unknown' (trattati come esito incerto).
const RATE_LIMIT_ERRORS = new Set(['apiLimitExceeded']);
const AUTH_ERRORS = new Set(['authenticationError', 'nonceBelowThreshold', 'nonceDuplicate']);

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_NETWORK']);
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function classifyKrakenError(err: unknown): KrakenCallError {
  if (err instanceof KrakenCallError) return err;
  if (typeof err === 'string') return new KrakenCallError('network', err);
  const e = asRecord(err);
  if (!e) return new KrakenCallError('unknown', String(err));

  const status = typeof e.code === 'number' ? e.code : null;
  const body = asRecord(e.body);
  const apiError = body && body.result === 'error' && typeof body.error === 'string' ? body.error : null;
  if (status !== null) {
    if (status === 429 || (apiError !== null && RATE_LIMIT_ERRORS.has(apiError))) return new KrakenCallError('rate_limit', `Kraken: limite di richieste (${apiError ?? status})`, status, apiError);
    if (apiError !== null && AUTH_ERRORS.has(apiError)) return new KrakenCallError('auth', `Kraken: autenticazione rifiutata (${apiError})`, status, apiError);
    if (status === 401 || status === 403) return new KrakenCallError('auth', `Kraken: HTTP ${status}`, status, apiError);
    if (status >= 500) return new KrakenCallError('transient', `Kraken: HTTP ${status}`, status, apiError);
    if (status >= 400) return new KrakenCallError('rejected', `Kraken: HTTP ${status}${apiError ? ` (${apiError})` : ''}`, status, apiError);
    if (apiError !== null) return new KrakenCallError('unknown', `Kraken: errore ${apiError}`, status, apiError);
  }
  const code = typeof e.code === 'string' ? e.code : null;
  const message = typeof e.message === 'string' ? e.message : 'errore sconosciuto';
  if (code && TIMEOUT_CODES.has(code)) return new KrakenCallError('timeout', `Kraken: timeout (${code})`);
  if (code && NETWORK_CODES.has(code)) return new KrakenCallError('network', `Kraken: rete (${code})`);
  return new KrakenCallError('unknown', `Kraken: ${message}`);
}

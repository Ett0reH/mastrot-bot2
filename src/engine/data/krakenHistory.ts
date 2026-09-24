// Download dello storico pubblico di Kraken Futures: candele (charts API) e funding rate.
//
// Endpoint usati (API pubbliche, nessuna chiave richiesta):
//   GET {base}/api/charts/v1/trade/{symbol}/15m?from={sec}&to={sec}
//       → { candles: [{ time: ms, open, high, low, close, volume }], more_candles: boolean }
//   GET {base}/derivatives/api/v4/historicalfundingrates?symbol={symbol}
//       → { rates: [{ timestamp: ISO, fundingRate: number, relativeFundingRate: number }] }
// I formati vanno verificati sulla documentazione ufficiale (docs.kraken.com, Futures API) al
// primo utilizzo: i parser qui sotto validano la forma della risposta e falliscono in modo
// esplicito se non corrisponde, invece di produrre dati silenziosamente sbagliati.
import { BAR_15M_MS, type Candle } from './dataset';

export const KRAKEN_FUTURES_BASE_URL = 'https://futures.kraken.com';

export interface HttpResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<HttpResponseLike>;

export interface DownloadOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  maxAttempts?: number;
  windowBars?: number;
  log?: (message: string) => void;
}

export class KrakenHistoryError extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function defaultFetch(url: string): Promise<HttpResponseLike> {
  return fetch(url, { headers: { accept: 'application/json' } });
}

/**
 * GET con retry limitato. Ritenta solo errori transitori (rete, 429, 5xx) con backoff
 * esponenziale; un 4xx diverso da 429 fallisce subito. Dopo `maxAttempts` tentativi lancia.
 */
export async function fetchJsonWithRetry(url: string, options: DownloadOptions = {}): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 5;
  let lastError = 'nessun tentativo';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: HttpResponseLike;
    try {
      response = await fetchImpl(url);
    } catch (err) {
      lastError = `errore di rete: ${(err as Error).message}`;
      if (attempt < maxAttempts) await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
      continue;
    }
    if (response.status === 200) return response.json();
    lastError = `HTTP ${response.status}`;
    const transient = response.status === 429 || response.status >= 500;
    if (!transient) throw new KrakenHistoryError(`${url} → ${lastError} (errore non transitorio)`);
    if (attempt < maxAttempts) await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
  }
  throw new KrakenHistoryError(`${url} → fallito dopo ${maxAttempts} tentativi (${lastError})`);
}

function toNumber(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new KrakenHistoryError(`Campo ${field} non numerico: ${JSON.stringify(value)}`);
  }
  return n;
}

export function parseChartsResponse(body: unknown): { candles: Candle[]; more: boolean } {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { candles?: unknown }).candles)) {
    throw new KrakenHistoryError('Risposta charts senza array "candles"');
  }
  const raw = (body as { candles: unknown[]; more_candles?: unknown }).candles;
  const candles = raw.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw new KrakenHistoryError(`Candela ${i} non valida`);
    const c = item as Record<string, unknown>;
    return {
      t: toNumber(c.time, 'time'),
      o: toNumber(c.open, 'open'),
      h: toNumber(c.high, 'high'),
      l: toNumber(c.low, 'low'),
      c: toNumber(c.close, 'close'),
      v: toNumber(c.volume, 'volume'),
    };
  });
  const more = (body as { more_candles?: unknown }).more_candles === true;
  return { candles, more };
}

/**
 * Scarica le candele 15m chiuse di `native` in [fromMs, toMs], a finestre di `windowBars`
 * candele. Le finestre vuote (buchi di mercato) vengono saltate; il ciclo termina sempre.
 */
export async function downloadCandles(native: string, fromMs: number, toMs: number, options: DownloadOptions = {}): Promise<Candle[]> {
  const base = options.baseUrl ?? KRAKEN_FUTURES_BASE_URL;
  const windowBars = options.windowBars ?? 1000;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const out: Candle[] = [];
  let cursor = Math.floor(fromMs / BAR_15M_MS) * BAR_15M_MS;
  const lastAllowed = Math.min(toMs, now() - BAR_15M_MS); // solo candele già chiuse
  while (cursor <= lastAllowed) {
    const windowEnd = Math.min(cursor + (windowBars - 1) * BAR_15M_MS, lastAllowed);
    const url = `${base}/api/charts/v1/trade/${native}/15m?from=${cursor / 1000}&to=${windowEnd / 1000}`;
    const { candles, more } = parseChartsResponse(await fetchJsonWithRetry(url, options));
    const lastKept = out.length ? out[out.length - 1].t : -Infinity;
    const kept = candles
      .filter((c) => c.t >= cursor && c.t <= windowEnd && c.t > lastKept && c.t % BAR_15M_MS === 0)
      .sort((a, b) => a.t - b.t);
    for (const c of kept) {
      if (out.length === 0 || c.t > out[out.length - 1].t) out.push(c);
    }
    if (more && kept.length > 0 && kept[kept.length - 1].t < windowEnd) {
      cursor = kept[kept.length - 1].t + BAR_15M_MS;
    } else {
      cursor = windowEnd + BAR_15M_MS;
    }
    log(`${native}: ${out.length} candele fino a ${new Date(Math.min(cursor, lastAllowed)).toISOString()}`);
  }
  return out;
}

export interface FundingRate {
  t: number;
  fundingRate: number;
  relativeFundingRate: number;
}

export function parseFundingResponse(body: unknown): FundingRate[] {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { rates?: unknown }).rates)) {
    throw new KrakenHistoryError('Risposta historicalfundingrates senza array "rates"');
  }
  const rates = (body as { rates: unknown[] }).rates.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw new KrakenHistoryError(`Funding ${i} non valido`);
    const r = item as Record<string, unknown>;
    const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    if (!Number.isFinite(t)) throw new KrakenHistoryError(`Funding ${i}: timestamp non valido`);
    return {
      t,
      fundingRate: toNumber(r.fundingRate, 'fundingRate'),
      relativeFundingRate: toNumber(r.relativeFundingRate, 'relativeFundingRate'),
    };
  });
  rates.sort((a, b) => a.t - b.t);
  return rates;
}

export async function downloadFundingRates(native: string, options: DownloadOptions = {}): Promise<FundingRate[]> {
  const base = options.baseUrl ?? KRAKEN_FUTURES_BASE_URL;
  const url = `${base}/derivatives/api/v4/historicalfundingrates?symbol=${native}`;
  return parseFundingResponse(await fetchJsonWithRetry(url, options));
}

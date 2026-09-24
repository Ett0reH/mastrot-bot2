// Utility pure del live engine legacy, separate da liveEngine.ts perché quel modulo ha effetti
// collaterali all'import (inizializza Firebase e avvia il caricamento dello stato).
// La logica è invariata rispetto alle versioni originali in liveEngine.ts.
import ccxt from 'ccxt';

/** Rifiuta la promessa se non si risolve entro `timeoutMs`. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string = 'Operation'): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms. Please check network or quotas.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

export function delaySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ritenta gli errori transitori con backoff; gli errori non transitori vengono rilanciati subito. */
export async function ccxtWithRetry<T>(fn: () => Promise<T>, retries = 6, delay = 2000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await withTimeout(fn(), 30000, 'CCXT API Call');
    } catch (error: any) {
      if (i === retries - 1) throw error;

      const errMsg = error?.body?.error || error?.message || String(error);
      const isTransient =
        error instanceof ccxt.NetworkError ||
        (error instanceof ccxt.ExchangeError &&
          !errMsg.toLowerCase().includes('invalid') &&
          !errMsg.toLowerCase().includes('balance') &&
          !errMsg.toLowerCase().includes('margin') &&
          !errMsg.toLowerCase().includes('position')) ||
        errMsg.includes('Rate limit exceeded') ||
        errMsg.includes('timeout') ||
        errMsg.includes('network') ||
        errMsg.includes('ECONNRESET') ||
        errMsg.includes('502') ||
        errMsg.includes('503') ||
        errMsg.includes('Service Unavailable') ||
        error?.code === 429 ||
        error?.code === 502 ||
        error?.code === 503 ||
        error?.code === 500;

      if (isTransient) {
        // Suppress Service Unavailable spam as Kraken Sandbox drops frequently
        if (errMsg.includes('Service Unavailable') || errMsg.includes('Rate limit') || errMsg.includes('503')) {
          if (i > 1) {
            console.log(`[Kraken Sync] API 503/Rate-limited. Waiting ${delay}ms before retry ${i + 1}/${retries}...`);
          }
        } else if (i > 0) {
          console.warn(`[Retry ${i + 1}/${retries}] API Transient Update: ${errMsg}. Retrying in ${delay}ms...`);
        }
        await delaySleep(delay);
        delay = Math.min(delay * 1.5, 10000); // capped exponential backoff
      } else {
        throw error;
      }
    }
  }
  throw new Error('Unreachable');
}

export interface MarketLimitsSource {
  markets?: Record<string, { limits?: { amount?: { min?: number }; cost?: { min?: number } } } | undefined>;
  amountToPrecision?: (symbol: string, amount: number) => string;
}

/** Applica precisione e limiti minimi (quantità e nozionale) a una size di ordine. */
export function resolveOrderAmount(exchange: MarketLimitsSource, symbol: string, rawAmount: number, price: number) {
  let ok = true;
  let reason = 'OK';
  let minAmount = 0;
  let minCost = 0;

  const market = exchange.markets ? exchange.markets[symbol] : null;
  if (market && market.limits) {
    if (market.limits.amount && market.limits.amount.min) minAmount = market.limits.amount.min;
    if (market.limits.cost && market.limits.cost.min) minCost = market.limits.cost.min;
  }

  if (rawAmount <= 0) {
    return { ok: false, amount: 0, reason: 'Amount must be positive', rawAmount, precisionAmount: 0, minAmount, minCost };
  }

  const precisionAmountStr = exchange.amountToPrecision ? exchange.amountToPrecision(symbol, rawAmount) : rawAmount.toString();
  const precisionAmount = Number(precisionAmountStr);

  if (precisionAmount <= 0) {
    return { ok: false, amount: 0, reason: 'Amount truncated to zero by precision', rawAmount, precisionAmount, minAmount, minCost };
  }

  if (minAmount > 0 && precisionAmount < minAmount) {
    ok = false;
    reason = `Amount ${precisionAmount} below min limits ${minAmount}`;
    return { ok, amount: precisionAmount, reason, rawAmount, precisionAmount, minAmount, minCost };
  }

  const notional = precisionAmount * price;
  if (minCost > 0 && notional < minCost) {
    ok = false;
    reason = `Notional ${notional} below min cost ${minCost}`;
    return { ok, amount: precisionAmount, reason, rawAmount, precisionAmount, minAmount, minCost };
  }

  return { ok, amount: precisionAmount, reason, rawAmount, precisionAmount, minAmount, minCost };
}

// Le chiamate a Kraken Futures usate dal bot: un sottoinsieme di DerivativesClient di
// @siebly/kraken-api, con le stesse firme (il client reale lo soddisfa senza adattatori).
// Documentazione di riferimento, citata da siebly: https://docs.kraken.com/api/docs/guides/futures-rest
// Endpoint (DerivativesClient.js): sendorder, editorder, cancelorder, cancelallorders, openorders,
// orders/status, openpositions, fills, accounts, leveragepreferences, transfer, instruments, tickers,
// api/history/v3/account-log.
import { DerivativesClient } from '@siebly/kraken-api';
import type { EngineConfig } from '../config/config';
import { krakenClientOptions } from '../config/runtime';

export type KrakenFuturesApi = Pick<
  DerivativesClient,
  | 'getInstruments'
  | 'getTickers'
  | 'submitOrder'
  | 'editOrder'
  | 'cancelOrder'
  | 'cancelAllOrders'
  | 'getOpenOrders'
  | 'getOrderStatus'
  | 'getOpenPositions'
  | 'getFills'
  | 'getAccounts'
  | 'getLeverageSettings'
  | 'setLeverageSettings'
  | 'submitWalletTransfer'
  | 'getAccountLog'
>;

/**
 * Client siebly per l'ambiente della configurazione (demo o produzione) con un timeout di rete
 * esplicito: il default di siebly è 5 minuti, troppo per un ciclo di trading.
 */
export function createKrakenFuturesApi(config: EngineConfig, requestTimeoutMs = 10_000): KrakenFuturesApi {
  return new DerivativesClient(krakenClientOptions(config), { timeout: requestTimeoutMs });
}

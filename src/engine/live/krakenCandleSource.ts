// Fonte delle candele 15m per il live: API pubblica "charts" di Kraken Futures in PRODUZIONE,
// la stessa da cui proviene il dataset del backtest (sezione 2: DEMO_DECISION_DATA =
// production_public). Anche in demo le decisioni usano questi dati; nessuna chiave richiesta.
// Endpoint e formato: vedi src/engine/data/krakenHistory.ts. Gli errori non vengono nascosti:
// una risposta non valida o un errore HTTP non transitorio fanno fallire il tick, che il
// ciclo ritenterà (con i dati stale non si aprono ingressi, gli stop nativi restano attivi).
import { KRAKEN_NATIVE_SYMBOLS } from '../data/dataset';
import { type DownloadOptions, downloadCandles } from '../data/krakenHistory';
import type { CandleSource } from './ports';

export class KrakenCandleSource implements CandleSource {
  constructor(private readonly options: DownloadOptions & { now: () => number }) {}

  async fetchCandles(symbol: string, fromMs: number, toMs: number) {
    const native = KRAKEN_NATIVE_SYMBOLS[symbol];
    if (!native) throw new Error(`Simbolo senza contratto Kraken Futures noto: ${symbol}`);
    return downloadCandles(native, fromMs, toMs, this.options);
  }
}

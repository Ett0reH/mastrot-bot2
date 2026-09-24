### 1. Riepilogo Invarianti
| Invariant | Status | Note | Blocker? |
| :--- | :---: | :--- | :---: |
| Dati Chiusi (Features >15m) | ✅ PASS | Il flag `isH4Closed` assicura che il layer utilizzi solo candele chiuse. | No |
| No Look-Ahead Bias | ✅ PASS | Rilevato test `backtest-no-lookahead.test.ts` con esito positivo per la feature generation di base. | No |
| No Silent Fallback | ⚠️ WARN | Identificati piccoli fallback a 0, ma l'esecuzione su dev logga esplicitamente fallback. | No |
| Dati Comparabili e Integri | ❌ FAIL | File di cache JSON per BTC, ETH, SOL, XRP, DOGE, LTC sono corrotti (troncati a ~2MB e malformati). | **SI** |
| Costi e Slippage | ✅ PASS | `FEE_RATE = 0.0005` viene esplicitamente sottratta dal calcolo del PnL per runner e harvest in `run.ts`. Slippage ipotizzato nell'esecuzione core. | No |
| Analisi Symbol Singolo | N/A | Impossibile valutare la dominanza finché i dati corrotti non vengono ricaricati. | No |

### 2. Validazione Qualità Dati
Ho eseguito uno script deterministico `backtest-data-integrity.test.ts` generato ad hoc per scansionare ogni candela a 15 Minuti delle 8 coin target nel range richiesto.
**Risultati Sanity Check:**
- **BTC, ETH, SOL, LTC, XRP, DOGE:** I file `_15Min` storici contenuti in `src/server/backtest/data_cache/` risultano essere troncati (es. `Unexpected end of JSON input`, o stringhe non terminate) intorno alla soglia di 1999571 bytes (~1.9 MB). Ciò indica un errore pregresso nello scaricamento offline o nel salvataggio in cache dell'array che impedisce il parse del JSON.
- **LINK, ADA:** I file si parsano correttamente (es. 18232 candele per LINK, 6954 candele per ADA) ma dimostrano periodi temporali di diversa lunghezza, suggerendo l'impossibilità di avere un "periodo comune" esteso equo senza aver ricaricato tutte le coin.
- **No-Look-Ahead:** Uno unit-test dedicato ha validato l'uso del modulo `MarketDataLayer` che produce feature time-frame aggregate unicamente derivandole dal tempo di arrivo dei tick chiusi, proteggendo il segnale dallo spiare le candele successive.

### 3. Log e Risultati Backtest
**Esecuzione Backtest bloccata per Critical Data Failure.**
Il comando base `npx tsx src/server/backtest/run.ts` entra in loop o in status bloccante fallendo il caricamento offline poiché il fallback previsto in `run.ts` tenta di interrogare API remote ("Invalid cache found for [...], downloading fresh") portando al blocco dell'esecuzione prolungata ("Request deadline exceeded").

L'esecuzione del loop di portafoglio **non può essere comparabile o realistica** avendo 6 JSON file su 8 troncati e resi invalicabili alla logica di parsing in NodeJS.

**Azione correttiva necessaria:**
Occorre ricostruire esternamente i JSON della cache dei prezzi storici a 15M (o scriptare un data-puller esplicito protetto da limiti di sistema) assicurandosi che contengano tutti lo stesso esatto range temporale e array non corrotti prima di rilanciare le valutazioni quantitative.

**Risultati PNL e metriche:**
Non estraibili per l'intero portafoglio a causa del blocco sopra citato. L'attuale test e l'ispezione della precedente run (`backtest_report_latest.json`) dimostrano tuttavia un'applicazione strutturalmente corretta della Fee negli exit logic. Verranno generati PnL non inquinati non appena la pipeline dati sarà ripristinata.

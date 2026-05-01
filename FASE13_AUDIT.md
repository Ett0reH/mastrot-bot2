# AUDIT BOT TRADING

## 1. Sintesi esecutiva
L'architettura teorica del bot poggia su solide basi quantitative strategiche, con use case per edge decay, regime filter e expectancy matrix. Tuttavia, l'implementazione pratica del live/paper trading (`liveEngine.ts`) è afflitta da criticità progettuali molto severe: diverge drasticamente dal backtester nella gestione del tempo (loop tick continui che bruciano `barsHeld` in minuti anziché giorni) e nei check asincroni con l'exchange, mascherando gli stati fallimentari degli ordini. Questo bot **non è pronto per il trading live** né per un paper trading significativo finché i disallineamenti di esecuzione asincrona e le validazioni stubbate non verranno sanate.

## 2. Architettura rilevata
Il flusso rileva OHLCV dal broker e incrocia segnali multi-timeframe (1H/4H).
- **Tick / Cron**: L'entry point `liveEngine.js` chiama `loopTick()` ogni ~7.5s valutando prezzi live, ma ricostruendo features stabili usando l'ultima candela temporale 1H "chiusa" e confermata.
- **Regime & Signal**: Il motore identifica Regimi Multipli (Bull, Bear, Euphoria, Chop, Crash) invocati da `RegimeLayer` e `MarketDataLayer`, assegnando segnali tramite `SignalLayer` che si divide su engine NORMAL o EXTREME.
- **Gatekeeper & Risk**: Un overlay storico di successi ("Expectancy Matrix" caricato da un file statico) filtra l'accesso al mercato; dopodiché `RiskLayer` definisce un cap in base alla leva teorica determinata dalla quality score.
- **Esecutore**: Viene invocato un order wrap "fire and forget" al layer custom `KrakenExchangeAdapter` basato su `@siebly/kraken-api` usando ordini Market, salvando ricorsivamente lo stato dei trade virtuali in Firebase.

## 3. Problemi critici

| Gravità | Area | File/Funzione | Problema | Impatto | Fix consigliato |
|---|---|---|---|---|---|
| **CRITICAL** | Core Quant | `src/server/core/architecture.ts` / `PositionExitLayer.monitorAndExit()` | `trade.barsHeld++` viene autoincrementato direttamente dentro `monitorAndExit` (valutato dal live server ad ogni singolo HTTP tick, ovvero ~7s). | Qualsiasi strategia di "max bars" o "Edge Decay", creata calcolando N candele, scade in meno di 2 minuti invalidando il position management. | Rimuovere l'auto-incremento in `monitorAndExit` e valutarlo nel wrapper `liveEngine` passandogli solo un flag `isNewClosedCandle=true`, oppure basarsi sui timestamp reali. |
| **CRITICAL** | Pricing / Entry | `liveEngine.ts` / `loopTick()` | Si calcolano SL, Leverages e Size basandosi sulla property statica `features.price`, la quale è stata congelata sull'ultimo closed price 1H, mentre il market order prenderà listini in tempo reale. | Se è passata mezza candela (30 minuti di differenza) da un trend veloce, le size e gli SL avranno distanze del tutto errate rispetto al punto reale di ingresso provocando liquidation accidentali e distruzione Expectancy. | Sovrascrivere `features.price = ticker.last;` prima di invocare il RiskLayer in modo che StopLoss e Size rispecchino l'attimo reale dell'esitazione a listino. |
| **HIGH** | Gestione Ordini | `liveEngine.ts` / `KrakenExchangeAdapter.fetchOrder` | La risposta mock ritorna letteralmente static json: `{ status: 'closed' ... }` bypassando ogni consultazione reale all'endpoint. | Qualsiasi ordine Live / Reale "rejected" o "partially filled" o rimasto appeso non notificato nel main-catch verrà inghiottito dal loop e considerato aperto/chiuso dal bot, disallineando equità locale e bilanci exchange. | Integrare l'API V3 di `@siebly` corretta per richiedere lo stato via `client.getFills()` o via websockets e iniettare gli state validi o passare in via definitiva a CCXT nativo per l'Execution. |
| **HIGH** | Trading Risk | `architecture.ts` / `RiskLayer` | L'invio dell'ordine via Broker avviene senza definire esplicitamente i vincoli di leverage dell'account (Isolated Margin vs Cross). In Kraken se ometti le flags va in Cross default usando le impostazioni max della GUI. | La logica calcola un position risk usando la sua `leverage = 2`, ma la transazione va a scontrarsi col collateral di portafoglio potendo esporre molto di più in caso di liquidazione di quanto ipotizzato nominalmente. | Includere il POST per gestire set leverage (es via endpoint `/derivatives/api/v3/leveragepreference`) o convertire le valutazioni a nozionali isolate con stop limit trigger per la massima resilienza. |

## 4. Dead code

| File | Funzione/Modulo | Evidenza | Rischio rimozione | Azione consigliata |
|---|---|---|---|---|
| `analyze_fase*.ts`, `gen_analysis.cjs`, `ablation_test.ts`, ecc (file su root) | Script di utility o reportistica vecchi test ML | Contengono pipeline vecchie o logiche standalone mai invocate da backend attivi o script `package.json` nel progetto live. | Nullo (solo repository memory). | Spostarli permanentemente in una directory `/tools` o rimuoverli. |
| `src/server/core/interfaces.ts` | Enum multipli (`SystemState`, `MarketRegime`, `TriggerSignal` ecc.) | Tutte le entità necessarie e vive sono già codificate nativamente in `architecture.ts`. Il file `interfaces.ts` è completamente dormiente e non referenziato negli import. | Nullo. | Rimuovere il file integralmente. |
| `test_ccxt.ts` , `test_kraken_order.ts` | Setup isolato CCXT Alpaca / CCXT Kraken Futures | Il vero engine live usa solo `@siebly` e un wrapper custom. Quedsti test girano su logiche inesatte CCXT cross over. | Nullo | Mantenere per debug o trasferire. |

## 5. Rischi Kraken

| File/Funzione | Problema | Rischio operativo | Fix |
|---|---|---|---|
| `KrakenExchangeAdapter.loadMarkets()` | Valori di precisioni (`limits: min/cost/precisions`) totalmente hardcodati sulla logica "BTC_is_x_else_y", impedendo l'uso universale scalare. | Trade con size minime invalidati e rifiutati silenziosamente alle API di Kraken; troncature distruttive di quote per assets con decimali complessi. | Non hardcodare i match alfanumerici ma fetchare l'`instruments` in REST o preconfigurarlo in JSON esatto per i top tier altcoin tracciati. |
| `KrakenExchangeAdapter.createMarketOrder()` (exits) | Nelle code di chiusura (`stopPaperTrading()`) l'esecutore inoltra array di chiusura `mkt` ridondanti senza associare alcun `ClientOrderId`. | In casi di race condition cross-process tra stop o liquidazione server, rischia duplicazione chiusura vendendo short inaspettatamente su un mercato flat. | Anche le esecuzioni `reduceOnly` dovrebbero possedere un robusto `ClientOrderId` collegato temporalmente. |

## 6. Rischi risk management

| Area | Problema | Scenario pericoloso | Fix |
|---|---|---|---|
| MFE/MAE Logging Update | `entryPrice` e `highWaterMark` non tracciano reali gap (Slippage invisibile). Un eseguito a listino ritardato porta su `features.price` lo switch di mercato e nasconde il rischio slippage. | Le metriche non mostreranno drawdown derivato dalla pessima rapidità di invio market order, illudendo il trader sul backtester. | Leggere SEMPRE dal Broker lo storico fill per posizionare il watermark, senza ereditare lo score "entry = close_price". |
| Posizioni Errate Sync | La logica "Sync" in `loopTick` droppa/crea posizioni locali mock ma se il bilancino differenzia lo status passa brutalmente a recupero mock di size su listini incrociati (`orphanedPos` -> reintegro). | Falsi negativi. Loop triggerano position drop che si riaprono da sole. | Separare netto Order Ledger in database locale SQLite/Firebase, se l'orphan si verifica per mismatch API non reinventare locale ma inviare `reduceOnly` per sicurezza prima di riprendere. |

## 7. Divergenze backtest vs paper/live

| Area | Differenza | Impatto | Fix |
|---|---|---|---|
| **Timer / Decay** | Il Backtest esegue `barsHeld++` sulle chiusure di 1H in batch statico. Il paper lo fa tick su tick (ogni ~7 secondi). | **HIGH** edge decay attivato a caso falsando interamente il trailing in live. | Incrementare `barsHeld` **solo** al passaggio confermato della successiva candela 1H temporale. |
| **Pricing Riferimento** | Backtest suppone entry e fill istantanei sulla close storica senza slippage. Il live prende il close, fa math, e manda su ticker in deviazione postuma. | **MED** Disallineamento profit e R:Risk. | Aggiornare `features.price` con il tick price `t.last` nel tick target prima della calcolazione del Signal. |
| **Cost & Fee** | Live esprime floating con tassa moltiplicata cross, Backtest è in batch net. | **LOW** Equity tracking diverged ma tollerabile per report | Livellare formula fee calcolata tra entryValue ed exitValue nominale. |

## 8. Logging mancante

| Evento non tracciato | Perché serve | Dove aggiungerlo |
|---|---|---|
| Errori `submitOrder` crudi di `@siebly` | Il fallback di error catch console esprime una view limitata, la colonna di Firebase per log history è asente salvo gli status change. Rende impercettibile un silent fail dal protocollo exchange. | Trappola di eccezione nel try-catch della create order e persistenza in file array `errors.log` locale (fs write). |
| Trace di "Data Gaps" Serverless | Per rilevare blocchi cronjob (cron.org) e capire quando il timestamp perde segnali | Log file `sync_drift.log`. |

## 9. Priorità
1. **Da correggere subito (Sopravvivenza):** Fix `PositionExitLayer.barsHeld++` - Disaccoppiare o passare una condizione solida. Bypassare `features.price` all'entry per listare solo il real-time ticker `currentLivePrice` all'inizio del submit del Gatekeeper risk management per assicurarsi coerenza sullo stoploss pre-buy.
2. **Da correggere dopo (Integrità):** Rimozione Mock Adapter `fetchOrder` di Kraken - Integrazione delle API per fetchare listini ordini pendenti verificati. Integrazione API Limit Orders invece di inviare Mkt.
3. **Pulizia tecnica:** Delete dei 25+ markdown passati e degli .ts root layer. Abolizione modulo di interfaces morto.

## 10. Patch consigliate 

1. **Fix `barsHeld` In Loop**
- *Obiettivo*: Prevenire che le posizioni si chiudano per time limit in minuti anziché in ore/giorni.
- *File*: `src/server/core/architecture.ts` e `liveEngine.ts`
- *Cosa cambia*: Introduzione di una variabile flag transitoria sulla sessione, valutando l'incremento di `barsHeld++` all'interno dell'`ExitManager` unicamente condizionandolo se l'id candela o il timestamp differisce di +3600 sec.
- *Rischio Residuo*: Nessuno.  
- *Test*: Apertura simulato posizioni in paper-trading, check log su mantenimento a 2 ticks senza auto chiusura.

2. **Price Targeting su Entry Delay**
- *Obiettivo*: Calcolare il limite SL e il target size sull'attuale price book anziché sulla candela storicizzata passata.
- *File*: `src/server/liveEngine.ts`
- *Cosa cambia*: Alla linea di ingresso `GatekeeperLayer.allowEntry(...)` impostare dinamicamente `features.price = ticker.last` in modo transazionale o recuperarlo dal dictionary locale listato per validare size e stop.  

## 11. Test consigliati
Si consiglia di inserire una unit test pipeline su queste direttrici:
- **Max Exposure / Collateral Test**: Iniettare un saldo finto molto basso e un calcolo `targetAlloc` imponente, verificare la riduzione automatica in min order size e respingimento fallace dell'adapter.
- **Double Tick Condition**: Eseguire 2 cron contemporanei spammati verso `/api/cron/tick`, verificare che `isTicking = true` impedisca il rientro.
- **Missing Fills Test**: Produrre uno stub di fill return status come "Reject", verificare invalidazione position locale invece di accettazione occulta by mock. 

## 12. Checklist finale
**[ ] NON pronto per live trading.**
**[ ] NON pronto per un paper trading asincrono stabile** (salvo immediate fix sui point 3.1 `barsHeld`).
Occorre la revision delle property citate e l'eradicamento del mock "fetchOrder" prima di fidarsi delle metriche e del reale bilancino virtuale.

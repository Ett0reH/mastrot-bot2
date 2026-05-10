# Analisi Debug: Macro-Area 5 (Persistence & Dashboard)

## 1. Mappa dei Flussi (Firebase & Server)
*   **Firebase Persistence (`Prompt 5.1.a`)**: 
    `liveEngine.ts` si aggancia a Firebase Firestore tramite `bot_state` > `STATE_DOC_ID`. Usa `JSON.parse(JSON.stringify(rawData))` per eliminare valori `undefined` che scatenerebbero errore nell'SDK. 
    L'engine asincrono effettua aggiornamenti non intrusivi mitigati dal `hashStateSnapshot()` in modo da non incappare nel rate limit del Database.
*   **Backend Endpoints (`Prompt 5.3.a`)**: 
    Il file `server.ts` serve endpoint come `/api/paper-trading/status` che chiamano `triggerCronTick()` su `liveEngine.ts` restituendo lo state object.
    Tuttavia, `/api/system/state` genera uno stato fittizio "Mocking" con setInterval (per `driftMs`, `confidence`) che invia informazioni fittizie.
*   **Startup Expectancy Bypass (`Prompt 5.3.b`)**:
    In `liveEngine.ts`, se nessuna ExpectancyMatrix è caricata da JSON locali associata al backtest, il bot inizializza un **Proxy `DEFAULT_NEUTRAL_MATRIX`**. Questo proxy restituisce matematicamente ProfitFactor 1.25 per ogningolo symbol e regime, **bypassando totalmente e sempre** l'ispezione della expectancy. È un bug critico di annullamento funzionalità. 

## 2. Anomalie Certe

*   **Dimenticanza Tracking Orario (`Prompt 5.1.c`)**: 
    Il `PositionExitLayer` relya su `trade.barsHeld` per attuare il _Progressive Edge Decay_. In `liveEngine.ts`, l'incremento di `barsHeld` avviene testando `(p as any)._lastHourId !== currentHourId`. Essendo `_lastHourId` agganciata solo alla memoria dell'istanza in run e mai salvata su DB Firestore, quando l'applicazione si riavvia (es. scale To Zero su Cloud Run), la variable è `undefined`. Questo triggera in automatico l'aggiunta di una barra di hold falsa su tutti i trade esistenti anche se l'ora corrente è la medesima, compromettendo e stringendo gli Stop Loss prematuramente.
*   **Quota Firebase ed Exit Forzati (`Prompt 5.1.b`)**:
    Esiste una salvaguardia se Firebase restituisce `RESOURCE_EXHAUSTED`, spegnendo lo write `quotaExceededContext = true`. Ma la ramificazione in `liveEngine.ts` non avvisa via email per la potenziale minaccia di Ghost-Trading invisibile. Se si ha freeze di Firebase, il database smette di aggiornarsi, ma l'app riavviandosi, o ricaricando il brovser senza il localState, caricherebbe un file vecchio, per poi cancellare posizioni o venderne duplicati, perchè non combaciano con Kraken live.

## 3. Anomalie Probabili (Dashboard)

*   **UI Fittizia vs Reale (`Prompt 5.4.c` & `5.4.a`)**:
    Il cruscotto front-end mescola sorgenti come `/api/system/state` (fittizie, create staticamente in memoria da `server.ts` con numeri random) e `/api/paper-trading/status`. L'utente vede "Confidence 0.85" che fluttua ma è generata da `Math.random()`. Anche il "Drift" e le informazioni di ModelFreshness non seguono i dati Kraken reali, illudendo l'operatore live.
*   **Cancellazione Ghost Orders Reali vs Database Revert (`Prompt 5.4.b`)**:
    Se Firebase va offline, il memory object di `liveEngine.ts` esegue un "close" a mercato di un trade profittevole. Kraken aggiorna lo status to closed cash. Ma Firestore fallisce l'aggiornamento. Al riavvio successivo dell'istanza Cloud Run, si tira lo State di ieri. Troverà la `simulatedPosition` come attiva. Entrando in un ciclo di Autoclear `[EMERGENCY_KILL_SWITCH] Dropping local-only orphan...`, esso applicherà uno STRANO ordine: se manca il trade su Kraken ma è su mock, the killer loop emette un MARKET ORDER IN DIREZIONE OPPOSTA (ridotta: limit, reduceOnly), il quale verrà RIFIUTATO da Kraken perchè la vera quota posizioni era zero. Questo trade rimane intrappolato nella UI come uno zombie, poiche `reduceOnly` faila, causando log in loop.

## 4. Test Consigliati
1.  **Test su Disconnect Restart**: Avviare in debug, piazzare mock trade con `_lastHourId = currentHourId`, e poi stoppare il backend. Ripristinano, ispezionare se Node, ricaricando lo snapshot pre-JSON, emette lo shift forzato `barsHeld++` senza curarsi.
2.  **Test Start senza Backtest JSON**: Cancellare la matrice o non definirla. Vedere il file `DEFAULT_NEUTRAL_MATRIX` avvelenare il sistema fornendo permessi a trade di scarsa qualità ingannando il Gatekeeper.

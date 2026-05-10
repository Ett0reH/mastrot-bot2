# Analisi Debug: Macro-Area 4 (Live Engine & Broker Sync)

## 1. Mappa dei Flussi Live
Il file `liveEngine.ts` dirige le chiamate cronometrate e la state-machine:
1. Sincronizzazione con Firebase e DB Snapshot Loader.
2. Acquisizione dei Ticker in bulk, estrapolazione del Floating PNL e salvataggio nel database delle Metriche.
3. Call `fetchOHLCV` (su timeframe 1H e 4H) gestita mediante array-caching.
4. Applicazione dell'`ActiveTrade` logic via `PositionExitLayer`. Se Exit -> Chiude posizione via `ccxt`.
5. Ricerca nuovi Entry passandola per `Gatekeeper` e `RiskLayer`.
6. Riconciliazione finale tra `simulatedPositions` e `livePositions` estratti da Kraken via API.

## 2. Anomalie Certe

*   **API Rate Limit Avalanche su Multiple Coins (`Prompt 4.2.a`)**:
    Nel loop di fetch per ricaricare le candele 1H e 4H se "scadute" o mancanti, `liveEngine.ts` effettua:
    `await ccxtWithRetry(() => exchange!.fetchOHLCV(symbol, '1h', undefined, 5)); await delaySleep(200);`
    In una watchlist di 40 asset, questa cadenza oraria sgancia 80 request. `Kraken` rate limit (su public tier) collassa rapidamente, costringendo `ccxtWithRetry` (2000ms delay x 6) ad un ingorgo di oltre un minuto che ritarda gli stop-loss e i trade execution esatti.
*   **Gestione Sync Ghost Order su Restarts (`Prompt 4.3.a`)**:
    Se il server viene forzato al riavvio, `liveEngine.ts` effettua il `CancelAllOrders()`? No, cerca un `[UNKNOWN_OPEN_ORDER_ON_BROKER]` loop. Identifica gli unmanaged orders filtrando via `simulatedPositions...brokerStopLossOrderId === o.order_id`. *SE il database DB Firebase subisce rollback* (o il memory state è corrotto) dopo che il broker ha inserito un SL, l'order SL non sarà in `simulatedPositions`, per cui l'`AUTO-HEAL` di startup lo scambierà per un "Unmanaged Order" e LO CANCELLERA'! Lasciando la live position aperta e SENZA stop loss. Poi due minuti dopo interviene `[NATIVE_SL_HEAL]` dicendo "Oh manca, lo re-inserisco", ma con il prezzo di SL magari slittato pesantemente dal gap informativo. 

## 3. Anomalie Probabili (Esecuzione e Tipi di Ordine)

*   **Reliance su Market Orders vs Limit (`Prompt 4.1.a`)**:
    Sia l'ingresso che l'uscita (`createMarketOrder(p.symbol, side, ...)`) usano esclusivamente ordini a Mercato. Sopratutto nei ritracci (es. Segnale `PULLBACK`), comprare a mercato su alt-coin illiquide tramite un bot automatico causerà sempre slippage negativo che disattende pesantemente il prezzo logico di `features.price` calcolato dal Risk Layer.
*   **Idempotenza Parziale Mancante (`Prompt 4.2.b`)**:
    Al termine del trade logico, il log recita `Sending sell exit order...` seguito dalla chiamata ccxt. Ma se la call API timeoutta sul socket pur avendo Kraken ricevuto l'intent, il bot assume `isLiveExitSuccess = false` e al ciclo *successivo* rimanderà una medesima request di `reduceOnly` al mercato, rischiando order spam (rifiutato da Kraken o riprocessato se il primo non era reduceOnly).

## 4. Test Consigliati
1.  **Test Resilienza Rate Limit**: Mockare `fetchOHLCV` per restituire fallimenti HTTP429 5 volte di fila. Constatare che il delay incrementale mantenga vivi i task asincroni ma freeza il runtime.
2.  **Test su Auto-Heal Ordini**: Istanziare una finta position DB priva di `brokerStopLossOrderId` ma creare il corrispettivo pending-order nativo. Constatare la rimozione + reinserimento, calcolandone l'inefficenza lato fee/API.

# Analisi Debug: Macro-Area 3 (Sotto-Aree 3.4 - Cleanup e Sync)

## 1. Mappa Exit Cleanup
*   Al verificarsi della condizione `exitDecision.shouldExit == true` (oppure se individuata l'attivazione nativa dello SL del broker), il `liveEngine.ts` omette di ricaricare il trade in `positionsToKeep`.
*   Calcola le fees in entrate del 5 bps (`0.05%`) in uscita, aggiunge al baseBalance simulato.
*   Interroga i Trade "Reali" da Kraken per sovrascriverli nel database del sistema per la Dashboard.

## 2. Anomalie Certe

*   **Amnesia dell'Exit Reason Semantico (`Prompt 3.4.a` & `3.4.b`)**: 
    La flag `exitDecision.exitType` ("TRAILING_STOP", "EDGE_DECAY", "REGIME_DERISK") viene brillantemente inferita dal sistema matematico e stampata nel `console.log`. Ma il sistema di persistenza *getta via questo pezzo di informazione inestimabile*! In `liveEngine.ts` non c'è una pipeline che salvi il Trade Object con i metadati logici da qualche parte. Al contrario, recupera lo storico tramite `exchange.fetchRecentTrades()`, che di fatto riporta meri riepiloghi "Bought X BTC at Y" (mancano i "Perché"). Questo disconnette irreparabilmente la UI analitica per lo sviluppo strategico.
*   **Race Conditions tra Nativo, Simulator e UI**: 
    Siamo in presenza di una chiara minaccia di Ghost Trade. Se in `exchange.createMarketOrder(..., { reduceOnly: true })` il backend Exchange sputa un errore perché l'utente o uno SL l'aveva già chiuso due secondi prima, l'eccezione viene loggata ma `positionsToKeep.push(p)` viene effettuato come Retry. Ciò mantiene persistente sul database il Trade, generando un Ghost infinito nella Dashboard (visto che proverà a chiuderlo per sempre venendo respinto per insufficenza fondi/pos). Esiste un try-catch blando `msg.includes('position')` per drop forzato, ma è linguisticamente debole.

## 3. Test Consigliati
1.  **Test Phantom Ghost Retention**: Forzare il broker adapter mockato a gettare errore `RateLimitExceeded` o `InvalidOrder` sull'intent di Uscita. Verificare l'accodamento in `positionsToKeep` che corrompe la UI a tempo indefinito e causa blocchi al limite delle esposizioni massime del capital.
2.  **Test su Exporting DB "Reason"**: Iniettare un logger su Database post-uscita e validarne la lettura corretta sulla UI, colmando il vuoto di `semanticReasons` su cui `FEATURE_FLAGS` si vanta.

# Analisi Debug: Macro-Area 1 (Sotto-Aree 1.4 - ExpectancyTracker)

## 1. Mappa Input -> Query -> Decisione
La classe `ExpectancyTracker` memorizza in una property statica privata `matrix` lo stato degli expectation metrics calcolati da un backtester esterno. 
*   **Caricamento Matrix (`Prompt 1.4.a`)**: Effettuata tramite `ExpectancyTracker.loadMatrix(data)` invocato da `server.ts` o boot sequence. Manca del file loader se ci limitiamo qui, ma vediamo che se la matrice ha missing keys viene gestita via fallback soft o hard a `INSUFFICIENT_DATA`.
*   **Query Realtime (`Prompt 1.4.b`)**: Usa il lookup dict via String templating `` ${symbol}_${regime}_${setup} ``. Restituisce tipi precisi di "Permessi" (`ENABLED`, `REDUCED_SIZE`, `DISABLED`, etc).

## 2. Anomalie Certe

*   **Mapping di Simboli Mismatch (`symbol.replace('USDT', 'USD')`)**: 
    All'interno del `GatekeeperLayer` e del `RiskLayer`, ogni qualvolta viene invocato il Tracker, il programmatore ha introdotto questo workaround fisso: `const normalizedSymbol = symbol.replace('USDT', 'USD')`. Se in fase di backtest era stato generato `BTC/USDT`, il lookup non troverà NULLA. O viceversa, in Kraken Futures live i formati sono `BTC/USD:USD` o simili. Questa assunzione hardcoded sui replace genera enormi "silent fails" (o fallback a insufficient data) se il formato exchange live diverge da quello su file JSON di expectancy storico!
*   **Accesso Privato Ostruttivo nel RiskLayer**: Nel `RiskLayer`, per estrarre la Permission dal tracker per i Tier 10 si ricorre ad accrocchi come `const metrics = (ExpectancyTracker as any).matrix?.[key]`. La manipolazione o accesso via `(as any)` in TS per leggere proprietà statiche private è anti-pattern critico. Esponendo un metodo pubblico con type-safety verrebbe risolto.

## 3. Anomalie Probabili (Silent Fails e Matrix Corrupted)

*   Se non viene passata correttamente una property `signal.type` identica ai keys generati dal tester (es. `MEAN_REVERSION` ma nel dict per errore i nomi generati contengono white spaces o underscore scorretti), l'aggancio in `getSetupPermission` non lancerà error ma decreterà il fallback passivo (`INSUFFICIENT_DATA` => che di solito risulta come ammesso in Size ridotta dimezzata anziché negata).
*   L'Expectancy non viene attivamente interrotta o rigenerata dopo grandi shifts - questo non è un bug lato runtime strettamente, ma il bot, che vi si affida, rimarrà ancorato ai preset statici fin dall'ultimo deploy/reboot di matrix.

## 4. Incoerenze architetturali

*   Nella logica del `GatekeeperLayer`, il check expectancy interviene con l'invariante: `signal.engine !== "NORMAL"`. I trade dell'engine `NORMAL` non passano mai sotto la lente della matrice `ExpectancyMatrix`. Perché? È un'omissione critica. Forse perché `NormalPullback` storicamente veniva considerato affidabile di base, ma è comunque escluso in blocco dal framework statistico in tempo reale.

## 5. Test Minimi Consigliati

1.  **Test Lookup Fallback**: Mock di una chiamata `ExpectancyTracker.getSetupPermission("BTC/USD:USD", "EUPHORIA", "MEAN_REVERSION")`. Appurare che se mancasse la traduzione in `BTC_USD_...`, non scambi una entry Extreme valida con `DISABLED` al variare arbitrario di underscore/symbol naming tra Backend Kraken vs Datafeed Backtester. C'è assoluto bisogno di standardizzazione Key.
2.  **Test su Access Level Violation**: Inibire l'`as any` in `RiskLayer` e constatare la build failure conseguenze. Serve incapsulare una public API su `ExpectancyTracker` tipo `.getMetricsForKey(k)`.

# Analisi Debug: Macro-Area 2 (Sotto-Aree 2.3 - Capital Management Layer)

## 1. Regole Applicate e Flusso `CapitalManagementLayer`
L'audit passa a come l'architettura difende la struttura di portafoglio globale tramite l'uso del `CapitalManagementLayer` in asincrono al signal-decision:
1. `evaluateAccountHealth` confronta `equity` corrente contro `maxHistoricalEquity`.
2. Se drawdown $\ge 25\%$, restituisce `{ isHalted: true, allowedCapacityMultiplier: 0 }`.
3. Se drawdown $\ge 15\%$ ma $\le 25\%$, `{ isHalted: false, allowedCapacityMultiplier: 0.5 }`.
4. Nel ciclo di scansione principale (`liveEngine.ts`), se l'health è halted -> il bot mette `state.isActive = false` e termina tutte le speculazioni nuove (gestisce solo chiusure aperte).
5. Se attiva ma in penalty, applica al calcolo `rawSize` (il `RiskLayer.calculateRisk.positionSize`) il modificatore.

## 2. Anomalie Certe (Limiti Globali ed Esposizioni)

*   **Hardcoded $50K Limite Ignaro dell'Equity (`Prompt 2.3.a`)**:
    In `liveEngine.ts`, riga ~1922: 
    `const MAX_GLOBAL_EXPOSURE = 50000;`
    `const currentExposure = simulatedPositions.reduce((acc, p) => acc + (p.size * p.entryPrice), 0);`
    `// check limit before execution`
    Questo parametro è scritto a secco nello script e non viene controllato in maniera programmatica in rapporto all'Equity Reale (`capital` o `state.balance`). In un conto di `$150.000`, il bot andrà costantemente out-of-margin prima di assorbire l'opportunity di mercato reale, tagliando 100k di fondi liberi su un conto. Capping per protezione va bene, ma deve essere `%` dell'intero pool di base o una variabile in ambiente.
*   **Peak Equity Bug su Prelievi ($Max Historical Equity$) (`Prompt 2.3.b`)**:
    Il Bot assorbe costantemente `if (state.balance > state.maxHistoricalEquity!) state.maxHistoricalEquity = state.balance;`.
    Se un account comincia con $10K, va a $20K... il system HighWaterMark è $20K. L'utente preleva "fiscamente" $6K, portando il saldo a $14K dall'app dell'exchange. Il Bot leggera il base balance da Live exchange Kraken (se livemode attiva) portandolo a 14K, ma l'high-water mark del bot in memoria rimarrà $20K. Il Bot crederà di essere in *DrawDown del 30%* (20k a 14k) e andrà istantaneamente in "SYSTEM_HALTED" mortale, distruggendo il bot per sempre perchè l'Halt non ammetterà più recuperi sui trade successivi!

## 3. Anomalie Probabili

*   **Sincronia "CapitalMultiplier" / RiskLayer**:
    Perchè RiskLayer deve farsi da solo il check di capital risk e calcolare un `targetAlloc = allocatedCapital * quality` per non sforare l'80% di esposizione usd, per poi farsela ulteriormente dimezzare (`rawSize = risk.positionSize * capitalHealth.allowedCapacityMultiplier`) giù nel bot *prima della call exchange* e limitata a ulteriori $50K assieme agli altri the coins open? Si verificano 3 layer distinti di "Shrinkage" non correlati che potrebbero portare i nominal order sizes sotto il `Minimum Order Size / Lot Size` dell'Exchange, che farà fallire gli API call di order su Altcoin (Slippage Errors of Size min-notional e.g. \$10).

## 4. Test Consigliati
1.  **Test High Water Mark "Crash by User Withdrawal"**: Avviare su un mock state, alzare maxHistoricalEquity e scalare fittizziamente baseBalance da esterno (mocking the `exchange.fetchMarginBalance()` value down suddenly by 30% as a legit withdrawal). Il bot non deve haltarsi ma ricalcolare una Withdrawal Baseline.
2.  **Test Global Exposure Overflow**: Testare una batteria di 5 coin long mandate simultaneamente con capital = 40K, ed aspettarsi che sommate non sfocino nella tolleranza bloccante.

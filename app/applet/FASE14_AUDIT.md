# AUDIT REPORT — TRADING SYSTEM

## 1. Executive Summary
L'audit eseguito sul sistema di trading online (codice base in `src/server/liveEngine.ts` e architettura in `src/server/core/architecture.ts`) ha evidenziato una piattaforma complessa, funzionalmente pronta per il Paper Trading ma che necessita di mitigazioni prima della produzione reale. Il sistema è modulare, prevede un forte accoppiamento con l'API Kraken Derivatives e si poggia su un solido framework Risk/Regime-based per le decisioni di ingresso/uscita al mercato. Sono state identificate piccole porzioni di codice non attive in live (dead code) e un'eccessiva dipendenza da statefulness locale derivante dai backtest.

## 2. Critical Findings
- **Dipendenza da Dati Offline nel Live Engine:** Il sistema `GatekeeperLayer` utilizza un modello di `ExpectancyTracker` basato su statistiche di successo passate. Nel file `liveEngine.ts`, questo viene caricato staticamente tramite la lettura di `src/server/backtest/data_cache/setup_expectancy_matrix.json`. Se il file è mancante (es. nuovo deploy pulito), o obsoleto, il motore adatterà le size o bloccherà i trade su assunzioni statistiche compromesse.
- **Desync tra Bilancio Virtuale e Kraken:** Il sistema utilizza un meccanismo di sincronizzazione («[STATE SYNC]») che ripristina la disponibilità del bot ("virtual base balance") in base al margine reale di Kraken. Tuttavia, in presenza di deviazioni importanti, il bot invoca solo warning e manual intervention (`[MANUAL_INTERVENTION_REQUIRED]`).

## 3. Findings by Severity

### ALTA (High)
- **Sincronia Ordini e Code Firebase:** Sebbene l'integrazione di Firebase persista lo state (`liveState`), non vi è resilienza garantita in caso di race condition durante l'update degli ordini in rapida successione. 
- **Gestione "Service Unavailable":** L'ambiente Sandbox di Kraken ha frequenti drop (503s). Anche se sono presenti wrapper come `ccxtWithRetry`, un ritardo eccessivo in fase di uscita (exit execution) per API drop, sfalserà lo stop loss virtuale.

### MEDIA (Medium)
- **Hardcoding di Costanti globali (Trade Metrics):** Il file `architecture.ts` instanzia vari singleton (`PullbackMetrics`, `TradeBudgetMetrics`, `NormalRsi2TrendTrailingStats`) progettati appositamente per statistiche di backtest e loggati brutalmente. Rimangono allocati anche usando il bot in live processando potenziale memory leak sul lungo periodo se scritti ad ogni tick (seppur sembrano richiamati solo in run/run_2w).

### BASSA (Low)
- **Dead Code Layer:** Il livello `AnalyticsLayer` e vari helper specifici in `architecture.ts` non vengono richiamati in `liveEngine.ts`. Questo dead code inquina la repository ma non intacca il data path reale.

## 4. Data Lineage Check
Il flusso reale è coerente e validato dalla catena:
1. **Data Ingestion:** I dati OHLCV sono presi da Kraken in polling con fallback retry e validati (`ccxtWithRetry`). 
2. **Features Injection:** Generazione dei technicals con `MathUtils` (`MarketDataLayer`).
3. **Strategy Engine (Regime & Signal):** Identificato da `RegimeLayer` come CHOP/TREND. Segnali generati da `SignalLayer`. 
4. **Gatekeeper & Risk Layer (Position Sizing):** Il Gatekeeper controlla l'expectancy matrix. Il `RiskLayer` impone una tolleranza massima e stop loss dinamici, appoggiandosi su `CapitalManagementLayer` per valutare gross drawdown (Halting system a -25% DD).
5. **Execution:** Viene inviato il webhook/REST verso Kraken per operare a mercato combinando `DerivativesClient` personalizzato e CCXT per funzioni standard.
6. **Dashboard & Firebase Sync:** Gli oggetti trade attivi finiscono nello state e traslati in Dashboard via event streaming/RT.

## 5. Kraken Integration Check
- **API Setup:** Supporto integrato Sandbox (`KRAKEN_SANDBOX`) / Prod switch e corretta derivazione di environment variables (`KRAKEN_API_KEY`, `KRAKEN_SECRET_KEY`).
- **Posizioni e Stop Loss:** Implementato trailing stop loss ibrido logico/nativo sul broker (`updateStopLossOrder`).  
- **Order Type:** Tutti i meccanismi usano market orders `ccxt` supportati da parametri `{ reduceOnly: true }` validi lato derivatives Kraken o Stop order "stp" nativi. L'esecuzione è logicamente solida.

## 6. Strategy Engine Check
- **Sizing & Allocation:** Non ci sono positions size statiche (naked positions); le trade quantities derivano unicamente dal target risk in base allo Stop Loss point calcolato nel `RiskLayer`. Tutte le entrate implicano SL correlati.
- **Drawdown Circuit Breakers:** Presente e verificato. Se la perdita del global portfolio supera il 15%, la size viene dimezzata. Superato il 25%, si attiva la flag `isHalted: true` che isola il sistema da nuovi entries permanentemente fino al reset. La logica risiede in `CapitalManagementLayer.evaluateAccountHealth`.

## 7. Dashboard Integrity Check
La UI (in `src/Dashboard.tsx`) renderizza i campi reali letti da `liveState`. Oltre a mostrare i log reali dello state (`krakenStatus?.connected`, `.driftMs`), mostra proiezioni dinamiche tramite `recharts` e `calculateMetrics()`. Nessuna evidenza di stub statici o dummy data (eccetto componenti UI puramente decorativi previsti dal boilerplate ui shadcn di react-motion).

## 8. Dead Code & Overlap Report
- **Layer attivi:** `MarketDataLayer`, `RegimeLayer`, `SignalLayer`, `GatekeeperLayer`, `RiskLayer`, `PositionExitLayer`, `CapitalManagementLayer`, `ExpectancyTracker`.
- **Layer e Logiche Inattive (Dead/Test Code):** `AnalyticsLayer` in `architecture.ts` (mai derivato in live, richiamato unicamente per logging dai tester). Singole interfacce come `PullbackMetrics`, `BreakoutRetestMetrics` creano footprint inutile se caricate runtime per via del pattern singleton. Alcuni script localizzati in `/scripts` (es. `test_margin.ts`, `check_orders.ts`) sono utility stand-alone.

## 9. Final Verdict
**Status: PRONTO PER PAPER TRADING / LIVE CON RISERVE.**  
Il sistema è architetturalmente funzionante per interazioni reali e test rigorosi (Paper/Sandbox) grazie ai solid layer di blocco logico e alla resilienza ai crash momentanei dell'API (retry policies). Il flusso di Risk Management è sofisticato.  
Tuttavia, un refactoring sulla dipendenza locale JSON di *setup expectancy* verso un provider distribuito (es. Firebase doc) e una logica aggressiva per recuperare ordini pendenti su Kraken durante il network drop rendono l'applicativo inadatto ai fondi reali ad alto stress "in unsupervised mode" in questo esatto commit. Consigliabile la migrazione al 100% cloud db prima del go-live mainnet.

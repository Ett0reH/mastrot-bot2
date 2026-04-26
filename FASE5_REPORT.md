# FASE 5 — EXTREME & NORMAL ENGINE SPLIT REPORT

## 1. Mappa Vecchia vs Nuova Architettura Signal Layer

### Vecchia Architettura (`baseline FASE 4`)
Il `SignalLayer.evaluate(features, regime)` processava proceduralmente e linearmente il segnale, contenendo internamente logica per trend bullish/bearish standard accanto alla cattura di crolli drastici (`CRASH` `MEAN_REVERSION`) operando come un singolo gigantesco if-else tree monolitico.

### Nuova Architettura (`FASE 5`)
Il `SignalLayer` è stato smantellato dal ruolo computazionale diretto per diventare un puro **Orchestratore di Moduli**.
Adotta il costrutto `SignalContext` e restituisce il `SignalCandidate`, che ora contiene la metrica `engine: "EXTREME" | "NORMAL" | "NONE"`.
*   **Se il Regime è Macroscopico/Caotico (`CRASH` o `EUPHORIA`)**: Viene risvegliato esclusivamente il `generateExtremeSignals(context)`, progettato per cecchinare *outlier* asimmetrici (e.g. `LONG MEAN_REVERSION` < 25 RSI e `SHORT MEAN_REVERSION` > 85 RSI).
*   **Se il Regime è Regolare/Tradizionale (Tutti gli altri)**: Il controllo passa a `generateNormalMarketSignals(context)`, progettato per sfruttare efficienze relative alla fluidità dei trend, come `PULLBACK` contro-trend direzionale e ripartenze in `CONTINUATION`.

## 2. Differenze di Output

Le variazioni logiche introdotte nel refactor sono strutturalmente isolate; **non** è stato modificato il target behavior dei trade, quindi c'è un'esatta sovrapposizione matematica del comportamento e del Win Rate simulato contro il benchmark di test FASE 4.

**Report End Equity Comparativo (2021-01 -> 2024-10)**:
- **Baseline (FASE 4 PNL)**: $50,419.94 | Trade eseguiti: 1443 | Win Rate: 40.1%
- **Rifattorizzazione (FASE 5 PNL)**: $50,419.94 | Trade eseguiti: 1443 | Win Rate: 40.1% 

Nessuna regressione riscontrata o deviazione delle equity. La separazione strutturale ha garantito una transizione silente, esponendo tuttavia statistiche isolate molto informative.

## 3. Metriche Isolate per Motore (Engine Stats)
Per la prima volta nel sistema sono state introdotte le tracciature isolate di Profit Factor per ramo decisionale, rivelando questo comportamento sul pool di trade del quadriennio ('21:'24):

*   **⚡ EXTREME Engine (Chaos & Outliers)**:
    *   **Volume di Trade**: 265 trade (18.3% del bot)
    *   **PnL Generato**: $18,727.22 (46% del profitto totale)
    *   **Profit Factor (PF)**: **1.78**
    *   **Win Rate**: **45.3%**
    *   **Insight**: L'Extreme Engine agisce meno frequentemente ma ha un Win Rate nettamente superiore e colpisce asimmetricamente i drawdowns con altissimi profitti relati (home-runs). 

*   **📈 NORMAL Engine (Trend & Pullback)**:
    *   **Volume di Trade**: 1178 trade (81.7% del bot)
    *   **PnL Generato**: $21,692.72 (54% del profitto totale)
    *   **Profit Factor (PF)**: **2.05**
    *   **Win Rate**: 38.9%
    *   **Insight**: Macina l'assoluta maggioranza del volume, gestito in condizioni stabili. Soffre di un Win Rate più aspro, ma le perdite sono tagliate con tale efficienza che il *Profit Factor* tocca valori notevolmente superiori (oltre 2.0x i profitti lordi sulle perdite lorde), rivelando che la de-risking policy nel Gatekeeper per segnali normali e chop-blocks funziona magnificamente.

## 4. Regressioni
Lo script è stato eseguito contro l'oracolo. **0 regressioni logiche**. Il behavior è perfettamente speculare alla base precedente per pips, PnL e fee loss. 

## 5. Dead Code Report
Le funzioni monolitiche all'interno di `evaluate` o `GatekeeperLayer` che dovevano storicizzare l'origin del tradeoff sono state sgrassate. Modificando i tipi (`TradeLog`, `ActiveTrade`, `SignalCandidate`) per instradare a monte e a valle della pipeline l'origine del signal (l'engine che l'ha lanciato), non permangono più hardcoded checks basati sul nome dei setup all'interno del report generator o nei tool di print in JSON. Nel report `backtest_report_fase5.json` appare adesso nativamente ed elegantemente la statistica sotto l'omino JSON `engineStats`.
Le vecchie query isolate in aggregator per la FASE 4 sono state rese fluide sul nuovo dictionary types.

# Analisi Debug: Macro-Area 2 (Sotto-Aree 2.2 - RiskLayer Sizing)

## 1. Regole Applicate e Flusso `RiskLayer`
1. Partenza base: `riskPerTrade` 5% del capitale (scalato via argomenti dalla config global), `leverage = 2.0`.
2. Fase 10 abilitata: Se EUPHORIA/CRASH, `riskPerTrade` sale del 50% ($* 1.5$). Leva viene verificata tramite qualifica (`btcConfirms`, `volAcceptable`, `highConfidence`). Se tutto match, Leva $5$, altrimenti $3$, fallback $2$.
3. Se fase $10$ non abilitata/Non Extreme, legacy rules: Leva $5$ in crash, $1$ in transition etc.
4. Moltiplicatore `gatekeeperRiskModifier` viene applicato al `riskPerTrade` corrente.
5. Calcolo SL e PnL Dists: `slDist = features.atr1H * 3.5`. `tpDist = slDist * 3` (3:1 fisso di Risk/Reward). Per l'engine NORMAL lo stop trailing sostituisce `atr` via un override in % nominale sul prezzo.
6. Catastrophe Hard-Stop calcolato piatto a 15%.
7. `targetAlloc` viene cappato a 80% dell'account prima di essere diviso per il current price.

## 2. Anomalie Certe (Liquidability e Errori Economici)

*   **Risk Layer - Trailing Overwrite in Normal Engine**: `slDist` è inizialmente basato su ATR (molto sicuro su altcoin volatili). Tuttavia se `signal.engine === "NORMAL"`, `slDist = features.price * trailPct`. Considerando che `trailPct` è tipicamente il 5% nei config medi... se applicato durante un forte flash-crash normal-driven, non rispetterà la dinamica di volatilità sottostante finendoci "whipped-out" molto prima.
*   **Catastrophe Liquidator Paradosso**: L'hard fallback `features.price * 0.85` (-15%) abbinato ad un `leverage = 5.0` risulta materialmente non eseguibile dalla clearinghouse dell'exchange a meno che l'utente non utilizzi un margin mode cross-margin illimitato. In isolated margin al 5x, -20% è la bancarotta, la liquidazione arriverà all'incirca al -14% (assumendo le fee di funding/maker&taker e margine di mantenimento Binance/Kraken). L'exchange liquiderà e caccerà un errore "Margin Call" PRIMA che l'ordine stop loss fisico del codice venga "Toccato".

## 3. Anomalie Probabili (`Prompt 2.2.b` - Modulazione Esposizione)

*   **Target Alloc Capping Ignaro**: `targetAlloc = Math.min(allocatedCapital, maxExposureUsdCap);` riduce elegantemente l'allocazione se un parametro impazzisce. Ma poi esegue `targetAlloc = targetAlloc * signal.quality;`. Se `maxExposureUsdCap` fosse di `$8000` (80% di `$10K`), e il SignalQuality è `0.9` -> Size viene ristretta a `$7200`. Di fatto la "size nominale" è corretta al segnale matematicamente, ma concettualmente scarta la premessa d'allocazione fissa d'account.
*   **Gestione `dynamicExposurePct`**: `dynamicExposurePct` opzionale viene utilizzato predefinito a 5% se assente. Ma da dove viene? Nel `liveEngine` è precalcolata/passata altrove o non viene proprio inviata nei parametri base?

## 4. Test Consigliati
1.  **Unit Test Catastrofe Stop Loss**: Invocare `calculateRisk` con un set di leva a 5x. Assicurarsi (e sistemare il codice prima!) che SL_Catastrofica scalari in modo inversamente proporzionale alla leva (Per es: calare l'hard stop a 4% se leva 5, anzichè lasciarlo 15%).
2.  **Test su Edge Value Zero o ATR Missing**: Fornire `features.atr1H = 0` o nullo (mock error). Controllare che l'SL Divenga Zero e il Take Profit pure; portando a posizioni fallate e liquidazioni immediate a rottura del tick di acquisto sul LiveEngine.

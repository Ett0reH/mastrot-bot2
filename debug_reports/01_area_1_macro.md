# Analisi Debug: Macro-Area 1 (Core Analysis & Signal Generation)

## 1. Mappa Reale dei Flussi

1.  **Dati In Ingresso**: Vengono presi due stream di candele: `bars1H` e `bars4H`. 
2.  **MarketDataLayer (`prepareFeatures`)**:
    *   Prende gli ultimi 15 elementi per il calcolo di ATR e ADX.
    *   Calcola RSI, SMA 50/200, EMA 50/200, Bollinger Bands etc., *utilizzando le intere slice passate o un subset*.
    *   Genera calcoli "Regime Scaling" (volZScore) guardando le ultime 20 chiusure di 1H.
    *   Applica check `isChop`, `isBreakoutRetestLong`, `isBreakoutRetestShort` definendo bounding box support/resistance usando N candele arretrate.
3.  **RegimeLayer (`detect`)**:
    *   Calcola `distFromSMA` basata su `sma200_4H`.
    *   Classifica come HMM proxy usando `volPct` e `volZScore` (CRASH, EUPHORIA, TRANSITION) o `trend4H` per standard emission states (BULL, BEAR, TRANSITION).
4.  **SignalLayer (`evaluate`)**:
    *   Decide tra due motori (Extreme vs Normal) basandosi sia sul `regime` (locale) che sul `btcRegime` (globale).
    *   In caso `generateExtremeSignals(extremeContext)` fallisca, fa fallback sicuro a `generateNormalMarketSignals(context)`.
5.  **ExpectancyTracker (`getSetupPermission`)**:
    *   Consultata (fuori dal Signal Layer puro, più nel Gatekeeper) per capire se un trade setup ha confidenza storica (Edge) usando parametri come profit factor > 1.15.

## 2. Anomalie Certe (Bug ed Errori Architetturali)

*   **Risk di Feature con Array Troppo Corti (Missing Data Fallbacks)**: Molte funzioni di `MathUtils` restituiscono `null` o si comportano in modo malevolo se la chain fornita scende sotto il `period`. Esempio: in `getATR(bars1H.slice(-15), 14)`, se passati solo 10 elementi restituirà `null`. Nel `prepareFeatures` ciò porta ad un fallback del tipo `closes1H[closes1H.length - 1] * 0.02`. Significa che un fetch failure produce *costanti simulate al 2%* falsando pesantemente tutti i segnali a valle senza lanciare errore bloccante.
*   **Disallineamento Logico su EXTREME Signal Context Override**: In `SignalLayer::evaluate()`, se `btcRegime` è CRASH/EUPHORIA ma il regime locale non lo è, il contesto passato a `generateExtremeSignals` **sovrascrive brutalmente** il regime locale con quello globale `regime: (btcRegime as TradingRegime)`. Se un asset sta letteralmente implodendo da solo (local CRASH) mentra BTC è tranquillo, questa condizione si comporta asimmetricamente. Inoltre, l’engine Normal processerà asset come se appartenessero ad una fase non loro qualora Extreme passi "NEUTRAL".
*   **Leak di decisione sul "Capital/Risk"**: In `SignalLayer.ts` (struttura logica), troviamo la definizione `export const RiskTierConfig` e la funzione `resolveRiskTier()`. L'area 1 (Generazione Segnale) non è completamente astratta dal concetto di "Esposizione/Rischio" in quanto sta incapsulando definizioni di base sul dimensionamento invece di confinarle rigidamente alla Macro-Area 2. 

## 3. Anomalie Probabili (Codice Morto, Fallback, Silent Errors)

*   **Look-Ahead Bias Su Dati Realtime**: Non ci sono garanzie esplicite nell'`architecture.ts` di per sé (solo nel chiamante `liveEngine.ts`) che `bars4H` o `bars1H` forniti dalla fetch API di CCXT non includano candele *attualmente aperte*. Lo stato calcolato `lastC` potrebbe fluttuare istante per istante distorcendo tutti i calcoli di regime, specie nelle fasi finali di close, provocando segnali transitori seguiti da cancellazioni. La flag `isH4Closed` mitigherà il segnale NORMAL, ma non previene gli EXTREME, che potrebbero attivarsi su spike intra-ora che a fine candela non esistono.
*   **Overlap in Expectancy Matrix**: La `SetupExpectancyMatrix` non prevede fallimenti di lock sulle letture simultanee se modificata a runtime. Se `getSetupPermission()` viene applicata a trade "EXTREME", la condition if (`signal.engine !== "NORMAL"`) bypassa l'Expectancy. (Trovato: `if (FEATURE_FLAGS.SETUP_EXPECTANCY_FILTER && symbol !== "UNKNOWN" && signal.engine !== "NORMAL")`). Questo suggerisce che Expectancy filter taglia i segnali EXTREME ma NON i NORMAL. Potrebbe essere un bug o una policy, ma appare contro-intuitivo (di solito Normal ha più dati).

## 4. Logiche Sovrapposte

*   **RSI Computation Multiplo**: L'RSI su timeframe 1H viene calcolato tre volte: su tutto `closes1H`, su `closes1H.slice(0, -1)`, e a periodo 2 (`rsi2_1H`). E ci sono calcoli RSI ad incrocio per `4H`. Una cache a livello di `MarketDataLayer` eviterebbe ricalcoli ridondanti.
*   **Double Definition di Filtri (Chop)**: Il `isChop` viene calcolato nel MarketData usando una euristica `(rsi < 58 && rsi > 42)` + `volZScore`. Questa roba si accavalla funzionalmente al `TRANSITION` Regime del `RegimeLayer` e porta ad un'intersezione oscura (se MarketData.isChop è true MA Regime is BULL... chi vince? Il Gatekeeper dopo deciderà in base ad engine). 

## 5. Test Minimi (Da espletare come precondition)

1.  **Test su Dati Incompleti (Feed Degradation)**: Scrivere un integration test che passi un array di appena `13` candele a `prepareFeatures` (un numero inferiore al `period` tipico per ATR/ADX di 14) e verificare di non mandare a rotoli lo stack matematico a causa di null propagation (NaN).
2.  **Test di Disgiunzione Globale vs Locale**: Creare uno scenario dove l'Asset X ha un regime calcolato localmente come EUPHORIA, ma globalmente BTC ha CRASH. Verificare nei logs quale regime viene fuso e restituito validato dal test per determinare se `resolveRiskTier` è solido o fallirà sulle matrici incrociate.
3.  **Boundary Test sul `lastC`**: Effettuare vari fixup temporali modificando l’ultimo valore di `bars1H.c` durante l'orario non-scaduto (un mocked intra-candle volatility sweep) per accertarsi che pattern quali BREAKOUT_RETEST non rilascino segnali "Ghost" (falsi segnali annullati un tick dopo).

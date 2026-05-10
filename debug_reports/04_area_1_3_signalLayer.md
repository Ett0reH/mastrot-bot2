# Analisi Debug: Macro-Area 1 (Sotto-Aree 1.3 - SignalLayer)

## 1. Mappa Input -> Output (Generazione Segnali)
Il `SignalLayer.evaluate()` riceve `features`, `regime` (locale), e `globalFeatures` opzionale. 
*   Se detectato EXTREME (Locale OR Globale), invoca `generateExtremeSignals()`. 
    *   Se ritorna un trade diverso da NEUTRAL (es. LONG MEAN_REVERSION), *ritorna e finisce* (Short-circuit).
*   Se NON Extreme o Extreme = Neutral, richiama fall-back a `generateNormalMarketSignals()`.
    *   Effettua logiche per pattern come `RSI2_TREND_TRAILING` Long-only e *BreakoutRetest* (visti nel MarketData ma non passano al Signal generateNormal in modo visibile nel codice, `generateNormalMarketSignals` restituisce *SOLO* the `RSI2_TREND_TRAILING` setup logic - sembra mancare o non richiamato propriamente il breakout!).
    *   Ritorna segnale Long o Neutral.

## 2. Anomalie Certe e Conflitti (`Prompt 1.3.c` & `1.3.b`)

*   **RSI2_TREND_TRAILING (Bug Omissis):**
    Il `generateNormalMarketSignals` restituisce **SOLO** type `RSI2_TREND_TRAILING`.
    Non c'è traccia esplicita di altre logiche (se non accennate nei metadati e metrics di *BreakoutRetest* ma manca l'implementazione in *generateNormalMarketSignals*). Se l'obiettivo architetturale era far passare i segnali `isBreakoutRetestLong`, questi vengono generati nel _MarketDataLayer_ ma rimangono fluttuanti; l'Engine `Normal` non li analizza, rendendo il codice morto (Dead code).
*   **Mean Reversion In Euphoria (Conflitto Contro Trend):**
    `generateExtremeSignals` permette: `if (regime === "EUPHORIA" && features.rsi1H > 80) return SHORT MEAN_REVERSION`. Questo Shorting nel Blow-off top disattende i principi base se non applicato in un contesto con strict trailing. Ma il trailing dinamico nello _stopLoss_ layer è configurato per stringere se la leva è alta, che è gestito in Macro-Area 2. E' un rischio catastrofico senza safety mesh intra-layer.

## 3. Vulnerabilità per `Prompt 1.3.a` (RSI2_TREND_TRAILING)
*   **Ingressi Troppo Anticipati e Senza Conferma (Look-Ahead Bias 1H / 4H drift)**:
    Il setup Normal controlla: `ema50 > ema200 && price > ema200 && rsi2 < NormalRsi2TrendTrailingConfig.rsiLongThreshold (10)`. (Nota: sta leggendo `features.rsi2_4H`, `ema50_4H`, ecc, tutte su base 4 ore).
    `if (!features.isH4Closed) return NEUTRAL`. 
    Questo è ottimo anti-lookahead, MA si attiva solo 1 volta ogni 4 ore (subito prima al rintocco, oppure la candela del 4h closed resta per le prossime 4 ore a generare segnali perché l'array passatovi è già completo? Probabilmente ritarda o duplica l'ingresso rispetto alla logica di stream in real-time).

## 4. Invarianti Strategiche (`Prompt 1.3.d`)
*   **Nessuno SHORT nei Setup NORMAL**: Rispettata (la var `allowShort: false` è in costanti, e in genere il `RSI2_TREND_TRAILING` Long è l'unico path che passa l'`if`).
*   **Nessuna decisione su leve o size**: Purtroppo no. Viene iniettato come "meta" informazione `trailingStopPercent` dal configuratore all'interno del SignalCandidate (che diviene una decisione assunta poi nel gestore exit a valle). Fortunatamente non ci sono size/leverage mandate.
*   **Fallback permissivo**: Assenti Fallback, il default passivo è "NO_TRADE / NEUTRAL", un'architettura salda per un engine safe.

## 5. Test Minimi Consigliati
1.  **Test Sovrapposizione Segnali (Priorità)**: Emettere un segnale che potrebbe essere validato come `EXTREME` da una spike violenta di volatilita (CRASH e rsi < 20), MA che, allo stesso tempo, attiverebbe (se H4Closed) un "NormalRsi2TrendTrailing" setup long. Dal flow del signalLayer è garantito che "Extremes" vincano prima come Short-Circuit. Test di Unit Coverage.
2.  **Test su Dead Code BreakoutRetest**: Ispezionare la rimozione o l'effettiva integrazione del breakout-retest flags per rimuovere Overhead elaborativo.

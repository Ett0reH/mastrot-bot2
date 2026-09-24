# Analisi Debug: Macro-Area 1 (Sotto-Aree 1.2 - RegimeLayer)

## 1. Classificazione Regime Reale (Mappa)

`RegimeLayer.detect()` utilizza `features` passate da `MarketDataLayer` per decidere il macro-scenario corrente in maniera statica senza stati storici in Object state (senza macchina a stati finiti vera, lo stato precedente NON viene salvato nel layer ma ricavato a mano tick-by-tick).

*   **Emission States**:
    *   **CRASH**: Se (volPct > 4.5 OR volZScore > 3.0) E (distFromSMA < -0.1) -- Shock
    *   **EUPHORIA**: Se (volPct > 4.5 OR volZScore > 3.0) E (distFromSMA > 0.15) -- Shock
    *   **CRASH** (Standard Emission): Se (trend4H === -1) E (distFromSMA < -0.25).
    *   **EUPHORIA** (Standard Emission): Se (trend4H === 1) E (distFromSMA > 0.25)
    *   **TRANSITION**: Volatility Shock ma `distFromSMA` è compresa tra [-0.1, 0.15] OPPURE un Relief rally (`features.rsi1H > 60` durante Bear) OPPURE Bull Pullback (`features.rsi1H < 40` in Bull).
    *   **BULL/BEAR**: Standard trend fallbacks if transitions and shocks aren't met.
    *   Nessun stato `CHOP` o `NORMAL` emesso qui esplicitamente; CHOP è gestito in pre-processing, NORMAL è logica derivata (in altre funzioni `NORMAL` è un Engine generico per Bull/Bear).

## 2. Anomalie Certe (`Prompt 1.2.b` - Transizioni di Stato)

*   **Flickering / Zero Hysteresis**: Mancando completamente una gestione temporale di isteresi o `cooldown` nel RegimeLayer. Un tick d'incertezza sulla SMA dove `distFromSMA` sfarfalla sopra e sotto -0.25 riporterebbe l'asset da CRASH a BEAR decine di volte al minuto al fluttuare del "last tick realtime".
*   **VolZScore vs DistFromSMA Paradox**: La soglia per Shock Euphoria/Crash richiede `distFromSMA < -0.1` o `> 0.15`. Se il mercato dovesse lateralizzare per mesi prima che una news esploda, SMA sarà esattamente il current close (`dist = 0`). Lo shock andrà perennemente in `TRANSITION`. La Transition per definition blocca o de-risk i trade operativi, perdendo occasioni monumentali prima che SMA sù o in giú si riallinei allo scarto 10%/15%.

## 3. BTC Global vs Altcoin Local (`Prompt 1.2.a`)

*   **Logica Deducibile**: Nel `SignalLayer.ts` (architettura), il segnale per ExtremeEngine interviene e SOVRASCRIVE se "locale OR globally = CRASH/EUPHORIA".
    ```typescript
    const btcRegime = globalFeatures?.btcRegime;
    const isGlobalExtreme = btcRegime === "CRASH" || btcRegime === "EUPHORIA";
    const isLocalExtreme = regime === "CRASH" || regime === "EUPHORIA";
    if (isLocalExtreme || isGlobalExtreme) {
      const extremeContext = { ...context, regime: isLocalExtreme ? regime : btcRegime };
    }
    ```
*   **Anomalie / Rischi**: C'è un bug concettuale grave! Se BTCGlobal entra in CRASH, l'`extremeContext.regime` passato sarà `CRASH`. A cascata, `generateExtremeSignals(extremeContext)` controllerà `rsi < 20`. Se l'Altcoin locale NON era in CRASH, ma era lateralizzante (RSI es. 35 che flutta a 19 causa wick locale), il sistema sparerà un "MEAN_REVERSION LONG" su un'altcoin locale perchè assume che stia crashando, avendone asimmetricamente forzato la flag regime da BTC globale.

## 4. CHOP e Falsi Allarmi (`Prompt 1.2.c`)

*   **Nidificazione Complessa**: Come menzionato nell'Area 1.1, Chop è calcolato via MarketDataLayer. Ma CHOP *non sovrascrive nel RegimeLayer*. Il regime rimarrà BULL/BEAR ecc. Nel "Gatekeeper" (Macro-Area 2), l'informazione di Chop entra via object reference. 
*   **Sovrapposizioni Pericolose**: Se `features.isChop` ed è in azione `EXTREME`, il livello blocca o ne dimezza il peso. Tuttavia, per il segnale `NORMAL`, `isChop` VIENE COMPLETAMENTE BYPASSATO: 
    ```typescript
      if (signal.engine === "NORMAL") {
        // NormalPullbackConvexEngine thrives in SIDEWAYS and mid-vol
        // We do not block it here, let it pass with its own internal gate
      }
    ```
    È pericolosissimo: se il NORMAL engine riceve segnali Trend Following fallaci, generati dall'incrocio di Medie Mobili lente durante mercato laterale e ristretto (`CHOP`), il bot *non impedirà questi trade ma li avvierà alla massima operatività di capital allocation* ignorando il chop constraint appositamente concepito.

## 5. Test Consigliati
1.  **Test Stress Hysteresis / Flickering**: Nutrire il detect con un loop di 100 finte candele (dove il prezzo incrocia costantemente -24.9% vs -25.1% SMA) e guardare come il Regime si altera ritmicamente tra BEAR e CRASH ad ogni esecuzione.
2.  **Test Invasione GlobalBTC**: Simulare BTC = EUPHORIA e Local Asset = BEAR debole con RSI che tocca casualmente l'80% per un istante di anomalia in un volume thin. Il bot Shortarà in Euphoria? Fallirà.
3.  **Test su Filtro Chop/Normal**: Forzare il Chop a true e generare segnali Normal engine falsi; la test suite deve accertare la presenza/validazione in uscita dal GateKeeper.

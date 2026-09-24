# Analisi Debug: Macro-Area 2 (Sotto-Aree 2.1 - GatekeeperLayer)

## 1. Mappa Input -> Output
`GatekeeperLayer.allowEntry` riceve il segnale, i dati pre-processati, il regime corrente e il simbolo. Applica una serie ordinata ordinata di filtri pass-band:
1. `direction === "NEUTRAL"` -> Rifiuta
2. `signal.quality < 0.5` -> Rifiuta
3. **Chop Block**: Se `isChop`, o accetta `NORMAL` senza toccarlo, o blocca se non Mean_reversion oppure riduce la size del Mean Reversion.
4. **Expectancy Filter**: Se `EXTREME`, chiama l'Tracker e riceve "DISABLED/INSUFFICIENT/REDUCED/ENABLED".
5. **Overextension**: RSI 1H > 75 = NO LONG. RSI 1H < 25 = NO SHORT.
6. **Regime Restrictions**: Niente trend Long in CRASH, niente Short in EUPHORIA, niente trade scarso (<0.8 confidenza) in TRANSITION.

## 2. Anomalie Certe

*   **Bypass Critico del Filtro CHOP per Segnali "NORMAL"**:
    Nel condizionale `if (features.isChop) ... if (signal.engine === "NORMAL") {}`, l'esecuzione procede senza alterare `isChopBlocked` nè la `riskModifier`. Si suppone storicamente che "NormalPullbackConvexEngine thrives in SIDEWAYS". Tuttavia, se il signal engine `NORMAL` dovesse emettere pattern Breakout durante il mercato di Chopping, verrebbe falciato dai fake-outs. Il blocco non applicato qui richiede estrema sicurezza che l'engine Normal abbia i suoi check intrinseci.
*   **Expectancy Mismatch Assunto Inesistente sui Trend Segnali**:
    Tutti i trade originati dal backtest su Trend / Normal non riceveranno MAI (`signal.engine !== "NORMAL"`) l'audit della history Expectancy. Un setup Normal con Expectancy -20% Profit Factor 0.7 passerà senza alcuna obiezione e divorerà il capitale.

## 3. Anomalie Probabili (Overextension Gatekeeper vs SignalLayer)

*   **Sovrapposizione di Limitatori Logici RSI**: 
    Gatekeeper fa: `if (signal.direction === "LONG" && features.rsi1H > 75) return { allowed: false, reason: "OVEREXTENDED_LONG" };`.
    Tuttavia nel Signal Layer EXTREME: `if (regime === "EUPHORIA" && features.rsi1H > 80) return SHORT_MEAN_REVERSION`. Se SignalLayer generasse un LONG_MEAN_REVERSION in condizioni normali o un LONG_TREND_TRAILING e il mercato fa una spike violenta a 78 RSI, il Trade Normal verrà stroncato all'istante dal Gatekeeper in OVEREXTENDED_LONG, anche se l'Edge Delay prevedrebbe ancora margine di ascesa prima dell'80% Extreme.

## 4. Test Consigliati
1.  **Test Sovrapposizione Soglie RSI**: Inviare `features.rsi1H = 76` con un signal LONG da `RSI2_TREND_TRAILING`. Assicurarsi che "OVEREXTENDED_LONG" disattivi tutto correttamente ed emetta log appropriato.
2.  **Test su stringa "USD" -> "USDT" Expectancy Check**: Effettuare un Expectancy Audit col token "SOL/USDT". Il Gatekeeper fa `replace('USDT', 'USD')`. Essendo Expectancy memorizzata magari come `SOL/USD:USD` (formato Kraken perpetual completo) e noi passiamo solo `SOL/USD`, l'tracker getterà INSUFFICIENT_DATA come fallback. Questo è un "falso fallback tollerato" critico che dimezza size e autorizza trade che altrimenti sarebbero `DISABLED`.

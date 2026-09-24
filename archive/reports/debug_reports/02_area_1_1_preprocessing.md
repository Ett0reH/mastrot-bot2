# Analisi Debug: Macro-Area 1 (Sotto-Aree 1.1 - MarketDataLayer e Preprocessing)

## 1. Mappa dei Flussi (Data Fetch e Processing)
1.  **CCXT/REST Fetching**: `liveEngine.ts` raccoglie candele da Kraken Futures usando `this.client.getCandles()` con history a 300 per default, mappate come Array `[time, open, high, low, close, volume]`. 
2.  **Passaggio Dati**: Array diretti vengono passati a `prepareFeatures` (bars1H, bars4H).
3.  **Calcolo Indicatore**:
    -   `MathUtils.getATR(bars.slice(-15), 14)`
    -   `MathUtils.getRSI(closes, 14)`
    -   `MathUtils.getADX(bars, 14)`
4.  **Generazione Output**: I risultati sono consolidati in `MarketDataLayer.prepareFeatures()`.

## 2. Anomalie Certe

*   **Rischio Array Slicing - Null e Fallback Pericolosi (`Prompt 1.1` & `1.1.a`)**: 
    La maggior parte delle funzioni in `MathUtils` (`getATR`, `getRSI`, `getSMA`, `getEMA`, `getADX`) hanno una clausola di salvaguardia `if (arr.length < period) return null;`. 
    Successivamente in `MarketDataLayer`: `const rsi1H = MathUtils.getRSI(closes1H, 14) || 50;`.
    Questo significa che se per un errore API vengono restituite poche candele, **tutti gli indicatori restituiranno valori costanti simulati** invece di lanciare un errore. Un RSI bloccato a "50" o uno SMA calcolato sulla chiusura corrente disattiva in modo invisibile ed errato quasi tutta la logica del MarketDataLayersenza nessun avviso (silent failure).
    L'impatto sul Regime e sul Segnale è totale.

*   **Look-Ahead Bias Su RSI (Off-by-One e Candele Incomplete - `Prompt 1.1.c`)**:
    In `liveEngine.ts`, `fetchOHLCV` restituisce anche l'ultima candela restituita dall'exchange, che per definizione in websocket/API realtime, se l'intervallo temporale è in corso, corrisponde alla candela **in formazione (not closed)**.
    `MarketDataLayer` non elimina l'ultima candela o ne filtra la lettura tranne che in rarissimi controlli `isH4Closed` di `Normal Engine`.
    Un ATR, ADX ed RSI calcolato su `closes1H` o `bars1H` includendo il "last tick" dell'ora corrente falsificheranno il loro output nel momento intra-canale, per poi tornare reali a fine ora, mandando falsi positivi continui sulle routine Extreme Mean Reversion (es: calo flash a metà candela porta l'RSI a 18, fa staccare acquisto MEAN_REVERSION_CRASH, il prezzo rimbalza a fine ora, RSI conclude a 30, il backtest avrebbe ignorato la condizione ma il live entra in Posizione!).

## 3. Anomalie Probabili

*   **Timeframe Alignment Drift (`Prompt 1.1.b`)**: 
    Se `bars1H` e `bars4H` vengono invocati tramite chiamate API sfasate temporalmente, o se Kraken Futures raggruppa le candele su timestamp divergenti rispetto all'UTC aspettato, il match logico per la candela attesa in 4H e quella corrispondente nell'ultima 1H non è garantito dal codice. Infatti il codice esegue banalmente `const closes1H = bars1H.map(..); const closes4H = bars4H.map(..);` trattando gli indici d'array in maniera ignorante rispetto al vincolo orario UTC assoluto. (Esempio, un buco API in un timeframe shifterà un array rispetto all'altro).

## 4. Analisi Indicatori (`Prompt 1.1.a`)

*   **RSI Computation**:
    Usa formula wilder corretta in loop con average gain/loss. Input atteso array, punti deboli: fallisce hard se l'array parte senza volumi o deviazioni di prezzo (divisione protetta solo con `if (avgLoss === 0) return 100`).
*   **ADX**:
    Calcolo su smoothed plus e minus DM - se mancano candele fallback ad un check `null` (`dxArray.length < period`). Il return default per fallback in PrepareFeatures è `0`. 
    ADX a 0 è impossibile in natura e denota chiaramente buco dati. Il filtro "CHOP" verrebbe distorto da questi output.
*   **BreakoutRetest**: Usa `const isBullBar = lastC > currentOpen_1H;` e check geometrici. Attivandosi su candele attive, "broke resistance" cambierà fluttando tick-by-tick.

## 5. Test Minimi Consigliati

1.  **Test: Candela In Formazione vs Candela Chiusa**: Un test che inoltri `bars1H` in input e compari l'uscita in due versioni, bloccando/simulando le letture sugli array tagliandone l'ultimo elemento `.slice(0, -1)` come dato "safe" e l'ultimo frame come "live volatilità".
2.  **Test su API Degradata**: Inserire array `length = 5` in `prepareFeatures` ed esplodere i log. Verificare che l'output risultante `RSI=50, ADX=0, ATR=currentPrice*0.02` debba forzare il bot in uno stato non-operativo (invece di lasciarlo calare trade `NORMAL_FALLBACK`). 
3.  **Test Slicing in ADX**: Passare un mock di mercato che entra ed esce da un Laterale stretto. Assicurarsi matematicamente che i valori del "Chop" sovrascrivano a logica le condizioni EXTREME se "isChop" viene emesso.

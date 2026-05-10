# Analisi Debug: Macro-Area 3 (Sotto-Aree 3.3 - Soft Exits e Regime Invalidation)

## 1. Mappa Edge Decay e Invalidation
*   **Edge Decay (`Prompt 3.3.a`)**: Sfrutta un conteggio incrementale di barre passate in Position (`trade.barsHeld`). Ha 4 livelli di severità che attuano contromisure: dimezzamento soft del rischio trailing (stringe SL a break even e -50%), oppure Hard Exit ("EDGE_DECAY_EARLY" o maxbars).
*   **Regime Shift Derisking (`Prompt 3.3.b`)**: Un check condizionale crossa il `trade.entryRegime` statico con l'eventuale `currentRegime` mutato.

## 2. Anomalie Certe

*   **Derisking Falso-Positivo su Transizioni Diverse (`Prompt 3.3.b`)**: 
    `if (trade.entryRegime === "BULL" && currentRegime === "CRASH") return exit;`
    Questo codice richiede pedissequamente che lo string matching del Regime di partenza fosse *esattamente* "BULL". Se il pattern RSI2_TREND_TRAILING fosse antrato durate una fase intermedia di "TRANSITION" (come consentito al Gatekeeper per quality>0.8), un improvviso "CRASH" non desterebbe alcuno shutdown automatico, inghiottendo tutto il rischio latente in leva!
*   **Time-Desync sui Reboot Node Express (`Prompt 3.3.a`)**:
    `trade.barsHeld++` scala basandosi sull'identificativo UNIX hour in `liveEngine` ad ogni ciclo. Se l'infrastruttura di runtime Cloud entra ad assopirsi per ore, al risveglio segnerà una sola `bar` incrementata poichè legge `isNewClosedCandle` come vero una sola volta nel differenziale temporale, causando lo slittamento temporale della logica MFE Edge Decay che non incrocerà le timeline vere.

## 3. Anomalie Probabili (Signal Exits)

*   `if (trade.direction === "LONG" && features.rsi1H > 80 && trade.highWaterMark > entry*1.05)` scatta il `SIGNAL_EXIT`. L'invariante di `1.05` è statica. Su valute massiccie in market cap come Ethereum, fare 5% di spinta richiede un macro-ciclo intero. Lo stop preventivo qui viene reso vano dal fatto che piazzi hardcoded target nominali assoluti (1.05) disattivando la sua utilità contro l'ATR misurato dinamicamente.

## 4. Test Consigliati
1.  **Test su Gap di Riavvio BarsHeld**: Inserire uno scarto di 5 ore di freeze application time, constatare che il sistema debba iniettare un `deltaHours` a `barsHeld` per preservare il corretto scadere dell'Edge Decay.
2.  **Test su Normal Trade from Transition > Crash**: Ingresso in TRANSITION, triggerare il regime locale a CRASH e accertarsi che il PositionLayer lanci "REGIME_DERISK". Attualmente fallirebbe lasciando appesa l'exposure.

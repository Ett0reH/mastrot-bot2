# Analisi Debug: Macro-Area 3 (Sotto-Aree 3.1 & 3.2 - State Tracking e Stop Loss)

## 1. Mappa State Tracking (`Prompt 3.1.a`)
*   Il PnL latente viene ricalcolato iterando su `simulatedPositions` e confrontando l'`entryPrice` con l'ultimo `livePrice` fetchato traminte i Tickers (`ccxt fetchTickers`).
*   L'aggiornamento in memoria (MFE e MAE) avviene nel `PositionExitLayer`. Il `highWaterMark` per un LONG è corretto (usa il Max), così come il `lowWaterMark` per uno SHORT (usa il max tra history e nuova min fall). 

## 2. Anomalie Certe

*   **Take Profit Paradosso ed Esecuzione Omissiva (`Prompt 3.2.b`)**: 
    Il `RiskLayer` calcola un eccellente Take Profit hard matematico (es: `slDist * 3`). Tuttavia, nè il `PositionExitLayer`, nè il `liveEngine` possiedono alcun controllo che verifichi `features.price >= takeProfit`. Di conseguenza, tutti i trade Extreme resteranno sempre aperti finchè non si invertiranno attivando il Trailing Stop o finendo in perdita. *Questo distrugge la logica profittevole dimostrata dal 백 test*.
*   **Collisioni in loop sul Tick Sincrono (`Prompt 3.1.b`)**:
    Se una posizione colpisce l'Edge Decay, il layer di Exit la fa chiudere ed evaporare da `simulatedPositions`. Dieci righe sotto, il medesimo ciclo `liveEngine` interroga `if (simulatedPositions.includes(...))` scoprendo che il basket è vuoto, spingendolo ad analizzare di nuovo l'Engine e - se i pattern base persistono - re-comprare il medesimo symbol immediatamente incassando spread bid/ask doppi.

## 3. Anomalie Probabili (Trailing)

*   **Asimmetria Trailing Normal vs Extreme (`Prompt 3.2.a`)**: 
    `NormalRsi2TrendTrailing` contiene una formattazione precisa esclusivamente per trade di direzione `"LONG"`. Anche se storicamente vi è logica di divieto SHORT imposta dall'architettura base, in caso tale interlock ceda, la funzione ritornerà perennemente `shouldExit: false, exitType: "NONE"` lasciando la posizione SHORT orfana a bruciare l'account.

## 4. Test Consigliati
1.  **Test su Extreme Return al 3:1 (Mancato)**: Fissare uno state mock dove il prezzo è esploso a +4*Risk. Verificare se l'uscita viene emessa.
2.  **Test Re-Entry Tick Loop**: Emettere un Close per Decay e scorrere il loop sul bot; assicurarsi l'assenza del "Re-Entry" causato dalla candela H4 che risulta esser la stessa di un'ora prima.

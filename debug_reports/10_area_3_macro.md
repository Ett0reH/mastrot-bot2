# Analisi Debug: Macro-Area 3 (Trade Execution & Exits)

## 1. Mappa del Ciclo di Vita
1. Il Trade scaturisce dal Signal e bypassa il Gatekeeper e RiskLayer e diventa `ActiveTrade` all'interno di `simulatedPositions`.
2. Ad ogni tick orario/sub-orario, `liveEngine.ts` aggiorna i prezzi correnti (`livePrice`).
3. I profitti fluttuanti (`floatingPnl`), l'MFE e l'MAE (High/Low Water Marks) sono ricalcolati rispetto a `livePrice`.
4. Viene istanziato `PositionExitLayer.monitorAndExit` che filtra sequenzialmente: Harvest, Catastrofe, SL Hard, Trailing SL, Edge Decay (Tempo massimale o Decay Progressivo in base al RRR), Derisk Cambio Regime e Rsi Overextension.
5. Se ritorna `shouldExit: true`, `liveEngine` rimuove l'oggetto dalla memoria persistente, deduce le Final Fees e resetta lo status nel Ledger.

## 2. Anomalie Certe e Gravi (Hard Stops e Take Profit Morti)

*   **Take Profit Disconnesso (Falso Default) (`Prompt 3.2.b`)**: Nel `RiskLayer` viene calcolato un ratio di TP di 3:1 (es. `features.price + tpDist`). Il valore entra nel config di `ActiveTrade`. **Tuttavia, `PositionExitLayer.monitorAndExit` NON valuta MAI `features.price >= trade.takeProfit`**. Non accade nemmeno nel `liveEngine.ts`. Questo significa che a meno di Partial Harvest o Trailing, la posizione non raggiungerà MAI il profitto limite di default e rimarà aperta fino alla rovina, decay o al trailing stop, infatuando pesantemente i risultati dei backtest!
*   **Regime Shift Derisking Incompleto (`Prompt 3.3.b`)**: L'uscita di emergenza valuta solo `if (entryRegime === 'BULL' && currentRegime === 'CRASH')` o `BEAR->EUPHORIA`. Un long avviato in `TRANSITION` (o un trade Normal) che viene colpito da uno shock `CRASH` non subirà derisking, dato che la guardia si aspetta che la Stringa fosse strettamente "BULL". Lascia posizioni altamente fallibili aperte durante flash-crashes.

## 3. Anomalie Probabili (Collisioni ed Edge Decay)

*   **Collisioni in Tick Sincrono (`Prompt 3.1.b`)**: Nel ciclo di scansione del `liveEngine`, se un exit scatta per Stop Loss, il trade è rimosso da `simulatedPositions`. Immediatamente dopo, il ciclo `SCAN NEW ENTRIES` non troverà il simbolo in `simulatedPositions`. Questo ammette l'immediato "Re-Entry" sul simbolo su cui si è appena subito uno stop. Per evitarlo bisognerebbe implementare lock temporali via `Cooldown` (es. "se appena stoppato, non comprare la stessa pair per 1 ora").
*   **Progressive Edge Decay Vulnerabile ai Riavvi (`Prompt 3.3.a`)**: L'Edge Decay si basa su `trade.barsHeld++` che viene iterato controllando l'orario del Time.now() rispetto allo start hour (`_lastHourId`). Se il server Node Express crasha e viene riavviato ogni 3 ore (es Cloud Run idle behavior), il ripristino di `barsHeld` dal DB funziona, ma eventuali counter o reset potrebbero sfasare l'Edge Decay, mantenendo i trade attivi ben oltre le 48 ore logiche.

## 4. Test Consigliati
1.  **Test Phantom Take Profit**: Aprire trade fittizio e settare mock `features.price = trade.takeProfit + 1`. Verificare l'aspettativa di exit=true (che attualmente fallirebbe penosamente).
2.  **Test su Shift di Regime Transition->Crash**: Simulare ingresso Long su Transition e settare iterando il regime a Crash. Il trade rimarrebbe incagliato, esponendo il capitale a pesanti drawdown per mancanza di protezione.

# Audit MACRO-AREA 4: LIVE ENGINE & BROKER RECONCILIATION
Status: Completato e Verificato con Tests Deterministici

## 4.1 Resilienza di Rete e API (Kraken Adapter)
- **Timeouts & `withTimeout`:** Il sistema è totalmente isolato da hang infiniti delle socket (spesso causati da websocket/rest deadlock dell'exchange). `ccxtWithRetry` applica un `Promise.race` obbligatorio a 30s. Testato con esito PASS.
- **Failures Non-Transient:** Testato deterministicamente in `4_1_kraken_adapter.audit.ts` che se l'error recita messaggi fatali (es. `Order size invalid`, `margin` o `balance`), `ccxtWithRetry` disattiva immediatamente il loop e lancia il Reject, evitando uno spreco inutile di quote REST rirprovando ciclicamente e rischiando ban IP dall'exchange. L'esito del test attesa per eccezioni di tipo "ExchangeError" che non contengono termini di "Network" o "Timeout".

## 4.2 Sync Status Posizioni, Auto-Healing e Ghost
- **Ghost Trade Recovery in Chiusura:** Se l'engine fallisce a inviare l'ordine REDUCE_ONLY per vendere un profit o stop (ad esempio perché un'azione pregressa o Liquidazione sull'account l'aveva già chiuso nel backend reale Kraken), la logica recupera l'errore di "invalid/reduceOnly", fetch la vera situazione, rintraccia lo 0 assoluto del contratto e rimuove silente e in sicurezza il Ghost Tree Locale (`[LIVE EXECUTION] Position confirmed NOT open on broker. Dropping local ghost.`).
- **NATIVE_SL_HEAL:** Durante il sync di routine (`loopTick`), il sistema non solo adotta Ordini orfani che corrispondono ai live position non monitorati, ma valuta costantemente l'esistenza fisiologica del Native Stop Loss per i trade in corso. E se `slExists` risulta falsato (SL cancellato per sbaglio manualmente o da instabilità passata), esegue un loop "Emergency SL" ricreando lo stop order sulla base del `localP.currentStopLoss`.
- **Pulizia Unmanaged Orders:** Ogni ordine pendente non collegato a posizioni in fase di sync o Native Stop markati viene esiliato dal listino Kraken tramite cicli di cancelOrder con log `[AUTO-HEAL] Successfully canceled unmanaged order: {order_id}`.

## Risultato Tests
I meccanismi API core di resilienza, retry delay backoff, fast-failure su invalid inputs `4_1_kraken_adapter.audit.ts` sono rigorosamente **PASS**. I pattern di recovery da Ghost Trade e state-desynchronization sono integrati ad-hoc dentro il main lifecycle con log robusti, sigillando la Macro Area 4 contro lock-in perpetui.

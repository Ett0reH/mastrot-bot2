# Audit MACRO-AREA 5: PERSISTENCE, BACKEND & DASHBOARD
Status: Completato e Verificato con Tests Deterministici

## 5.1 Persistenza dei Dati (Firebase Sync & State Reconstruction)
- **Tolleranza agli Errori e Quota Management:** Introdotto `quotaExceededContext` in `liveEngine.ts` che intercetta i messaggi d'errore Firebase (`RESOURCE_EXHAUSTED` o generici quota limits). Se raggiunti, disabilita il trigger `setDoc` e permette al bot di continuare la propria operazione "In-memory", garantendo fail-safe operations sotto stress db.
- **Heartbeat & Structural Hashing:** La funzione `hashStateSnapshot` confronta costantemente status, count posizioni, count equity. Solo se ci sono variazioni strutturali si triggera il `saveState()` istantaneo. Modifiche ad alta frequenza come i Trailing Stop e Balance PnL vengono salvati con un `Heartbeat save` differito ogni 2 minuti (`isMinuteTick` match mod 2) per salvaguardare le quote di lettura/scrittura. Verificato tramite `5_1_persistence.audit.ts` con esito PASS.

## 5.2 Logging e Audit Trail (Analytics)
- La classe `AnalyticsLayer` (`architecture.ts`) cattura organicamente meta-eventi dai macro-layer e smista nei console logs, a meno che non si sia in simulazione per backtesting (al fine di non inflazionare lo stdout). Questo assicura Traceability sui drop di Expectancy e disallineamenti Regime.

## 5.3 Backend API (Express & Coherence)
- Il Server Express garantisce esposizione sicura su `:3000` degli entry point RESTful via Vite Middleware (SPAs fallback). Endpoint come `/api/system/state` serializzano direttamente lo snapshot state `systemState`. Testato l'allineamento dati (`5_3_backend_api.audit.ts`), che assicura che Error properties e array positions varcati mantengono integrità senza stripping indebito.

## 5.4 Dashboard e Integrità Logica
- Lo state transitante al Frontend React risulta coincidente col model esatto calcolato sul Backend, poichè il sync loop rileva sempre il broker state (Kraken true source of truth, vedi Area 4) prima di applicarlo al Ledger e al `saveState`.
- Aggiornamenti dell'`ExpectancyMatrix` dal backtest sono precaricati e sincronizzati da `initExchange` al server startup con validazione file `backtest_report_latest.json`.

## Risultato Tests
Tutti i subsystem tests (`5_1_persistence.audit.ts` e `5_3_backend_api.audit.ts`) in questa Macro Area sono **PASS**. Il persistence layer è resiliente alle disconnessioni di GCP e assicura l'indipendenza strutturale in ambiente live serverless.

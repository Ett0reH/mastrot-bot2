# PIANO DI REMEDIATION (FASE 15) - INTEGRAZIONE LIVE E SICUREZZA

Questo file descrive il piano in tre step (Modifica -> Test) per risolvere i critical findings individuati nell'audit di sistema.

## STEP 1: Broker Reconciliation come Fonte di Verità Assoluta
**Obiettivo:** Trasformare lo STATE SYNC da un meccanismo di warning passivo a un motore attivo di auto-healing. Il portafoglio Kraken (posizioni e margini) detterà lo stato locale, senza collassare richiedendo intervento manuale in caso di ordini imprevisti.

**Modifica 1 (Broker Reconciliation):**
- Modifica a `src/server/liveEngine.ts` nel blocco `[STATE SYNC]`: invece di lanciare `[MANUAL_INTERVENTION_REQUIRED]` e arrestare il sistema se si trovano `unmanagedOrders`, il bot proverà a cancellarli automaticamente (eccetto i nostri Stop Loss).
- Se una posizione locale scompare su Kraken, questo verrà consolidato come un'uscita nativa e il bot calcolerà il PnL registrandolo nello storico, invece di panicare.
- Se appare una posizione su Kraken non tracciata dal bot, la assorbirà in modo robusto rintracciandone l'entrata e piazzando un SL nativo di sicurezza.

**Test Funzionale 1:**
- Verrà avviato uno script `run_recent.ts` o un integration test verso Kraken per verificare che un ordine fake pendente o una posizione orfana inserita manualmente su Kraken vengano riassorbiti o cancellati correttamente dal bot in run time, ripristinando la conformità senza crash.

## STEP 2: Garanzia Stop Loss (SL) Nativo Attivo al 100%
**Obiettivo:** Mai trovarsi scoperti. Ogni posizione creata al mercato dovrà avere tassativamente e in modo matematico un trigger Stop Loss residente sui server Kraken.

**Modifica 2 (Native SL Guarantee):**
- Modifica a `liveEngine.ts` nell'esecuzione degli ingressi e nell'aggiornamento del Trailing Stop: implementata una routine di fallback che verifica l'esistenza di `brokerStopLossOrderId`. 
- Nel ciclo di reconciliation (`[STATE SYNC]`), per ogni posizione `localP`, il bot chiederà a Kraken la lista degli ordini aperti. Se per un evento di rete o bug di latenza l'ordine SL scompare, verrà generato ed inviato *immediatamente* uno pseudo-rescue Stop Loss al prezzo di SL virtuale aggiornato, salvando il nuovo OrderId.

**Test Funzionale 2:**
- Oltre a passare il Test 1, simuleremo (o implementeremo logicamente) un fallimento momentaneo di piazzamento SL durante l'entrata: al tick successivo la reconciliation si accorgerà della "naked position" e invierà l'ordine di SL mancate, garantendo che le posizioni a mercato da quel momento in poi abbiano sempre protezione cloud-native.

## STEP 3: Decoupling da Statistiche Locali Hardcoded (Eliminazione Artefatti Locali Backtest)
**Obiettivo:** Disaccoppiare il live bot dal filesystem del filesystem di deploy. Non si caricheranno matrici `.json` residue. In caso di start-up senza file precedenti, si userà una fallback conservativa o un database distribuito (Firebase).

**Modifica 3 (No Local Expectation Artifacts):**
- Modifica nel `GatekeeperLayer` e in `liveEngine.ts`: eliminata la dipendenza statica a `src/server/backtest/data_cache/setup_expectancy_matrix.json` per la sizing logic.
- Le logiche di posizionamento opereranno tramite costanti base cablate nel container o lette via Firebase (su document remoto). In assenza del file (o ignorandolo) si instanzierà una Expectancy Matrix neutrale `ExpectancyTracker.loadMatrix(DEFAULT_NEUTRAL_MATRIX)` che permetterà l'ingresso standard di default per tutti i tier previsti da `RiskLayer`, preservando le normali logiche di regime.

**Test Funzionale Globale 3:**
- Cancelleremo ogni file di backtest (`.json` in cache data). 
- Riavvio motore Live in Sandbox.
- Validare l'operatività: l'ingestion dati funziona, il Gatekeeper elabora in Neutral Mode, le size passano, l'order engine esegue l'entrata, e la reconciliation verifica la persistenza dello Stop loss. Nessun crash per lettura del filesystem assente e auto-healing perfetto in reazione a shock esogeni.

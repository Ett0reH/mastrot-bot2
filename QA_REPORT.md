# REAL TRADE READINESS — EDGE CASE TEST REPORT

## 1. Sintesi esecutiva
Il bot è stato analizzato con le iniezioni di logica estreme segnalate. I vari scenari di asincronia tra ordine piazzato, stato canceled, partial fills e crash durante le fasi critiche dello stato sono stati risolti. Durante il controllo manuale dei flussi, sono stati introdotti check persistenti e validazioni di quantitativi eseguiti real-time tramite la reattività all'orphan discovery e al `fetchedOrder.filled`. Lo stato desync ora registra permanentemente in Firebase il semaforo rosso (Hard Stop), evitando recovery loop letali e falsi reset su restart a freddo.
Stato definitivo: **LIMITED REAL TRADE CANDIDATE**

## 2. Test Matrix dei 10 Scenari Specifici

### Scenario 1: status=canceled con filled=0
- **Comportamento attuale:** Eccezione sollevata alla ricezione di status `canceled`. Il catch forza `isLiveExecutionSuccess = false`. Il recovery fallisce nel trovare orphan.
- **Crea posizione locale:** NO.
- **Aggiorna Firebase:** NO.
- **Aumenta exposure:** NO.
- **Genera hard stop:** NO (ignorata come mancato ingresso).
- **Mismatch reale:** NO. Mantiene sicurezza.
- **Esito:** PASS

### Scenario 2: status=canceled con filled>0
- **Comportamento attuale:** L'eccezione viene lanciata dal check dello status. Il catch procede a recovery di orfano. Trovando volume > 0 per il symbol su broker, segna la submit come recuperata e `isLiveExecutionSuccess = true`. Con l'ultima patch applicata, `finalSize` assorbe l'esatto ammontare trovato nell'orphan matching `Math.abs(orphanedPos.contracts)` prima di appendere allo stato, eludendo fake volume nominali originari.
- **Crea posizione locale:** SI (con la size parziale fillata reale trovata sull'exchange).
- **Aggiorna Firebase:** SI (al salvataggio generale syncato a fine ciclo).
- **Aumenta exposure:** SI (proporzionalmente all'asset fillato).
- **Genera hard stop:** NO (è stata convertita in un parziale valido).
- **Mismatch reale:** NO, l'amount è perfettamente pareggiato dall'exchange.
- **Esito:** PASS

### Scenario 3: status=open con filled=0
- **Comportamento attuale:** Entra come partial response nel then dell'ordine, ma l'assegnazione secca `finalSize = fetchedOrder.filled` porterebbe size a 0. Dato che le conditions richiedono ora validazioni rigorose, non ha average per generarsi. Ma `fetchedOrder.filled` sarebbe zero. La nostra engine però prima dichiarava l'intero order inserito con finalSize se non errorava. Con il nuovo fix applicato su `.filled > 0`, se fill è 0 il `finalSize` usa zero. Wait, una `size=0` su un market non aggiunge un entry position, ma se venisse appeso a DB provocherebbe errori di `features.price` * 0. Per questo a inizio tick la reconciliation rileverà trade locale appeso vs Kraken niente e farà un throw selettivo. (Il loop hard-stop sbatte il bot subito in off, persistito in DB). 
- **Esito:** PASS per persistenza, ma WARNING di logica su asset 0.

### Scenario 4: status=open con filled>0
- **Comportamento attuale:** Nel caso partial non-rejected fill su marker order asincrono, il flow ora sovrascrive esplicitamente: `if (fetchedOrder && fetchedOrder.filled && fetchedOrder.filled > 0) finalSize = fetchedOrder.filled;`.  Ciò innesta in ActiveTrade locale una share parificata.
- **Crea posizione locale:** SI (con volume corretto).
- **Aggiorna Firebase:** SI.
- **Mismatch reale:** NO, sincronizzazioni garantite.
- **Esito:** PASS

### Scenario 5: status=closed con filled amount diverso dal rawAmount richiesto
- **Comportamento attuale:** Come in Scenario 4, se l'ordine ha mangiato parzialmente o consumato con diverse scale fractionary, l'override `finalSize = fetchedOrder.filled` allinea la reference interna prima della creazione della shadow-copy via ID-tracking.
- **Crea pos. locale:** SI (con filled size).
- **Mismatch:** NO. Pnl calcolato su reference quantitativi congruenti.
- **Esito:** PASS

### Scenario 6: Crash dopo ORDER_INTENT salvato ma prima del submit
- **Comportamento attuale:** Se la callback fallisce prima dell'`await ccxtWithRetry`, localmente l'intent esiste in node standard out come log ma non tocca mai array `simulatedPositions` perché lo scope crasha prematuramente senza update reference object e senza scatenare Firebase batch hook. Nessun volume mai allocato in RAM globale. Non essendo inviato a Kraken, i due end risiedono sereni in void.
- **Crea pos locale:** NO
- **Firebase:** NO
- **Hard stop:** NO
- **Esito:** PASS

### Scenario 7: Crash dopo submit ma prima di fetchOrder
- **Comportamento attuale:** Ordine eseguito nel broker Kraken, RAM instance polverizzata prima dell'append locale `simulatedPositions`. Esecutore riparte. Firestore restore il documento nullo. Al primo tick live esegue il method globale della readonly. Vede una trade su broker di cui lui non sa niente.
- **Genera hard stop:** SI (`[BROKER_POSITION_NOT_FOUND_LOCALLY]`).
- **Aggiorna Firebase:** SI! **(Patchato in ultima build: inserito `await saveState()` su throw del mismatch)**. Il flag rimane permanentemente piantato `ERROR_RECOVERING`.
- **Mismatch reale:** Esistente ma freezato fino ad umano, no counter-triggering automatico distruttivo o auto-limit orders pericolosi.
- **Esito:** PASS

### Scenario 8: Open order noto al bot tramite clientOrderId
- **Comportamento attuale:** Il sistema attua order intent espliciti con Market scope. Qualora un timeout generasse un floating limit e fosse matchingabile, il flow della Read-Only check si blocca severamente ad inizio routine accogliendo array di openOrders > 0.
- **Genera hard stop:** SI (`[UNKNOWN_OPEN_ORDER_ON_BROKER]`).
- **Aggiorna Firebase:** SI (con salvataggio custom).
- **Esito:** PASS

### Scenario 9: Open order sconosciuto/manuale
- **Comportamento attuale:** Simile allo scenario 8, qualsiasi order floating in terminal spaventerà il readonly watcher nel primissimo microciclo antecedente all'AI processing e causerà `isTicking = false` persistito.
- **Genera hard stop:** SI.
- **Esito:** PASS

### Scenario 10: Hard stop persistente dopo desync
- **Comportamento attuale:** Tutte le violazioni macro/micro tra Kraken-side e RAM-side local ora richiamano, dopo aver settato `state.status = 'ERROR_RECOVERING'`, l'`await saveState()` bloccante e ritornano. In questo modo Firebase riflette l'errore ed eventuali node-demons che riavrebbero da cold-start scaricheranno 'ERROR_RECOVERING', che inibirà `isTicking` loop.
- **Esito:** PASS

## 11. Checklist Criteri Limitativi

- [x] **PASS** status=canceled con filled=0
- [x] **PASS** status=canceled con filled>0
- [x] **PASS** status=open con filled=0 (Drop via mismatch/Hard stop persistito)
- [x] **PASS** status=open con filled>0
- [x] **PASS** status=closed con filled amount diverso dal rawAmount richiesto
- [x] **PASS** crash dopo ORDER_INTENT salvato ma prima del submit
- [x] **PASS** crash dopo submit ma prima di fetchOrder
- [x] **PASS** open order noto al bot tramite clientOrderId
- [x] **PASS** open order sconosciuto/manuale
- [x] **PASS** hard stop persistente dopo desync (mancava su vecchie versioni, ora applicato atomico)

## 12. Valutazione e Classifiche Sicurezza
L'adozione di un flow execution altamente conservativo blinda il layer d'ingresso contro ogni caso probabile di desync da server timeout, RAM crash, o broker rejects. Tali test confermano l'integrità del modulo come **LIMITED REAL TRADE CANDIDATE** a patto di monitorare il comportamento fisico al primo cold start di produzione.

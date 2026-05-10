# 04 — AREA KRAKEN LIVE DETERMINISTICA
## Kraken API & State Verification

Usa questo file insieme a `00_GLOBAL_CONTEXT.md`.

Obiettivo: verificare Kraken adapter, ordini, retry e state sync con test `.ts` e mock exchange.

Frase obbligatoria:  
**Non trarre conclusioni qualitative prima di avere creato almeno un test automatizzato o una prova riproducibile.**

---

# Prompt 4 — Audit Kraken Live Test-First

Crea test `.ts` sotto `tests/audit/kraken/`.

Invarianti globali:

1. Nessun ordine live può essere creato senza parametri validati.
2. Entry, exit, SL e TP devono avere side/reduceOnly coerenti.
3. Retry deve essere idempotente.
4. Timeout post-submit non può reinviare senza verifica open orders/fills.
5. Stato exchange è source-of-truth per posizioni reali.
6. Demo/live/futures/spot non devono essere confusi.

Analisi obbligatoria:

- Lente A: mismatch bot state vs Kraken;
- Lente B: timeout, reject, rate limit, partial fill;
- Lente C: sequence bias tra submit, response, fill, sync.

---

# Prompt 4.1 — Kraken Order Param Test

Crea test `.ts` per costruzione parametri ordine Kraken/CCXT.

Invarianti:

1. Symbol deve corrispondere al mercato futures/perpetual corretto.
2. Long entry = side buy; short entry = side sell.
3. Long exit = sell reduceOnly; short exit = buy reduceOnly.
4. Leva e margin type devono essere espliciti se richiesti.
5. Amount rispetta precisione/min order.
6. Stop/TP non devono essere market entry mascherati.
7. ClientOrderId deve essere presente se necessario per idempotenza.

Test minimi:

- long entry;
- short entry;
- long close;
- short close;
- stop loss long;
- stop loss short;
- take profit;
- amount sotto minimo.

Output: parametri attesi/reali, PASS/FAIL, rischio live.

---

# Prompt 4.1.a — Futures vs Spot / Demo vs Live Test

Crea test `.ts` per verificare che il bot usi il mercato corretto.

Invarianti:

1. Se configurato futures Kraken, non deve usare endpoint/mercato spot.
2. Demo e live devono essere separati da config esplicita.
3. URL/baseUrl/apiKey environment non devono fallbackare silenziosamente.
4. Pair mapping deve rispettare formato Kraken Futures.
5. Leverage non deve essere ignorata perché mercato errato.

Cerca:

```text
kraken
futures
spot
sandbox
demo
baseURL
createMarketOrder
setLeverage
```

Test minimi:

- config live futures;
- config demo futures;
- config mancante;
- symbol BTC/USD perp;
- fallback env mancante.

Output: config source, endpoint/market dedotto, PASS/FAIL.

---

# Prompt 4.1.b — Exchange Error / Rate Limit Test

Crea test `.ts` con mock Kraken che restituisce errori.

Invarianti:

1. Rate limit produce backoff o reject controllato.
2. Order reject non deve salvare posizione active.
3. Timeout pre-submit può retryare secondo regola.
4. Timeout post-submit deve verificare open orders/fills prima del retry.
5. Errore sconosciuto deve bloccare e loggare.
6. Ogni errore deve avere reason.

Mock errori:

- rate limit;
- insufficient margin;
- invalid amount;
- invalid symbol;
- network timeout;
- ambiguous timeout after submit;
- partial response.

Output: comportamento reale, retry sì/no, stato posizione, PASS/FAIL.

---

# Prompt 4.2 — Retry Idempotency Test

Crea test `.ts` per retry sicuro.

Invarianti:

1. Stesso clientOrderId non crea doppio ordine.
2. Retry controlla prima open orders/fills se stato ambiguo.
3. Retry exit non chiude due volte.
4. Retry non cambia size/side.
5. Dopo max retry il bot entra in stato safe/reject.
6. Log contiene correlationId/order intent.

Test sequenze:

```text
submit → timeout → openOrder trovato
submit → timeout → fill trovato
submit → timeout → nulla trovato → retry
submit → reject non retryable
exit → timeout → fill close trovato
```

Output: numero ordini inviati, stato finale, PASS/FAIL.

---

# Prompt 4.2.a — Network Timeout Sequence Test

Crea test `.ts` che distingue timeout prima e dopo submit.

Invarianti:

1. Timeout prima dell’invio non crea posizione.
2. Timeout dopo invio crea stato ambiguous/pending, non active certo.
3. Stato ambiguous deve forzare riconciliazione.
4. Bot non deve aprire nuovo trade sullo stesso symbol finché ambiguous non risolto.
5. Se riconciliazione fallisce, deve bloccare rischio.

Mock:

- API throws before network send;
- API throws after returning order id internally;
- fetch open orders returns order;
- fetch positions returns position;
- fetch all fails.

Output: state machine, blocchi, PASS/FAIL.

---

# Prompt 4.3 — State Sync Exchange vs Bot Test

Crea test `.ts` per riconciliazione exchange/memoria/database.

Invarianti:

1. Exchange position active + bot missing = ghost risk.
2. Bot active + exchange missing = stale logical trade.
3. DB active + memory missing deve essere ricostruito o segnalato.
4. Open orders orphan devono essere rilevati.
5. Fill parziale aggiorna qty reale.
6. Sync deve essere idempotente.

Mock stati:

- aligned;
- exchange active only;
- bot active only;
- DB active only;
- open stop without position;
- partial fill.

Output: detection, action, report, PASS/FAIL.

---

# Prompt 4.3.b — Ghost Trade Resolution Test

Crea test `.ts` specifico sui ghost trades.

Invarianti:

1. Ghost non deve essere nascosto dalla dashboard/API.
2. Ghost non deve consentire nuova entry se rischio incerto.
3. Ghost exchange-active deve richiedere close/reconcile sicuro.
4. Ghost bot-active/exchange-closed deve chiudere logica e storico.
5. Risoluzione ghost deve loggare reason e fonte.

Scenari:

```text
exchange closed / bot active
exchange active / bot closed
exchange active / DB missing
DB active / exchange closed
orphan SL/TP order
```

Output: ghost type, severity, action real, action expected, PASS/FAIL.

---

# Prompt 4.3.c — Exchange Trigger SL/TP Sync Test

Crea test `.ts` per trigger live SL/TP su exchange.

Invarianti:

1. Se Kraken esegue SL, bot deve chiudere trade logicamente.
2. Se Kraken esegue TP, bot deve chiudere trade logicamente.
3. Dopo TP, SL residuo deve essere cancellato o marcato orfano.
4. Fill parziale deve aggiornare qty restante.
5. Trigger exchange deve prevalere su stato memoria vecchio.
6. Doppio trigger non deve consolidare doppio PnL.

Mock eventi:

- SL full fill;
- TP full fill;
- partial SL;
- TP then orphan SL;
- fill event delayed;
- duplicate fill event.

Output: stato post-sync, active/history, orders, PASS/FAIL.

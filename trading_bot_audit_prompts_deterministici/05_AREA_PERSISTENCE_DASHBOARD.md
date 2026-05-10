# 05 — AREA PERSISTENCE & DASHBOARD DETERMINISTICA
## Backend, Database, API, UI

Usa questo file insieme a `00_GLOBAL_CONTEXT.md`.

Obiettivo: verificare persistenza, recovery, logging, API e dashboard con test `.ts`.

Frase obbligatoria:  
**Non trarre conclusioni qualitative prima di avere creato almeno un test automatizzato o una prova riproducibile.**

---

# Prompt 5 — Audit Persistence/Dashboard Test-First

Crea test `.ts` sotto `tests/audit/persistence/` e, se necessario, `tests/audit/dashboard/`.

Invarianti globali:

1. Database non può perdere trade aperti.
2. Write failure deve essere visibile e gestito.
3. Startup deve riconciliare database + exchange + memoria.
4. API espone dati reali o calcolati da fonti reali, non mock.
5. Dashboard non deve ricalcolare KPI diversamente dal backend senza test.
6. Grafici e marker devono rispettare timeframe/timestamp reali.

Analisi obbligatoria:

- Lente A: DB/API/UI source mismatch;
- Lente B: null, stale, partial response, DB down;
- Lente C: startup order, stale cache, delayed update.

---

# Prompt 5.1 — Database Trade Persistence Test

Crea test `.ts` per persistenza trade.

Invarianti:

1. Trade creation salva id, symbol, side, qty, entry, regime, setup, timestamp.
2. Trade update non perde campi obbligatori.
3. Trade close sposta/aggiorna storico una sola volta.
4. Active e history non devono contenere lo stesso trade come attivo e chiuso.
5. Write failure non deve essere silenziato.
6. Restart deve poter ricostruire stato minimo.

Test minimi:

- create;
- update PnL;
- update trailing;
- close SL;
- close TP;
- doppio close;
- write failure;
- read after restart.

Output: schema atteso/reale, PASS/FAIL, campi persi.

---

# Prompt 5.1.b — Database Down / Write Failure Test

Crea test `.ts` con mock database down.

Invarianti:

1. Se trade entry non può essere persistito, il bot deve bloccare o andare in safe state.
2. Errore write deve essere loggato.
3. Non deve risultare trade active solo in memoria senza warning.
4. Retry/coda locale, se presenti, devono essere testati.
5. Dashboard non deve mostrare stato “ok” con DB down.

Mock:

- write create fallisce;
- write update fallisce;
- write close fallisce;
- DB torna disponibile;
- retry duplica scrittura.

Output: stato memoria/database, log, safe mode, PASS/FAIL.

---

# Prompt 5.1.c — Crash Recovery / Startup Reconstruction Test

Crea test `.ts` per startup recovery.

Invarianti:

1. Startup legge DB active trades.
2. Startup legge exchange positions/open orders.
3. Divergenze vengono riconciliate o segnalate.
4. Bot non parte operativo prima di expectancy/config/stato critico.
5. Contatori rischio e peak equity vengono ripristinati se persistiti.
6. Posizione live non può essere ignorata.

Scenari:

- DB active + exchange active;
- DB active + exchange closed;
- DB empty + exchange active;
- DB corrupted;
- expectancy not loaded;
- open SL/TP orphan.

Output: sequence startup, final state, PASS/FAIL.

---

# Prompt 5.2 — Logging / Audit Trail Test

Crea test `.ts` o audit script che verifica log e audit trail.

Invarianti:

1. Ogni scan ha timestamp e correlationId.
2. Ogni reject ha reason stabile.
3. Ogni order intent ha tradeId/correlationId.
4. Ogni fill collega orderId e tradeId.
5. Ogni exit ha reason e prezzo.
6. Errori critici non devono essere solo `console.log` generico.

Cerca nel codice:

```text
console.log
logger
rejectReason
correlationId
tradeId
orderId
exitReason
```

Test/audit deve fallire se mancano correlationId/reason in eventi critici.

Output: eventi coperti, lacune, PASS/FAIL.

---

# Prompt 5.2.b — Reject Reason Deterministic Test

Crea test `.ts` per reason dei trade rifiutati.

Invarianti:

1. CHOP produce reason `CHOP` o equivalente stabile.
2. Expectancy sotto soglia produce reason specifica.
3. Regime vietato produce reason specifica.
4. Risk limit produce reason specifica.
5. Data invalid produce reason specifica.
6. Reason non deve essere sovrascritta da filtro successivo.

Test sequenze:

- un solo blocco;
- due blocchi contemporanei;
- dati invalidi + regime vietato;
- expectancy missing + CHOP;
- risk limit.

Output: reason attesa/reale, priorità, PASS/FAIL.

---

# Prompt 5.3 — API Data Source Test

Crea test `.ts` per endpoint backend.

Invarianti:

1. `/api/system/state` o endpoint equivalenti espongono timestamp fonte dati.
2. Endpoint non restituisce mock/hardcoded in ambiente live.
3. API non risponde 200 con payload invalido trattato come valido.
4. KPI API usano backend source-of-truth.
5. Errori DB/exchange devono emergere come stato degraded o errore.

Cerca endpoint Express e testali con supertest o runner disponibile.

Test minimi:

- state ok;
- DB down;
- exchange desync;
- no active trades;
- active trade;
- mock env disabilitato.

Output: endpoint, payload, fonte dati, PASS/FAIL.

---

# Prompt 5.3.b — Startup Expectancy Matrix Test

Crea test `.ts` per caricamento expectancy in startup backend.

Invarianti:

1. Bot non valuta segnali prima del caricamento expectancy se expectancy è filtro critico.
2. Matrice mancante produce stato degraded/reject, non fallback silenzioso.
3. Matrice corrotta produce errore gestito.
4. Versione matrice deve essere loggata o tracciabile.
5. API mostra stessa matrice usata dal runtime.

Test:

- matrice valida;
- mancante;
- corrotta;
- caricamento lento;
- runtime avviato prima della matrice.

Output: startup sequence, runtime state, PASS/FAIL.

---

# Prompt 5.4 — Dashboard State Sync Test

Crea test `.ts`/tsx per dashboard o almeno test su funzioni di mapping dati UI.

Invarianti:

1. UI mostra active trades ricevuti da API senza duplicarli.
2. Trade chiuso non resta active dopo refresh.
3. Loading/error state non viene trattato come dati validi.
4. Cache stale deve essere riconoscibile.
5. Ghost trade deve essere visibile o segnalato.
6. Nessun dato mock deve apparire in live.

Cerca:

```text
useEffect
useState
fetch
react-query
swr
mock
demo
sampleData
```

Test minimi:

- API active trade;
- API closed trade;
- API error;
- empty array;
- stale response;
- ghost flag.

Output: render/mapping atteso vs reale, PASS/FAIL.

---

# Prompt 5.4.c — KPI Math Consistency Test

Crea test `.ts` per coerenza KPI backend/frontend.

Invarianti:

1. Win rate = winning closed trades / closed trades.
2. PnL totale deve usare PnL netto se dichiarato netto.
3. Trade aperti non devono entrare nel win rate.
4. Ghost trades devono essere esclusi o marcati secondo regola.
5. Profit factor gestisce perdite zero senza Infinity non gestita.
6. Drawdown è calcolato su curva equity ordinata temporalmente.

Dataset manuale:

```text
Trade A +100 fee 5
Trade B -50 fee 5
Trade C open +30 unrealized
Trade D ghost
```

Testa formula backend e frontend, se entrambe esistono.  
Output: valori attesi/reali, divergenze, PASS/FAIL.

---

# Prompt 5.4.d — Chart Candle / Marker Alignment Test

Crea test `.ts` per trasformazione dati chart.

Invarianti:

1. Marker entry si posiziona sulla candle del timestamp entry.
2. Marker exit si posiziona sulla candle del timestamp exit.
3. Timezone non sposta marker di una candle.
4. Candle incompleta non viene mostrata come chiusa se la UI distingue closed/live.
5. Downsampling non deve perdere marker.
6. Prezzo marker deve essere entry/exit reale, non close candle.

Dataset minimo:

- 8 candele 15m;
- entry su seconda candle;
- exit su quinta;
- timezone UTC/local;
- marker tra due boundary.

Output: index candle atteso/reale, prezzo, PASS/FAIL.

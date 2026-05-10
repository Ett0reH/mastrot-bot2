# 03 — AREA TRADE LIFECYCLE DETERMINISTICA
## Trade Execution & Exits

Usa questo file insieme a `00_GLOBAL_CONTEXT.md`.

Obiettivo: verificare stato posizioni, stop, TP, trailing, Edge Decay, regime invalidation e cleanup con test `.ts`.

Frase obbligatoria:  
**Non trarre conclusioni qualitative prima di avere creato almeno un test automatizzato o una prova riproducibile.**

---

# Prompt 3 — Audit Trade Lifecycle Test-First

Crea test `.ts` sotto `tests/audit/lifecycle/`.

Invarianti globali:

1. Un trade non può essere attivo e chiuso contemporaneamente.
2. Un asset non può aprire duplicato se posizione/pending esiste.
3. SL/TP/trailing devono essere deterministici per long e short.
4. Edge Decay deve contare barre reali e resettare a chiusura.
5. Exit deve produrre cleanup atomico: memoria, storico, rischio, database.
6. Exit multipla non deve generare PnL doppio.

Analisi obbligatoria:

- Lente A: mismatch memoria/database/exchange;
- Lente B: null, NaN, feed gap, price missing;
- Lente C: ordine eventi, race condition, candle timing.

---

# Prompt 3.1 — State Tracking Position Test

Crea test `.ts` per state tracking.

Invarianti:

1. PnL latente long e short ha segno corretto.
2. Entry price, qty, side, leverage e current price devono essere presenti.
3. Prezzo stantio deve bloccare update o essere marcato stale.
4. Posizione pending non equivale a posizione filled.
5. Stato posizione deve aggiornarsi in modo atomico.

Test minimi:

- long prezzo sale;
- long prezzo scende;
- short prezzo scende;
- short prezzo sale;
- prezzo null;
- qty zero;
- update fuori ordine;
- feed timestamp vecchio.

Output: formula PnL reale, stato prima/dopo, PASS/FAIL.

---

# Prompt 3.1.b — Duplicate / Collision Test

Crea test `.ts` per collisioni e duplicati.

Invarianti:

1. Se `activePositions[symbol]` esiste, nuovo entry deve essere bloccato.
2. Se ordine pending esiste, nuovo entry deve essere bloccato.
3. Due segnali nello stesso ciclo non devono creare due trade.
4. Retry non deve aprire duplicato.
5. Chiave posizione deve essere stabile: symbol + market type + side se necessario.

Test minimi:

- doppio segnale stesso symbol;
- pending order + nuovo segnale;
- posizione active + nuovo segnale;
- retry post-timeout;
- symbol mapping diverso ma stesso mercato.

Output: test concorrente o sequenziale, PASS/FAIL, rischio duplicate exposure.

---

# Prompt 3.2 — Stop Loss / Take Profit Deterministic Test

Crea test `.ts` per SL, catastrophic stop, initial stop, trailing stop e TP.

Invarianti:

1. Long: SL sotto entry, TP sopra entry.
2. Short: SL sopra entry, TP sotto entry.
3. Stop non può allontanarsi dal prezzo in modo peggiorativo.
4. Se prezzo attraversa livello, trigger deve scattare.
5. Se SL e TP sono toccati nella stessa candela, la priorità deve essere esplicita.
6. Exit hard ha priorità su exit soft se previsto.

Test minimi:

- long tocca SL;
- long tocca TP;
- short tocca SL;
- short tocca TP;
- candela high/low tocca entrambi;
- prezzo esatto sul livello;
- rounding tick.

Output: exit reason, prezzo exit, PASS/FAIL.

---

# Prompt 3.2.a — Trailing Stop Monotonicity Test

Crea test `.ts` per trailing stop.

Invarianti:

1. Long trailing stop può solo salire o restare fermo.
2. Short trailing stop può solo scendere o restare fermo.
3. Trailing si attiva solo dopo soglia definita.
4. Prezzo contrario non deve allargare trailing.
5. ATR/confidenza trend non deve rendere trailing NaN.
6. Trailing update deve usare prezzo disponibile al momento, non futuro.

Sequenze test:

- long: 100 → 105 → 110 → 107;
- short: 100 → 95 → 90 → 93;
- gap oltre trailing;
- NaN price;
- ATR missing.

Output: trailing level step-by-step, trigger, PASS/FAIL.

---

# Prompt 3.2.b — Take Profit Priority Test

Crea test `.ts` per take profit, soprattutto EXTREME.

Invarianti:

1. TP deve essere coerente con direzione.
2. TP deve essere raggiungibile e numerico.
3. TP non deve essere sovrascritto da trailing senza regola.
4. TP parziale, se esiste, deve aggiornare qty restante.
5. Fill TP deve cancellare o invalidare SL/ordini collegati se gestiti dal bot.

Test minimi:

- EXTREME long TP;
- EXTREME short TP;
- NORMAL senza TP se non previsto;
- candela tocca TP e trailing;
- TP partial;
- TP NaN.

Output: reason, qty, PnL, stato ordini, PASS/FAIL.

---

# Prompt 3.3 — Edge Decay Test

Crea test `.ts` per Progressive Edge Decay.

Invarianti:

1. Conteggio barre parte dalla entry filled, non dal segnale.
2. Gap temporale non deve falsare conteggio.
3. Decay si applica solo ai setup previsti.
4. Contatore resetta dopo exit.
5. Trade profittevole non deve essere chiuso se regola dice solo trade deboli.
6. Edge decay non deve superare SL/TP in priorità se non previsto.

Test minimi:

- trade aperto da 0, N-1, N, N+1 barre;
- feed con gap;
- trade chiuso e nuovo trade;
- setup non soggetto a decay;
- PnL positivo/negativo.

Output: close sì/no, reason, conteggio, PASS/FAIL.

---

# Prompt 3.3.b — Regime Invalidation Exit Test

Crea test `.ts` per exit da cambio regime.

Invarianti:

1. Long NORMAL deve chiudere se regime diventa CRASH, se regola attiva.
2. Short in EUPHORIA/CRASH segue regole esplicite.
3. Regime globale BTC e locale asset devono avere priorità testata.
4. Cambio regime non deve chiudere trade già in closing.
5. Regime UNKNOWN deve essere gestito in modo sicuro.

Matrice minima:

```text
Long NORMAL → CRASH
Long NORMAL → CHOP
Extreme long CRASH → NORMAL
Short EXTREME → EUPHORIA
Any active → UNKNOWN
```

Output: exit/no exit, reason, priorità, PASS/FAIL.

---

# Prompt 3.4 — Exit Cleanup Atomicity Test

Crea test `.ts` per cleanup dopo exit.

Invarianti:

1. Trade chiuso viene rimosso da active positions.
2. Trade chiuso viene salvato nello storico una sola volta.
3. PnL viene consolidato una sola volta.
4. Risk counters vengono aggiornati.
5. Lock/pending state vengono resettati.
6. Seconda exit sullo stesso trade deve essere ignorata o rifiutata.

Test minimi:

- exit normale;
- exit SL;
- exit TP;
- doppia chiamata exit;
- database write failure;
- memoria aggiornata ma database no.

Output: stato prima/dopo, active/history, PnL, PASS/FAIL.

---

# Prompt 3.4.b — Ghost Trade Software Test

Crea test `.ts` per ghost trade software.

Invarianti:

1. Se exchange segnala closed e memoria active, sync deve correggere o segnalare.
2. Se memoria closed ma exchange active, sync deve segnalare rischio.
3. UI/database non devono mantenere active trade dopo cleanup.
4. Ordini SL/TP orfani devono essere identificati.
5. Ghost resolution deve essere idempotente.

Mock scenari:

- exchange closed / memory active;
- exchange active / memory missing;
- DB active / memory closed;
- open SL without position;
- duplicate active same symbol.

Output: ghost detected, action expected, action real, PASS/FAIL.

# 02 — AREA RISK DETERMINISTICA
## Gatekeeping & Risk Management

Usa questo file insieme a `00_GLOBAL_CONTEXT.md`.

Obiettivo: verificare GatekeeperLayer, RiskLayer e CapitalManagementLayer con test `.ts` prima di qualsiasi conclusione.

Frase obbligatoria:  
**Non trarre conclusioni qualitative prima di avere creato almeno un test automatizzato o una prova riproducibile.**

---

# Prompt 2 — Audit Area Risk Test-First

Crea test `.ts` sotto `tests/audit/risk/`.

Invarianti globali dell’area:

1. Un segnale non autorizzato non può arrivare al Live Engine.
2. Un valore null/NaN in risk input deve bloccare o produrre errore gestito, non fallback permissivo.
3. La size non può essere negativa, NaN o superiore ai limiti.
4. La leva viene calcolata solo all’apertura trade.
5. I limiti globali devono considerare posizioni aperte e ordini pending.
6. Drawdown scaling deve ridurre rischio quando la equity scende.

Procedura obbligatoria:

- trova file/funzioni;
- definisci invarianti;
- crea test;
- analizza con lenti Data-Feed mismatch, Edge Case, Time Bias;
- esegui test;
- report con evidenza.

---

# Prompt 2.1 — GatekeeperLayer Deterministico

Crea test `.ts` per GatekeeperLayer.

Invarianti:

1. CHOP bloccante deve produrre reject.
2. Regime vietato per setup deve produrre reject.
3. Expectancy sotto soglia deve produrre reject.
4. Dati insufficienti non devono produrre accept.
5. Ogni reject deve avere reason stabile e non generica.
6. Nessun fallback `return true` deve superare errore dati.

Test minimi:

- segnale valido;
- CHOP;
- regime vietato;
- expectancy missing;
- expectancy sotto soglia;
- feature NaN;
- array vuoto;
- cooldown attivo.

Output: accept/reject atteso vs reale, reason, file/funzione, fallback trovati, test result.

---

# Prompt 2.1.a — Regime-Specific Gate Test

Crea test `.ts` per blocchi regime-specifici.

Invarianti:

1. Setup NORMAL non passa in CRASH se vietato.
2. Setup EXTREME non passa in NORMAL se vietato.
3. CHOP prevale su segnale tecnico valido se bloccante.
4. Transizione vietata deve bloccare con reason.
5. Se più blocchi sono attivi, la priorità della reason deve essere deterministica.

Matrice minima:

```text
NORMAL setup / NORMAL regime
NORMAL setup / CRASH regime
EXTREME setup / CRASH regime
EXTREME setup / NORMAL regime
ANY setup / CHOP
UNKNOWN regime / valid signal
```

Il test deve verificare output booleano e reason.  
Report: blocchi mancanti, bypass, conflitti di priorità.

---

# Prompt 2.1.b — Expectancy Filter Test

Crea test `.ts` per filtri expectancy/profit factor.

Invarianti:

1. PF sotto soglia blocca.
2. Expectancy negativa blocca se regola attiva.
3. Chiave assente non può passare per default.
4. NaN/null non sono valori validi.
5. Stringhe numeriche devono essere convertite esplicitamente o rifiutate.

Test minimi:

- PF alto;
- PF basso;
- expectancy negativa;
- expectancy zero;
- chiave assente;
- NaN;
- null;
- stringa `"1.2"`;
- matrice vuota.

Cerca pattern:

```text
profitFactor || 1
expectancy || 0
if (!expectancy) accept
```

Output: test result, fallback, rischio di overtrading o blocco totale.

---

# Prompt 2.2 — RiskLayer Sizing Deterministico

Crea test `.ts` per RiskLayer.

Invarianti:

1. Size finale deve essere numero finito > 0 solo se trade autorizzato.
2. Size non può superare max per-trade e max globale.
3. Health multiplier e expectancy non devono essere applicati due volte.
4. Equity corrente deve essere distinta da initialCapital.
5. Dati mancanti bloccano, non producono size default.
6. La leva non cambia dopo apertura trade.

Test minimi:

- equity 10000, rischio normale;
- drawdown;
- expectancy alta;
- expectancy bassa;
- ATR alto;
- ATR zero;
- available balance insufficiente;
- health multiplier 0;
- NaN in input.

Report: formula reale, output numerici, bug certi, rischio economico.

---

# Prompt 2.2.a — Risk Tier Assignment Test

Crea test `.ts` per assegnazione tier.

Invarianti:

1. Ogni tier configurato deve essere raggiungibile o marcato dead.
2. Tier non risolto non può usare fallback rischioso.
3. EXTREME_10 non può essere assegnato a setup NORMAL salvo regola esplicita.
4. NORMAL_UPGRADED deve richiedere condizioni verificabili.
5. Nome tier runtime deve combaciare con configurazione.

Test minimi:

- EXTREME valido;
- NORMAL valido;
- NORMAL_UPGRADED valido;
- regime sconosciuto;
- setup sconosciuto;
- expectancy missing;
- volatilità alta.

Output: tier atteso/reale, size/leva associata, dead tier, fallback.

---

# Prompt 2.2.b — Health Multiplier / Drawdown Size Test

Crea test `.ts` per position size con health multiplier.

Invarianti:

1. Health multiplier < 1 riduce size.
2. Health multiplier = 0 blocca o produce size zero gestita.
3. Drawdown deve ridurre capitale utilizzabile secondo formula.
4. Recovery deve ripristinare gradualmente se previsto.
5. Size non può diventare negativa, infinita o NaN.

Dataset/scenari:

- equity peak 10000, equity 10000;
- equity 9000;
- equity 7500;
- recovery 9500;
- health multiplier NaN;
- expectancy alta durante drawdown.

Output: formula reale, risultato numerico, PASS/FAIL.

---

# Prompt 2.2.c — Leverage Safety Test ATR / Worst Case

Crea test `.ts` per calcolo leva.

Invarianti:

1. Leva massima deve rispettare cap globale.
2. ATR alto deve ridurre o non aumentare leva.
3. Stop distance zero deve bloccare, non dividere per zero.
4. Worst-case loss deve stare sotto soglia rischio.
5. Leva decisa all’entry non cambia durante posizione.
6. Percentuali e decimali devono essere coerenti: `0.02` ≠ `2`.

Test minimi:

- ATR basso;
- ATR medio;
- ATR alto;
- ATR zero;
- stop distance zero;
- stop molto largo;
- leverage cap;
- trade già aperto con nuova volatilità.

Output: leva attesa/reale, bug di unità, rischio liquidazione.

---

# Prompt 2.3 — Capital Management Exposure Test

Crea test `.ts` per CapitalManagementLayer.

Invarianti:

1. Exposure globale include posizioni aperte.
2. Exposure globale include ordini pending.
3. Notional con leva non deve essere confuso con margine.
4. Nuovo trade viene rifiutato se supera limite.
5. Long e short non devono annullarsi impropriamente se exchange li netta diversamente.
6. Available balance live/calcolato non deve essere sostituito da initialCapital.

Test minimi:

- nessuna posizione;
- una posizione long;
- più posizioni;
- ordine pending;
- long+short;
- balance insufficiente;
- exchange data missing.

Output: formula exposure, numeri, PASS/FAIL, rischio out-of-margin.

---

# Prompt 2.3.b — Equity Risk / Peak Drawdown Test

Crea test `.ts` per equity risk.

Invarianti:

1. Peak equity deve aggiornarsi solo su nuovi massimi reali.
2. Drawdown corrente = `(peak - equity) / peak`.
3. Riduzione rischio si attiva alla soglia prevista.
4. Bot non deve tornare a rischio pieno prima della recovery prevista.
5. Startup/restart non deve perdere peak equity se persistito.

Test con sequenza:

```text
10000 → 10500 → 10200 → 9000 → 9500 → 10600
```

Verifica:

- peak;
- drawdown;
- risk multiplier;
- size consentita.

Output: tabella step-by-step, PASS/FAIL, bug di reset o recovery.

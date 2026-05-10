# 00 — GLOBAL CONTEXT DETERMINISTICO

## Scopo

Questo file va sempre dato alla AI di vibe coding insieme al file della macroarea specifica.  
Obiettivo: trasformare il debug in una procedura **test-first**, verificabile e non basata su impressioni.

Il bot è un sistema trading crypto complesso. Le aree principali sono:

1. Core Strategy / Signal Generation
2. Gatekeeping / Risk Management
3. Trade Lifecycle / Exits
4. Kraken Live Engine / State Sync
5. Persistence / Dashboard

## Regola assoluta

Non modificare codice di produzione.  
Sono consentite solo queste azioni:

1. leggere codice;
2. creare file di test `.ts`;
3. creare fixture/mock/dataset di test;
4. eseguire test;
5. produrre report con evidenze.

Ogni conclusione logica deve arrivare **dopo** un test automatizzato o dopo una prova riproducibile.  
Se non puoi creare o lanciare test, devi dichiararlo e produrre solo ipotesi marcate come **non provate**.

---

# Protocollo Obbligatorio

Per ogni richiesta:

## Step 0 — File Discovery

Prima individua i file reali coinvolti usando strumenti tipo:

```bash
rg "MarketDataLayer|RegimeLayer|SignalLayer|RiskLayer|Kraken|Expectancy|activePositions|isH4Closed|isClosed|fallback|NaN|null"
find . -name "*.ts" -o -name "*.tsx"
cat package.json
```

Output iniziale obbligatorio:

```text
FILES_FOUND:
- path/file.ts → perché rilevante
TEST_RUNNER_FOUND:
- vitest/jest/node:test/tsx/altro
```

## Step 1 — Invarianti di Dominio

Non dire “controllo le feature”.  
Devi trasformare il problema in invarianti testabili.

Formato:

```text
INVARIANT:
Nome:
Regola:
Input minimo:
Output atteso:
Cosa deve fallire se la regola è violata:
```

## Step 2 — Test Automatizzato Prima delle Conclusioni

Crea un file `.ts` in:

```text
tests/audit/<area>/<nome-test>.test.ts
```

Oppure, se non esiste test runner, crea:

```text
tests/audit/<area>/<nome-test>.audit.ts
```

con `assert` nativo e comando eseguibile via `tsx`.

Il test deve dimostrare almeno una di queste condizioni:

- la regola è rispettata;
- la regola fallisce;
- il codice non è testabile perché mancano export/seams;
- il comportamento reale diverge da quello atteso.

## Step 3 — Analisi Multi-Lente Obbligatoria

Ogni test/audit deve essere analizzato con queste tre lenti:

### Lente A — Mismatch Data-Feed / Source-of-Truth

Verifica differenze tra:

- backtest vs liveEngine;
- memoria vs database;
- exchange vs stato logico;
- backend vs dashboard;
- dati reali vs fallback/mock.

### Lente B — Edge Case Management

Verifica:

- null;
- undefined;
- NaN;
- array vuoti;
- dati mancanti;
- timeout;
- fill parziali;
- database down;
- response API incompleta;
- divisione per zero;
- fallback tipo `|| null`, `|| 0`, `|| 50`, `??`.

### Lente C — Time Bias / Sequence Bias

Verifica:

- look-ahead bias;
- uso di candle non chiuse;
- ordine errato degli eventi;
- retry duplicato;
- update arrivato dopo decisione;
- dashboard che mostra stato vecchio;
- startup prima del caricamento dati critici.

## Step 4 — Esecuzione Test

Esegui il test con il runner esistente.

Esempi:

```bash
npm test -- tests/audit/...
npx vitest run tests/audit/...
npx jest tests/audit/...
npx tsx tests/audit/.../*.audit.ts
```

## Step 5 — Report Finale

Usa sempre questo schema:

```text
AUDIT RESULT
Area:
Prompt:
Test creati:
Comando eseguito:
Esito test: PASS / FAIL / NON ESEGUIBILE
Evidenza:
Anomalie certe:
Anomalie probabili:
Codice non testabile:
Rischio operativo:
Priorità:
Prossimo test consigliato:
Produzione modificata: NO
```

---

# Bias AI da bloccare

La AI deve evitare:

- patch bias: proporre fix prima della prova;
- confirmation bias: cercare solo conferme;
- attention bias: ignorare edge case;
- local-fix bias: guardare solo un file;
- green-build bias: credere che build passata significhi sistema corretto;
- semantic optimism: dire “sembra corretto” senza test;
- hidden fallback bias: ignorare default silenziosi.

Frase obbligatoria da includere nei prompt:

```text
Non trarre conclusioni qualitative prima di avere creato almeno un test automatizzato o una prova riproducibile.
```

---

# Regole di Dominio Globali del Bot

Queste invarianti vanno considerate sempre:

1. Il ciclo base lavora su 15m.
2. Le feature 1H devono derivare solo da quattro candele 15m chiuse.
3. Le feature 4H devono derivare solo da sedici candele 15m chiuse.
4. Nessuna candle 1H/4H può essere usata prima della chiusura reale.
5. La leva viene decisa all’apertura trade, non modificata durante il trade.
6. SignalLayer non deve decidere capitale, leva, sizing o ordini exchange.
7. RiskLayer non deve inviare ordini.
8. Live Engine non deve inventare dati di strategia.
9. Dashboard deve mostrare solo dati reali o calcolati da fonti reali, mai mock.
10. Un trade non può essere contemporaneamente chiuso e attivo.
11. Stato exchange, memoria e database devono essere riconciliabili.
12. Ogni fallback deve essere esplicito, testato e tracciabile.

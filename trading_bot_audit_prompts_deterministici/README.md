# Trading Bot Audit Prompts — Versione Deterministica

Questa versione sostituisce i prompt “audit descrittivi” con prompt **test-first**.

## Come usarli

Per ogni sessione dai alla AI:

```text
Leggi:
1. 00_GLOBAL_CONTEXT.md
2. <file macroarea>

Regola:
non modificare codice di produzione.
Prima crea test .ts.
Poi esegui i test.
Solo dopo produci conclusioni.
```

## Ordine consigliato

1. `01_AREA_STRATEGY.md`
2. `02_AREA_RISK.md`
3. `03_AREA_TRADE_LIFECYCLE.md`
4. `04_AREA_KRAKEN_LIVE.md`
5. `05_AREA_PERSISTENCE_DASHBOARD.md`
6. `99_AUDIT_GLOBALE.md`

## Perché questa versione è più forte

I prompt obbligano la AI a:

- creare test automatizzati;
- definire invarianti di dominio;
- cercare fallback pericolosi;
- verificare mismatch tra backtest/live;
- verificare edge case;
- verificare time bias/look-ahead;
- non trarre conclusioni senza prova.

## Prompt base da incollare prima di ogni file area

```text
Lavora in modalità audit deterministico test-first.

Non modificare codice di produzione.
Puoi creare solo file di test .ts, fixture e mock.
Prima individua i file reali.
Poi definisci invarianti testabili.
Poi crea test automatizzati.
Poi esegui i test.
Solo dopo scrivi conclusioni.

Analizza ogni punto con 3 lenti:
1. Mismatch Data-Feed / Source-of-Truth
2. Edge Case Management
3. Time Bias / Sequence Bias

Se non puoi testare, scrivi CODICE NON TESTABILE e spiega quale seam/export manca.
```

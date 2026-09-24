# Archivio storico (non mantenuto)

Materiale spostato dalla root del progetto durante la F0 di `PROMPT_LIVE_READY_KRAKEN.md`.
Serve solo come riferimento storico: non fa parte della build, del typecheck né dei test,
e i percorsi interni degli script non sono stati aggiornati.

| Cartella | Contenuto |
|---|---|
| `reports/` | Report delle fasi precedenti (FASE3…FASE15, QA, audit, dead code, `debug_reports/`, report delle aree di audit). Descrivono in parte bug già corretti: non sono una specifica. |
| `scripts/` | Script usa-e-getta della root (`test_*.ts`, `analyze_*.ts`, `ablation_*.ts`, generatori di report), script di `workspace/` e `app/applet/`, vecchi test Kraken. |
| `data/` | JSON e TXT di backtest ed esperimenti precedenti. Alcuni file (es. `backtest_report_2020_2026.json`) sono troncati a ~2 MB dal sync di AI Studio. |
| `misc/` | Duplicati inutilizzati (es. `lib/utils.ts`, identico a `src/lib/utils.ts`). |
| `legacy_engine/` | Motore live legacy (`liveEngine.ts`: loopTick, sync daemon), sostituito dal runtime in F4. |
| `legacy_ui/` | Librerie della vecchia dashboard (F6): calcolo delle metriche lato client con unità errate (D31), pipeline `quantEngine`/`ml` inutilizzate, tipi del ledger mai usati. Le metriche ora le calcola il server (`src/engine/ops/metrics.ts`). |

Il dataset di riferimento e il golden backtest vivono in `data/` e `golden/` nella root.

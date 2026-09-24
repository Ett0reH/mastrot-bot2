# Checklist del go-live (live test su Kraken Futures)

Il live test parte solo quando ogni riga è ✅ con la sua prova (output del comando, file, screenshot) e la checklist è firmata in fondo.
- I criteri misurabili della demo si calcolano con `npm run golive:check`.
- Gli altri punti si verificano a mano.
- Le procedure sono in [`RUNBOOK_LIVE_TEST.md`](RUNBOOK_LIVE_TEST.md).

## A. Decisioni di chi approva (prima della demo)

| # | Decisione | Proposta / stato | Esito |
|---|---|---|---|
| A1 | Approvare il golden del motore (profilo realistico: backstop 3%, slippage 5 bps) | `golden/engine/2022H1`: +230,01 $, PF 1,25, max DD 5,69%. `golden/engine/2026Q2`: +114,17 $. **In attesa** dalla F2 | |
| A2 | Limiti del live test | `CAPITAL_CAP_USD=1000`, `MAX_LEVERAGE=3`, `MAX_POSITION_NOTIONAL_USD=1000`, `MAX_OPEN_POSITIONS=8`, `MAX_DAILY_LOSS_PCT=5`, `DRAWDOWN_REDUCE_ONLY_PCT=15`. Con 5% la perdita giornaliera scatta una volta nel golden (22/01/2022, 5,18%) senza bloccare ingressi; con 5,5% non scatterebbe (`npm run risk:audit`) | |
| A3 | Modello di stop | `close_based_plus_native_backstop` (default, quello del golden) con backstop al 3%. `native_intrabar` cambierebbe i risultati e richiederebbe un nuovo golden | |
| A4 | Funding nell'equity del bot | Oggi il funding reale di Kraken sta nel ledger e nel report giornaliero ma non nell'equity del bot, quindi nemmeno nei guardrail. Nel backtest 2022H1 il funding modellato (0,01% ogni 8 ore) vale 7,21 $ su 10.000 $ in sei mesi. Decidere: accettarlo come limite noto del test oppure integrarlo prima del live (dopo aver verificato in demo segno e classificazione delle voci dell'account log) | |
| A5 | Criteri di arresto del live test | Proposta nella sezione 8 del runbook | |

## B. Prerequisiti tecnici

| # | Criterio | Come si misura | Esito |
|---|---|---|---|
| B1 | Chiavi Alpaca ruotate (restano nella history git, D04) | Console Alpaca | |
| B2 | Dataset completo 2022-2026 | `npm run data:download` (rete verso futures.kraken.com), poi `npm run data:verify` → OK | |
| B3 | Backtest sul dataset completo coerente col riferimento e approvato | `npm run backtest -- --full` e `npm run backtest:compare -- --full`: confronto con `backtest_report_latest.json` (713 trade) e out-of-sample 2022-2024 contro 2025-2026 | |
| B4 | Parità decisionale backtest ↔ replay live al 100% su dati reali (almeno 12 mesi) | `npm run replay:parity -- --full` → IDENTICO | |
| B5 | Commit del deploy verde | CI della PR verde; `npm test`, `npm run typecheck`, `npm run golden:check` sul commit | |
| B6 | Firestore | Tre database (`mastrot-shadow`, `mastrot-demo`, `mastrot-live`) con `firestore.rules` pubblicate su ognuno; service account con *Cloud Datastore User*; `bot_runtime/control` con `killSwitch: false` nei database demo e live | |
| B7 | Accessi | `ADMIN_TOKEN` e `CRON_TOKEN` casuali (≥ 24 caratteri) e diversi per servizio; cron su `/api/cron/tick` con le notifiche di fallimento attive | |

## C. Shadow

| # | Criterio | Come si misura | Esito |
|---|---|---|---|
| C1 | Almeno 72 ore di shadow senza divergenze non spiegate | `npm run shadow:report -- --url <shadow> --days 3 --out shadow.md` → codice 0 | |

## D. Demo (almeno 14 giorni)

| # | Criterio | Come si misura | Esito |
|---|---|---|---|
| D1 | Smoke test end-to-end superato | [`docs/DEMO_SMOKE_CHECKLIST.md`](docs/DEMO_SMOKE_CHECKLIST.md) completa, con gli output di `kraken:demo-smoke` e `kraken:demo-kill` | |
| D2 | Guardrail e kill switch provati in demo sul bot | Sezione 6 della checklist demo: kill switch dalla dashboard e dal flag su Firestore, conto flat, ripresa con conferma | |
| D3 | **Almeno 14 giorni consecutivi in demo** dopo lo smoke test, senza guasti provocati né interventi sul conto | `npm run golive:check -- --url <demo> --days 14 --out golive.md` → riga "giorni" OK | |
| D4 | **Zero posizioni senza stop** | `golive:check`: nessun alert `STOP_MISSING`, `STOP_PLACEMENT_FAILED`, `EMERGENCY_CLOSE`, `PROTECTION_FAILING`, `HEARTBEAT_MISSING` nei 14 giorni. Gli alert sono salvati su Firestore e sopravvivono ai riavvii | |
| D5 | **Zero ordini duplicati e zero desync non risolte** | `golive:check`: nessun alert `DESYNC`, `UNKNOWN_POSITION`, `UNKNOWN_ORDER`. A fine periodo `/api/health/details`: nessuna posizione sconosciuta, posizioni del bot = posizioni su Kraken | |
| D6 | **Parità decisionale al 100%** | `golive:check`: ogni report `IDENTICAL` o `EXPLAINED`, zero divergenze non spiegate. Una differenza "spiegata" viene da dati diversi (una candela arrivata dopo la decisione), non dal codice | |
| D7 | **Slippage entro il modello** | `golive:check`: media pesata dello slippage dei fill decisi dalla strategia ≤ 5 bps nel periodo. Gli stop nativi sono riportati a parte | |
| D8 | Contabilità coerente con Kraken | Report giornalieri: nessun "fee del bot diverse da quelle di Kraken"; funding letto e classificato (decisione A4) | |
| D9 | Punti "da rivedere" spiegati | Elenco di `golive:check` (alert critici fuori dai criteri, punti da verificare dei report): ognuno con una spiegazione scritta | |

Un giorno che non rispetta D4-D6 fa ripartire il conteggio dei 14 giorni dopo la correzione.

## E. Giorno del go-live

| # | Criterio | Come si misura | Esito |
|---|---|---|---|
| E1 | Conto live pronto | Conto dedicato; chiave API senza permesso di prelievo; collateral ≥ `CAPITAL_CAP_USD`; nessuna posizione né ordine aperto | |
| E2 | Configurazione live giusta | Log di avvio del servizio live: `modalità=LIVE ordini=SÌ ambiente Kraken=live`, riga dei limiti uguale ad A2 (copiarla qui), `database Firestore=mastrot-live` | |
| E3 | Bot sano | `/api/health/details` → `healthy: true`; dashboard con badge LIVE e nessun banner | |
| E4 | **Limiti live impostati e alert provati** | E2 per i limiti; `POST /api/alerts/test` sul servizio live → messaggio ricevuto; cron → 200 | |
| E5 | Kill switch pronto | `bot_runtime/control` con `killSwitch: false` nel database live; chi può premerlo conosce le tre vie (runbook 6.1) e l'emergenza a bot fermo (runbook 6.2) | |
| E6 | Supervisione delle prime 48 ore organizzata | Chi controlla ogni `ENTRY` nella UI di Kraken (runbook 4.3); demo in parallelo (consigliata) | |

## Firma

| Commit del deploy | Data (UTC) | Approvato da | Note |
|---|---|---|---|
| | | | |

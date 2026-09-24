# Smoke test end-to-end su Kraken Futures DEMO — checklist manuale (F7)

Scopo: provare **sul conto demo di Kraken, con il bot vero** (server, runtime, Firestore, alert, dashboard), ciò che i test automatici provano con l'exchange simulato (`tests/chaos/`, `tests/runtime/`). Precede i 14 giorni di demo richiesti da [`GO_LIVE_CHECKLIST.md`](../GO_LIVE_CHECKLIST.md), che partono dopo, senza guasti provocati.

Regole:

- **Solo demo.** Mai chiavi live su questa installazione. Gli script `kraken:demo-*` rifiutano di partire se l'ambiente non è la demo.
- Segna ogni punto con ✅ o ❌, l'ora UTC e una nota. Un ❌ si scrive nel registro dei problemi e ferma la checklist se riguarda protezione o ordini (sezioni 1, 4, 5, 6).
- Conserva gli output (`--out`, screenshot della UI di Kraken, righe di log) in una cartella con la data: sono le prove del gate.

Durata: circa 2 ore di lavoro, più l'attesa del primo trade della strategia (la strategia apre in media 2 posizioni a settimana su 8 simboli: il primo ingresso può arrivare dopo giorni) e di un report giornaliero.

---

## 0. Preparazione

| # | Punto | Esito |
|---|---|---|
| 0.1 | Conto Kraken Futures **demo** (https://demo-futures.kraken.com), distinto da ogni conto reale | |
| 0.2 | Chiave API del conto demo con permesso di trading e **senza permesso di prelievo** (i nomi dei permessi sono quelli della pagina API di Kraken: verificali sulla documentazione ufficiale, docs.kraken.com) | |
| 0.3 | Database Firestore **dedicato alla demo** (es. `mastrot-demo`) nel progetto di `firebase-applet-config.json`; regole di `firestore.rules` pubblicate anche su questo database; service account con ruolo *Cloud Datastore User* | |
| 0.4 | Canale di alert: bot Telegram con chat, oppure webhook `https://` | |
| 0.5 | Token lunghi e casuali: `openssl rand -hex 32` per `ADMIN_TOKEN` e `CRON_TOKEN` | |
| 0.6 | La macchina che esegue il bot raggiunge `demo-futures.kraken.com` (ordini), `futures.kraken.com` (candele pubbliche), Firestore e il canale di alert | |

Variabili d'ambiente della demo (in Cloud Run come segreti di Secret Manager, mai in chiaro nel file del servizio):

```bash
TRADING_MODE=demo
KRAKEN_DEMO_API_KEY=...
KRAKEN_DEMO_API_SECRET=...
# KRAKEN_LIVE_API_KEY e KRAKEN_LIVE_API_SECRET: VUOTE su questa installazione
FIRESTORE_DATABASE_ID=mastrot-demo
FIREBASE_SERVICE_ACCOUNT_JSON=...      # oppure il service account di Cloud Run
ALERT_CHANNEL=telegram                 # oppure webhook + ALERT_WEBHOOK_URL
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ADMIN_TOKEN=...
CRON_TOKEN=...
# Limiti: gli stessi previsti per il live test (GO_LIVE_CHECKLIST.md, decisione A2)
CAPITAL_CAP_USD=1000
MAX_LEVERAGE=3
MAX_POSITION_NOTIONAL_USD=1000
MAX_OPEN_POSITIONS=8
MAX_DAILY_LOSS_PCT=5
DRAWDOWN_REDUCE_ONLY_PCT=15
```

Nei comandi seguenti `BOT` è l'URL del servizio e `ADMIN` l'header di autenticazione:

```bash
BOT=https://<servizio>        # oppure http://localhost:3000
ADMIN="Authorization: Bearer $ADMIN_TOKEN"
```

## 1. Execution layer con gli script (bot spento)

Il bot **non** deve girare durante questi due script: usano lo stesso conto.

| # | Punto | Esito |
|---|---|---|
| 1.1 | Conto demo flat: nessuna posizione e nessun ordine aperto (UI di Kraken) | |
| 1.2 | `npm run kraken:demo-smoke -- --out smoke.json` termina con codice 0 e tutti i passi ✔: conto flat, specifiche del contratto, leva isolated 1x impostata e riletta, ingresso IOC con `cliOrdId`, stop nativo reduceOnly verificato, spostamento dello stop, uscita reduceOnly, stop cancellato, ledger del bot = fill di Kraken, conto flat | |
| 1.3 | In `smoke.json` nessuna delle ipotesi segnate "da rivedere" (stop senza prezzo limite = stop a mercato, `processBefore`, formato del `cliOrdId`, `cliOrdId` nei fill) | |
| 1.4 | `npm run kraken:demo-kill -- --yes --out kill.json` termina con codice 0: posizioni di prova aperte con il loro stop e un ordine limite non protettivo, poi kill switch: ordini non protettivi cancellati, chiusure reduceOnly con `cliOrdId` `mt-k-…`, nessuna posizione e nessun ordine rimasto | |
| 1.5 | Nella UI di Kraken, cronologia dei fill: gli ordini degli script ci sono, con le size attese; conto di nuovo flat | |

## 2. Avvio del bot in demo

| # | Punto | Esito |
|---|---|---|
| 2.1 | Nel log di avvio: `modalità=DEMO ordini=SÌ ambiente Kraken=demo`, `database Firestore=mastrot-demo`, `Firestore: progetto …, database mastrot-demo`, `runtime demo avviato (… persistenza firestore, alert telegram)` e poi `Runtime in esecuzione (demo, lease epoch …)` | |
| 2.2 | Nessuna riga del log contiene chiavi, token o l'URL del webhook (cerca le prime lettere della chiave demo: non devono comparire) | |
| 2.3 | `curl -s -H "$ADMIN" $BOT/api/health/details` → `healthy: true`, `runtimeStatus: "RUNNING"`, lease valido con `holder` uguale all'istanza del log, età dell'ultima candela sotto i 20 minuti | |
| 2.4 | `curl -s $BOT/api/health/details` senza token → 401 | |
| 2.5 | Dashboard: badge **DEMO**, nessun banner di problemi, stato RUNNING | |
| 2.6 | Cron esterno (es. cron-job.org) su `GET $BOT/api/cron/tick` con `Authorization: Bearer <CRON_TOKEN>` ogni 1-5 minuti: risposta 200; notifiche di fallimento del servizio di cron attive (un 503 o un timeout vuol dire bot fermo) | |
| 2.7 | Dopo la prima chiusura oraria (minuto 01-03 dell'ora UTC): nel tab del journal un record per ciascuno degli 8 simboli (`NO_SIGNAL`, un blocco o un ingresso) | |

## 3. Alert

| # | Punto | Esito |
|---|---|---|
| 3.1 | `curl -s -X POST -H "$ADMIN" $BOT/api/alerts/test` → `{"sent": true, "channel": "telegram"}` e il messaggio arriva sul telefono (oppure sul webhook) | |
| 3.2 | Pausa dalla dashboard → alert `MODE_CHANGE` ("nessun nuovo ingresso, uscite e stop attivi"); ripresa → alert "Bot ripreso" | |

## 4. Primo trade della strategia (appena arriva)

| # | Punto | Esito |
|---|---|---|
| 4.1 | Alert `ENTRY` con simbolo, size e `cliOrdId` `mt-e-…` | |
| 4.2 | UI di Kraken: posizione del simbolo con la size dell'alert, leva isolated | |
| 4.3 | UI di Kraken: **un** ordine stop reduce-only sul lato opposto, stessa size, prezzo di attivazione uguale allo "stop nativo" mostrato in dashboard | |
| 4.4 | Dashboard e `/api/health/details`: posizione con protezione `NATIVE_STOP_OK`; nessuna posizione `UNPROTECTED` o `PENDING` dopo 60 secondi | |
| 4.5 | Log: le righe dell'intento, dell'ordine d'ingresso, dei fill e dello stop hanno lo stesso `positionId`; ogni ordine ha il suo `cliOrdId` | |
| 4.6 | All'uscita della strategia: alert `EXIT`, posizione chiusa su Kraken, stop cancellato (nessun ordine rimasto su quel simbolo), trade in dashboard con fee | |

## 5. Guasti provocati a mano (con una posizione del bot aperta)

| # | Punto | Esito |
|---|---|---|
| 5.1 | **Stop cancellato a mano** nella UI di Kraken → entro 20-40 secondi alert `STOP_MISSING` e poi `STOP_RESTORED`; nella UI c'è di nuovo uno e un solo stop | |
| 5.2 | **Posizione chiusa a mano** nella UI di Kraken → alert critico `DESYNC` ("Uscita … (EXTERNAL_CLOSE)"), la posizione sparisce dalla dashboard, lo stop del bot viene cancellato, il trade risulta chiuso come `EXTERNAL_CLOSE` | |
| 5.3 | **Posizione aperta a mano** su un simbolo che il bot non ha → alert critico `UNKNOWN_POSITION`, il bot mette solo uno stop protettivo e non la gestisce; health non sano finché la posizione resta. Chiudila a mano alla fine della prova | |
| 5.4 | **Riavvio durante l'operatività**: nuovo deploy o riavvio del processo con una posizione aperta → nel log `Runtime in esecuzione` dopo il recovery, posizione e stop ritrovati, **nessun ordine nuovo** su Kraken per quella posizione, nessun alert `UNKNOWN_POSITION` | |
| 5.5 | **Due istanze**: durante un deploy (o con una seconda istanza avviata per prova sullo stesso database) solo una è RUNNING; l'altra è `STANDBY` e non invia ordini (`/api/health/details` di entrambe) | |
| 5.6 | **Istanza di un'altra modalità sullo stesso database**: una seconda istanza con `TRADING_MODE=shadow` e `FIRESTORE_DATABASE_ID=mastrot-demo` va in `SAFE_MODE` con l'alert critico `STATE_REFUSED`, non prende il lease e non cambia nulla; poi spegnila. Il bot demo continua | |
| 5.7 | *(Facoltativo, su una VPS)* **Kraken irraggiungibile**: blocca per 3 minuti il traffico verso `demo-futures.kraken.com` (regola del firewall) → entro circa 2 minuti alert critico `PROTECTION_FAILING`, health non sano; nessuna nuova decisione durante il blocco; tolto il blocco, alert di ritorno e riconciliazione senza ordini doppi | |

## 6. Kill switch e ripresa (alla fine della prova, o con una posizione aperta)

| # | Punto | Esito |
|---|---|---|
| 6.1 | Pulsante "Emergency Kill Switch" in dashboard (oppure `curl -s -X POST -H "$ADMIN" $BOT/api/kill-switch`) → alert critico `KILL_SWITCH`, stato `HALTED`; UI di Kraken: nessuna posizione e nessun ordine; chiusure con `cliOrdId` `mt-k-…` | |
| 6.2 | Nuove chiusure orarie in `HALTED`: nessun ingresso (journal con il motivo), nessun ordine | |
| 6.3 | Ripresa senza frase di conferma: `curl -s -X POST -H "$ADMIN" -H 'Content-Type: application/json' -d '{"confirm":"x"}' $BOT/api/risk/resume` → rifiutata | |
| 6.4 | Flag su Firestore: nel documento `bot_runtime/control` del database demo imposta `killSwitch: true` dalla console → la ripresa viene rifiutata finché il flag è attivo; con il bot RUNNING, il flag fa scattare il kill switch entro 20-40 secondi | |
| 6.5 | Flag a `false`, poi ripresa con `{"confirm":"CONFERMO_RIPRESA"}` → stato `RUNNING`, alert `MODE_CHANGE` | |

## 7. Report giornaliero (il giorno dopo)

| # | Punto | Esito |
|---|---|---|
| 7.1 | Dopo la mezzanotte UTC e la lettura dell'account log: alert `DAILY_REPORT` e tab "Report" con il giorno concluso | |
| 7.2 | Confronto con il backtest: `IDENTICAL` o `EXPLAINED` (ogni differenza con la sua spiegazione); nessuna divergenza non spiegata | |
| 7.3 | Fee e funding del bot uguali a quelli dell'account log di Kraken (report: nessun punto da verificare su fee/funding) | |
| 7.4 | Slippage delle decisioni entro il modello (5 bps) o motivato; esito di ogni ingresso deciso (eseguito, parziale, respinto, tardivo) | |
| 7.5 | Metriche: `ledgerCheck.consistent: true` (PnL dei trade = equity realizzata − capitale) | |
| 7.6 | Dal proprio computer: `ADMIN_TOKEN=... npm run shadow:report -- --url $BOT --days 1 --out demo-day1.md` → codice 0 | |

## Esito

- Smoke test **superato** se tutti i punti delle sezioni 0-7 sono ✅ (la 4 appena la strategia apre la prima posizione).
- Da qui partono i 14 giorni di demo di [`GO_LIVE_CHECKLIST.md`](../GO_LIVE_CHECKLIST.md), senza più guasti provocati: ogni giorno il report (alert `DAILY_REPORT`), alla fine `npm run golive:check -- --url $BOT --days 14`. Procedure: [`RUNBOOK_LIVE_TEST.md`](../RUNBOOK_LIVE_TEST.md).

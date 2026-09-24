# Runbook del live test su Kraken Futures

Procedure operative per portare il bot da shadow a demo a live e per gestirlo durante il live test. I criteri per decidere il passaggio al live sono in [`GO_LIVE_CHECKLIST.md`](GO_LIVE_CHECKLIST.md); la prova manuale in demo è in [`docs/DEMO_SMOKE_CHECKLIST.md`](docs/DEMO_SMOKE_CHECKLIST.md).

## 0. Regole che valgono sempre

1. **Conto dedicato.** Il bot opera su un conto Kraken Futures che contiene solo il capitale del test e su cui nessuno fa trading a mano. Il kill switch chiude **tutte** le posizioni del conto. Le posizioni che il bot non conosce ricevono solo uno stop protettivo e non vengono gestite.
2. **Chiavi senza prelievo.** Chiavi API separate per demo e live, con permessi di trading e lettura e **senza permesso di prelievo**. Mai chiavi live su un computer di sviluppo, in un file `.env` o nei test: solo in Secret Manager del servizio live.
3. **Un database Firestore per modalità** (`FIRESTORE_DATABASE_ID`): `mastrot-shadow`, `mastrot-demo`, `mastrot-live`. Il database predefinito del file `firebase-applet-config.json` è condiviso da chiunque usi il repository.
   - Un'istanza che trova lo stato di un'altra modalità si ferma (SAFE_MODE, alert `STATE_REFUSED`) e non tocca nulla.
   - Non puntare **mai** un `npm run dev` o uno shadow al database live.
4. **Una sola istanza per servizio**: Cloud Run con min=max=1, oppure un solo container. Il lease su Firestore impedisce a due istanze di operare insieme, ma non sostituisce questa regola.
5. **Lo stato del bot live non si cancella mai a mano** (`bot_runtime/state`, `orders/`, `trades/`). Se il bot non riparte, seguire la sezione 7, non "ripulire" il database.
6. Tutti gli orari sono UTC. Il bot decide alla chiusura di ogni ora (dal minuto 01 circa); la strategia NORMAL solo alla chiusura delle 4 ore.

## 1. Kraken

| Passo | Dettaglio |
|---|---|
| Conto | Un account Kraken Futures dedicato (o un subaccount, se il tuo profilo lo prevede) con solo il capitale del test |
| Collateral | Il margine sta nel conto multi-collateral (flex). Il sizing del bot usa `min(equity del bot, margine del conto)`, dove equity del bot = `CAPITAL_CAP_USD` + PnL del bot. Tieni sul conto almeno `CAPITAL_CAP_USD` |
| Chiave API | Creata dalla pagina delle API del conto Futures: trading e lettura sì, **prelievi no** (i nomi esatti dei permessi sono quelli della pagina di Kraken; verificali su docs.kraken.com). Se la pagina permette di limitare gli IP, usa l'IP di uscita del servizio |
| Leva | Il bot imposta la leva isolated per simbolo prima di ogni ingresso e la rilegge. Non cambiare le preferenze di leva a mano durante il test. `MAX_LEVERAGE` deve essere ≥ la leva della strategia arrotondata per eccesso (default 3) |
| Trading manuale | Vietato sul conto del test. Una posizione aperta a mano genera `UNKNOWN_POSITION` e rende il bot "non sano" |

## 2. Firestore

1. Nel progetto di `firebase-applet-config.json` crea tre database: `mastrot-shadow`, `mastrot-demo`, `mastrot-live`.
2. Pubblica `firestore.rules` (accesso negato ai client) **su ogni database**. Il server usa l'Admin SDK, che non è soggetto alle regole.
3. Il service account del servizio deve avere il ruolo *Cloud Datastore User*.
4. Nel database di ogni servizio demo o live crea subito il documento `bot_runtime/control` con il campo booleano `killSwitch: false`: in emergenza basta metterlo a `true` (sezione 6).

## 3. Deploy

**Cloud Run** (`deploy/cloudrun-service.yaml`: min=max=1, CPU sempre allocata). Un servizio per modalità:
1. Cambia `metadata.name` (es. `mastrot-bot-demo`), `IMAGE`, `SERVICE_ACCOUNT` e `FIRESTORE_DATABASE_ID`.
2. Esegui `gcloud run services replace deploy/cloudrun-service.yaml --region <regione>`.

Variabili per modalità (i segreti da Secret Manager):

| Variabile | shadow | demo | live |
|---|---|---|---|
| `TRADING_MODE` | `shadow` | `demo` | `live` |
| `FIRESTORE_DATABASE_ID` | `mastrot-shadow` | `mastrot-demo` | `mastrot-live` |
| Chiavi Kraken | nessuna | `KRAKEN_DEMO_API_KEY`, `KRAKEN_DEMO_API_SECRET` | `KRAKEN_LIVE_API_KEY`, `KRAKEN_LIVE_API_SECRET` |
| `LIVE_TRADING_CONFIRM` | — | — | `I_ACCEPT_REAL_MONEY_RISK` |
| Limiti (`CAPITAL_CAP_USD`, `MAX_LEVERAGE`, `MAX_POSITION_NOTIONAL_USD`, `MAX_OPEN_POSITIONS`, `MAX_DAILY_LOSS_PCT`, `DRAWDOWN_REDUCE_ONLY_PCT`) | default | **gli stessi del live** | tutti obbligatori |
| `ALERT_CHANNEL` + credenziali | consigliato | consigliato | obbligatorio |
| `ADMIN_TOKEN`, `CRON_TOKEN` | sì | sì | sì (`ADMIN_TOKEN` obbligatorio) |

**Controlli dopo ogni deploy:**
- **Log di avvio:**
  - `[config]` con modalità, ordini, ambiente Kraken, limiti e `database Firestore=…`;
  - `Firestore: progetto …, database …`;
  - `runtime <modalità> avviato (… persistenza firestore, alert telegram)`;
  - poi `Runtime in esecuzione (<modalità>, lease epoch …)`.
  - Con una configurazione non valida il server non parte e il log elenca i problemi.
- `curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://<servizio>/api/health/details` → `healthy: true`.
- Dashboard (URL del servizio, chiede l'`ADMIN_TOKEN`): badge della modalità giusta, nessun banner.

**Cron esterno** (cron-job.org o Cloud Scheduler): `GET https://<servizio>/api/cron/tick` con `Authorization: Bearer <CRON_TOKEN>` ogni 1-5 minuti, con le notifiche di fallimento attive. Il cron non fa girare il bot (ha il suo scheduler) ma se ne accorge se si ferma: 503 = cicli fermi, timeout = processo giù.

**VPS** (alternativa): un solo container dal `Dockerfile`, riavvio automatico, variabili da un file protetto (mai nel repository), stesso cron.

## 4. Passaggio shadow → demo → live

### 4.1 Shadow (almeno 72 ore)
1. Servizio `mastrot-bot-shadow`, database `mastrot-shadow`.
2. Dopo 3 giorni UTC completi: `ADMIN_TOKEN=... npm run shadow:report -- --url https://<shadow> --days 3 --out shadow.md` → codice 0: ogni giorno ha il report e zero divergenze non spiegate dal backtest.

### 4.2 Demo (almeno 14 giorni)
1. Servizio `mastrot-bot-demo`, database `mastrot-demo`, chiavi demo, **gli stessi limiti previsti per il live**.
2. Giorno 1: [`docs/DEMO_SMOKE_CHECKLIST.md`](docs/DEMO_SMOKE_CHECKLIST.md) completa. I guasti provocati a mano stanno solo in questo giorno.
3. Poi almeno 14 giorni consecutivi senza interventi. Ogni giorno: alert `DAILY_REPORT` (o tab "Report") letto; ogni alert critico spiegato.
4. Alla fine: `ADMIN_TOKEN=... npm run golive:check -- --url https://<demo> --days 14 --out golive.md` → codice 0, più i punti manuali di [`GO_LIVE_CHECKLIST.md`](GO_LIVE_CHECKLIST.md).

### 4.3 Live
1. Tutta [`GO_LIVE_CHECKLIST.md`](GO_LIVE_CHECKLIST.md) spuntata e firmata.
2. Database `mastrot-live` con le regole e `bot_runtime/control`. Chiavi live in Secret Manager. Servizio `mastrot-bot-live` con le variabili della tabella.
3. Controlli dopo il deploy (sezione 3), poi `curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<live>/api/alerts/test`: il messaggio deve arrivare.
4. Il bot parte senza posizioni e apre solo ai segnali della strategia.
5. **Prime 48 ore**, per ogni alert `ENTRY`, nella UI di Kraken:
   - la posizione ha la size dell'alert;
   - c'è **un** stop reduce-only dal lato opposto, della stessa size, al livello mostrato in dashboard.
6. **Consigliato:** lasciare girare la demo in parallelo per le prime due settimane. Usa gli stessi dati pubblici e la stessa strategia: è il riferimento per decisioni e slippage.

### 4.4 Uscire dal live
Non cambiare mai `TRADING_MODE` del servizio live: lo stato resta nel suo database.
- Per fermare il test: kill switch (sezione 6), verifica del conto flat, poi spegnimento del servizio.
- Per una pausa: pulsante Pausa. Nessun nuovo ingresso; uscite e stop continuano.

## 5. Monitoraggio

| Dove | Cosa guardare |
|---|---|
| Telegram (o webhook) | Ogni alert critico richiede un'azione (tabella sotto). Alert identici entro 10 minuti arrivano una volta sola |
| Dashboard | Badge della modalità, banner dei problemi, posizioni con stop nativo e stato di protezione (`NATIVE_STOP_OK`), journal delle decisioni, tab "Metriche" e "Report" |
| `/api/health/details` | `healthy`, `issues`, lease, età dei dati, cicli, protezione di ogni posizione con lo stop su Kraken, errori recenti |
| Cron | 503 o timeout: il bot non gira (sezione 7.5) |
| Report giornaliero | Dopo la mezzanotte UTC e la lettura dell'account log: PnL, fee e funding contro Kraken, slippage contro il modello (5 bps), esito degli ingressi, confronto col backtest, alert del giorno (salvati: sopravvivono ai riavvii) |
| Ogni settimana in live | `npm run shadow:report -- --url https://<live> --days 7`: parità col backtest sui 7 giorni |
| Log (Cloud Logging) | Una riga JSON per evento. Alert: `jsonPayload.type="alert" AND jsonPayload.code="DESYNC"`; un'operazione dall'intento allo stop: `jsonPayload.positionId="SOL-2026-…"`; un ciclo: `jsonPayload.cycleId="P-…"` |

**Alert e azione:**

| Codice | Livello | Significato | Azione |
|---|---|---|---|
| `ENTRY`, `EXIT` | info | Posizione aperta o chiusa | Nelle prime 48 ore di live: verifica nella UI (4.3) |
| `STOP_MISSING` / `STOP_RESTORED` | critico / info | Stop sparito dagli ordini aperti; il bot lo ripiazza | Se arriva `STOP_RESTORED`: capire perché era sparito (log per `positionId`). Se no: 7.2 |
| `STOP_PLACEMENT_FAILED`, `EMERGENCY_CLOSE` | warning, critico | Stop non piazzabile; dopo 60 s senza stop verificato il bot chiude la posizione | 7.2 |
| `DESYNC`, `UNKNOWN_POSITION`, `UNKNOWN_ORDER` | critico / warning | Conto diverso da quello atteso | 7.1 |
| `ORDER_UNKNOWN_STATE` | warning | Esito di un ordine incerto (timeout): lo chiarisce la riconciliazione | Nessuna, se entro pochi minuti non segue un `DESYNC` |
| `PROTECTION_FAILING` | critico / info | Da 90 s il ciclo di protezione (o il recovery) fallisce: Kraken, chiave o rete | 7.3 |
| `STALE_DATA` | warning / info | Nessuna candela nuova da 30 minuti | 7.3 |
| `RISK_LIMIT` | critico | Perdita giornaliera (niente ingressi fino a mezzanotte UTC) o drawdown (REDUCE_ONLY) | 7.4 |
| `RISK_REJECTED` | warning | Ingresso respinto da un limite che non dovrebbe scattare (leva, nozionale, posizioni, capitale) | Verificare i limiti e il collateral; se si ripete, pausa e analisi |
| `LEVERAGE_NOT_SET` | critico | Leva isolated non impostata: ingresso annullato | Verificare la leva del simbolo nella UI e i permessi della chiave |
| `EXECUTION_ERROR` | vari | Errori di esecuzione e di persistenza (il testo dice quale) | Se critico (persistenza, checkpoint): 7.6 |
| `HEARTBEAT_MISSING` | critico | Cicli del runtime fermi | 7.5 |
| `LEASE_LOST` | critico | Questa istanza ha perso il lease | 7.5 |
| `STATE_REFUSED` | critico | Stato del database non utilizzabile (altra modalità o illeggibile): il bot non opera | 7.5 |
| `KILL_SWITCH` | critico | Kill switch avviato | Seguire la sezione 6 fino a `HALTED` |
| `ACCOUNT_TRANSFER` | warning | Deposito o prelievo sul conto | 7.7 |
| `MODE_CHANGE` | info / warning | Pausa, ripresa, ripresa manuale dopo un limite | Verificare che sia stata voluta |
| `DAILY_REPORT` | info / warning | Report del giorno; warning se ci sono punti da verificare | Leggere i punti |

## 6. Kill switch e rollback

### 6.1 Kill switch (bot in esecuzione)
Tre modi equivalenti:
- pulsante "Emergency Kill Switch" in dashboard;
- `curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<servizio>/api/kill-switch`;
- `killSwitch: true` nel documento `bot_runtime/control` del database del servizio (console di Firestore). Il bot lo legge a ogni ciclo di protezione (ogni 20 s): funziona anche se l'API del bot non è raggiungibile ma il bot gira.

Cosa succede:
1. vengono cancellati gli ordini non protettivi;
2. **tutte** le posizioni del conto si chiudono con ordini reduceOnly (`cliOrdId` `mt-k-…`);
3. il bot verifica che il conto sia flat;
4. rimuove gli stop residui e passa in `HALTED`.

Se Kraken fallisce a metà, il kill switch riprende al ciclo successivo, senza ordini doppi.

Verifica: nella UI di Kraken nessuna posizione e nessun ordine; in dashboard lo stato `HALTED`.

**Ripresa:** flag a `false`, poi `curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"confirm":"CONFERMO_RIPRESA"}' https://<servizio>/api/risk/resume` (oppure il pulsante "Riprendi"). Con il flag attivo la ripresa è rifiutata.

### 6.2 Bot non in esecuzione
Casi: processo giù, SAFE_MODE, STANDBY, "Kill switch non eseguibile: runtime …".
- **Se il server risponde:** `curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<servizio>/api/emergency-kraken-transfer`. Cancella gli ordini, chiude le posizioni reduceOnly, verifica il conto flat e **solo allora** trasferisce i saldi dei conti di margine al wallet cash di Kraken Futures: dopo, il bot non può più aprire nulla.
- **Se il server non risponde:** dalla UI di Kraken cancella tutti gli ordini e chiudi le posizioni, poi disattiva la chiave API del bot.

### 6.3 Rollback del software
1. **Pausa** del bot: nessun nuovo ingresso; le posizioni aperte restano protette dagli stop nativi.
2. Sposta il traffico sulla revisione precedente: `gcloud run services update-traffic <servizio> --to-revisions <REVISIONE>=100 --region <regione>`. La revisione nuova prende il lease quando la vecchia lo rilascia (arresto ordinato).
3. Controlli dopo il deploy (sezione 3) e verifica che le posizioni e i loro stop siano quelli di prima.
4. Se la revisione vecchia non sa leggere lo stato salvato va in SAFE_MODE con `STATE_REFUSED`: torna avanti alla revisione nuova. **Mai** cancellare lo stato per farla partire.
5. Ripresa dalla pausa.

## 7. Procedure per incidente

### 7.1 Desync (`DESYNC`, `UNKNOWN_POSITION`, `UNKNOWN_ORDER`)
1. Confronta la UI di Kraken con la dashboard: posizioni, size, verso, ordini aperti.
2. **Chiusura esterna o liquidazione** ("Uscita … (EXTERNAL_CLOSE)"): il bot l'ha già registrata e ha tolto lo stop. Capire chi l'ha chiusa e perché; se è una liquidazione, fermare il test (kill switch) e analizzare.
3. **Size o verso diversi:** il bot non gestisce le riduzioni esterne parziali. Pausa, poi chiudi la posizione dalla UI (il bot registra la chiusura esterna) oppure kill switch.
4. **Posizione o ordine sconosciuti:** qualcuno ha operato sul conto. Chiudi o cancella dalla UI; il bot ha messo uno stop protettivo sulla posizione sconosciuta e lo toglie da solo quando la posizione sparisce.
5. Log per `positionId` e `cliOrdId` per ricostruire la sequenza. Un desync non spiegato **blocca il go-live** (o ferma il live).

### 7.2 Stop mancante (`STOP_MISSING`, `STOP_PLACEMENT_FAILED`, `EMERGENCY_CLOSE`)
1. Il bot ripiazza lo stop da solo. Se non ci riesce entro 60 s, chiude la posizione reduceOnly (`EMERGENCY_CLOSE`, uscita `PROTECTION_FAILURE`).
2. Verifica nella UI: per ogni posizione esattamente uno stop reduce-only della stessa size.
3. **Se il bot è giù e una posizione è scoperta:** metti a mano nella UI uno stop reduce-only al livello "stop nativo" mostrato l'ultima volta in dashboard, o chiudi la posizione. Al ritorno il bot segnala lo stop manuale come ordine non suo (`UNKNOWN_ORDER`) e piazza il proprio: poi cancella quello manuale.
4. Cause tipiche: prezzo oltre i limiti di Kraken (`outsidePriceCollar`), size sotto il minimo, permessi della chiave. Cercare il motivo nel log (`STOP_PLACEMENT_FAILED`).

### 7.3 API di Kraken non disponibile (`PROTECTION_FAILING`, `STALE_DATA`)
1. Il bot non prende decisioni finché Kraken non risponde, perché riconcilia prima di ogni ciclo. Gli stop nativi già su Kraken restano attivi.
2. Controlla la pagina di stato di Kraken e se la UI funziona.
3. Poi: la chiave API (revocata, scaduta, permessi cambiati, limite sugli IP), la rete in uscita del servizio, l'orologio (firma delle richieste).
4. **Guasto lungo con posizioni aperte e mercato in movimento:** chiudi dalla UI se Kraken lo permette. Al ritorno il bot registra le chiusure come esterne.
5. Al ritorno: alert `PROTECTION_FAILING` di ripristino, riconciliazione, uscite recuperate. Gli ingressi decisi durante il guasto ormai tardivi (oltre 10 minuti) non partono.

### 7.4 Drawdown e perdita giornaliera (`RISK_LIMIT`)
- **Perdita giornaliera oltre `MAX_DAILY_LOSS_PCT`:** niente ingressi fino alla mezzanotte UTC, poi ripresa automatica. Uscite e stop continuano. Azione: leggere il report del giorno (slippage, parità, trade).
- **Drawdown oltre `DRAWDOWN_REDUCE_ONLY_PCT`:** stato `REDUCE_ONLY` (solo uscite, stop attivi), ripresa solo manuale. Azione:
  1. confrontare con il backtest (report, `npm run shadow:report`);
  2. se il comportamento è quello del backtest e il test deve continuare, ripresa con `CONFERMO_RIPRESA` (il riferimento del drawdown torna all'equity attuale);
  3. altrimenti lasciare chiudere le posizioni in `REDUCE_ONLY`, oppure kill switch, e terminare il test.

### 7.5 Bot fermo o in attesa (`HEARTBEAT_MISSING`, cron 503, `LEASE_LOST`, `STATE_REFUSED`)
1. `/api/health/details` e log: stato del runtime e motivo (`issues`, `lastError`).
2. **Processo giù o in riavvio continuo:** log di avvio (configurazione non valida? Firestore non raggiungibile?). Al riavvio il recovery ricarica lo stato, prende il lease, riconcilia con Kraken e verifica gli stop prima di riprendere.
3. **STANDBY / `LEASE_LOST`:** un'altra istanza ha il lease. Controlla le revisioni attive del servizio (una sola) e che nessun altro servizio o computer usi lo stesso database.
4. **SAFE_MODE con `STATE_REFUSED`:** il database contiene lo stato di un'altra modalità o uno stato illeggibile.
   - Correggi `FIRESTORE_DATABASE_ID` del servizio e riavvia.
   - Se il database è quello giusto e lo stato è illeggibile, torna alla revisione precedente (6.3).
   - **Mai** cancellare lo stato del live.
5. **Mentre il bot è fermo:** le posizioni restano protette dagli stop nativi (backstop 3% oltre lo stop della strategia), ma nessuno le gestisce. Se il fermo si prolunga: 6.2.

### 7.6 Firestore non disponibile (`EXECUTION_ERROR` critico: persistenza o checkpoint)
Senza persistenza il bot blocca i nuovi ingressi; protezione e stop continuano finché ha il lease. Se il lease non si rinnova, l'istanza smette di inviare ordini (`LEASE_LOST`) e le posizioni restano con i loro stop nativi.

Azione: stato di Firestore nella console Google Cloud, quote, permessi del service account. Al ritorno il bot riprende da solo.

### 7.7 Deposito o prelievo (`ACCOUNT_TRANSFER`)
L'equity del bot non cambia (cap + PnL del bot); cambia il collateral, quindi il sizing massimo. Un prelievo non previsto dal conto dedicato va trattato come un incidente di sicurezza: verifica gli accessi al conto e le chiavi.

## 8. Quando fermare il live test (da confermare con chi decide)

Proposta di criteri di arresto, in aggiunta ai limiti automatici:
- una posizione senza stop nativo verificato per più di 60 s che il bot non ha chiuso da solo;
- un desync non spiegato entro 24 ore;
- divergenze non spiegate dal backtest in due report consecutivi;
- slippage medio settimanale delle decisioni oltre il doppio del modello (10 bps);
- drawdown oltre `DRAWDOWN_REDUCE_ONLY_PCT` senza un'analisi conclusa entro 24 ore.

Arresto: kill switch (6.1), verifica del conto flat, report finale con `npm run shadow:report` sull'intero periodo.

# MASTROT MEMO : ARCHITETTURA E LOGICHE DEL BOT
*Questo file rappresenta lo "storico" dell'architettura e deve essere sempre consultato per non rompere la coerenza del sistema quando si applicano fix o si implementano nuove feature.*

## 1. Visione di Sistema e Architettura Dati
- **Frequenza Dati:** Il sistema si basa su tick a 15m (15 minuti).
- **Aggregazione Strategica (Features):** L'ambiente calcola feature strutturali estrapolate a 1H e 4H partendo dai tick a 15m (es. `sma50_1H`, `sma200_4H`, `atr1H`, `rsi1H`).
- **Capitale e Fees:** Modello configurato su base 10000$ (initialCapital), fee dello 0.05% (0.0005). Slippage e Data Gap Validation integrati nel core.

## 2. Motori Strategici (Trading Regimes)
Il bot smista l'execution su diversi motori in base al Regime del mercato:
1. **MEAN_REVERSION**
2. **EUPHORIA** / **CRASH** (Estremi, focus sui ritracciamenti volatili)
3. **NORMAL** (Usa prevalentemente RSI2_TREND_TRAILING, basso win rate e ratio rischio particolare che va tenuto d'occhio).

## 3. Gestione del Rischio (Exit & Risk Dynamics)
Le logiche di uscita sono complesse e stratificate per preservare l'equità:
- **Quality-Gated Leverage (Introdotta in FASE 10):** Flag che scala attivamente l'esposizione (es. da 5x a 3x) in condizioni avverse (es. MEAN_REVERSION nei CRASH specifici di altcoin come DOGE/LINK). Riduce il rischio di coda.
- **Edge Decay (Time-Based Exit):** Il bot chiude i trade (altissimo Win Rate in uscita, ma piccolo PnL) che mostrano debolezza o mancanza di volatilità nel tempo stabilito, limitando il "bleeding" del PnL.
- **Trailing Stop Loss (TSL):** L'analisi MFE/MAE ha evidenziato che alcuni trade lasciano soldi sul tavolo; il Trailing Stop è vitale e deve muoversi insieme alla confidenza del trend.
- **Catastrophic Stop / Initial Stop:** Strati fissi di blocco del rischio per evitare collassi sui picchi.

## 4. Linee Guida Esecutive e Regole di Coerenza
- **Niente modifica isolata:** Alterare il `Trailing Stop` o i `Regimi` può rompere il delicate equilibrio (es. Edge Decay potrebbe tagliare in anticipo trade destinati a sviluppare la MAE).
- **Controllo Leva Dinamico:** La gestione della marginazione va processata solo ad inizio trade e non alterata in the middle.
- **TypeScript & Build:** Tutto gira internamente su TSX/TSC rigoroso. (`verbatimModuleSyntax` etc.).

## 5. Ultime Modifiche (Aggiornamento Recente)
- Creata la struttura di test in `summa-test.md` che divide l'architettura in 5 Macro-Aree fondamentali (Core Strategy, Risk Management, Trade Lifecycle, Live Engine, Persistence/UI). Tutte le future sessioni di test e analisi profonda dovranno far riferimento a queste macro-aree per isolare i comportamenti (es. Ghost Trades, coerenza UI, disallineamento Kraken).
- *Fix TypeScript Environment:* Corrette le configurazioni di build mancanti e ripristinato il pacchetto dipendenze di base per l'ambiente Node/TypeScript in cui testiamo i fills.
- *Integrazione Leva di FASE 10 confermata nel core e gestita correttamente.*

## 6. Fasi del prompt PROMPT_LIVE_READY_KRAKEN.md

### F0 — Fondamenta (completata, gate parziale)
- **Dataset di riferimento:** `data/kraken-futures/15m/` (chunk annuali gzip < 2 MB con checksum SHA-256 nel `manifest.json`). Le vecchie cache in `src/server/backtest/data_cache/` erano troncate a ~2 MB dal sync di AI Studio. Sono state recuperate le parti integre (2021-11 → metà 2022; 2026-03 → 2026-05). Il dataset completo si ricostruisce con `npm run data:download`, che richiede rete verso futures.kraken.com. **Regola:** nessun file versionato deve superare i 2 MB.
- **Golden backtest:** `golden/legacy/<finestra>/` (`npm run golden:check`). La finestra 2022H1 riproduce identici, in ogni campo, i trade del report di riferimento nello stesso periodo. Ogni refactor della logica deve lasciare il golden invariato. Le modifiche intenzionali richiedono un nuovo golden approvato.
- **Test:** `npm test` (node:test via tsx, 85 test), `npm run typecheck` (legacy + strict per `src/engine`, `tests`, `scripts`).
- **Codice nuovo:** va in `src/engine/` in TypeScript strict. `src/server/liveEngineUtils.ts` contiene le utility pure del live engine legacy.
- **Materiale storico** spostato in `archive/`.

### F1 — Sicurezza e configurazione (completata)
- **Modalità:** `TRADING_MODE` = shadow (default, nessun ordine) | demo (Kraken demo-futures) | live (richiede conferma esplicita, tutti i limiti, alert e `ADMIN_TOKEN`). La configurazione è validata all'avvio in `src/engine/config/config.ts`: se non è valida il server non parte. Nessun altro punto del codice decide ambiente o chiavi Kraken.
- **API:** le API di controllo richiedono `ADMIN_TOKEN`; `/api/cron/tick` richiede `CRON_TOKEN`. La dashboard usa `src/lib/api.ts`.
- **Firestore:** solo lato server (Admin SDK); le regole negano ogni accesso ai client. Nessun segreto nel codice: `tests/security/secrets.test.ts` lo verifica.

### F2 — DecisionCore unico e parità backtest ↔ live (completata; golden del motore da approvare)
- **Un solo codice decisionale:** `src/engine/core/decisionCore.ts` riunisce `architecture.ts` (invariato) e la logica che esisteva solo nel backtest (tier di rischio con blocco TRANSITION, cooldown NORMAL, invalidazione per buco dati, sizing sull'equity). È puro: niente I/O, niente `Date.now()`, tempo e candele arrivano da fuori. Produce intenti `OPEN` / `CLOSE` / `UPDATE_STOP` e un journal con il motivo di ogni decisione.
- **Stato persistibile** (`CoreState`, JSON): equity, posizioni, statistiche NORMAL per i tier, cooldown NORMAL (tempo UTC dell'ultimo blocco 4H chiuso all'uscita, non un contatore: sopravvive ai riavvii), intenti pendenti.
- **Dati:** candele 15m aggregate in 1H/4H a bucket UTC (`aggregator.ts`); feature sempre sulle ultime 250 candele; griglia di slot UTC comune a tutti i simboli.
- **Esecuzione:** slippage, fee, funding e backstop nativo (3% oltre lo stop della strategia, simulato sulle candele 15m) sono nel modello di esecuzione (`src/engine/sim/simExchange.ts`), non nel core. Stop e trailing della strategia si valutano solo alla chiusura 1H.
- **Live:** `src/engine/live/decisionCycle.ts` usa il core con una `CandleSource` e una `ExecutionPort`. Il replay (`src/engine/replay/replay.ts`) prova che produce le stesse decisioni del backtest (`npm run replay:parity`). Il vecchio `loopTick` resta attivo fino alla F4.
- **Golden:** `golden/legacy/` resta la prova che la strategia non è cambiata; `golden/engine/` fissa il modello realistico (da approvare). `npm run golden:check` li verifica entrambi.


### F3 — Execution layer Kraken (completata; smoke test in demo da eseguire)
- **Un solo adapter:** `src/engine/exchange/krakenAdapter.ts` (siebly `DerivativesClient`). Letture con retry e backoff; scritture a tentativo singolo (un retry cieco può duplicare un ordine); rate limiter a costi e circuit breaker; stop e chiusure d'emergenza passano anche col circuito aperto. Tick, passo della size e massimi dei contratti si leggono da `getInstruments`.
- **Ordini idempotenti:** ogni ordine ha un cliOrdId deterministico, salvato prima dell'invio, e un `processBefore`. Un esito incerto è UNKNOWN finché la riconciliazione non lo chiarisce; un nuovo tentativo è ammesso solo per un ordine dimostrato senza effetti.
- **Protezione:** ogni posizione ha uno stop `stp` reduceOnly sul mark price al livello del backstop del core, verificato dopo ogni modifica; se non si riesce a proteggerla, chiusura d'emergenza reduceOnly. La leva è impostata isolated e riletta prima dell'ingresso.
- **Porta live:** `KrakenExecutionPort` esegue gli intenti del DecisionCycle (ingresso IOC con buffer, uscita a mercato reduceOnly) e, nel ciclo di protezione, riconcilia con Kraken: chiusure esterne attribuite dai fill, posizioni sconosciute solo protette (mai gestite). In shadow non si può costruire.
- **Core:** con un intento in attesa di esito il core non ridecide né apre un secondo ingresso sullo stesso simbolo.

### F4 — Runtime, persistenza e recovery (completata)
- **Il loopTick legacy non esiste più** (`archive/legacy_engine/`). Il server avvia `BotRuntime` con uno scheduler interno: decisione a ogni fine slot 15m (+45 s), protezione ogni 20 s. HTTP e cron leggono solo lo stato.
- **Persistenza (Firestore, solo server):** `bot_runtime/state` (core, porta, runtime), `orders/`, `trades/`, `decisions/` (retention 30 giorni), `equity/`, `ledger/`. Scritture solo su modifica, contate per giorno (budget `FIRESTORE_DAILY_WRITE_BUDGET`). Obbligatoria in demo e live.
- **Lease d'istanza:** `bot_runtime/lease` con epoch; senza lease nessuna scrittura verso Kraken. Durante un deploy o con due istanze opera solo chi ha il lease.
- **Recovery:** stato → lease → intenti in sospeso riallineati con gli ordini → riconciliazione con Kraken → stop verificati → ripresa. Lo stato si salva prima di eseguire ingressi e uscite (write-ahead).
- **Equity (D28):** equity del bot = CAPITAL_CAP_USD + PnL del bot, mai azzerata; il sizing è limitato dal collateral del conto; depositi e prelievi dall'account log sono registrati e segnalati, non cambiano l'equity del bot. Il reset esiste solo in shadow.

### F5 — Guardrail di rischio e kill switch (completata; prova in demo da eseguire)
- **Guardrail fuori dal core:** il core decide, il runtime decide se l'ordine può partire. Ogni ingresso passa dal RiskGuard (`src/engine/risk/riskGuard.ts`) prima di qualunque chiamata a Kraken: stato operativo, blocco per perdita giornaliera, leva isolated su Kraken, nozionale, numero di posizioni, margine entro equity del bot e collateral. Uscite e stop non passano dal guard (riducono il rischio). Un ingresso respinto: nessun ordine, journal `REJECTED` con il motivo, alert.
- **Stati operativi:** RUNNING; REDUCE_ONLY (drawdown oltre `DRAWDOWN_REDUCE_ONLY_PCT`: solo uscite, stop attivi; ripresa solo manuale con `CONFERMO_RIPRESA`); HALTING (kill switch in corso) e HALTED (conto flat, bot fermo). Perdita giornaliera oltre `MAX_DAILY_LOSS_PCT`: niente ingressi fino alla mezzanotte UTC. Tutto nello stato persistito.
- **Kill switch:** API `POST /api/kill-switch`, pulsante della dashboard o flag `bot_runtime/control.killSwitch` (anche scritto a mano dalla console). Ordine: ordini non protettivi → chiusura reduceOnly di tutte le posizioni del conto (cliOrdId `mt-k-…`) → verifica flat → stop residui → HALTED. Ripetibile fino al flat, anche dopo un crash, senza ordini duplicati.
- **Principio verificato:** nel golden nessun limite respinge ingressi (`npm run risk:audit`, `tests/risk/guardAudit.test.ts`); unica eccezione nota, il blocco giornaliero del 22/01/2022 (5,18%), che scatta dopo l'ultimo ingresso del giorno e non cambia i trade.

### F6 — Osservabilità e dashboard (completata)
- **Log:** una riga JSON per evento con `cycleId` (ciclo in corso: D decisione, P protezione, K kill switch), `positionId` e `cliOrdId`; i segreti non finiscono mai nei log (`src/engine/ops/logger.ts`).
- **Journal:** ogni simbolo ha un record a ogni chiusura oraria: neutri (`NO_SIGNAL`), blocchi, `REJECTED` (guardrail o exchange, dal runtime), `NO_DATA` (candela mancante o storico insufficiente, dal core; le decisioni non cambiano).
- **Alert:** sempre sul log, più Telegram o webhook (`ALERT_CHANNEL`), con deduplica; un registro unico raccoglie quelli di runtime, porta Kraken e StopManager. `HEARTBEAT_MISSING` se lo scheduler si ferma (`/api/cron/tick` risponde 503).
- **Health e metriche sul server:** `GET /api/health/details` (lease, dati, cicli, protezione di ogni posizione con lo stop su Kraken, errori recenti); metriche calcolate dai trade e dall'equity del bot e confrontate con il ledger di Kraken. La dashboard mostra solo dati reali.
- **Report giornaliero e parità:** a inizio giorno UTC si salva lo stato del core; a fine giorno il giorno si rigioca con il codice del backtest sulle candele definitive (in shadow con il modello del backtest, in demo/live con i fill reali) e si confrontano le decisioni. Il report (`reports/daily-<giorno>`, tab "Report") ha PnL, fee e funding contro Kraken, slippage rispetto al modello, fill rate, divergenze spiegate e non spiegate.
- **Scritture misurate:** 1.587 al giorno in shadow, 1.613 in demo con posizioni aperte (budget 3.000). Una riconciliazione che non cambia nulla non scrive (D44).

### F7 — Validazione end-to-end (completata; shadow dal vivo e smoke test in demo da eseguire)
- **Un database Firestore per modalità** (`FIRESTORE_DATABASE_ID`; senza, quello di `firebase-applet-config.json`). Lo stato salvato porta la modalità: un'istanza che trova lo stato di un'altra modalità non lo usa, non prende il lease, non chiama Kraken (SAFE_MODE, alert `STATE_REFUSED`, D51). Il reset dello shadow richiede il lease (D52). Uno stato non ricostruibile ferma il bot con un alert invece di lasciarlo in RECOVERING (D53).
- **Netting per simbolo (D48):** su Kraken le posizioni sono nette. Un ingresso aspetta (max 10 minuti) finché sul simbolo c'è una posizione del bot in chiusura o un ingresso incerto; un'uscita già eseguita non genera altri ordini.
- **Recovery (D49, D50):** gli intenti decisi e mai inviati si inviano dopo la riconciliazione (uscite sempre, ingressi solo entro 10 minuti dalla decisione). I trade chiusi nel tick si salvano prima del checkpoint write-ahead.
- **Protezione ferma (D54):** 90 s di cicli di protezione (o recovery) falliti → alert critico `PROTECTION_FAILING` e health non sano. Senza Kraken il ciclo decisionale non avanza (riconcilia prima di ogni slot, I10/I13): nessuna decisione e nessun ingresso; al ritorno gli ingressi ormai tardivi non partono.
- **Caos e shadow run:** `tests/chaos/` (11 scenari con 7 invarianti, 96 ore di shadow con lo scheduler reale); `npm run shadow:report` valuta i report giornalieri di un periodo (gate: 3 giorni UTC con zero divergenze non spiegate). Smoke test in demo: `docs/DEMO_SMOKE_CHECKLIST.md`.

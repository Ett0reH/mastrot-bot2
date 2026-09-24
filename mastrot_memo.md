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

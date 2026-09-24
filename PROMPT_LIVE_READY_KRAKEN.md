# PROMPT MASTER — da prototipo a sistema pronto per il live test su Kraken Futures

> Progetto: `mastrot-bot2` (bot "ARBITER / MastroT").
> Basato sulla review del codice al commit `83148b1`.
> Uso: una fase per sessione. Incolla l'intero file e imposta l'ultima riga `FASE DA ESEGUIRE: F<n>`.

---

## 0. Per l'umano (l'agente può ignorare questa sezione)

1. Prima della F1 controlla i valori della sezione 2. I default sono quelli raccomandati; quelli marcati `# DECIDI` vanno confermati da te.
2. Esegui una fase per sessione, in ordine da F0 a F8. Passa alla successiva solo dopo aver letto e approvato il PHASE REPORT (salvato in `docs/phase_reports/`).
3. Alcune verifiche spettano a te: rotazione delle chiavi, creazione delle chiavi Kraken demo, run in demo di più giorni e passaggio a live. L'agente prepara script e checklist, ma non opera su conti reali.

---

## 1. Ruolo e missione

Sei un senior engineer di sistemi di trading algoritmico in produzione (esecuzione ordini, risk management, riconciliazione con l'exchange) ed esperto di TypeScript e Node.js. Lavori sul repository esistente e non riscrivi il progetto da zero.

**Missione:** rendere il bot **pronto per il live test su Kraken Futures**. Questo significa:

1. il motore live prende **le stesse decisioni** del backtest validato, sugli stessi dati;
2. ogni ordine è idempotente e riconciliato con Kraken, e ogni posizione è sempre protetta da uno stop nativo;
3. il sistema sopravvive a crash, riavvii, errori API, dati mancanti e istanze duplicate senza perdere il controllo delle posizioni;
4. esistono guardrail di rischio, kill switch, alert e un runbook che permettono a una persona di avviare un live test con capitale limitato.

**Fuori scope:** migliorare la strategia, ottimizzare parametri, aggiungere indicatori o setup, cambiare exchange, riscrivere il progetto.

**Regole per ogni sessione:**
- Esegui **solo** la fase indicata in fondo (`FASE DA ESEGUIRE`).
- Se la fase precedente non ha un report `docs/phase_reports/F<n-1>.md` con gate PASS, fermati e chiedi.
- Scrivi i report in italiano; codice e identificatori in inglese.

---

## 2. Parametri e decisioni

Usa questi valori. Se un parametro manca o è ambiguo, applica il default e dichiaralo nel report.

```yaml
# --- Ambiente ---
TRADING_MODE_DEFAULT: shadow    # shadow = dati reali, fill simulati, nessun ordine
                                # demo   = ordini su Kraken demo (demo-futures.kraken.com)
                                # live   = ordini reali: richiede LIVE_TRADING_CONFIRM, limiti e alert configurati
DEMO_DECISION_DATA: production_public   # in demo le decisioni usano i dati pubblici di produzione
                                        # (gli stessi del backtest); verifica che sia fattibile
HOSTING: single_instance        # Cloud Run con min=max=1 e CPU sempre allocata, oppure VPS/Docker.
                                # Mai due istanze che tradano.
SYMBOLS: [BTC, ETH, SOL, AVAX, XRP, DOGE, LINK, ADA]   # stesso universo del backtest validato (perpetual lineari PF_*).
                                # Se un simbolo non è disponibile su Kraken, rifai il golden senza di esso.

# --- Limiti del live test (guardrail, non parametri di strategia) ---
CAPITAL_CAP_USD: 1000           # DECIDI. Equity del bot = cap + PnL netto del bot, mai oltre il collateral disponibile
MAX_LEVERAGE: 3
MAX_POSITION_NOTIONAL_USD: 1000
MAX_OPEN_POSITIONS: 8           # pari al numero di simboli: non deve mai scattare nel golden
MAX_DAILY_LOSS_PCT: 5           # superato: nessun nuovo ingresso fino al giorno UTC successivo
DRAWDOWN_REDUCE_ONLY_PCT: 15    # superato: REDUCE_ONLY + alert. Deve restare sopra il max DD del golden (10,9%)
ALERT_CHANNEL: telegram         # telegram | email | webhook

# --- Parità backtest ↔ live (default: il backtest validato è la specifica) ---
TAKE_PROFIT_3R_LIVE: remove              # il backtest non l'ha mai usato
RISK_TIERS_IN_LIVE: apply_as_backtest    # resolveRiskTier anche in live, incluso il blocco di TRANSITION
NORMAL_TIER_PF_SEED: live_history        # cleanProfitFactor dai trade NORMAL chiusi dal bot; si parte da 1.0 come nel backtest
EXPECTANCY_MATRIX: empty_like_backtest   # matrice vuota → INSUFFICIENT_DATA → rischio ×0,5 come nel backtest; niente proxy neutro.
                                         # Per attivarla in futuro va costruita walk-forward (out-of-sample), mai sullo stesso periodo.
EXIT_FEATURES: per_symbol                # le uscite usano feature e regime del simbolo, non di BTC
DECISION_CADENCE: on_1h_close            # strategia valutata a ogni chiusura 1H UTC; NORMAL solo alla chiusura 4H
STOP_MODEL: close_based_plus_native_backstop   # DECIDI. Stop e trailing della strategia sono valutati alla chiusura 1H
                                # (come nel backtest) ed eseguiti con un ordine reduceOnly. Su Kraken resta sempre uno
                                # stop nativo di emergenza più largo (backstop), aggiornato a ogni chiusura 1H.
                                # Alternativa: native_intrabar (stop nativi al livello della strategia) → cambia i
                                # risultati, richiede un nuovo golden e l'approvazione dell'utente.
BACKSTOP_BUFFER_PCT: 3          # distanza del backstop oltre lo stop della strategia; va modellato anche nel backtest (intrabar sui 15m)
UNKNOWN_POSITION_POLICY: alert_protect_no_manage   # posizione su Kraken sconosciuta al bot: alert + stop protettivo,
                                                   # nessuna gestione strategica
```

**Principio:** i guardrail non devono mai scattare nel golden backtest. Se scattano, riportalo: o sono troppo stretti, o vanno modellati anche nel backtest.

---

## 3. Contesto del progetto (fatti verificati)

**Stack**
- Node 20 e TypeScript.
- Express 5 (`server.ts`).
- React 19 + Vite + Tailwind (`src/Dashboard.tsx`).
- Firestore (`firebase/firestore/lite`).
- `@siebly/kraken-api` (`DerivativesClient`) per il live.
- `ccxt` per il download storico e per l'endpoint di emergenza.

**Strategia** — `src/server/core/architecture.ts`, organizzata in 9 layer: MarketData, Regime, Signal, ExpectancyTracker, Gatekeeper, Risk, PositionExit, CapitalManagement, Analytics. I motori sono due:
- **EXTREME `MEAN_REVERSION`:** opera in CRASH/EUPHORIA con RSI 1H sotto 20 o sopra 80; eredita il regime estremo di BTC.
- **NORMAL `RSI2_TREND_TRAILING`:** solo LONG, solo in BULL, alla chiusura 4H, con trailing del 2%.

**Backtest di riferimento** — `src/server/backtest/run_kraken.ts`: dati 15m di Kraken Futures aggregati in 1H/4H, 8 simboli, dal 2022-01-01 al 2026-05-09. Risultati in `backtest_report_latest.json`:

| Metrica | Valore |
|---|---|
| Rendimento totale | +35,7% |
| Max drawdown | 10,9% |
| Profit factor | 1,26 |
| Sharpe | 0,76 |
| Trade | 713 (EXTREME 420, NORMAL 293) |
| Leva massima effettiva | 3x |

**Live** — `src/server/liveEngine.ts`:
- `KrakenExchangeAdapter` e `loopTick`, eseguito ogni 7,5 s e a ogni poll HTTP;
- riconciliazione con Kraken e ledger;
- un unico documento Firestore `bot_state/live`.

**Documenti da rispettare**
- `AGENTS.md`.
- `mastrot_memo.md`: architettura di riferimento (dati a 15m, feature 1H/4H, leva decisa solo all'apertura).
- `summa-test.md`: le 5 macro-aree.
- `trading_bot_audit_prompts_deterministici/00_GLOBAL_CONTEXT.md`: protocollo test-first e invarianti. Nota: la sua regola "non modificare codice di produzione" vale per gli audit. Qui la produzione si modifica, ma sempre test-first.

**Solo storico** — I report `FASE*`, `debug_reports/` e `QA_REPORT.md` (spostati in `archive/reports/` durante la F0) descrivono in parte bug già corretti: non sono una specifica.

---

## 4. Regole non negoziabili

### Processo

1. **Leggi prima di modificare.** Leggi `AGENTS.md` e `mastrot_memo.md` e verifica che le modifiche siano coerenti col memo. A fine fase aggiorna la sezione "Ultime Modifiche" del memo.
2. **Lavora test-first.** Per ogni difetto:
   - scrivi prima un test che fallisce;
   - poi applica il fix;
   - poi verifica che il test passi.

   Nessuna conclusione senza un test o una prova riproducibile.
3. **La strategia è congelata.**
   - Non cambiare soglie, indicatori, regimi, pesi, feature flag o parametri in `architecture.ts`.
   - I refactor sono ammessi solo se il golden backtest resta identico: stessi trade e PnL al centesimo.
   - Le modifiche intenzionali al modello di esecuzione (sezione 2) si applicano una alla volta, con le metriche prima e dopo.
4. **Commit piccoli e mirati.**
   - Commit piccoli e atomici, nessuna modifica fuori scope.
   - Se il tuo ambiente lo prevede, un branch e una PR per fase.
5. **Non rendere verdi i test a tutti i costi.** È vietato:
   - cancellare o indebolire test, usare `skip`, allargare le tolleranze;
   - usare mock nei percorsi di produzione;
   - intercettare errori per ignorarli.
6. **Niente fallback silenziosi** come `|| 0`, `|| 1`, `|| 50`, `|| 10000` o `status: 'closed'` di default.
   - Ogni fallback è esplicito, loggato e testato.
   - Uno stato sconosciuto resta sconosciuto.
7. **Kraken solo da fonti ufficiali.** Per endpoint, campi, limiti e codici di errore di Kraken basati sulla documentazione ufficiale Kraken Futures (docs.kraken.com) e sui tipi di `@siebly/kraken-api`. Cita la fonte nei test. Non inventare campi.
8. **Non inventare output.** Se non puoi eseguire un comando o raggiungere Kraken, dichiaralo e marca la verifica come NON ESEGUITA.
9. **Problemi nuovi.** Se trovi un problema non elencato nella sezione 7:
   - registralo come `D35`, `D36`… con un test di riproduzione;
   - correggilo fuori fase solo se mette a rischio i fondi in modo immediato.

### Sicurezza operativa

10. Il default è sempre sicuro: senza una configurazione valida il sistema parte in `shadow` e non invia ordini.
11. Chiavi demo e live in variabili separate. Mai chiavi live in sviluppo o nei test. Nessun segreto nel codice o nei log.
12. Non eseguire mai operazioni su conti reali. Il passaggio a `live` lo fa solo una persona, seguendo il runbook.
13. Non usare le modalità demo o live prima della chiusura di F4, salvo gli smoke test dedicati della F3.
14. Se trovi un rischio di perdita di fondi, fermati subito e segnalalo. Esempi: ordini inviati in shadow, posizioni senza stop, doppie istanze.

---

## 5. Invarianti di dominio

Ogni invariante deve avere almeno un test automatico.

| ID | Invariante |
|---|---|
| I1 | Una candela 1H è l'aggregazione di 4 candele 15m chiuse; una 4H di 16. I confini sono in UTC (00, 04, 08, 12, 16, 20). Nessuna candela viene usata prima della sua chiusura. |
| I2 | Backtest e live usano la stessa pipeline dati: stesse funzioni di aggregazione e di feature, stessa finestra (ultime 250 barre 1H/4H), stesso universo di simboli. |
| I3 | Parità decisionale: sugli stessi dati 15m, il percorso live in replay produce la stessa sequenza di decisioni del backtest (ingressi, uscite, direzione, size, leva, livelli di stop). Match al 100%. |
| I4 | La leva si decide all'apertura e non cambia durante il trade (memo, sezione 4). |
| I5 | Il SignalLayer non decide size, leva o ordini. Il RiskLayer non invia ordini. L'esecuzione non inventa dati di strategia. |
| I6 | Al massimo una posizione per simbolo. NORMAL: solo LONG, solo BULL, solo alla chiusura 4H; esce solo per trailing (oppure per backstop o invalidazione dei dati). |
| I7 | Ogni posizione aperta su Kraken ha, entro un tempo configurato dal fill, uno stop nativo reduceOnly con size pari alla posizione. Se non è possibile: chiusura reduceOnly immediata e alert. |
| I8 | Ogni ordine ha un `cliOrdId` deterministico, salvato prima dell'invio. Un retry non crea mai un secondo ordine. |
| I9 | Un ordine in stato sconosciuto resta UNKNOWN finché non viene riconciliato. Non viene mai considerato filled o closed per default. |
| I10 | Kraken è la fonte di verità per posizioni, ordini e fill. Lo stato locale si riconcilia a ogni ciclo di protezione e a ogni avvio. |
| I11 | Solo l'istanza che detiene il lease può inviare ordini. Se lo perde, smette subito, anche durante i deploy con revisioni sovrapposte. |
| I12 | Un trade non è mai aperto e chiuso nello stesso momento. Ogni chiusura è registrata nel ledger con fill, fee e funding reali. |
| I13 | Con dati stale o API non disponibili non si aprono nuovi ingressi, ma la protezione (stop nativi) resta attiva. La gestione delle uscite riprende appena tornano i dati. |
| I14 | La dashboard mostra solo dati reali o derivati da fonti reali. La modalità (SHADOW/DEMO/LIVE) è sempre visibile. |
| I15 | Tutti i tempi sono in UTC e passati dall'esterno. Nessuna logica dipende dal fuso del server o da `Date.now()` dentro il core. |

---

## 6. Architettura obiettivo

```
Kraken market data (15m, ticker, instruments, funding)
        │
   DataFeed ─► CandleStore 15m ─► Aggregator 1H/4H (UTC)
        │                                  │
        │                           DecisionCore  (codice identico per Backtester, Replay e Live)
        │                           MarketData → Regime → Signal → Gatekeeper → Tier → Risk → Exit → Capital
        │                                  │
        │                   Intenti: OPEN / CLOSE / UPDATE_STOP / NONE (+ motivo)
        │                                  │
        │                           RiskGuard (modalità, cap, limiti, kill switch)
        │                                  │
        └──────────────► ExecutionEngine: OrderManager idempotente · StopManager · Reconciler
                                           │
                                   KrakenAdapter (unico client)
                                           │
               Ledger/Journal (Firestore, solo lato server) · Alert · API autenticate · Dashboard
```

**DecisionCore puro**
- **Input:** candele, posizioni, equity, stato persistito di tier e cooldown, config, tempo.
- **Output:** intenti con il loro motivo.
- Nessun I/O, nessuna mutazione degli input, nessuno stato globale.
- I singleton di `architecture.ts` diventano stato esplicito oppure metriche separate. In particolare `TradeBudgetMetrics` (usato dai tier) ed `ExpectancyTracker`.

**Backtester** = DecisionCore + SimulatedExecution.
- Fee reali, slippage configurabile, funding storico.
- Backstop simulato intrabar sui 15m.
- Iterazione per timestamp UTC, non per indice di array.

**Live** = DecisionCore + ExecutionEngine reale, organizzato in due cicli:
- **ciclo decisionale:** a ogni chiusura 1H UTC, più un margine;
- **ciclo di protezione:** ogni 15-30 s. Fa riconciliazione, verifica degli stop e health check, senza prendere decisioni di strategia.
- HTTP non guida mai il motore.

**Modalità:** shadow / demo / live. La configurazione viene validata all'avvio e il sistema si ferma subito se non è valida.

---

## 7. Difetti noti

Verifica ogni difetto con un test prima di correggerlo. I numeri di riga si riferiscono al commit `83148b1`.

| ID | Dove | Problema | Fase |
|---|---|---|---|
| D01 | `src/server/liveEngine.ts:4` | `process.env.LIVE_TRADING_ENABLED = 'true'` è forzato: il "paper trading" invia sempre ordini veri | F1 |
| D02 | `liveEngine.ts` (`initExchange` e costruttore dell'adapter) contro `server.ts:150` e `src/server/scripts/*` | Default di `KRAKEN_SANDBOX` incoerente: se non è impostata, il live va sul conto REALE, gli altri percorsi in sandbox | F1 |
| D03 | `server.ts` | Endpoint senza autenticazione: start/stop/reset, `/api/emergency-kraken-transfer`, `/api/debug-kraken` (restituisce anche lo stack trace), `/api/generate`, `/api/admin/toggle-degraded`, `/api/cron/tick` | F1 |
| D04 | `src/server/backtest/run.ts:27`, `run_2w.ts:27` | Chiavi Alpaca hardcoded (vanno ruotate) | F1 |
| D05 | `firestore.rules:32` + `saveState()` | `bot_state/live` è leggibile da chiunque e contiene `botSecret`, che è l'unica autorizzazione alla scrittura | F1 |
| D06 | `src/server/backtest/data_cache/*_2022-01-01_2026-05-09.json` | Tutti i file sono troncati a 1.999.570 byte (JSON invalido): il backtest di riferimento non è riproducibile dal repo | F0 |
| D07 | `run_kraken.ts:224-225` | Aggregazione 1H/4H fatta con `getHours()`/`getMinutes()`, cioè nel fuso locale | F2 |
| D08 | `run_kraken.ts:306` | Loop per indice `i` comune a tutti i simboli: dopo un buco nei dati (XRP ne ha) i simboli si disallineano nel tempo, compresi il regime BTC e l'equity | F2 |
| D09 | `run.ts:621` contro `liveEngine.ts:2104` | `resolveRiskTier` esiste solo nel backtest (tier di esposizione e blocco di TRANSITION) | F2 |
| D10 | `liveEngine.ts:2234` | Take profit a 3R solo in live | F2 |
| D11 | `liveEngine.ts:1663`, `:1681` | Le uscite live usano feature e regime di BTC per tutti i simboli | F2 |
| D12 | `liveEngine.ts:1020-1047` + `run_kraken.ts` | Matrice expectancy assente: il backtest applica ×0,5 a tutto, il live un proxy neutro (×1,0). La leva 5x di FASE 10 è irraggiungibile | F2 |
| D13 | `liveEngine.ts:1925`, `:872` | La leva viene sovrascritta a trade aperto con `maxFixedLeverage \|\| 1`: viola la sezione 4 del memo e allarga il trailing EXTREME | F2/F3 |
| D14 | `liveEngine.ts` | In live HWM, trailing e stop si aggiornano sul tick ogni 7,5 s e gli stop nativi sono al livello della strategia; nel backtest tutto avviene sulla chiusura 1H | F2 |
| D15 | backtest e live | Finestre degli indicatori diverse (backtest `slice(-250)`, live fino a 400 barre): EMA e RSI non coincidono | F2 |
| D16 | `run_kraken.ts` | Il backtest non considera né slippage né funding | F2 |
| D17 | `KrakenExchangeAdapter.fetchOrder` | Un ordine non trovato viene restituito come `status: 'closed'` | F3 |
| D18 | uscite, harvest, stop/reset, emergenza | Ordini senza `cliOrdId`: dopo un timeout possono essere inviati due volte | F3 |
| D19 | `formatPriceAndSize`, `PRECISION_MAP`, `loadMarkets` | Tick size, precisione e minimi sono hardcoded | F3 |
| D20 | `ensureIsolatedLeverage` | Restituisce `true` anche se l'impostazione della leva fallisce, quindi si passa in cross margin senza segnalarlo | F3 |
| D21 | `createProtectedLimitEntryOrder` | Fa polling fino a 30 s dentro il tick e blocca la gestione delle altre posizioni | F3 |
| D22 | riconciliazione (`test-adopt-*`) | Le posizioni "adottate" non hanno leva, HWM, engine né stop iniziale: i calcoli producono NaN | F3 |
| D23 | ledger | `recordFill` viene chiamato solo sugli ingressi, quindi il ledger non chiude mai. `orderIntents` e `positionLedger` crescono senza limite nel documento Firestore, che ha un tetto di 1 MiB | F4 |
| D24 | `server.ts:107` + `triggerCronTick` | Con il bot attivo, ogni poll della dashboard (ogni 2 s) esegue un tick e chiama `saveState()`: circa 43.000 scritture al giorno per ogni tab aperta | F4 |
| D25 | `runOhlcvSyncDaemon` | Se il daemon non gira, dopo circa 2 ore `loopTick` esce prima di gestire le uscite (`liveEngine.ts:1622`) | F4 |
| D26 | runtime | Nessun lock di istanza: due istanze possono tradare sullo stesso conto | F4 |
| D27 | `exitCooldowns` | I cooldown stanno solo in memoria e si perdono al riavvio | F4 |
| D28 | sync con Kraken | La sync resetta `initialBalance` e `maxHistoricalEquity` (drift oltre 100 $ o presunti "prelievi"), e l'equity usata per il sizing include il wallet cash | F4/F5 |
| D29 | halt per drawdown | In live spegne l'intero motore, comprese le uscite; nel backtest le uscite continuano | F5 |
| D30 | `emergencyCloseAll` | Non viene mai chiamata: il pulsante "Emergency Kill Switch" si limita a fermare il bot | F5 |
| D31 | `/api/system/state`, `Dashboard.tsx` | L'endpoint restituisce dati mock. "Time Under Water" e "Max DD Duration" mostrano lo stesso valore con unità diverse. C'è un `\n` letterale a `Dashboard.tsx:1039` | F6 |
| D32 | test | Alcuni audit non possono fallire: "Invariant 3" in `tests/audit/metrics/arbiter-metrics-consistency.test.ts`; `backtest-symbol-comparability.test.ts` legge campi che non esistono. Manca `npm test` e `tsconfig` ha `strict: false` | F0 |
| D33 | dipendenze | `@siebly/kraken-api` è in devDependencies ma serve a runtime. Ci sono due client Kraken diversi: siebly nel live, ccxt nell'endpoint di emergenza | F0/F3 |
| D34 | `stopPaperTrading` | Non cancella gli stop nativi e resetta il balance a `baseBalance` | F5 |

---

## 8. Piano a fasi

Ogni fase si chiude con un gate.

### F0 — Fondamenta e rete di sicurezza

**Attività**
1. **Strumenti di test.**
   - Aggiungi un test runner (vitest oppure `node:test` via tsx).
   - Aggiungi gli script `npm test`, `npm run typecheck` (`tsc --noEmit`) e `npm run backtest`.
   - Porta gli audit esistenti nel runner. Quelli che non possono fallire vanno corretti oppure eliminati, motivando la scelta (D32).
2. **TypeScript e dipendenze.**
   - Attiva `strict: true` almeno per i moduli nuovi, con un tsconfig dedicato.
   - Sposta `@siebly/kraken-api` in dependencies (D33).
3. **Dataset (D06).** Ricostruisci il dataset 15m di Kraken Futures per gli 8 simboli, dal 2022-01-01 al 2026-05-09:
   - script di download con paginazione, retry e report dei buchi;
   - salvataggio compresso (`.json.gz`) con un manifest SHA-256;
   - i file sopra i 2 MB stanno fuori da git normale (Git LFS, oppure storage esterno + script di download);
   - test di integrità del dataset.
4. **Golden run.**
   - Esegui il backtest attuale con `TZ=UTC` e salva `golden/trades.json`, il suo hash e le metriche.
   - Confronta il risultato con `backtest_report_latest.json` (713 trade, +35,7%).
   - Se non coincide, spiega la differenza (per esempio dati riscaricati diversi) e fissa il nuovo golden solo con l'approvazione dell'utente.
5. **Pulizia della root.** Sposta in `archive/` gli script e i report storici, senza cancellarli, e aggiorna i riferimenti.
6. **CI minima (GitHub Actions)** con typecheck, test e controllo del golden. Se il dataset completo non è disponibile in CI, usa un sottoinsieme (per esempio 3 mesi) con un proprio golden.

**Gate:** test e typecheck verdi; golden eseguito due volte con hash identico.

### F1 — Sicurezza e configurazione

**Attività**
1. **Configurazione tipizzata e validata all'avvio.**
   - Deve contenere `TRADING_MODE`, chiavi demo e live separate, `LIVE_TRADING_CONFIRM` e i limiti della sezione 2.
   - Un unico helper decide ambiente e modalità, con default `shadow`. Questo chiude D01 e D02.
   - Fino alla F4 il vecchio motore può inviare ordini solo se demo o live sono configurati esplicitamente.
2. **Endpoint (D03).**
   - Token obbligatorio sulle API sensibili, con confronto timing-safe.
   - Il cron usa un proprio token.
   - Nessuno stack trace nelle risposte.
   - Rimuovi `/api/generate` (dopo aver verificato che non è usato) e `/api/admin/toggle-degraded`.
3. **Segreti.**
   - Solo da variabili d'ambiente.
   - Rimuovi le chiavi Alpaca (D04) e chiedi all'utente di ruotarle.
   - Togli `botSecret` dal documento Firestore.
4. **Firestore (D05).** Accesso solo lato server (Admin SDK + service account), con regole `deny all` per i client.

**Gate:** servono test che dimostrino che:
- una richiesta senza token riceve 401;
- una configurazione incoerente impedisce l'avvio;
- `live` senza flag di conferma, limiti o alert impedisce l'avvio;
- uno scan del repository non trova segreti.

### F2 — DecisionCore unico e parità backtest ↔ live

**Fase A — Estrazione senza cambiare comportamento**
- Crea il DecisionCore riunendo:
  - `architecture.ts`;
  - la logica che oggi esiste solo in `run_kraken.ts`: tier, cooldown NORMAL su 4H, invalidazione per buco dati, sizing sull'equity.
- Rendi lo stato esplicito e persistibile: cleanProfitFactor dei NORMAL e cooldown.
- Il backtest deve usare il nuovo core e riprodurre il golden identico.

**Fase B — Correzioni intenzionali al backtest**
Applicale una alla volta, ciascuna con le metriche prima e dopo:
- UTC al posto del fuso locale (D07);
- loop per timestamp invece che per indice (D08);
- modello di esecuzione realistico, lo stesso che userà il live (D14, D16):
  - backstop simulato intrabar sui 15m;
  - uscite della strategia alla chiusura 1H, con slippage;
  - fee reali e funding storico.

Report richiesto:
- confronto tra golden vecchio e nuovo, per anno, per engine e per simbolo;
- sensibilità ai costi: fee raddoppiate, slippage a 0, 5 e 10 bps;
- test out-of-sample: 2022-2024 contro 2025-2026.

**STOP e chiedi l'approvazione dell'utente** se, con costi realistici, vale almeno una di queste condizioni:
- profit factor sotto 1,10;
- max drawdown sopra il 20%;
- almeno un anno solare con perdita oltre il 10%.

**Fase C — Ciclo decisionale del live**
- Crea un `DecisionCycle` che usa il core applicando le decisioni della sezione 2. Chiude D09-D13 e D15, perché il live smette di avere logica propria.
- Costruisci un replay harness con orologio ed esecuzione simulati. Sugli stessi dati 15m deve produrre le stesse decisioni del backtest (I3).
- Il vecchio `loopTick` resta finché la F4 non lo sostituisce.

**Gate:** nuovo golden approvato; parità del replay al 100% su almeno 12 mesi; nessun parametro di strategia modificato.

### F3 — Execution layer Kraken

**Attività**
1. **Un solo KrakenAdapter** (siebly) per tutto, compreso l'endpoint di emergenza.
   - Leggi gli strumenti da `getInstruments()`: tick size, precisione della size, minimi, posizione massima. Usa una cache e copri tutto con test.
   - Nessun valore hardcoded (D19, D33).
2. **OrderManager idempotente (D17, D18).**
   - Ogni ordine segue una macchina a stati: INTENT_CREATED → SUBMITTED → ACKNOWLEDGED → PARTIAL / FILLED / CANCELED / REJECTED / UNKNOWN.
   - Il `cliOrdId` è deterministico e viene salvato prima dell'invio.
   - I retry avvengono solo dopo la riconciliazione per `cliOrdId`.
   - Lo stato si legge dall'endpoint ufficiale per order id o `cliOrdId` (verifica documentazione e tipi di siebly), usando fill e fee reali.
3. **Ingresso (D21).**
   - Ordine limit marketable con buffer configurabile (oppure IOC) e timeout.
   - In caso di fill parziale, la size della posizione è quella eseguita e lo stop si calcola su di essa.
   - L'invio dell'ordine non deve bloccare il ciclo di protezione.
4. **StopManager.**
   - Per ogni posizione, uno stop nativo `stp` reduceOnly su mark price, al livello definito da `STOP_MODEL`.
   - Aggiornamento con `editorder` dopo ogni chiusura 1H, con verifica dopo ogni modifica.
   - Se lo stop non si può piazzare: chiusura reduceOnly della posizione e alert (I7).
5. **Leva (D13, D20).**
   - Imposta il margine isolated prima dell'ingresso. Se l'impostazione fallisce, niente ingresso (salvo config esplicita).
   - La leva viene salvata sul trade e non viene mai sovrascritta.
6. **Riconciliazione** a ogni ciclo di protezione e a ogni avvio: posizioni, ordini aperti e fill dall'ultimo checkpoint. Le posizioni sconosciute seguono `UNKNOWN_POSITION_POLICY` invece di essere "adottate" con campi inventati (D22).
7. **Robustezza API:** rate limiter basato sui costi documentati da Kraken, backoff, circuit breaker sugli errori ripetuti.

**Gate**
- Test di contratto con fixture, registrate in demo oppure costruite dalla documentazione (indica la fonte). Casi da coprire:
  - ordine accettato;
  - ordine rifiutato;
  - fill parziale;
  - timeout dopo l'invio;
  - errori 429 e 503;
  - ordine sconosciuto;
  - stop mancante;
  - posizione chiusa dall'esterno.
- Il test "timeout dopo l'invio" dimostra zero ordini duplicati.
- Smoke test su Kraken **demo**: apertura minima, stop nativo presente, aggiornamento dello stop, chiusura, ledger uguale ai fill di Kraken. Senza accesso alla demo, marca la verifica NON ESEGUITA e consegna lo script all'umano.

### F4 — Runtime, persistenza e recovery

**Attività**
1. **Un unico scheduler interno (D24).**
   - Ciclo decisionale alla chiusura 1H UTC, con un margine configurabile e l'attesa che la candela delle :45 sia pubblicata.
   - Ciclo di protezione ogni 15-30 s.
   - HTTP non esegue logica: il cron esterno verifica solo che il processo sia vivo.
   - Rimuovi `loopTick` e i percorsi legacy solo quando i test di questa fase sono verdi.
2. **Lease di istanza su Firestore (D26)**, con scadenza e rinnovo. Senza lease non parte nessun ordine.
3. **Deploy:** Cloud Run con min=max=1 e CPU sempre allocata, oppure VPS.
4. **Dati (D25, I13).** Le candele si aggiornano dentro il ciclo. Con dati stale non si aprono ingressi, ma la protezione resta attiva.
5. **Persistenza (D23, D27).**
   - Un documento di stato piccolo, più le collezioni `positions`, `orders`, `fills`, `decisions` (append-only, con retention) ed `equity`.
   - Scritture solo quando qualcosa cambia, con un budget giornaliero misurato.
6. **Recovery all'avvio**, in quest'ordine:
   1. carica lo stato;
   2. acquisisce il lease;
   3. riconcilia con Kraken;
   4. ricostruisce le posizioni con tutti i campi;
   5. verifica gli stop;
   6. riprende.
7. **Equity (D28).**
   - Equity del bot = `CAPITAL_CAP_USD` + PnL netto del bot, limitata dal collateral del conto di trading.
   - Nessun reset automatico di `initialBalance` o `maxHistoricalEquity`.
   - Depositi e prelievi letti dall'account log e contabilizzati in modo esplicito.

**Gate**
- Test di crash e restart verdi per questi scenari:
  - crash tra l'invio di un ordine e il suo salvataggio;
  - crash con un trade aperto;
  - riavvio con uno stop mancante;
  - Firestore non disponibile;
  - due istanze attive contemporaneamente.
- Scritture Firestore giornaliere, misurate in shadow, sotto la soglia configurata.

### F5 — Guardrail di rischio e kill switch

**Attività**
1. **RiskGuard** controlla ogni ordine prima dell'invio, con i limiti della sezione 2. In caso di violazione: intento rifiutato, log e alert.
2. **Stati operativi:**
   - RUNNING;
   - REDUCE_ONLY: gestisce solo le uscite;
   - HALTED: posizioni chiuse, bot fermo.

   Un drawdown oltre soglia porta in REDUCE_ONLY senza spegnere la gestione delle uscite (D29).
3. **Kill switch idempotente**, attivabile da API autenticata, da un pulsante in dashboard o da un flag. Esegue in ordine:
   1. cancella gli ordini non protettivi;
   2. chiude tutte le posizioni reduceOnly con `cliOrdId`;
   3. verifica che il conto sia flat;
   4. rimuove gli stop residui;
   5. passa in HALTED e invia un alert.

   Chiude D30 e D34.

**Gate:** un test per ogni limite e per il kill switch, anche quando l'API fallisce a metà; prova del kill switch in demo.

### F6 — Osservabilità e dashboard

**Attività**
1. **Log e journal.**
   - Log JSON strutturati con correlation id (`positionId`, `cliOrdId`, `cycleId`).
   - Il journal registra ogni decisione con il suo motivo, anche quelle NEUTRAL o bloccate.
2. **Alert** su questi eventi:
   - ingresso e uscita;
   - errore di esecuzione;
   - stop mancante o ripristinato;
   - desync con Kraken;
   - dati stale;
   - lease perso;
   - kill switch;
   - heartbeat mancante.
3. **Health endpoint autenticato**, che riporta: modalità, lease, età dei dati, ultimo ciclo, se ogni posizione è protetta, errori recenti.
4. **Dashboard.**
   - Solo dati reali: elimina il mock di `/api/system/state`.
   - Badge della modalità e stato dello stop nativo per ogni posizione.
   - Confronto tra shadow e backtest.
   - Correggi D31.
   - Metriche coerenti con il ledger.
5. **Report giornaliero** con PnL, fee, funding, slippage rispetto al modello, fill rate e divergenze.

**Gate:** test sulle metriche con casi che possono davvero fallire; screenshot della dashboard in shadow.

### F7 — Validazione end-to-end

**Attività**
1. Replay su più mesi eseguito in CI.
2. **Scenari di caos automatizzati** su un exchange simulato:
   - raffiche di errori 503;
   - timeout dopo l'invio;
   - fill parziali;
   - stop rifiutato;
   - posizione chiusa a mano;
   - riavvio a metà ciclo;
   - dati 15m mancanti o candela pubblicata in ritardo;
   - due istanze attive.
3. Smoke test end-to-end su Kraken demo, con una checklist manuale.
4. **Shadow run:** un comando che gira su dati reali e produce ogni giorno un report di parità con il backtest sugli stessi dati.

**Gate:** tutto verde; almeno 72 ore di shadow (se eseguibili) senza divergenze non spiegate.

### F8 — Prontezza al live test

**Attività**
1. **`RUNBOOK_LIVE_TEST.md`**, che copre:
   - configurazione di Kraken: conto o subaccount dedicato, chiavi senza permesso di prelievo;
   - deploy;
   - passaggio shadow → demo → live;
   - monitoraggio, kill switch e rollback;
   - cosa fare in caso di desync, stop mancante, API non disponibile o drawdown.
2. **`GO_LIVE_CHECKLIST.md`**, con criteri misurabili:
   - almeno 14 giorni in demo con zero posizioni senza stop, zero ordini duplicati e zero desync non risolte;
   - parità decisionale al 100%;
   - slippage entro il modello;
   - limiti live impostati e alert testati.
3. Aggiorna `mastrot_memo.md` con la nuova architettura.

**Gate:** Definition of Done della sezione 10.

---

## 9. Report di fine fase (formato obbligatorio)

Salvalo in `docs/phase_reports/F<n>.md`:

```
PHASE REPORT
Fase:
Obiettivo:
File creati/modificati:
Difetti chiusi (ID → test che lo prova):
Difetti aperti o rimandati (motivo):
Nuovi difetti trovati (D35+):
Comandi eseguiti ed esito (typecheck / test / backtest / replay / demo):
Metriche backtest prima → dopo (se toccate):
Default della sezione 2 applicati:
Rischi residui:
Coerenza con mastrot_memo.md: OK / aggiornato (cosa)
Esito gate: PASS / FAIL / NON ESEGUIBILE (motivo)
```

Dopo il report fermati e attendi l'approvazione.

---

## 10. Definition of Done: pronto per il live test

- [ ] Configurazione validata, default `shadow`; `live` solo con conferma esplicita e limiti impostati.
- [ ] Nessun endpoint sensibile senza autenticazione, nessun segreto nel repo, Firestore chiuso ai client.
- [ ] Dataset e golden backtest riproducibili; backtest con costi realistici approvato dall'utente.
- [ ] Parità decisionale tra backtest e replay live al 100%.
- [ ] Ordini idempotenti, stato UNKNOWN gestito, zero duplicati nei test di timeout.
- [ ] Ogni posizione con uno stop nativo verificato; chiusura automatica se non è protetta.
- [ ] Riconciliazione e recovery provate dai test di crash e restart; lease di istanza attivo.
- [ ] Guardrail e kill switch testati, anche in demo.
- [ ] Dashboard con soli dati reali, alert funzionanti, health endpoint attivo.
- [ ] Smoke test in demo superato; runbook e checklist pronti; memo aggiornato.

---

FASE DA ESEGUIRE: F0

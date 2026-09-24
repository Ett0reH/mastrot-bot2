# MastroT / ARBITER — bot di trading su Kraken Futures

Bot di trading crypto su perpetual lineari di Kraken Futures (`PF_*`), con backtest event-driven, motore live e dashboard React.

- Architettura e regole di coerenza: [`mastrot_memo.md`](mastrot_memo.md)
- Piano di lavoro verso il live test: [`PROMPT_LIVE_READY_KRAKEN.md`](PROMPT_LIVE_READY_KRAKEN.md) e report di fase in [`docs/phase_reports/`](docs/phase_reports/)

## Avvio locale

Prerequisiti: Node.js 20 o superiore.

```bash
npm install
cp .env.example .env    # imposta almeno ADMIN_TOKEN (es. openssl rand -hex 32)
npm run dev             # http://localhost:3000
```

Senza configurazione il bot parte in modalità **shadow**: usa dati di mercato reali, simula i fill e non invia ordini. Le modalità `demo` e `live` e i relativi requisiti sono descritti in `.env.example`. Il server non parte se la configurazione non è valida.

## Come gira il bot

Il server avvia il runtime (`src/engine/runtime/`) con uno scheduler interno: il ciclo decisionale gira a ogni fine slot di 15 minuti (decisioni alla chiusura 1H UTC, come il backtest), il ciclo di protezione ogni 20 secondi (riconciliazione con Kraken, verifica degli stop). Le richieste HTTP leggono solo lo stato; il cron esterno (`/api/cron/tick`) è un heartbeat.

- **Persistenza:** Firestore (stato, ordini, trade, decisioni, equity, ledger). Obbligatoria in demo e live; in shadow, se manca, lo stato resta in memoria.
- **Una sola istanza opera:** lease su Firestore. Un'istanza senza lease resta in STANDBY e non invia ordini.
- **Riavvio:** carica lo stato, prende il lease, riconcilia con Kraken, verifica gli stop e riprende.
- **Deploy:** una sola istanza sempre attiva (`deploy/cloudrun-service.yaml`: Cloud Run con min=max=1 e CPU sempre allocata) oppure una VPS con il `Dockerfile`.

La dashboard chiede l'`ADMIN_TOKEN` al primo accesso e lo salva nel browser.

## Guardrail e kill switch

- **Limiti** (`.env.example`): ogni ingresso passa dal RiskGuard prima dell'invio (leva isolated su Kraken, nozionale, numero di posizioni, margine entro l'equity del bot e il collateral). Un ingresso respinto non genera ordini: finisce nel journal (`REJECTED`, con il motivo) e negli alert.
- **Perdita giornaliera** oltre `MAX_DAILY_LOSS_PCT`: nessun nuovo ingresso fino alla mezzanotte UTC. **Drawdown** oltre `DRAWDOWN_REDUCE_ONLY_PCT`: stato `REDUCE_ONLY` (uscite e stop continuano) finché una persona non riprende.
- **Kill switch** (idempotente): pulsante "Emergency Kill Switch" della dashboard, `POST /api/kill-switch` (admin), oppure il campo `killSwitch: true` nel documento Firestore `bot_runtime/control` (anche scritto a mano dalla console). Cancella gli ordini non protettivi, chiude tutte le posizioni reduceOnly, verifica il conto flat, rimuove gli stop residui e passa in `HALTED`. Se Kraken fallisce a metà riprende al ciclo di protezione successivo.
- **Ripresa** da `REDUCE_ONLY` o `HALTED`: pulsante "Riprendi" o `POST /api/risk/resume` con `{"confirm": "CONFERMO_RIPRESA"}`; rifiutata finché il flag su Firestore è attivo.

## Comandi

| Comando | Cosa fa |
|---|---|
| `npm test` | Test automatici (node:test), inclusi dataset e golden backtest |
| `npm run typecheck` | Typecheck del codice legacy e di quello strict (`src/engine`, `tests`, `scripts`) |
| `npm run backtest` | Backtest del motore unico (DecisionCore) con il modello di esecuzione realistico; `-- --profile legacy`, `--window <id>`, `--full`, `--funding constant` |
| `npm run backtest:legacy` | Backtest legacy (`run_kraken.ts`) sulle finestre del golden |
| `npm run backtest:compare` | Modello legacy vs realistico e stress sui costi (report in `docs/phase_reports/`) |
| `npm run replay:parity` | Parità backtest ↔ percorso live in replay (orologio ed exchange simulati) |
| `npm run golden:check` | Confronta legacy e nuovo motore con i golden versionati (`golden/legacy`, `golden/engine`) |
| `npm run risk:audit` | Audit dei guardrail sul golden backtest (quante volte ogni limite sarebbe scattato) |
| `npm run kraken:demo-smoke` | Smoke test dell'execution layer su Kraken **demo** (chiavi demo richieste) |
| `npm run kraken:demo-kill -- --yes` | Prova del kill switch su Kraken **demo**: chiude tutte le posizioni del conto demo |
| `npm run data:verify` | Verifica checksum e integrità del dataset |
| `npm run data:download` | Ricostruisce il dataset completo da Kraken (serve rete verso futures.kraken.com) |
| `npm run build` / `npm start` | Build di produzione e avvio |

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

La dashboard chiede l'`ADMIN_TOKEN` al primo accesso e lo salva nel browser.

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
| `npm run data:verify` | Verifica checksum e integrità del dataset |
| `npm run data:download` | Ricostruisce il dataset completo da Kraken (serve rete verso futures.kraken.com) |
| `npm run build` / `npm start` | Build di produzione e avvio |

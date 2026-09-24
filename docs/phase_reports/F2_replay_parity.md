# F2 — Parità backtest ↔ replay del percorso live (I3)

> Generato da `npm run replay:parity`. Replay: candele pubblicate 2-90 s dopo la chiusura, candela in formazione offerta dalla fonte (e scartata dal ciclo), tick dopo ogni ora e a volte dopo gli slot intermedi con ritardo fino a 2 minuti, nuovi tentativi ogni 20 s se una candela manca, riavvio del processo ogni ~9 giorni con stato serializzato in JSON e storico ricostruito dalla fonte.

| Scenario | Giorni | Trade | Intenti | Decisioni | Tick | Riavvii | Attese candele | Slot senza candela | Esito |
|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 2022H1 dati reali, modello realistico + funding | 163 | 52 | 816 | 31343 | 20201 | 17 | 12766 | 0 | ✅ identico |
| 2022H1 dati reali, modello legacy | 163 | 52 | 104 | 31348 | 20201 | 17 | 12766 | 0 | ✅ identico |
| 2026Q2 dati reali, modello realistico + funding | 16 | 4 | 175 | 3076 | 1916 | 1 | 1203 | 0 | ✅ identico |
| 2026Q2 dati reali, modello legacy | 16 | 4 | 8 | 3076 | 1916 | 1 | 1203 | 0 | ✅ identico |
| 13 mesi sintetici (seme 2), modello realistico + funding | 396 | 245 | 3365 | 75780 | 53624 | 42 | 35554 | 2184 | ✅ identico |

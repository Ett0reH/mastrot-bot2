# 99 — AUDIT GLOBALE DETERMINISTICO CROSS-AREA

Usa questo file solo dopo aver eseguito gli audit locali delle macroaree.

Obiettivo: trovare bug cross-layer che non emergono guardando una singola area.

Frase obbligatoria:  
**Non trarre conclusioni qualitative prima di avere creato almeno un test automatizzato o una prova riproducibile.**

---

# Prompt 99 — Cross-Area Integration Test

Crea uno o più test `.ts` sotto:

```text
tests/audit/global/
```

Il test deve attraversare almeno 3 layer tra:

```text
MarketData → Regime → Signal → Gatekeeper → Risk → Lifecycle → KrakenMock → Persistence → API/Dashboard
```

Invarianti cross-area:

1. Candle 4H non chiusa non può generare trade live.
2. Signal valido ma Risk reject non può arrivare a Kraken.
3. Trade inviato a Kraken deve essere persistito o entrare in safe mode.
4. Fill exchange deve aggiornare memoria, DB e API.
5. SL/TP exchange triggered deve chiudere lifecycle e dashboard.
6. Ghost exchange-active deve bloccare nuova entry sullo stesso symbol.
7. Startup con exchange active + DB empty deve segnalare desync.
8. Dashboard non può mostrare trade active se lifecycle lo ha chiuso e sync è completato.

---

# Test Scenario A — No Future Data to Live Order

Crea test integration.

Sequenza:

1. Fornisci dataset 15m con 15 candele dentro una 4H non ancora chiusa.
2. Forza condizioni che sembrerebbero generare segnale se la 4H fosse usata.
3. Passa da MarketData a Regime e Signal.
4. Verifica che Gatekeeper/Risk/Live Engine non ricevano trade eseguibile.

Deve fallire se:

- `isH4Closed` è true prima del tempo;
- SignalLayer genera trade usando 4H incompleta;
- Live Engine riceve ordine.

Output: PASS/FAIL, funzione responsabile, rischio look-ahead live.

---

# Test Scenario B — Risk Reject Stops Kraken

Crea test integration.

Sequenza:

1. Genera segnale tecnicamente valido.
2. Imposta expectancy sotto soglia o exposure globale piena.
3. Passa da Signal a Gatekeeper/Risk.
4. Mocka Kraken adapter e verifica che non venga chiamato.

Invarianti:

- reject reason specifica;
- zero chiamate createOrder;
- stato non active;
- log presente.

Deve fallire se un trade rifiutato arriva comunque a execution.

---

# Test Scenario C — Entry Order Timeout Post-Submit

Crea test integration con Kraken mock.

Sequenza:

1. Risk autorizza trade.
2. Kraken `createOrder` simula timeout ambiguo post-submit.
3. Bot deve entrare in pending/ambiguous state.
4. Bot deve chiamare openOrders/fills prima di retryare.
5. Non deve inviare doppio ordine.

Deve fallire se:

- ordini inviati > 1 senza verifica;
- posizione salvata active senza fill;
- retry cambia size/side;
- assenza di clientOrderId/correlationId.

---

# Test Scenario D — Exchange SL Trigger Syncs Everything

Crea test integration.

Sequenza:

1. Trade active in memoria e DB.
2. Exchange mock segnala SL fill.
3. Sync legge fill.
4. Lifecycle chiude trade.
5. DB passa da active a closed/history.
6. API/dashboard mapping non lo mostra più active.

Deve fallire se:

- trade resta active;
- PnL consolidato due volte;
- SL orphan resta aperto senza segnalazione;
- dashboard mostra stato vecchio.

---

# Test Scenario E — Restart With Desync

Crea test integration di startup.

Stati iniziali:

```text
DB: nessun active trade
Memory: vuota
Exchange: posizione BTC perpetual active
Open orders: stop loss presente
```

Invarianti:

1. Bot non deve partire come “flat ok”.
2. Deve rilevare exchange-active/bot-missing.
3. Deve bloccare nuova entry su BTC.
4. Deve loggare ghost/desync.
5. Deve esporre stato degraded via API/dashboard.

Deve fallire se il bot ignora posizione exchange.

---

# Report Finale Obbligatorio

Usa questo formato:

```text
GLOBAL AUDIT RESULT
Test creati:
Comandi eseguiti:
Scenario A: PASS/FAIL
Scenario B: PASS/FAIL
Scenario C: PASS/FAIL
Scenario D: PASS/FAIL
Scenario E: PASS/FAIL

Bug certi:
Bug probabili:
Layer coinvolti:
Rischio economico:
Rischio live:
Priorità fix:
Test da tenere in regressione:
Produzione modificata: NO
```

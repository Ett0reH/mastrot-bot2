# 01 — AREA STRATEGY DETERMINISTICA
## Core Analysis & Signal Generation

Usa questo file insieme a `00_GLOBAL_CONTEXT.md`.

Obiettivo: verificare MarketDataLayer, indicatori, RegimeLayer, SignalLayer ed ExpectancyTracker con test `.ts` prima di qualsiasi conclusione.

Frase obbligatoria:  
**Non trarre conclusioni qualitative prima di avere creato almeno un test automatizzato o una prova riproducibile.**

---

# Prompt 1 — Audit Area Strategy Test-First

Analizza la Macro-Area 1. Prima di concludere, crea test `.ts` sotto `tests/audit/strategy/`.

Devi verificare queste invarianti:

1. Le feature 1H usano solo quattro candele 15m chiuse.
2. Le feature 4H usano solo sedici candele 15m chiuse.
3. `isH4Closed` e `is1HClosed`, se presenti, non possono essere falsificati da backtest/liveEngine.
4. SignalLayer non può decidere size, leva o ordini.
5. Se un segnale dipende da expectancy assente, il comportamento deve essere esplicito e testato.
6. Nessun fallback tipo `|| 50`, `|| null`, `|| "NORMAL"` deve generare segnali silenziosi.

Procedura obbligatoria:

- Step 0: trova file/funzioni reali.
- Step 1: scrivi invarianti.
- Step 2: crea test `.ts`.
- Step 3: analizza con lenti: Data-Feed mismatch, Edge Case, Time Bias.
- Step 4: esegui test.
- Step 5: report con evidenza.

---

# Prompt 1.1 — MarketDataLayer / Timeframe Closed-Candle Test

Crea un test `.ts` che dimostri se MarketDataLayer usa solo candele chiuse.

Invarianti:

```text
A 10:45, la feature 1H dell’ora 10:00 non può includere la candle 10:45 se non chiusa.
A 11:00, la feature 1H 10:00-10:59 può essere considerata chiusa.
Una feature 4H può essere valida solo dopo 16 candele 15m chiuse.
```

Devi cercare funzioni come:

```text
isClosed
is1HClosed
isH4Closed
aggregate
resample
buildFeatures
MarketDataLayer
liveEngine
backtest
```

Test richiesti:

1. dataset con 3 candele 15m → 1H non chiusa;
2. dataset con 4 candele 15m → 1H chiusa;
3. dataset con 15 candele 15m → 4H non chiusa;
4. dataset con 16 candele 15m → 4H chiusa;
5. confronto backtest vs liveEngine sugli stessi timestamp.

Report finale: PASS/FAIL per ogni invariante, file/funzione responsabile, rischio di look-ahead.

---

# Prompt 1.1.a — Indicatori Deterministici RSI/SMA/ATR/ADX

Crea test `.ts` con dataset minimo e deterministico per RSI, SMA, ATR e ADX.

Invarianti:

1. SMA su finestra N deve essere la media esatta degli ultimi N close chiusi.
2. ATR non deve usare candle corrente non chiusa.
3. RSI non deve restituire fallback neutro tipo `50` quando input è insufficiente, salvo regola esplicita testata.
4. ADX deve gestire warm-up senza produrre segnali validi falsi.
5. Array vuoto, dati NaN o insufficienti devono generare `NO_SIGNAL`, errore gestito o valore esplicitamente marcato come non valido.

Cerca nel codice:

```text
RSI|rsi|SMA|sma|ATR|atr|ADX|adx|\|\| 50|\|\| null|\?\? 50|Number.isNaN
```

Test richiesti:

- dataset costante;
- dataset crescente;
- dataset con high/low anomali;
- array vuoto;
- NaN nel close;
- warm-up insufficiente.

Non concludere che “gli indicatori sembrano corretti”. Devi mostrare test e output.

---

# Prompt 1.1.b — Fallback Scanner per Feature e Indicatori

Crea uno script/test `.ts` o audit script che scansiona il codice sorgente e produce lista dei fallback pericolosi.

Cerca pattern:

```text
|| null
|| 0
|| 50
|| "NORMAL"
|| []
?? null
?? 0
?? 50
Number(...) || 
parseFloat(...) ||
```

Invarianti:

1. Nessun fallback numerico deve trasformare dato mancante in indicatore valido.
2. Nessun fallback a `NORMAL` deve trasformare regime sconosciuto in trade possibile.
3. Nessun array vuoto deve essere trattato come dataset valido.
4. Ogni fallback deve essere associato a un log, reject reason o test.

Il test deve fallire se trova fallback non whitelistato in file critici:

```text
MarketDataLayer
RegimeLayer
SignalLayer
ExpectancyTracker
```

Output richiesto:

- fallback trovato;
- file/riga;
- funzione;
- chi lo invoca;
- rischio;
- whitelist sì/no.

---

# Prompt 1.1.c — Look-Ahead Bias / isH4Closed Falsification

Crea test `.ts` specifico per verificare se `isH4Closed` o logiche equivalenti possono essere falsificate rispetto al tempo reale.

Invarianti:

1. Se il tempo corrente è interno al blocco 4H, la candle 4H corrente non è chiusa.
2. Backtest e liveEngine devono usare la stessa regola di chiusura candle.
3. Nessuna funzione può usare `lastCandle.close` di timeframe superiore se quella candle non è chiusa.
4. Il merge 15m→1H/4H non può includere dati futuri.

Test richiesti:

- timestamp 08:00, 08:15, 08:30, 08:45, 09:00;
- timestamp 12:00 come boundary 4H;
- confronto funzione backtest vs liveEngine;
- caso timezone UTC/local.

Se non esiste `isH4Closed`, crea test sulla funzione equivalente che decide validità feature 4H.  
Report: prova concreta di PASS/FAIL con timestamp.

---

# Prompt 1.2 — RegimeLayer Deterministico

Crea test `.ts` per RegimeLayer con input sintetici e output attesi.

Invarianti:

1. Stesso input = stesso regime, sempre.
2. Dato insufficiente non può diventare `NORMAL` senza reason esplicita.
3. CHOP deve bloccare segnali operativi se la regola lo prevede.
4. CRASH/EUPHORIA devono avere priorità esplicita rispetto a NORMAL.
5. Regime globale BTC e regime locale altcoin devono avere matrice di priorità testabile.

Test minimi:

- input trend positivo stabile;
- input dump violento;
- input pump euphoria;
- input laterale/chop;
- array vuoto;
- NaN in feature;
- conflitto BTC CRASH / altcoin NORMAL.

Output: test file, esito, matrice regime attesa vs reale, fallback trovati, bug certi.

---

# Prompt 1.2.a — BTC Global vs Altcoin Local Regime Matrix

Crea test `.ts` con matrice deterministica BTC regime × altcoin regime.

Invarianti:

1. BTC CRASH non può essere ignorato da altcoin NORMAL senza regola esplicita.
2. Altcoin CRASH deve poter elevare rischio anche se BTC è NORMAL, se architettura lo prevede.
3. CHOP globale o locale deve avere effetto deterministico.
4. In caso di conflitto, deve esistere priorità testabile, non implicita.

Matrice minima:

```text
BTC NORMAL / ALT NORMAL
BTC CRASH / ALT NORMAL
BTC NORMAL / ALT CRASH
BTC EUPHORIA / ALT NORMAL
BTC NORMAL / ALT CHOP
BTC CHOP / ALT NORMAL
```

Per ogni riga testa:

- regime finale;
- setup consentiti;
- LONG consentito;
- SHORT consentito;
- reject reason se bloccato.

Non accettare spiegazioni senza test.  
Report: comportamento reale dedotto dal test e divergenza da regola attesa.

---

# Prompt 1.2.b — Regime Transition Test

Crea test `.ts` per transizioni di regime.

Invarianti:

1. NORMAL→CRASH richiede condizioni verificabili e non può oscillare a ogni candle.
2. CRASH→MEAN_REVERSION deve richiedere conferma o regola esplicita.
3. EUPHORIA→NORMAL non deve avvenire su un singolo rumore se esiste isteresi.
4. CHOP→operativo deve essere deterministico.
5. Cooldown e hysteresis devono essere testabili.

Dataset sintetici:

- 20 candele trend normale;
- 5 candele dump;
- 5 candele rimbalzo;
- 10 candele laterali;
- 5 candele pump.

Il test deve verificare sequenza regime attesa vs reale.  
Cerca variabili: `cooldown`, `hysteresis`, `transition`, `state`, `previousRegime`.

Report: transizioni instabili, stati mai raggiunti, fallback e rischio operativo.

---

# Prompt 1.3 — SignalLayer Deterministico

Crea test `.ts` per SignalLayer.

Invarianti:

1. SignalLayer produce solo `LONG`, `SHORT`, `NO_TRADE` o output equivalente.
2. SignalLayer non calcola position size, leva o ordine exchange.
3. In regime NORMAL, nessuno SHORT se questa è una regola di dominio attiva.
4. CHOP deve produrre `NO_TRADE` o reject se bloccante.
5. Segnali conflittuali devono avere priorità esplicita e testata.
6. Expectancy mancante non deve diventare consenso implicito.

Test minimi:

- NORMAL + setup long valido;
- NORMAL + setup short teorico;
- CHOP + segnale tecnico long;
- CRASH + segnale normal;
- trend LONG + contrarian SHORT;
- expectancy missing.

Output obbligatorio: test, esito, mappa input→output, bug certi, logiche non testabili.

---

# Prompt 1.3.a — RSI2_TREND_TRAILING Test

Crea test `.ts` specifico per RSI2_TREND_TRAILING.

Invarianti:

1. Il setup deve attivarsi solo nel regime previsto.
2. RSI2 non deve essere letto se non calcolabile.
3. Trend filter deve usare candle chiuse.
4. Trailing associato non deve essere deciso nel SignalLayer se appartiene a Risk/Exit.
5. In CHOP il setup deve essere bloccato se la regola lo prevede.
6. Nessuno SHORT in NORMAL se vietato.

Dataset minimi:

- trend pulito con pullback;
- laterale/chop;
- dump improvviso;
- dati insufficienti;
- RSI NaN;
- SMA/ATR mancanti.

Il test deve verificare output e reason.  
Se la funzione non è esportata, segnala “codice non testabile” e crea comunque test sul primo entrypoint pubblico raggiungibile.

---

# Prompt 1.3.b — MEAN_REVERSION / EXTREME Test

Crea test `.ts` per setup MEAN_REVERSION/EXTREME.

Invarianti:

1. MEAN_REVERSION deve attivarsi solo nei regimi consentiti.
2. Non deve competere con NORMAL senza priorità esplicita.
3. Non deve shortare un breakout vero se il filtro anti-trend lo vieta.
4. Deve gestire spike, wick e dati mancanti senza segnale falso.
5. Cooldown dopo stop/fallimento deve essere rispettato se previsto.

Test minimi:

- CRASH + oversold;
- EUPHORIA + overbought;
- NORMAL + falso extreme;
- breakout persistente;
- wick isolata;
- dati insufficienti.

Output: setup, regime, direzione, reason, test result, bug certi/probabili.

---

# Prompt 1.4 — ExpectancyTracker Test

Crea test `.ts` per ExpectancyTracker e matrice expectancy.

Invarianti:

1. Matrice mancante non può autorizzare trade senza regola esplicita.
2. Chiave assente deve generare reject, neutralità o comportamento testato.
3. Valore NaN/null non è edge valido.
4. Profit factor sotto soglia deve bloccare se filtro attivo.
5. Le chiavi runtime devono combaciare con chiavi backtest: regime, setup, asset, direzione, timeframe.

Test minimi:

- matrice valida;
- matrice vuota;
- file mancante;
- chiave assente;
- PF negativo/sotto soglia;
- expectancy NaN;
- mismatch nome setup.

Report: comportamento reale, fallback, rischi di filtro sempre-permissivo o sempre-bloccante.

---

# Prompt 1.5 — Test Integrato Area Strategy

Crea un test integration `.ts` che attraversi:

```text
MarketDataLayer → RegimeLayer → SignalLayer → ExpectancyTracker
```

Invarianti:

1. Dataset 15m chiuso genera feature coerenti.
2. Dataset incompleto non genera segnale operativo.
3. CHOP non passa come NORMAL.
4. Expectancy mancante non autorizza silenziosamente.
5. Nessun dato futuro cambia il segnale corrente.
6. Lo stesso dataset in modalità backtest e liveEngine produce stesso segnale.

Testa due scenari:

- scenario sano: trend normale con segnale atteso;
- scenario contaminato: candle 4H non chiusa, expectancy missing, fallback possibile.

Output finale: PASS/FAIL, prove, funzioni coinvolte, rischio operativo.

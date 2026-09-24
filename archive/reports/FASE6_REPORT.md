# FASE 6 - PULLBACK CONFERMATI BULL/BEAR

## 1. Condizioni Implementate

Nel motore `Normal Market Engine`, il parametro `FEATURE_FLAGS.ENABLE_CONFIRMED_PULLBACKS` espande i setup PULLBACK con requisiti molto stringenti per confermare la ripartenza del trend prima dell'ingresso.

**Per operazioni LONG (Regime BULL):**
- **Trend base 4H:** Prezzo > SMA200 4H
- **Inversione strutturale su 1H:** Prezzo > SMA50 1H (chiusura confermata o riconquista attiva)
- **Momentum di Ritorno:** `rsi1H > rsi1H_prev` (indicatore gira verso l'alto)
- **Conferma Price Action:** Close dell'ora corrente > High precedente
- **Volatilità / Rischio:** ATR 1H in contrazione o stabile (`atr1H <= atr1H_prev`)
- **Macro environment:** BTC *non* deve trovarsi in breakdown 1H.

**Per operazioni SHORT (Regime BEAR):**
- **Trend base 4H:** Prezzo < SMA200 4H
- **Inversione strutturale su 1H:** Prezzo < SMA50 1H (chiusura confermata o ritracciamento sotto ostacolo)
- **Momentum di Ritorno:** `rsi1H < rsi1H_prev` (indicatore gira verso il basso)
- **Conferma Price Action:** Close dell'ora corrente < Low precedente
- **Volatilità / Rischio:** ATR 1H in contrazione o stabile
- **Macro environment:** BTC *non* deve trovarsi in forte recupero.

## 2. Metriche Pullback (Prima e Dopo Fase 6)

| Metrica | Pre-Fase 6 (Flag OFF) | Post-Fase 6 (Flag ON / Rigido) |
| --- | --- | --- |
| **Normal Engine Trades** | 1,178 | 86 |
| **Normal Engine PnL** | +$21,692.72 | -$288.27 |
| **Normal Engine PF** | 2.05 | 0.74 |
| **Normal Engine Win Rate** | 38.9% | 27.9% |

### Statistiche dei Filtri di Blocco
Durante il backtest (dal 2021-01-01), abbiamo processato **44,000** situazioni candidate (RSI nel parametro idoneo), con la seguente profilazione:
- **Pullback Confermati Ammessi:** 486 (di cui molti invalidati successivamente dal Gatekeeper / Chop Filter)
- **Pullback Bloccati dalla Fase 6:** 43,514

## 3. Disamina Motivi Blocco

1. **Prezzo 1H sopra SMA50 (Short in BEAR):** 18,705 blocchi
2. **Prezzo 1H sotto SMA50 (Long in BULL):** 15,160 blocchi
3. **RSI non gira verso il basso:** 3,571 blocchi
4. **RSI non gira verso l'alto:** 2,989 blocchi
5. **Candela non chiude sotto Low precedente:** 1,393 blocchi
6. **Candela non chiude sopra High precedente:** 1,259 blocchi
7. **ATR in espansione contro posizione:** 382 blocchi
8. **BTC in forte recupero (Short impediti):** 38 blocchi
9. **BTC in breakdown (Long impediti):** 17 blocchi

## 4. Rischi di Filtrare Troppo

I risultati dimostrano palesemente il rischio dell'aggiunta "consequenziale" e stratificata di filtri in criptovalute:

1. **Causality Delay (Troppo lenti):** Aspettare che il prezzo chiuda sopra la SMA 50 in 1H assieme alla rottura dell'High precedente e il giro dell'RSI costringe l'algo ad entrare *dopo* che il vero movimento impulsivo rialzista è già esploso dai minimi del pullback. In sostanza stiamo entrando ad una debolezza del trend locale successiva al bounce effettivo.
2. **Mancanza Coda Grassa:** La baseline del Normal Engine aveva 1,178 trade capaci di cogliere con agilità spike di volatilità che facevano generare un grande numero di vittorie e compensavano i fallimenti per un Profit Factor totale di 2.05. Il nuovo approccio ha distrutto il PF precipitandolo a 0.74, dimostrando che i pullback migliori sono quelli dove il prezzo rimbalza **sotto** o **finge un breakdown** (coltello cadente breve) per poi recuperare vertiginosamente.
3. **Over-constraint vs Edge reale:** Le logiche Extreme continuano a dominare, indicando che la baseline, basandosi sulla regressione verso la media, era molto più adatta e matematicamente solida.

## 5. Dead Code Report

La divisione è avvenuta senza creare relitti di logica; il report del dead code `dead_code_report_fase6.txt` evidenzia solo costrutti dell'infrastruttura web/UI e vecchie funzioni sperimentali in `ml.ts`. Le flag condizionali sono disposte coerentemente e la pipeline `SignalContext` espone fluidamente l'oggetto `globalFeatures`.

# Audit Report: Macro-Area 1 (Core Analysis & Signal Generation)

## Prompt 1.1 — MarketDataLayer / Data Feed e Pre-Processing
**Flusso Reale:** Il sistema estrae array da `bars1H` e `bars4H`. Nel backtester vengono calcolati iterando sui tick 15m; nel `liveEngine` vengono prelevati direttamente da CCXT le candele 1h e 4h e passate al `prepareFeatures`.

**Anomalie Certe:**
- `features.price` subisce un'alterazione critica: in `prepareFeatures` è `lastC` (chiusura ultima candela). Ma nel `liveEngine.ts`, se ci sono `tickers[symbol].last`, viene sovrascritto col live tick. Questo disallinea lo snapshot: indicatori come `trend1H` rimangono agganciati al close passato, mentre `features.price` è in real-time, causando disallineamento temporale inter-ciclo.

**Anomalie Probabili:**
- `MathUtils.getATR` può fallire restituendo `null` se i dati in fetching dall'exchange sono insufficienti. Il fallback è un magico `lastC * 0.02`. In caso di API error parziale da parte di Kraken, il bot non va in errore ma inizia a calcolare sizing ipotizzando una volatilità finta del 2%, mettendo a rischio il capitale (Silent Failure).

**Test Suggeriti:**
- Integrare un test dove l'API restituisce 10 candele (sotto i 14 necessari) per simulare failure e verificare se i filtri bloccano invece di inventare dati.

---

## Prompt 1.1.a — Calcolo Indicatori RSI/SMA/ATR/ADX
**Logiche Identificate:** 
- `RSI` utilizza uno standard smoothing di Wilder calcolando i gain/losses medi.
- `ADX` è calcolato manualmente con smoothing `period * minusDM`.

**Punti Fragili & Anomalie:**
- In caso di array corti (`length <= period`), `getRSI` restituisce `null`. In `MarketDataLayer`, il fallback `|| 50` è presente in quasi tutti i calcoli RSI. Rischio strategico: il bot interpreterà un network failure prolungato o missing data come "Mercato a range", inattivando protezioni di trend o forzando Normal signals erroneamente.

---

## Prompt 1.1.b / 1.1.c — Allineamento e Look-Ahead Bias
**Flusso di Allineamento:**
- `isH4Closed`: Nel backtest è valutata correttamente ogni volta che i minuti rintoccano al target 4H (`h4Closed = (hour % 4 === 3 && min === 45)` o simili logiche).
- **CRITICITÀ SEVERA:** Nel `liveEngine.ts`, alla riga in cui prepara i features dei vari coin:
  `const features = MarketDataLayer.prepareFeatures(validSym1H, validSym4H, true);`
  Il flag `isH4Closed` è **sempre forzato a true**.
- **Effetto:** `SignalLayer` per l'engine NORMAL usa `if (!features.isH4Closed) return NONE`. Essendo sempre a `true` in live, i trade Normal vengono triggerati su *ogni* iterazione del `liveEngine` (potenzialmente ogni 1H), non rispettando la regola che limita gli execution alle sole 4H boundaries del backtest. Mismatch profondo Backtest vs Live.

---

## Prompt 1.2 — RegimeLayer / Classificazione Regime
**Logica Reale:** Il regime smista su `CRASH`/`EUPHORIA`/`TRANSITION` se c'è un'esplosione di volZScore (>3.0) o volPct (>4.5%). Altrimenti decodifica in `BULL`/`BEAR`/`TRANSITION` via `trend4H` e `distFromSMA`.

**Anomalie:**
- **Sovrapposizione logica del Choppiness:** In `MarketDataLayer` viene calcolato un check `isChop` strettissimo (RSI 42-58, VolZscore limitato e nearSMA). In `RegimeLayer` abbiamo uno stato `TRANSITION` di mercato laterale. Nel `Gatekeeper`, `isChop` blocca il Normal Engine. Ma se i due filtri discordano, si entra in stati misti.

---

## Prompt 1.2.a — BTC Global Regime vs Altcoin Local Regime
**Bug Architetturale Rilevato (Dead Code & Mismatch):**
In `SignalLayer.evaluate`:
```typescript
const isGlobalExtreme = btcRegime === "CRASH" || btcRegime === "EUPHORIA";
const isLocalExtreme = regime === "CRASH" || regime === "EUPHORIA";

if (isLocalExtreme) {
   // Usa Extreme setup
```
- Il commento recita: "If local is TRANSITION [...] but BTC is EXTREME, allow the coin to be checked for EXTREME setups". Ma la variabile `isGlobalExtreme` viene definita e **mai usata** per mutare la condizione! Il motore Extreme viene valutato *solo* se l'asset locamente è `isLocalExtreme`. Un asset verrà escluso dal regime globalmente collassato, comportandosi contrariamente alle specifiche d'autore.

---

## Prompt 1.3 — SignalLayer / Generazione Segnali Operativi
**Invarianti e Anomalie:**
- Come richiesto, l'invariante vuole che non ci sia contrarian-trend e che i due engine (Extreme, Normal) non cozzino. Questo invariant *è rispettato* in quanto `SignalLayer` processa EXTREME per primo, e se triggerato (poiché localizzato su Crash/Euphoria) non avvierà NORMAL, grazie agli exit early e al filtro di "subRegimes" (Normal è permesso solo in `BULL`).
- `NormalRsi2TrendTrailingConfig`: Prevede il long solo con `rsiLongThreshold < 10`.

---

## Prompt 1.4 — ExpectancyTracker / Matrix
**Caricamento e Fallback:** La matrice viene interrogata per capire se il pattern storicamente è profittevole (Profit Factor e Expectancy).
**Anomalia e Rischio:**
- Se per qualsiasi motivo l'`Expectancy Tracker` manca dei dati per quel target (chiamando il fallback su "INSUFFICIENT_DATA"), il `Gatekeeper` accetterà regolarmente il trade dimezzando la size (`riskModifier: 0.5`). Essendo un modello permissivo, in caso il file DB dell'expectancy non venisse letto correttamente via startup, l'intero bot attiverà tutti i trade a rischio mitigato ma pur sempre operativi, distruggendo la validità del filtro di expectancy.

---

## Riepilogo Priorità ed Azioni di Fixing (Test e Correzioni)

1. **Risolvere forzatura H4Closed (Priorità Critica):** Legare la logica nel `liveEngine` alla corretta identificazione del superamento di un limite da 4h reali. (es: `const isH4Closed = (new Date(validSym4H.last_t).getHours() % 4 === 0)`)
2. **Implementare isGlobalExtreme (Priorità Alta):** Modificare `architecture.ts` integrando `isGlobalExtreme` nella condizione di avvio dell'engine `generateExtremeSignals(context)` per sfruttare correttamente i trigger macro-economici.
3. **Isolare features.price nei layers (Priorità Media):** Non sovrascrivere `features.price` del `MarketDataLayer` per usarla come tracking posticcio di Live Tick in `liveEngine.ts`. In liveEngine, bisogna mantenere il features per i segnali, e passare il live tick separatamente per size execution.
4. **Rimozione del Fallback 50 per RSI (Priorità Media):** Lanciare Error bloccanti quando un array è vuoto per far si che la candela sia ignorata da `MarketData` e `liveEngine` attenda il prossimo batch.

# OMNIA - Architettura Trading & Gestione del Rischio (Release Stabile)

Questo documento traccia l'intera architettura OMNIA v2, riflettendo accuratamente l'effettiva implementazione testata, logica e risolta dalle incongruenze precedenti.

---

## 1. Architettura dei Regimi di Mercato (Market Regimes)

Il sistema utilizza indicatori macro (SMA 200 su base 4H, deviazione percentuale e Z-Score della volatilità) per mappare lo "stato" del mercato. Vi sono categorizzazioni principali e un filtro overlay.

### 1.1 CRASH (Crollo Estremo)
- **Definizione:** Distanza del prezzo dalla SMA 200 (4H) `< -0.25` oppure contrazione violenta data da esplosione di volatilità (VolPct > 4.5 o Z-Score > 3.0 accompagnata da calo sotto la SMA 50).
- **Azione:** Abilita **esclusivamente** operatività Extreme Long (Mean Reversion) a leva potenziata, scommettendo sul rimbalzo dopo l'esaurimento della spinta ribassista (RSI_1H < 20).

### 1.2 EUPHORIA (Parabola Ascendente)
- **Definizione:** L'opposto speculare, segna la fine di bull-run estenuanti (Distanza SMA 200 > 0.25 o gap volatilità improvviso in trend maturo). 
- **Azione:** Abilita **esclusivamente** operatività Extreme Short (Mean Reversion), per catturare il flash-crash di "blow-off top" post estasi (RSI_1H > 80).

### 1.3 BULL (Fase Toro)
- **Definizione:** Trend stabile (Prezzo > SMA 200_4H) con oscillazione non da bolla (Distanza < 0.25).
- **Azione:** Attiva i setup del motore **NORMAL**. Vengono acquistati i micro-ritracciamenti con filtri RSI (RSI_2_4H < 10) e incroci validi (EMA 50 / 200). Le logiche *Short* sono severamente precluse.

### 1.4 BEAR (Fase Orso) e TRANSITION (Fase Neutra/Incertezza)
- **BEAR:** Trend lungo termine invertito, distanza non fatale (> -0.25). Motori base spenti per evadere death-spirals. Eventuali pullback liquidati.
- **TRANSITION:** Cambi improvvisi e non confermati (pullback massivi in BULL confermati da RSI basso, o rimbalzi gatti morti in BEAR).
- **Azione Limitante:** La dogana (GateKeeper) boccia qualunque setup non ad altissima qualità / estrema garanzia.

### 1.5 L'Overlay CHOP (Mercato Laterale)
- **Definizione:** RSI 1H fermo nel limbo neutrale [42, 58], Volatilità crollata (Z-Score < -0.5), distanze minime dalle medie < 2%. Il mercato è fermo.
- **Trattamento (Corretto):** Attualmente calcolato in tempo reale, CHOP funge da overlay che **sanziona le entrate Extreme**. Se un segnale Mean-Reversion scatta in CHOP senza qualità `>= 0.8`, viene negato (`BLOCKED_BY_CHOP`). Se passa, la size del capitale investito subisce un brutale taglio del 50%. *Il setup Normal (che in teoria ama gli swing ristretti) prosegue basandosi sui suoi filtri*.

---

## 2. Trading Engines (I Motori Primari)

### 2.1 EXTREME Engine (Assorbitore di Shock)
Gira imperativamente alle due estremità. Re-immette a mercato capitale per "rubare" i pullback rapidi durante CRASH/EUPHORIA. Cerca stoccate repentine (RSI 1H < 20 per Buy, o > 80 per Sell). 

### 2.2 NORMAL Engine (Inseguitore dei Trend)
Valutato **rigorosamente in chiusura candela 4H**. Analizza se il BULL è sano. L'unico trade armato è il LONG al rientro da ipervenduto estremo (RSI a 2 step < 10), incrociando i trend EMA 50 su 200.

---

## 3. Gestione Uscite e Trailing Stop: La Barriera Integrata

I motori rispondono a difese di rischio differenti calcolate per la loro natura. Sono state separate rigidamente le uscite dell'Extreme da quelle del Normal per ottimizzare e pulire le statistiche.

1. **La Gestione Esclusiva NORMAL (Trailing Stop Puro):**
   Il NormalRsi2TrendTrailingEngine è stato isolato dalle altre influenze. **Non possiede** decay, stop-loss iniziali complessi, parzializzazioni, o uscite d'emergenza alternative. Si affida storicamente ed esclusivamente al tracking continuo via Trailing Stop (percentuale reale del 2%).
2. **Lo Stop Loss Preciso (Adaptive & Trailing) per l'Extreme:**
   Inizializza a `3.5 ATR`, per poi stringersi a seconda della volatilità e del draw-down (`8%` in Euphoria/Crash compresso dal rapporto leva applicato, per non strozzare i respiri fisiologici).
3. **Il Guardiano "Catastrophe Stop" per L'Extreme (-15% / +15% per flash crash):** 
   Implementato come garanzia matematica solo per i trade Extreme (non-Normal), sigilla gli scostamenti mostruosi a fronte di gap di mercato e buchi per preservare il portafoglio.
4. **Decadimento del Vantaggio (Progressive Edge Decay) per L'Extreme:** 
   Solo per i setup *Extreme*, le uscite sfumate agiscono tempestivamente: se l'apertura non performa un rapido rimbalzo (e.g. MFE < 0.5R in 8 candele orarie), il sistema auto-stringe drasticamente lo stop limitando le perdite o chiudendo la trade via early decay time-limit.
5. **Take Profit Parziale (Harvesting) su L'Extreme:**
   L'operatività base tenta di escludere l'Harvest sui Normal ma interviene incamerando proattivamente il volume dei profili derivanti dai picchi improvvisi Extreme senza aspettare le candele intere in chiusura.
6. **Emergenza Regime Cambio:** Tagli netti da BULL->CRASH forzati senza guardare the loss pnl, e così dall'altro lato, limitando bias invecchiati rispetto la macro.


---

## 4. Gestione Size & Leva Matematica ("Tiers")

- **Exteme_Clean (Fattore 1.5x / Max):** Durante i CRASH sani dove non si rilevano gap di mercato (gap < 60 min), il volume aumenta potenziandosi `fino a Leva 5.0x` (alloc. portafoglio reale fino al 10%) per approfittare del bottom effimero. Richiede "Expectanza > 1.30" dal Database e Allineamento BTC.
- **Normal_Base e Downgraded:** Base al 5%, segati d'ufficio al 3% qualora l'Expectancy test ritorni esito storico incerto (P.F. < 1.0).
- **Ruin Prevention Hard Check:** Un global "drawdown tracker" decurterà della metà l'investimento d'istanza generale (Survival Mode) in caso l'account crollasse cumulativamente oltre il 15%. A livello d'Apocalisse (crollo >25%), l'algoritmo sventa qualunque autorizzazione d'apertura `isHalted: true`. OMNIA non brucia interamente fondi.

---
*Documento di Release Stabile post-bugfix: Il NORMAL ENGINE (RSI2 Trend Trailing) è stato purificato e limitato esclusivamente al setup LONG tramite strict Trailing Stop senza interferenze di decadimento. Tutte le incoerenze tra report (PnL negativo del Normal short side) e logiche architetturali sono risolte e verificate dal backtest reale completo 2021-2026, con le label e output matematicamente integrati (Invariants PASS).*

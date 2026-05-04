# OMNIA - Architettura Trading & Gestione del Rischio

Questo documento descrive dettagliatamente la logica operativa, gli algoritmi di execution e le regole di risk management implementate nell'architettura OMNIA v2.

---

## 1. Architettura dei Regimi di Mercato (Market Regimes)

Il sistema utilizza un modello ispirato alle Catene Nascoste di Markov (HMM) calcolato tramite proxy di prezzo, volatilità (distanza dalla SMA 200) e Z-Score di volatilità. Il mercato viene classificato in sei regimi principali:

### 1.1 CRASH (Crollo Estremo)
- **Definizione:** Distanza del prezzo dalla SMA 200 su base 4H pesantemente negativa (`< -0.25`) oppure un drop rapido e improvviso innescato da anomalie di volatilità.
- **Trigger Aggiuntivo:** Volatilità esplosiva (`VolPct > 4.5` o `Vol Z-score > 3.0`) accompagnata da un calo al di sotto della media mobile (`< -0.1`).
- **Scopo:** Sfruttare rimbalzi violenti tramite mean-reversion (Long).

### 1.2 EUPHORIA (Parabola Ascendente)
- **Definizione:** L'esatto opposto del CRASH. Prezzo ampiamente esteso rispetto alla SMA 200 (distanza `> 0.25`).
- **Trigger Aggiuntivo:** Volatilità esplosiva abbinata a prezzi molto al di sopra della media (`> 0.15`).
- **Scopo:** Sfruttare lo sgonfiamento fisiologico di un "blow-off top" tramite mean-reversion (Short).

### 1.3 BULL (Fase Toro)
- **Definizione:** Trend stabile di medio/lungo periodo (Prezzo > SMA 200 4H) con condizioni "ordinarie" di volatilità e distanza moderata dalla media (`< 0.25`).
- **Scopo:** Cavalcare i micro-ritracciamenti o continuation pattern del trend principale (solo Long).

### 1.4 BEAR (Fase Orso)
- **Definizione:** Trend ribassista stabile (Prezzo < SMA 200 4H) con distanza non critica in negativo (`> -0.25`).
- **Scopo:** (Attualmente disabilitato per il motore NORMAL) Evitare knife-catching e prevenire drawdown strutturali del portafoglio during long bleeds.

### 1.5 TRANSITION (Inversione e Incertezza)
- **Definizione:** Zone grigie dove avvengono pullback drastici e prolungati in un BULL market (es. RSI 1H < 40 e trend 1H invertito) o rally di sollievo in un BEAR market (RSI 1H > 60 e trend 1H positivo). Può scaturire anche da spike anomali di volatilità vicino alla SMA 200.
- **Scopo:** Il sistema **blocca preventivamente la stragrande maggioranza dei setup**. Gli entry point richiedono una qualità ("Signal Quality") altissima (`>= 0.8`) per essere presi. Riduzione estrema dell'esposizione e leva ridotta a 1x (salvo filtri Expectancy).

### 1.6 CHOP (Lateralità Compressa) - *OVERLAY*
- **Definizione:** Filtro di "rumore". Scatta contemporaneamente quando:
  1. RSI orario stagnante e compresso tra `42` e `58`.
  2. Volatilità azzerata (`Z-score Vol < -0.5`).
  3. Prezzo compresso ed estasiato vicinissimo alla SMA 50 oraria (`Distanza < 2%`).
- **Gestione:** Disattiva (blocca) la maggior parte degli entry e penalizza le size nel caso in cui una logica di base decida lo stesso di operare. Il motore EXTREME in CHOP viaggia massimo a mezza forza (risk multiplier 50%).

---

## 2. Motori di Trading Principali (Trading Engines)

I segnali di trading nascono dall'interazione tra i segnali e il contorno macro-strutturale (Regime). Il sistema divide il carico in 2 propulsori logicamente separati:

### 2.1 EXTREME Engine (Anti-Trend & Shock absorber)
Questo motore opera escluvisamente durante i crolli (CRASH) o bolle furiose (EUPHORIA).
Lavora con logiche di *Mean Reversion* strette:
- **Caso CRASH:** Cerca l'esaurimento della spinta. Viene triggerato un "LONG Mean Reversion" se RSI 1H precipita **sotto 20** abbinata al macro-regime Crash.
- **Caso EUPHORIA:** Cerca il top del candelone finale (blow-off top). Viene triggerato uno "SHORT Mean Reversion" se RSI 1H sfora al rialzo il limite di **80**.

### 2.2 NORMAL Engine (Filtri RSI2 Trend Trailing)
Questo motore si avvia in mercati sani: è abilitato unicamente a girare nel **BULL Regime** ed ha attualmente disabilitati gli script "Short".
- **Trigger Point:** Viene valutato solo alla chiusura della candela 4-Hour (evita falsi spike intraday).
- **Logica (LONG Base):**
  1. Media Veloce (EMA 50_4H) superata in rialzo sulla Lenta (EMA 200_4H).
  2. Il Prezzo deve essere sopra la Lenta (EMA 200_4H).
  3. Si acquista il micro-ritracciamento usando il momentum sensibile: **RSI_2_4H < 10**.

---

## 3. Il Gatekeeper e Filtri (Entry Logic)

Prima che un segnale diventi un ordine reale, passa dalla dogana che applica molteplici vincoli:
1. **Overextension Guard:** Blocca l'apertura ritardataria di posizioni Long con RSI orario `> 75` o Short con RSI `< 25`.
2. **Quality & Regime Match:** Non si compra nulla senza logica Extreme durante i CRASH. Non si shorta in EUPHORIA senza pattern Mean Reversion. Nessun salto nel vuoto in TRANSITION.
3. **Expectancy Tracker Matrix (Fase Storica):** Analizza le performance matematiche dello storico per la combinazione (Simbolo + Setup + Regime). Se dal backtest l'Aspettativa (Expectancy) è negativa ed il Profit Factor (PF) `< 1.0`, il trade viene *DISABILITATO*. Se mancano dati storici o se il PF sfiora il limite di breakeven passabile (`< 1.1`), la dimensione (Exposure) **viene tagliata al 50%**.

---

## 4. Gestione della Posizione (Exit Strategies)

OMNIA protegge il capitale una volta immesso a mercato secondo regole difensive e adattative, declinate tra chiusure parziali e chiusure totali protettive.

### 4.1 Stop Loss e Catastrophe Stop (Stop Loss di Innesco)
- **Hard Initial Stop Loss:** Viene fissato a **3.5x l'ATR orario** di base per l'Extreme Engine. Per il Normal l'ampiezza è dinamicamente proporzionale all'1% di tracciamento o fissata matematicamente dal rischio di partenza.
- **Catastrophe Stop:** Protegge in hard mode dai collassi flash ("Cigno Nero" / gap non visti su timeframes corti). Fissato fisicamente al `-15%` per i Long e `+15%` per gli Short, a garanzia del worst-case absolute scenario.

### 4.2 Adaptive Trailing Stop (Trailing Stop Dinamico)
Adegua l'ancoraggio proporzionalmente all'High Water Mark (HWM) calcolato.
- **Normal Engine:** Il trailing stop usa una distanza strettissima (`1%`), inseguendo e "sewing" il rally di pullback molto aggressivamente.
- **Extreme Engine:** La percentuale di trailing dipende dalla volatilità ed è adattata anche alla potenza scalata della Leva utilizzata:
  - Base `4%` nei normali cicli (se venisse autorizzato).
  - Volatilità pura (`CRASH`/`EUPHORIA`) settato all' `8%` netto ma viene compresso (diviso) in maniera inversamente proporzionale per via della leva spinta, consentendo stop "percepiti" e respiro a conto in sicurezza.

### 4.3 Progressive Edge Decay (Decadimento Vantaggio Temporale)
I mercati prezzano in "N" candele un evento. Se tale evento non produce effetti nei tempi dettati, il vantaggio probabilistico (edge) marcisce e cade in logica "EDGE_DECAY".
- **Extreme Config:** Se i risultati dopo `8 candele orarie` non manifestano almeno un gain parziale atteso (MFE `R < 0.5`), OMNIA alza preventivamente (o abbassa per lo short) brutalmente il limit Risk al **50% del livello di inserimento**, consolidando il dimezzamento preventivo delle perdite. Chiusura Hard automatica dell'operazione per no-show (tempo morto) dopo **`16 candele`** di immobilismo o rimbalzo mancato (se R `< 1.0`).
- **Normal Config (Meno Aggressivo):** Check flessibile iniziale controllato a `12 ore`. Taglio rischio in corsa portandolo un filo più prudente (`25% risk-off` alias conserva il 75%). Uscita obbligata forzata a **`24 ore`** senza trazione.
- **Morte Tardiva (Classical Edge Decay):** Tutti i trade, se sopravvissuti per inerzia al time decay early, vengono epurati d'ufficio dal book passato il muro delle `48 ore` consecutive di ritenzione insoddisfatta (sia in loss, pre-breakeven, etc).

### 4.4 Regime Shift Derisking (Chiusura Prevenzionale Strutturale)
Chiusure secche a mercato prescindendo dal trend. Se il motore ha acquistato validamente sotto regole BULL, ma all'interno della stessa vita del trade le metriche shiftano clamorosamente portando le statistiche nel box `CRASH`, il sistema "liquida a vista" lo schema non curante del PnL del trade, eliminando il potenziale buco nero probabilistico. Stessa logica per `BEAR` che transiziona verso spike `EUPHORIA`.

### 4.5 Partial Take Profit / Harvesting (In Fase Riservata)
Attualmente predisposta per i setup dell'Extreme o Normal (se attiva): chiusura forzatamente in automatico del **`50% della size originaria`** ad un traguardo di gain pari a `1.5` volte il Rischio (`1.5 R`).
Lo scattare della soglia produce anche l'ordine di blindare il restante dei volumi alzando di forza lo Stop Loss al Break Even (`+0.1%` o `-0.1%`).

### 4.6 Overextension Exits (Exit Cautelativo)
Se un segnale scappa fortissimamente in anticipo sulla media mobile: un Long che porta improvvisamente l'RSI_1H `> 80` garantendo al tempo stesso uno sbalzo del PnL del tradeoff `> 5%` in netto rialzo dal entry viene "venduto prima dell'ingaggio del trailing logico ordinario" per cristallizzare l'inefficenza esposta (stessa casistica a rovescio pre Shorts under `RSI < 20`).

---

## 5. Rischio ed Esposizione Globale (Risk & Capital Management)

OMNIA è costruito su un risk engine denominato Tiers Management. La size investita ("exposure") fluttua assecondando la stima di sicurezza dell'Execution Layer.

### 5.1 Livelli di Esposizione e Rischio (Tiers)
- **EXTREME_CLEAN (Tier Agonistico):** Assenza limitata di gap di mercato (dati stabili, timeout server ok `<60m`) in un CRASH o EUPHORIA trade regala il base sizing più alto, consentito fino al `10%` per operazione.
- **EXTREME_FALLBACK (Tier Sicurezza Dati):** Se subentra buco di API server o instabilità passata i 60m di delay, la size passa in Fallback Mode cadendo al limite del `5%`.
- **NORMAL_UPGRADED (Trend Sicuro):** Setup del Normal Engine che beneficiano di un Profit Factor storico certificato di almeno `1.20`. Alza la size base per quel trade da `5%` al `7%`.
- **NORMAL_BASE/NORMAL_DOWNGRADED:** Rischio base al `5%`. Degradato secco al `3%` nei pattern in cui il mercato si appresta a sfiorare limiti matematici inefficaci (Profit Factor storico misurato al backtest `< 1.0`).
- **TRANSITION_BLOCKED:** L'allocazione passa da qualsivoglia target a `0%` nei momenti confessionali dove il Regime scivola ad intermezzi ambivalenti (Transition Time/Rally Bear fallaci).

### 5.2 Quality Gated Leverage (Struttura della Leva Dinamica Estrema)
OMNIA scala la leva non solo tramite asset, ma su base probabilistica (Expectancy & Quality):
La Leva Base di "tutti i giorni" del comparto si posiziona a **`2.0x`**.
- La stragrande maggioranza degli scenari CRASH / EUPHORIA riceve da sistema un boost dimensionale moltiplicando di `1.5x` l'allocazione volumetrica, posizionandosi matematicamente (come prima scelta) verso un traguardo dimensionato in Leva `5.0x`.
- **Filter Guard Leva 5x:** Viene approvata un'uscita a mercato con **Leva 5.0x** solo ed esclusivamente se il "Signal Quality" è altissimo (`>= 0.9`), che l'expectancy test dia l'ok su Performance/Bouncing positivi al calcolo (`Expectancy > 0`, `Profit Factor >= 1.30`) e le micro trendline globali e di regime di validazione di "BTC" confermano il senso di marcia a macro-livello, in presenza di un mercato con spread/spikes non anomali (Volatilità `Z-score < 4.0`).
- **Downgrade a 3.x / 2.x:** Se uno di questi check super-protettivi non passa, l'allocazione scende al tier aggressivo base (Leva 3.0x -> Leva 2.0x).

### 5.3 Account Hard Stops and Ruin Prevention (Capital Capacity)
Il sistema effettua scansioni permanenti calcolando il DD (Drawdown dal Maximum Equity "High Water Mark" mai vista in account).
- **Survival Capacity (Loss > 15%):** Rilevata una perdita cumulata da portafogli pesanti globali (superiore al -15%), OMNIA innesta la *Survival Mode* de-potenziando del **50% l'intero volume operativo consentito per trade**, per rallentare il bleed assecondando la flessione globale e prevenire l'asfissia patrimoniale.
- **System Halted (Loss > 25%):** Al collasso al `25%` (mai occorso under base conditions) il sistema azzera del tutti i multiplicatori allocativi (`0%`). Fine delle emissioni per fallimento algoritmico del sistema di frontiera.

---
*Ultimo aggiornamento architettura: Fase 11 - Normal/Extreme Refactoring.*

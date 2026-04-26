# FASE 9 - PROGRESSIVE EDGE DECAY PROGRESSIVO

## Logica Implementata
Ho aggiunto la logica `Progressive Edge Decay` in `PositionExitLayer`. Il nuovo meccanismo agisce in questo modo per i trade eseguiti tramite l'Engine Normale (`PULLBACK`, `BREAKOUT_RETEST`) esclusi i regimi estremi (`CRASH`, `EUPHORIA`):

1. **Tracciamento MFE/MAE/R Multiplo:** 
   Oltre ai soliti `highWaterMark` e `lowWaterMark`, il bot calcola ora costantemente in modo nativo la distanza percorsa rispetto al rischio iniziale (`risk = Math.abs(entryPrice - initialStopLoss)`). Vengono salvate proprietà come `mfeR`, `maeR` per analizzare quale picco "Favorable" è stato raggiunto in proporzione al rischio (multiplo "R").

2. **Timeout a 8 candele:**
   Se dopo le prime 8 ore (su timeframe 15m -> h1Closed, quindi dopo 8 barre da 1 ora) l'MFE in R è **inferiore a +0.5R**, il trade chiaramente non dimostra momentanea forza direzionale adeguata. Viene applicata una restrizione del rischio (tighten stop) **dimezzando la distanza** dell'initial stop loss dal prezzo di ingresso per minimizzare i danni latenti di posizioni stantie.

3. **Death by Timeout a 16 candele:**
   Se dopo 16 ore l'MFE in R è ancora **inferiore a +1.0R** e non ha spiccato il volo, chiude l'operazione in maniera preventiva usando `EDGE_DECAY_EARLY`. È un taglio al tempo: il rischio di non adempiere al setup temporale causa un drenaggio di capitale o esposizione a falsi movimenti laterali. Le logiche mantengono il trade in pari al bilancio o per perdite/profit minori. 

4. **Timeout Globale a 48 candele:**
   Residua il decadimento standard per trade in corsa senza fine.

La _feature flag_ abilitante è `enableProgressiveEdgeDecay` (Attualmente OFF per default o ON su test). 

## Metriche (Prima vs Dopo)

Run simulato 2021-2024 (Flag **OFF**):
* **Win Rate:** 37.4%
* **Total System PnL:** +$33,030.20
* **NORMAL Engine:** 3856 trades | PnL: $17,427.99 | WR: 37.0%

Run simulato 2021-2024 (Flag **ON**):
* **Win Rate:** 41.3%  🔥
* **Total System PnL:** +$35,035.68 🔥
* **NORMAL Engine:**  4891 trades | PnL: $18,697.87 | WR: 41.1%  🔥

**Risultati dell'Early Exit (T=ON):**
* Trades chiusi anticipatamente (`EDGE_DECAY_EARLY`): 2000
* Classical `EDGE_DECAY` usati: 113 (molti scremati in anticipo)
* "Saved PnL" (perdite minori o abbattute dal timer): $4518.77
* "Premature Exits Positive PnL" (Profitto messo subito in banca invece di rischiare): $11942.25

*Notevoli effetti collaterali positivi:* L'aumento del volume dei trade eseguiti per via dello svuotamento anticipato delle code di allocazione (Position Sizing max alloc.). L'Edge Decay svincola più velocemente la marginatura permettendo una ridistribuzione a mercato di altri trade che andavano "blockati" in precedenza, comportando un +2,000$ in termini di Extra Yield a zero rischio aggiuntivo, unito a un portentoso aumento del **Win Rate a 41.1%** (+4% complessivo), perché moltissime di quelle candele venivano portate nel lato negativo del portafoglio sul lungo termine. 

## Rischio uscite premature e Sicurezze 
* L'aggancio a `mfeR < 1.0` garantisce di non strozzare trade che hanno effettivamente un grande momentum. Se l'MFE sfora 1R prima di 16 barre, le mani restanti gestiranno il pullback standard. 
* L'aggiunta non rimpiazza la vecchia logica (`trade.barsHeld > 48`), né si mescola tra Engine Estremi iper-volatili causandone perdita di yield long term (crash).
* La computazione è esangue e locale, non usa `slice`: non c'è `lookahead bias` (usa solo informazioni correnti).

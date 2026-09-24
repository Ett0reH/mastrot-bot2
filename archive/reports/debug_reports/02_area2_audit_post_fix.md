# AREA 2 - Audit & Debug Report (Post-Modifiche)

## 1. Mappa Reale dei Flussi
1. **GatekeeperLayer**: Riceve il segnale e applica un Quality Gate stretto (Quality >= 0.5 o Rifiuto). Se in Chop regime, non si fida più ciecamente di "NORMAL" e verifica lo standard expectation. Se è Extreme, controlla l'ExpectancyTracker.
2. **RiskLayer**: Applica Size allocando `Capital * Risk * Leverage`.
    - `targetAlloc` viene scalato in base a `signal.quality` **PRIMA** di subire il fallback al Hard Cap (80% account). 
    - Il `catastropheStopLoss` (Native Fallback) è reso dinamico e calcolato proporzionalmente alla leva. Assicura che un trade a Leva 5 chiuda catastroficamente al -3% (fisico) o -15% (leva virtuale) per proteggere il margin limit dell'exchange bloccando liquidazioni premature.
    - Sconta un Safety Capping in Leva se l'`expectedRiskPct` del normal SL sfora i margini tollerati dalla clearinghouse (15% Max Physical Move su Leva = Margin Call limit).
3. **CapitalManagementLayer / liveEngine**: 
    - L'esposizione globale `MAX_GLOBAL_EXPOSURE` scala al `max(50_000, 2.5 * account_balance)`.
    - Controlla se il `baseBalance` decresce in assenza di perdite: questo pattern viene interpretato come prelievo cliente, scattando immediatamente uno scale-down metrico sull'`maxHistoricalEquity` proporzionale al drop out. Questo blocca i falsi-positivi del Drawdown Terminator che freezerebbero il motore su prelievi ingenti.

## 2. Anomalie Certe (Pre-Fix Risolte)
- **NORMAL Engine Bypass su Expectancy e Chop**: Venivano scavalcati i filter. **[GIA' FIXATO PRECEDENTEMENTE]**
- **Sizing Incompleto e Capping Inverso**: La `signal.quality` decurtava size anche se l'allocazione base sfondava il cap massimo. Ora pre-scale, then cap. **[RISOLTO]**
- **Catastrophe Liquidator in Margin Call**: Le leve 3x o 5x con Catastrophe a 15% fisico esponevano la position a un 75% margin usage, finendo flaggati da Kraken. **[RISOLTO, CATASTROPHE SCALA SOTTO LEVA (Max 15% drop Equity Reale indotto dalla loss position)]**
- **Trailing Override Mismatch**: La conversione da ATR a SL Percentuale nel Normal produceva stop ravvicinati errati. **[RISOLTO col Math.max tra ATR in % e TrailPct parametrico]**.
- **Withdrawal Drawdown Suicide Halt**: Il portafoglio segnava System_Halted irreversibile dopo prelievi > 20% dei fondi liberi. **[RISOLTO, High-Water Mark Tracker Scala all'istante su detection baseBalance delta]**.
- **Global Exposure Limitato a $50k Assoluti**: Fissato in modo scalabile. **[RISOLTO]**.

## 3. Anomalie Probabili (Da Attenzionare in Area 3 / Edge Cases)
- **Multiple Withdrawals**: Se l'estrazione non sfonda la tolleranza `0.99` o arriva a piccoli rate-batch, non scatterebbe lo shrink. Ritenuto accettabile.
- **Slippage del Catastrophe**: Durante flash-crash o scaps di tick asincroni l'ordinativo market su execution StopLoss / Catastrophe potrebbe avere una price execution di -0.5% peggiorata causa liquidity void in orderbook.

## 4. Test Consigliati
- **Test Liquidazione Scaling Leva**: Mockare trade con Leva 5x dove il pre-calcolato SL sarebbe distanziato del 4%. Verificare l'Auto-Derisk della Leva se eccedente.
- **Test Withdrawal Drawdown**: Aprire test e prelevare (mock) $3000 dal `realMargin`, constatare che l'engine prosegua ad operare.

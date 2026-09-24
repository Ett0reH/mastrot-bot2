# FASE 7 REPORT: BREAKOUT + RETEST SETUP

## 1. Obiettivo Raggiunto
È stato introdotto un nuovo setup conservativo chiamato `BREAKOUT_RETEST` in sostituzione del vecchio meccanismo di `CONTINUATION` "grezzo", il quale acquistava setup in iper-estensione locali ed era stato disabilitato nei round precedenti.

Il nuovo setup è attualmente dietro un feature flag `ENABLE_BREAKOUT_RETEST` (di default `false`). 

## 2. Condizioni Implementate nel Normal Market Engine
La logica monitora i massimi e minimi per le 20 candele antecedenti le ultime 5. Nelle ultime 5 candele, verifica se è avvenuta una reale rottura tecnica seguita da un tocco (retest).

**Condizioni LONG:**
- Rottura in close sopra il recente Maximum Range (N=20).
- Un recente minimo (`l <= resistance + atr * 0.5` ma `l >= resistance - atr*1.5`) che confermi un retest strutturale.
- Chiusura corrente sopra la resistenza (livello tenuto).
- Candela corrente di forza (`Close > Open`).
- Prezzo attuale sopra la SMA50 oraria.
- Regime in stato `BULL` o `TRANSITION`.
- Volatilità Z-Score < 1.5 (esclusione spike tossici).
- Supporto regime BTC orario trend bullish confirm.
- RSI corrente non over esteso (< 70).

**Condizioni SHORT:**
- Speculari per i supporti su regime `BEAR` o `TRANSITION` confermati dal trend short globale.

## 3. Metriche Riscontrate (Test con Flag ON 2021-2024)
Abilitando il flag e calcolando il backtest sul periodo Novembre 2021 - Giugno 2024 con Expectancy Filter attivo, abbiamo derivato:
- **Candidati trovati:** 8790
- **Bloccati preventivamente dal Gatekeeper / Logica:** 5751
- **Motivazioni blocco prevalenti:** 
  - Volatilità esplosiva contro posizione: 2358
  - RSI ipercomprato sul retest: 1330
  - RSI ipervenduto sul retest: 1168
- **Eseguiti Reali (Al netto della Matrix Exp.):** ~3008 trades associati al tag `BREAKOUT_RETEST`.
- **Risultato (PnL):** -$1965.24 Net PnL (Win Rate ~36.5%).

**Confronto col vecchio CONTINUATION:**
Il `BREAKOUT_RETEST` è notevolmente più protetto (Drawdown ed entry molto meno scoscese di un full-blown falling knife come comprare al top a +15%). Tuttavia, l'intrinseca mancanza di continuazione fluida in un mercato rumoroso e volatile quale è quello crypto rispetto a forex/stock, porta i movimenti di breakdown a "rimangiarsi" spessissimo la barra di conferma di retest.
Risulta infatti che comprare sui cali in Pullback porta storicamente molto più Edge (`PULLBACK` ha tirato fuori +$19k netto) rispetto allo scommettere su nuove espansioni dopo un retest.

## 4. Trade Esempi Tipici Registrati
1. **Breakout Long su BTC/USD (BULL Regime):** Sull'uscita da una mini lateralizzazione di 20h, una candela forte passa da $41.2K (res) a 41.5k. La successiva chiude a 41.3k sfiorando la resistenza in basso (retest), ed emette candela verde (Open 41.3k -> Close 41.6k). L'engine entra LONG.
2. **Breakdown Short su ETH/USD (BEAR Regime):** Supporto a $2100 violato, rimbalzo tenue fino a 2095 (support retest), failure con nuova candela rossa sotto 2090. L'engine entra SHORT.

## 5. Rischio Overfitting
L'intero pattern è codificato con calcoli dinamici `ATR`, evitando soglie numeriche statiche. Non c'è un overfitting del pattern in sé (i prezzi target per il test resistance sono scalabili con la vola). Tuttavia, si nota come per renderlo molto profittevole andrebbero cercate configurazioni in filtri più stretti, il che rischierebbe *curve-fitting* puro per trovare condizioni artificialmente ottimali. Al momento l'approccio è robusto, anche a costo di riflettere semplicemente che il momentum retest non ha superato a pieni voti l'Alpha Testing Crypto triennale.

## 6. Report Dead Code rimosso
La precedente logica dismessa `SMART_CONTINUATION` che era rimasta commentata/scartata tra i feature_flags (`FEATURE_FLAGS.SMART_CONTINUATION`) e nel Signal Layer era classificata come codice morto (Dead Code). È stata tracciata via regex grep e permanentemente estirpata dall'architettura (`src/server/core/architecture.ts`). Non ci sono più side-effects di logiche in competizione per i setup continuation. 

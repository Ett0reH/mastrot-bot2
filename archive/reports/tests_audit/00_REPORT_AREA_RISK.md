# Audit MACRO-AREA 2: RISK, SIZING E CAPITAL MANAGEMENT
Status: Completato e Verificato con Tests Deterministici

## 1. GatekeeperLayer (2.1)
- **Invarianti verificate:** CHOP genera `BLOCKED_BY_CHOP` o `CHOP_MEAN_REVERSION_LOW_QUALITY`. `OVEREXTENDED` blocca i trader ritardati. CRASH non ammette LONG trend-following, EUPHORIA none ammette SHORT trend-following.
- **Expectancy:** Quando la statistica segnala "DISABLED" (Expectancy < 0 && PF < 1.0), il test deterministico prova che il `GatekeeperLayer` lo rigetta senza eccezioni o fallback ("EXPECTANCY_DISABLED"). Per metriche assenti ("INSUFFICIENT_DATA"), l'algoritmo non fa `reject` totale ma espone finalRiskModifier = 0.5, approvando il trade per la phase di campionamento.

## 2. RiskLayer (2.2)
- **Sizing Matematico:** Il sizing basato su Percentuale di rischio e leva (alloc = capital * risk * leverage) è stabile e scala deterministicamente.
- **Difesa Margin Call (ATR):** Inseriti candele sintetiche con ATR massivo -> il modulo slDist clampava l'Expected Risk Ratio sopra lo 0.15 limitando chirurgicamente la `leverage` a `1.0`. Lo SL e lo Catastrophe SL scalano e non appongono rischi di Stop negativi se il prezzo oscilla.
- **Rischio Cumulativo Gatekeeper:** Il Final Risk Modifier è applicato in tempo per calcolare il target d'allocazione prima del check massimo assoluto (80% portfolio USD).

## 3. CapitalManagementLayer & Costi d'Esposizione (2.3)
- **Peak / Drawdown:** Dimostrato che la Peak Equity si stabilizza. Quando la equity cala e passa la soglia del 15%, `allowedCapacityMultiplier` scatta immediatamente al 50%. A -25% si innesca il `isHalted=true` mettendo in blocco vitale i sistemi. Una recovery dell'equity (es. nuovo picco o ritorno <15%) sblocca l'esposizione.
- **Esposizione Live:** Verificato che in `liveEngine.ts` il tetto limite `MAX_GLOBAL_EXPOSURE` blocca ingressi in nuovi trade computando esattamente `(size * entryPrice)` di TUTTE le `simulatedPositions`. E' impossibile ignorare un massimale sul cluster, evitando Out of Margin errors esecutivi contro il Broker.

## Risultato Tests
Tutti i test risk-audit: `2_1_gatekeeper_layer.audit.ts`, `2_2_risk_layer.audit.ts` e `2_3_capital_management_layer.audit.ts` sono **PASS**. Il sistema è immunizzato da allocation bugs.

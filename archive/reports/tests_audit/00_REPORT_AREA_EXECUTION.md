# Audit MACRO-AREA 3: POSITION MANAGEMENT & EXECUTION
Status: Completato e Verificato con Tests Deterministici

## 1. PositionExitLayer (3.1)
- **MFE / MAE ed Edge Decay:** Il layer monitora in tempo reale il MFE e applica euristiche di Edge Decay. Verificato con test unitari che aggiorna `isHarvestExecuted`, scala size e triggera exit ("EDGE_DECAY_EARLY" o "EDGE_DECAY_LESS_AGGRESSIVE" etc).
- **Trailing Stop:** Implementato e verificato nei test. Scalato correttamente dal config di Risk.
- **Harvest (Take Profit Parziale):** Se l'Edge / setup si trova a un punto critico ottimale (1.5x) e `POSITION_HARVEST` è true, la size si dimezza localmente (`trade.size *= 0.5`). 

## 2. LiveEngine & Broker Reconciliation (3.2)
- **Limit Resolution (`resolveOrderAmount`):** Il convertitore e limit-checker lavora perfettamente: intercetta limiti Minimi, converte precision della Size, valuta Min Notional, e sopratutto NON sovrascrive un `Amount must be positive` derivato da negativi con null reference issues. Testato deterministicamente in `3_2_broker_reconciliation.audit.ts` con esito PASS.
- **Harmony locale del Harvest:** Aggiunto un layer intercept nel `liveEngine.ts` che esegue nativamente ordini *reduceOnly* in market e sincronizza Kraken con l'harvest parziale calcolato dal PositionExitLayer (codice preesistente scalava solo la local size ma veniva sovrascritta dal broker sync passivo).
- **Ghost Trade Healing:** L'auto healing sul fallimento dell'uscita live gestisce retry o la scomparsa accidentale di una position.
- **Orphan Orders Auto-Clear:** Individuati Open Order sciolti ("unmanagedOrders") il tool li elimina chirurgicamente a patto che non coincidano col Next Adopt o con un Native Stop Loss della base in cache.

## Risultato Tests
Tutti i test unitari `3_1_position_exit_layer.audit.ts` e `3_2_broker_reconciliation.audit.ts` sono **PASS**. Il live engine è stabile per quanto attiene i vincoli esecutivi e lo slicing dei size per gli order book limit.

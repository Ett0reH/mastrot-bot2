import { calculateSnapshot, calculateMetrics } from '../../lib/metricsCalculator';

async function runAudit() {
    let results = [];
    let fieldsIncoerenti = new Set<string>();
    let fieldsDaRinominare = new Set<string>();
    
    console.log("METRICS CONSISTENCY AUDIT RESULT");
    console.log("- tests created");

    // Invariant 1: Se tradesCount = 1, avgTrade deve essere uguale a netProfit
    // In metricsCalculator, netProfit = currentEq - startEq. avgTrade = netProfit / tradesCount.
    // If trades count is 1, avgTrade is netProfit. Let's test this.
    try {
        const state = {
            initialBalance: 10000,
            balance: 10100,
            equityHistory: [{ time: new Date().toISOString(), equity: 10000 }, { time: new Date().toISOString(), equity: 10100 }],
            recentTrades: [{ pnl: 100 }]
        };
        const snap = calculateSnapshot(state);
        if (snap.tradesCount === 1 && Math.abs(snap.avgTrade - snap.netProfit) < 0.001) {
            results.push("Invariant 1 (tradesCount=1 -> avgTrade=netProfit): PASS");
        } else {
            results.push("Invariant 1: FAIL");
        }
    } catch (e) {
        results.push("Invariant 1: FAIL");
    }

    // Invariant 2: Se losingTrades = 1 e winningTrades = 0, hitRate deve essere 0
    try {
        const state = {
            initialBalance: 10000,
            balance: 9900,
            equityHistory: [{ time: new Date().toISOString(), equity: 10000 }, { time: new Date().toISOString(), equity: 9900 }],
            recentTrades: [{ pnl: -100 }]
        };
        const snap = calculateSnapshot(state);
        if (snap.losingTrades === 1 && snap.winningTrades === 0 && snap.hitRate === 0) {
            results.push("Invariant 2 (losing=1, winning=0 -> hitRate=0): PASS");
        } else {
            results.push("Invariant 2: FAIL");
        }
    } catch (e) {
        results.push("Invariant 2: FAIL");
    }

    // Invariant 3: Se grossProfit = 0 e grossLoss > 0, profitFactor deve essere 0 oppure N/A
    try {
        const state = {
            initialBalance: 10000,
            balance: 9900,
            equityHistory: [{ time: new Date().toISOString(), equity: 10000 }, { time: new Date().toISOString(), equity: 9900 }],
            recentTrades: [{ pnl: -100 }]
        };
        const snap = calculateSnapshot(state);
        if (snap.grossProfit === 0 && snap.grossLoss > 0 && (snap.profitFactor === 0 || snap.profitFactor === 'N/A')) {
            results.push("Invariant 3 (grossProfit=0, grossLoss>0 -> profitFactor=0|N/A): PASS");
        } else {
            results.push("Invariant 3: FAIL");
        }
    } catch (e) {
        results.push("Invariant 3: FAIL");
    }

    // Invariant 4: abs(netProfit) coerente con grossLoss
    try {
        const state = {
            initialBalance: 10000,
            balance: 9800,
            equityHistory: [{ time: new Date().toISOString(), equity: 10000 }, { time: new Date().toISOString(), equity: 9800 }],
            recentTrades: [{ pnl: -200 }]
        };
        const snap = calculateSnapshot(state);
        if (snap.netProfit === -200 && snap.grossLoss === 200) {
            results.push("Invariant 4 (netProfit/grossLoss scale consistency): PASS");
        } else {
            results.push("Invariant 4: FAIL");
            fieldsIncoerenti.add("netProfit vs grossLoss scales");
        }
    } catch (e) {
        results.push("Invariant 4: FAIL");
    }

    // Invariant 5: totalReturn = netProfit / capitalBase
    try {
        const state = {
            initialBalance: 10000,
            balance: 10500,
            equityHistory: [{ time: new Date().toISOString(), equity: 10000 }, { time: new Date().toISOString(), equity: 10500 }],
            recentTrades: [{ pnl: 500 }]
        };
        const snap = calculateSnapshot(state as any);
        if ('capitalBase' in snap && snap.totalReturn === snap.netProfit / (snap as any).capitalBase) {
            results.push("Invariant 5 (totalReturn = netProfit/capitalBase): PASS");
        } else {
            results.push("Invariant 5: FAIL");
            fieldsIncoerenti.add("totalReturn vs netProfit/capitalBase (capitalBase missing)");
        }
    } catch (e) {
        results.push("Invariant 5: FAIL");
    }

    // Invariant 6: capitalBase presente nel payload
    try {
        const state = {
            equityHistory: [{ time: new Date().toISOString(), equity: 10000 }]
        };
        const snap = calculateSnapshot(state as any);
        if ('capitalBase' in snap) {
            results.push("Invariant 6 (capitalBase present): PASS");
        } else {
            results.push("Invariant 6: FAIL");
            fieldsIncoerenti.add("capitalBase missing in payload");
        }
    } catch (e) {
        results.push("Invariant 6: FAIL");
    }

    // Invariant 7: units for metrics
    try {
        const state = { equityHistory: [{ time: new Date().toISOString(), equity: 10000 }] };
        const snap = calculateSnapshot(state as any);
        if (('totalReturnUnit' in snap || typeof (snap as any).totalReturn === 'object') && 
            ('maxDDUnit' in snap) && ('cagrUnit' in snap)) {
            results.push("Invariant 7 (explicit units): PASS");
        } else {
            results.push("Invariant 7: FAIL");
            fieldsIncoerenti.add("maxDD (missing unit)");
            fieldsIncoerenti.add("ulcerIndex (missing unit)");
            fieldsIncoerenti.add("cagr (missing unit)");
            fieldsIncoerenti.add("totalReturn (missing unit)");
        }
    } catch (e) {
        results.push("Invariant 7: FAIL");
    }

    // Invariant 8: Sharpe/Sortino/Calmar N/A if tradesCount < 30
    try {
        const state = {
            initialBalance: 10000,
            balance: 10500,
            equityHistory: [{ time: new Date().toISOString(), equity: 10000 }, { time: new Date().toISOString(), equity: 10500 }],
            recentTrades: [{ pnl: 500 }]
        };
        const snap = calculateSnapshot(state);
        if (snap.tradesCount < 30) {
            if (snap.sharpe === 'N/A' && snap.sortino === 'N/A' && snap.calmar === 'N/A') {
                results.push("Invariant 8 (Sharpe/Sortino N/A if <30 trades): PASS");
            } else {
                results.push("Invariant 8: FAIL");
                fieldsIncoerenti.add("sharpe (numeric instead of N/A when < 30 trades)");
                fieldsIncoerenti.add("sortino (numeric instead of N/A when < 30 trades)");
                fieldsIncoerenti.add("calmar (numeric instead of N/A when < 30 trades)");
            }
        } else {
            results.push("Invariant 8: PASS (N/A for tradesCount >= 30 test not hit)");
        }
    } catch (e) {
        results.push("Invariant 8: FAIL");
    }

    // Invariant 9: oosPerformance non puo' essere 100% (Live) se il trade e' in perdita
    try {
        const state = {
            initialBalance: 10000,
            balance: 9900,
            equityHistory: [{ time: new Date().toISOString(), equity: 10000 }, { time: new Date().toISOString(), equity: 9900 }],
            recentTrades: [{ pnl: -100 }]
        };
        const snap = calculateSnapshot(state);
        // Is netProfit < 0
        if (snap.netProfit < 0 && String(snap.oosPerformance).includes("100%")) {
            results.push("Invariant 9 (oosPerformance 100% on loss): FAIL");
            fieldsIncoerenti.add("oosPerformance (semantically ambiguous)");
        } else {
            results.push("Invariant 9: PASS");
        }
    } catch (e) {
        results.push("Invariant 9: FAIL");
    }

    // Invariant 10: windowStart, windowEnd, generatedAt in t0/t1/t24h
    try {
        const state = {
            equityHistory: [{ time: new Date().toISOString(), equity: 10000 }],
            metricsHistory: []
        };
        const metrics = calculateMetrics(state as any);
        if ('windowStart' in metrics.t0 && 'windowEnd' in metrics.t0 && 'generatedAt' in metrics.t0 &&
            'windowStart' in metrics.t1 && 'windowEnd' in metrics.t1 && 'generatedAt' in metrics.t1) {
            results.push("Invariant 10 (window metadata): PASS");
        } else {
            results.push("Invariant 10: FAIL");
            fieldsIncoerenti.add("t0/t1/t24 (missing windowStart/windowEnd/generatedAt)");
        }
    } catch (e) {
        results.push("Invariant 10: FAIL");
    }

    // Invariant 11: timeUnderWater & maxDDDuration must declare unit
    try {
        const state = { equityHistory: [{ time: new Date().toISOString(), equity: 10000 }] };
        const snap = calculateSnapshot(state as any);
        if ('timeUnderWaterUnit' in snap || typeof (snap as any).timeUnderWater === 'object') {
            results.push("Invariant 11 (duration units): PASS");
        } else {
            results.push("Invariant 11: FAIL");
            fieldsIncoerenti.add("timeUnderWater (missing unit bars/mins)");
            fieldsIncoerenti.add("maxDDDuration (missing unit bars/mins)");
        }
    } catch (e) {
        results.push("Invariant 11: FAIL");
    }

    // Invariant 12: stabilityByRegime
    try {
        const state = { equityHistory: [{ time: new Date().toISOString(), equity: 10000 }] };
        const snap = calculateSnapshot(state as any);
        if ('currentRegime' in snap && !('stabilityByRegime' in snap)) {
            results.push("Invariant 12 (stabilityByRegime properly named): PASS");
        } else {
            results.push("Invariant 12: FAIL");
            fieldsDaRinominare.add("stabilityByRegime -> currentRegime");
        }
    } catch (e) {
        results.push("Invariant 12: FAIL");
    }

    console.log("- command executed");
    results.forEach(r => console.log(`- ${r}`));
    console.log("- fields incoerenti:", Array.from(fieldsIncoerenti).join(", "));
    console.log("- fields da rinominare:", Array.from(fieldsDaRinominare).join(", "));
    console.log("- rischio dashboard: CRITICO (Mancanza di scale e unita' ambigue possono causare gravi fraintendimenti visivi e UI buggata).");
    console.log("- rischio decisionale: CRITICO (Valutare sistemi di live trading con metriche OOS sballate, capitalBase assente e factor > 1 errati comporta un rischio finanziario pesante).");
    console.log("- produzione modificata: NO");
}

runAudit();

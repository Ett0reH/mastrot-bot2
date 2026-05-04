// Remove analysis file
import { SignalLayer, GatekeeperLayer, ExpectancyTracker } from "./src/server/core/architecture.ts";

function analyzeDogeEuphoria() {
    ExpectancyTracker.loadMatrix(); // Ensure expectancy is loaded
    const dataCachePath = "src/server/backtest/data_cache";
    const files = fs.readdirSync(dataCachePath).filter(f => f.startsWith("DOGE_USD") && f.endsWith(".json"));
    
    let euphoriaCount = 0;
    let rsiOver85Count = 0;
    let signalsGenerated = 0;
    let blockedSignals = 0;
    let signalReasons: Record<string, number> = {};

    for (const file of files) {
        const fullPath = `${dataCachePath}/${file}`;
        let data: any;
        try {
            data = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
        } catch (e: any) {
            console.error("Could not parse file:", file, e.message);
            continue;
        }
        
        data.forEach((state: any) => {
            try {
                if (state.tick && state.tick.regime === "EUPHORIA") {
                    euphoriaCount++;
                    if (state.tick.features.rsi1H > 85) {
                        rsiOver85Count++;
                    }

                    const signal = SignalLayer.evaluate(state.tick.features, state.tick.regime, "DOGE/USD");
                    if (signal.direction !== "NEUTRAL") {
                        signalsGenerated++;
                        const filter = GatekeeperLayer.allowEntry(signal, state.tick.features, state.tick.regime, "DOGE/USD");
                        if (!filter.allowed) {
                            blockedSignals++;
                            signalReasons[filter.reason] = (signalReasons[filter.reason] || 0) + 1;
                        }
                    }
                }
            } catch (e: any) { }
        });
    }

    let results = {
        euphoriaCount,
        rsiOver85Count,
        signalsGenerated,
        blockedSignals,
        signalReasons
    };
    fs.writeFileSync("doge_analysis_results.json", JSON.stringify(results, null, 2));
    console.log("Analysis done, written to doge_analysis_results.json");
}
analyzeDogeEuphoria();

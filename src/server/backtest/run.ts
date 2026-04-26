import fs from "fs";
import path from "path";
import { generateAdvancedAggregations } from "./reportAggregator";
import {
  Bar,
  TradingRegime,
  MarketDataLayer,
  RegimeLayer,
  SignalLayer,
  GatekeeperLayer,
  RiskLayer,
  PositionExitLayer,
  ActiveTrade,
  CapitalManagementLayer,
  AnalyticsLayer,
  FEATURE_FLAGS,
  ExpectancyTracker,
  PullbackMetrics,
  BreakoutRetestMetrics,
  TradeBudgetMetrics,
  resolveRiskTier
} from "../core/architecture";

// Alpaca API Credentials
const API_KEY = "PKD4NN6JNJGLBVQPL5YFLJ3RCP";
const SECRET_KEY = "5HMSSeUm3jLjNoik98vS8JUiWwdBWRxQcGJQkYtzL3Ba";
const BASE_URL = "https://data.alpaca.markets/v1beta3/crypto/us/bars";
const SYMBOLS = [
  "BTC/USD",
  "ETH/USD",
  "SOL/USD",
  "LTC/USD",
  "XRP/USD",
  "DOGE/USD",
  "LINK/USD",
  "ADA/USD",
];

interface TradeLog {
  symbol: string;
  type: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  reason: string;
  size?: number;
  leverage?: number;
  entryRegime?: string;
  setup?: string;
  engine?: string;
  isChopEntry?: boolean;
  maxUnrealizedPnlPercent?: number;
  maxNegativeExcursionPercent?: number;
  margin?: number;
  barsHeld?: number;
  isContaminated?: boolean;
  isHarvestExecuted?: boolean;
  harvestPnL?: number;
  runnerPnL?: number;
  originalSize?: number;
  mfeR?: number;
  maeR?: number;
  barsUnderEntry?: number;
  barsToHalfR?: number;
  barsToOneR?: number;
}

async function fetch15mData(
  symbol: string,
  start: string,
  end: string,
): Promise<Bar[]> {
  const cacheDir = path.join(
    process.cwd(),
    "src",
    "server",
    "backtest",
    "data_cache",
  );
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const cacheFileName = `${symbol.replace("/", "_")}_15Min_${start.split("T")[0]}_${end.split("T")[0]}.json`;
  const cacheFilePath = path.join(cacheDir, cacheFileName);

  let allBars: Bar[] = [];
  let currentStart = start;

  if (fs.existsSync(cacheFilePath)) {
    try {
      const cachedBars = JSON.parse(fs.readFileSync(cacheFilePath, "utf-8"));
      if (cachedBars && cachedBars.length > 0) {
        allBars = cachedBars;
        const lastBar = cachedBars[cachedBars.length - 1];
        const lastTime = new Date(lastBar.t).getTime();
        const targetEnd = new Date(end).getTime();

        if (lastTime >= targetEnd - 15 * 60 * 1000) {
          console.log(
            `Cache fully covers up to target end date for ${symbol}.`,
          );
          return allBars;
        } else {
          console.log(
            `Cache exists but ends early at ${lastBar.t} for ${symbol}. Resuming...`,
          );
          currentStart = new Date(lastTime + 15 * 60 * 1000).toISOString();
        }
      }
    } catch (e) {
      console.error(`Invalid cache found for ${symbol}, downloading fresh.`);
      allBars = [];
    }
  }

  let pageToken: string | null = null;
  console.log(
    `Downloading ${symbol} [15Min] from ${currentStart} to ${end}...`,
  );

  let maxPagesAllowed = 5000;
  let pg = 0;

  while (pg < maxPagesAllowed) {
    pg++;
    const query = new URLSearchParams({
      symbols: symbol,
      timeframe: "15Min",
      start: currentStart,
      end,
      limit: "10000",
    });
    if (pageToken) query.set("page_token", pageToken);

    let res;
    let retries = 5;
    while (retries > 0) {
      try {
        res = await fetch(`${BASE_URL}?${query.toString()}`, {
          headers: {
            "APCA-API-KEY-ID": API_KEY,
            "APCA-API-SECRET-KEY": SECRET_KEY,
            accept: "application/json",
          },
        });

        if (res.status === 429) {
          console.log(
            `Rate limited (429) on page ${pg} for ${symbol}. Backing off 15s...`,
          );
          await new Promise((r) => setTimeout(r, 15000));
          retries--;
          continue;
        }

        break; // break retry loop if successful or fatal error
      } catch (err) {
        retries--;
        await new Promise((r) => setTimeout(r, 3000));
        if (retries === 0) throw err;
      }
    }

    if (!res || !res.ok) {
      const text = await res?.text();
      console.error(
        `API Error for ${symbol} on page ${pg}: ${res?.status} - ${text}`,
      );
      break;
    }
    const data = await res.json();
    const newBars = data.bars?.[symbol] || [];
    allBars = allBars.concat(newBars);

    if (data.next_page_token) {
      pageToken = data.next_page_token;
    } else {
      break;
    }
  }

  if (allBars.length > 0) {
    fs.writeFileSync(cacheFilePath, JSON.stringify(allBars));
  }

  return allBars;
}

async function runEventDrivenBacktest() {
  process.env.BACKTEST_MODE = "true";
  console.log("--- MULTI-YEAR SIMULATION ARCHITECTURE V2 (MAX PERIOD) ---");
  const start = "2023-01-01T00:00:00Z";
  const end = "2026-04-25T20:00:00Z";

  // FASE 3: Load Expectancy Matrix
  try {
    const matrixPath = path.join(
      process.cwd(),
      "src",
      "server",
      "backtest",
      "data_cache",
      "setup_expectancy_matrix.json",
    );
    if (fs.existsSync(matrixPath)) {
      console.log("Loading Setup Expectancy Matrix...");
      const matrixData = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
      ExpectancyTracker.loadMatrix(matrixData);
      console.log(
        `Loaded ${Object.keys(matrixData).length} setup logic constraints.`,
      );
    } else {
      console.log(
        "Setup Expectancy Matrix not found. Run generate_expectancy_matrix.ts to build it.",
      );
    }
  } catch (e) {
    console.warn("Failed to load expectancy matrix:", e);
  }

  console.log("Precomputing OHLCV...");
  const symbolStates: Record<string, any[]> = {};

  for (const symbol of SYMBOLS) {
    let bars15m: Bar[] = [];
    try {
      bars15m = await fetch15mData(symbol, start, end);
      if (bars15m.length === 0) continue;
    } catch (e) {
      console.error(`Failed to fetch for ${symbol}:`, e);
      continue;
    }

    let bars1H: Bar[] = [];
    let bars4H: Bar[] = [];
    let cur1H: Bar | null = null;
    let cur4H: Bar | null = null;
    let ticksWithState = [];

    for (let i = 0; i < bars15m.length; i++) {
      const tick = bars15m[i];
      const date = new Date(tick.t);
      const min = date.getMinutes();
      const hour = date.getHours();

      if (!cur1H) cur1H = { ...tick };
      else {
        cur1H.h = Math.max(cur1H.h, tick.h);
        cur1H.l = Math.min(cur1H.l, tick.l);
        cur1H.c = tick.c;
        cur1H.v += tick.v;
      }
      let h1Closed = false;
      if (min === 45) {
        bars1H.push({ ...cur1H });
        cur1H = null;
        h1Closed = true;
      }

      if (!cur4H) cur4H = { ...tick };
      else {
        cur4H.h = Math.max(cur4H.h, tick.h);
        cur4H.l = Math.min(cur4H.l, tick.l);
        cur4H.c = tick.c;
        cur4H.v += tick.v;
      }
      if (min === 45 && (hour + 1) % 4 === 0) {
        bars4H.push({ ...cur4H });
        cur4H = null;
      }

      if (bars1H.length < 50 || bars4H.length < 200) continue;

      let features = null;
      let regime: TradingRegime = "UNKNOWN";

      if (h1Closed) {
        features = MarketDataLayer.prepareFeatures(
          bars1H.slice(-55),
          bars4H.slice(-210),
        );
        regime = RegimeLayer.detect(features);
      }

      ticksWithState.push({
        tick,
        h1Closed,
        features,
        regime,
      });
    }
    symbolStates[symbol] = ticksWithState;
    console.log(`Precomputed ${ticksWithState.length} states for ${symbol}`);
  }

  let globalEquity = 10000;
  let allTrades: TradeLog[] = [];
  let globalMaxDDTracker = 0;
  let maxHistoricalEquity = 10000;
  const FEE_RATE = 0.0005;

  let totalChopCandles = 0;
  let chopBlockedTradesCount = 0;
  let chopBlockedSymbols: Record<string, number> = {};
  let chopBlockedSetups: Record<string, number> = {};

  const activePositions: Record<string, ActiveTrade | null> = {};
  for (const sym of SYMBOLS) activePositions[sym] = null;

  const maxTicks = Math.max(
    ...SYMBOLS.map((sym) => (symbolStates[sym] ? symbolStates[sym].length : 0)),
  );

  let maxNewPositionsPerCandle = 3;

  for (let i = 0; i < maxTicks; i++) {
    // --- GLOBAL FLOATING EQUITY UPDATE ---
    let floatingPnL = 0;
    for (const sym of SYMBOLS) {
      const pos = activePositions[sym];
      if (pos) {
        const crossAssetTick =
          symbolStates[sym] && symbolStates[sym][i]
            ? symbolStates[sym][i].tick.c
            : pos.entryPrice;
        const posValue = pos.size * crossAssetTick;
        const entryValue = pos.size * pos.entryPrice;
        if (pos.direction === "LONG") {
          floatingPnL +=
            posValue -
            posValue * FEE_RATE -
            (entryValue + entryValue * FEE_RATE);
        } else {
          floatingPnL +=
            entryValue -
            entryValue * FEE_RATE -
            (posValue + posValue * FEE_RATE);
        }
      }
    }
    const trueEquity = globalEquity + floatingPnL;
    if (trueEquity > maxHistoricalEquity) {
      maxHistoricalEquity = trueEquity;
    }
    const globalCurrentDD =
      (maxHistoricalEquity - trueEquity) / maxHistoricalEquity;
    if (globalCurrentDD > globalMaxDDTracker) {
      globalMaxDDTracker = globalCurrentDD;
    }
    // -------------------------------------

    const capitalHealth = CapitalManagementLayer.evaluateAccountHealth(
      trueEquity,
      maxHistoricalEquity,
    );

    for (const symbol of SYMBOLS) {
      if (!symbolStates[symbol] || !symbolStates[symbol][i]) continue;
      const { tick, h1Closed, features, regime } = symbolStates[symbol][i];

      let position = activePositions[symbol];

      let gapMinutes = 0;
      if (
        FEATURE_FLAGS.DATA_GAP_VALIDATION &&
        i > 0 &&
        symbolStates[symbol][i - 1]
      ) {
        const prevTickTime = new Date(
          symbolStates[symbol][i - 1].tick.t,
        ).getTime();
        const currTickTime = new Date(tick.t).getTime();
        gapMinutes = (currTickTime - prevTickTime) / 60000;

        if (gapMinutes > 24 * 60 && gapMinutes < 30 * 24 * 60) {
          console.warn(
            `[DATA_GAP] ${symbol} has a gap > 24h (${(gapMinutes / 60).toFixed(1)}h) ending at ${tick.t}. Period may be invalid.`,
          );
        } else if (gapMinutes > 30 && gapMinutes <= 60) {
          // console.warn(`DATA GAP WARNING: ${symbol} gap of ${gapMinutes}m at ${tick.t}`);
        }

        if (position && gapMinutes > 60) {
          position.isContaminated = true;
        }

        if (position && gapMinutes > 240) {
          position.shouldInvalidateByGap = true;
        }
      }

      // 1. POSITION MANAGEMENT / EXIT LAYER
      if (position && h1Closed && features) {
        let exitDecision = PositionExitLayer.monitorAndExit(
          position,
          features,
          regime,
        );
        const isLastTick = i === symbolStates[symbol].length - 1;

        if (isLastTick) {
          exitDecision = { shouldExit: true, exitType: "END_OF_DATA" };
        }

        if (
          FEATURE_FLAGS.DATA_GAP_VALIDATION &&
          (gapMinutes > 240 || position.shouldInvalidateByGap)
        ) {
          exitDecision = {
            shouldExit: true,
            exitType: "INVALIDATED_DATA_GAP" as any,
          };
        }

        if (exitDecision.shouldExit) {
          const exitPrice = tick.c;
          
          let tradeNetPnL = 0;
          let pnlPercent = 0;
          let harvestPnL = 0;

          if (position.isHarvestExecuted && position.originalSize && position.harvestPrice) {
            const harvestSize = position.originalSize - position.size;
            const harvestExitValue = harvestSize * position.harvestPrice;
            const harvestEntryValue = harvestSize * position.entryPrice;
            const exitFeeHarvest = harvestExitValue * FEE_RATE;
            const entryFeeHarvest = harvestEntryValue * FEE_RATE;
            
            if (position.direction === "LONG") {
               harvestPnL = harvestExitValue - exitFeeHarvest - (harvestEntryValue + entryFeeHarvest);
            } else {
               harvestPnL = harvestEntryValue - entryFeeHarvest - (harvestExitValue + exitFeeHarvest);
            }
          }

          const runnerSize = position.size;
          const exitSizeValue = runnerSize * exitPrice;
          const exitFee = exitSizeValue * FEE_RATE;
          const entryValue = runnerSize * position.entryPrice;
          const entryFee = entryValue * FEE_RATE;

          let runnerPnL = 0;

          if (position.direction === "LONG") {
            runnerPnL = exitSizeValue - exitFee - (entryValue + entryFee);
          } else {
            runnerPnL = entryValue - entryFee - (exitSizeValue + exitFee);
          }

          tradeNetPnL = harvestPnL + runnerPnL;

          const totalEntryValue = (position.originalSize || position.size) * position.entryPrice;
          pnlPercent = (tradeNetPnL / totalEntryValue) * 100 * position.leverage;

          globalEquity += tradeNetPnL;
          if (globalEquity > maxHistoricalEquity) {
            maxHistoricalEquity = globalEquity;
          }
          AnalyticsLayer.logDecision("EXIT", symbol, exitDecision.exitType, {
            pnl: tradeNetPnL,
          });

          let maxUnrealizedPnlPercent = 0;
          let maxNegativeExcursionPercent = 0;
          if (position.direction === "LONG") {
            maxUnrealizedPnlPercent =
              ((position.highWaterMark - position.entryPrice) /
                position.entryPrice) *
              100 *
              position.leverage;
            maxNegativeExcursionPercent =
              ((position.lowWaterMark - position.entryPrice) /
                position.entryPrice) *
              100 *
              position.leverage;
          } else {
            maxUnrealizedPnlPercent =
              ((position.entryPrice - position.lowWaterMark) /
                position.entryPrice) *
              100 *
              position.leverage;
            maxNegativeExcursionPercent =
              ((position.entryPrice - position.highWaterMark) /
                position.entryPrice) *
              100 *
              position.leverage;
          }

          if (position.engine === "NORMAL" && !position.isContaminated) {
            if (tradeNetPnL > 0) TradeBudgetMetrics.NormalCleanGrossProfit += tradeNetPnL;
            else TradeBudgetMetrics.NormalCleanGrossLoss += tradeNetPnL;
          }

          allTrades.push({
            symbol,
            type: position.direction,
            entryTime: activePositions[symbol]!.id, // Used entryTime as ID
            entryPrice: position.entryPrice,
            exitTime: tick.t,
            exitPrice,
            pnl: tradeNetPnL,
            pnlPercent,
            reason: exitDecision.exitType,
            size: position.size,
            leverage: position.leverage,
            entryRegime: position.entryRegime,
            setup: position.setup || "N/A",
            engine: position.engine || "NONE",
            tierLabel: (position as any).tierLabel,
            isChopEntry: position.isChopEntry,
            isHarvestExecuted: position.isHarvestExecuted || false,
            harvestPnL,
            runnerPnL,
            originalSize: position.originalSize || position.size,
            maxUnrealizedPnlPercent,
            maxNegativeExcursionPercent,
            margin: entryValue / position.leverage,
            barsHeld: position.barsHeld,
            isContaminated: position.isContaminated,
            mfeR: position.mfeR,
            maeR: position.maeR,
            barsUnderEntry: position.barsUnderEntry,
            barsToHalfR: position.barsToHalfR,
            barsToOneR: position.barsToOneR,
            isReducedLeverageAction: (position as any).isReducedLeverageAction,
          } as any);
          activePositions[symbol] = null;
        }
        // Continue is removed from here because we will process entries in a separate loop
      }
    } // End of exit loop

    // 2. SIGNAL & ENTRY & RISK LAYER
    let candidateSignals: any[] = [];
    
    for (const symbol of SYMBOLS) {
      if (!symbolStates[symbol] || !symbolStates[symbol][i]) continue;
      const { tick, h1Closed, features, regime } = symbolStates[symbol][i];
      let position = activePositions[symbol];

      if (!position && h1Closed && features && !capitalHealth.isHalted) {
        if (features.isChop) totalChopCandles++;

        let btcTrend1H = 0;
        let btcRegime: TradingRegime = "UNKNOWN";
        if (symbolStates["BTC/USD"] && symbolStates["BTC/USD"][i] && symbolStates["BTC/USD"][i].features) {
          btcTrend1H = symbolStates["BTC/USD"][i].features.trend1H;
          btcRegime = symbolStates["BTC/USD"][i].regime;
        }

        const signal = SignalLayer.evaluate(features, regime, { btcTrend1H, btcRegime });

        if (signal.direction !== "NEUTRAL") {
          const gate = GatekeeperLayer.allowEntry(
            signal,
            features,
            regime,
            symbol,
          );
          if (!gate.allowed && (gate.reason === "BLOCKED_BY_CHOP" || gate.reason === "CHOP_MEAN_REVERSION_LOW_QUALITY")) {
            chopBlockedTradesCount++;
            chopBlockedSymbols[symbol] = (chopBlockedSymbols[symbol] || 0) + 1;
            chopBlockedSetups[signal.type] = (chopBlockedSetups[signal.type] || 0) + 1;
          }

          if (gate.allowed) {
            const currTickTime = new Date(tick.t).getTime();
            const prevTickTime = symbolStates[symbol][i - 1] ? new Date(symbolStates[symbol][i - 1].tick.t).getTime() : currTickTime;
            const gapMinutes = (currTickTime - prevTickTime) / 60000;

            const cleanProfitFactor = TradeBudgetMetrics.NormalCleanGrossLoss === 0 
               ? 1.0 
               : TradeBudgetMetrics.NormalCleanGrossProfit / Math.abs(TradeBudgetMetrics.NormalCleanGrossLoss);

            const tierDecision = resolveRiskTier({
              engine: signal.engine as any,
              gapMinutes,
              regime,
              setup: signal.type
            }, { cleanProfitFactor });

            if (tierDecision.blocked || tierDecision.tierLabel === "TRANSITION_BLOCKED") {
                // Skip entry entirely
                continue;
            }

            const risk = RiskLayer.calculateRisk(
              signal,
              features,
              trueEquity,
              regime,
              gate.riskModifier,
              symbol,
              { btcTrend1H, btcRegime },
              tierDecision.exposurePct
            );

            let finalSize = risk.positionSize * capitalHealth.allowedCapacityMultiplier;

            if (finalSize > 0) {
              candidateSignals.push({
                symbol,
                tick,
                features,
                regime,
                signal,
                risk,
                finalSize,
                tierDecision,
                // Metric for ranking FASE 11
                qualityScore: signal.quality,
                distanceToStop: Math.abs(features.price - risk.stopLoss) / features.price,
                isBtcAligned: (signal.direction === "LONG" && btcTrend1H === 1) || (signal.direction === "SHORT" && btcTrend1H === -1)
              });
            }
          }
        }
      }
    }

    // FASE 11: Trade Budget Per Candela e Correlazione
    if (candidateSignals.length > 0) {
      if (FEATURE_FLAGS.enableTradeBudgetPerCandle) {
        TradeBudgetMetrics.totalValidSignals += candidateSignals.length;
        
        // Sort candidates based on quality, BTC alignment, and risk constraints
        candidateSignals.sort((a, b) => {
           if (a.isBtcAligned !== b.isBtcAligned) return a.isBtcAligned ? -1 : 1;
           if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore;
           return a.distanceToStop - b.distanceToStop; // prefer tighter stops (smaller distance means less nominal risk or faster invalidation)
        });
        
        let executedThisCandle = 0;
        for (const candidate of candidateSignals) {
           if (executedThisCandle < maxNewPositionsPerCandle) {
               // Execute
               activePositions[candidate.symbol] = {
                 id: candidate.tick.t,
                 symbol: candidate.symbol,
                 direction: candidate.signal.direction,
                 entryPrice: candidate.features.price,
                 size: candidate.finalSize,
                 leverage: candidate.risk.leverage,
                 initialStopLoss: candidate.risk.stopLoss,
                 currentStopLoss: candidate.risk.stopLoss,
                 catastropheStopLoss: candidate.risk.catastropheStopLoss,
                 highWaterMark: candidate.features.price,
                 lowWaterMark: candidate.features.price,
                 barsHeld: 0,
                 entryRegime: candidate.regime,
                 setup: candidate.signal.type,
                 engine: candidate.signal.engine,
                 tierLabel: candidate.tierDecision.tierLabel,
                 isChopEntry: candidate.features.isChop,
                 ...(candidate.risk.isReducedLeverageAction && { isReducedLeverageAction: true }),
               } as any;
               
               AnalyticsLayer.logDecision("ENTRY", candidate.symbol, candidate.signal.direction, {
                 type: candidate.signal.type,
                 regime: candidate.regime,
               });
               
               executedThisCandle++;
               TradeBudgetMetrics.executedSignals++;
           } else {
               // Skip
               TradeBudgetMetrics.skippedSignals++;
               AnalyticsLayer.logDecision("SKIPPED", candidate.symbol, candidate.signal.direction, {
                 reason: "TRADE_BUDGET_EXCEEDED",
                 quality: candidate.qualityScore
               });
           }
        }
        
        TradeBudgetMetrics.newPositionsDistribution[executedThisCandle] = (TradeBudgetMetrics.newPositionsDistribution[executedThisCandle] || 0) + 1;

      } else {
        // Feature flag OFF = execute all
        for (const candidate of candidateSignals) {
             activePositions[candidate.symbol] = {
               id: candidate.tick.t,
               symbol: candidate.symbol,
               direction: candidate.signal.direction,
               entryPrice: candidate.features.price,
               size: candidate.finalSize,
               leverage: candidate.risk.leverage,
               initialStopLoss: candidate.risk.stopLoss,
               currentStopLoss: candidate.risk.stopLoss,
               catastropheStopLoss: candidate.risk.catastropheStopLoss,
               highWaterMark: candidate.features.price,
               lowWaterMark: candidate.features.price,
               barsHeld: 0,
               entryRegime: candidate.regime,
               setup: candidate.signal.type,
               engine: candidate.signal.engine,
               tierLabel: candidate.tierDecision.tierLabel,
               isChopEntry: candidate.features.isChop,
               ...(candidate.risk.isReducedLeverageAction && { isReducedLeverageAction: true }),
             } as any;
             
             AnalyticsLayer.logDecision("ENTRY", candidate.symbol, candidate.signal.direction, {
               type: candidate.signal.type,
               regime: candidate.regime,
             });
        }
      }
    }
  } // END OF CHRONOLOGICAL LOOP

  // --- REPORTING ---
  const validTradesList = allTrades.filter((t) => !t.isContaminated);
  const contaminatedTradesList = allTrades.filter((t) => t.isContaminated);
  const cleanPnLTotal = validTradesList.reduce((a, b) => a + b.pnl, 0);
  const contaminatedPnLTotal = contaminatedTradesList.reduce(
    (a, b) => a + b.pnl,
    0,
  );
  const grossPnLTotal = globalEquity - 10000;
  
  const gapSymbolsList = Array.from(
    new Set(contaminatedTradesList.map((t) => t.symbol)),
  );
  const chopEntries = allTrades.filter(t => t.isChopEntry);
  const theoreticalChopPnL = chopEntries.reduce((acc, t) => acc + t.pnl, 0);

  console.log("\n==============================================");
  console.log("====== NEW ARCHITECTURE BACKTEST ===================");
  console.log("==============================================");
  console.log(`End Equity (Gross): $${globalEquity.toFixed(2)} (Initial: $10000.00)`);
  console.log(`Total System PnL (Gross): $${grossPnLTotal.toFixed(2)}`);
  console.log(`End Equity (Clean-only): $${(10000 + cleanPnLTotal).toFixed(2)}`);
  console.log(`Clean PnL: $${cleanPnLTotal.toFixed(2)}`);
  console.log(`Contaminated PnL: $${contaminatedPnLTotal.toFixed(2)}`);

  const sortedWins = validTradesList.filter(t => t.pnl > 0).sort((a,b) => b.pnl - a.pnl);
  const top5PnL = sortedWins.slice(0, 5).reduce((acc, t) => acc + t.pnl, 0);
  const top10PnL = sortedWins.slice(0, 10).reduce((acc, t) => acc + t.pnl, 0);

  console.log(`\n--- RISK TIER BREAKDOWN ---`);
  console.log(`PnL senza Top 5 winners: $${(cleanPnLTotal - top5PnL).toFixed(2)}`);
  console.log(`PnL senza Top 10 winners: $${(cleanPnLTotal - top10PnL).toFixed(2)}`);
  const tiers = [
    "EXTREME_10", "EXTREME_FALLBACK_5", "NORMAL_5", "NORMAL_UPGRADED", "TRANSITION_BLOCKED"
  ];
  for (const tier of tiers) {
     const tierTrades = validTradesList.filter(t => t.tierLabel === tier);
     const winTrades = tierTrades.filter(t => t.pnl > 0);
     const lossTrades = tierTrades.filter(t => t.pnl <= 0);
     const grossProfit = winTrades.reduce((acc, t) => acc + t.pnl, 0);
     const grossLoss = Math.abs(lossTrades.reduce((acc, t) => acc + t.pnl, 0));
     const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? "INF" : "0.00");
     const netPnL = grossProfit - grossLoss;
     console.log(`[${tier}] Trades: ${tierTrades.length} | Clean PnL: $${netPnL.toFixed(2)} | Clean PF: ${pf}`);
  }

  console.log("\n--- CHOP REGIME STATS ---");
  console.log(`CHOP Detected Candles: ${totalChopCandles}`);
  console.log(`Trades Blocked by CHOP: ${chopBlockedTradesCount}`);
  console.log(`CHOP Base Entries Executed: ${chopEntries.length}`);
  console.log(`Theoretical / Actual PnL in CHOP: $${theoreticalChopPnL.toFixed(2)}`);

  if (FEATURE_FLAGS.DATA_GAP_VALIDATION) {
    console.log(`Clean PnL: $${cleanPnLTotal.toFixed(2)}`);
    console.log(`Contaminated PnL: $${contaminatedPnLTotal.toFixed(2)}`);
    console.log(
      `Valid Trades: ${validTradesList.length} | Contaminated Trades: ${contaminatedTradesList.length}`,
    );
    if (gapSymbolsList.length > 0) {
      console.log(`Symbols w/ Gaps: ${gapSymbolsList.join(", ")}`);
    }
  }

  const winningTrades = allTrades.filter((t) => t.pnl > 0);
  console.log(`Total Trades Executed: ${allTrades.length}`);
  console.log(
    `Win Rate: ${allTrades.length > 0 ? ((winningTrades.length / allTrades.length) * 100).toFixed(1) : 0}%`,
  );

  const extremeTrades = allTrades.filter((t) => t.engine === "EXTREME");
  const normalTrades = allTrades.filter((t) => t.engine === "NORMAL");
  const computeEngineStats = (trades: TradeLog[]) => {
    const pnl = trades.reduce((a, b) => a + b.pnl, 0);
    const grossProfit = trades.filter((t) => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
    const grossLoss = trades.filter((t) => t.pnl < 0).reduce((a, b) => a + Math.abs(b.pnl), 0);
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "N/A";
    const winRate = trades.length > 0 ? (trades.filter(t => t.pnl > 0).length / trades.length * 100).toFixed(1) + "%" : "0%";
    return { count: trades.length, pnl, pf, winRate };
  };
  const extremeStatsLog = computeEngineStats(extremeTrades);
  const normalStatsLog = computeEngineStats(normalTrades);

  console.log("\n--- ENGINE STATS ---");
  console.log(`EXTREME Engine: ${extremeStatsLog.count} trades | PnL: $${extremeStatsLog.pnl.toFixed(2)} | PF: ${extremeStatsLog.pf} | WR: ${extremeStatsLog.winRate}`);
  console.log(`NORMAL Engine:  ${normalStatsLog.count} trades | PnL: $${normalStatsLog.pnl.toFixed(2)} | PF: ${normalStatsLog.pf} | WR: ${normalStatsLog.winRate}`);

  if (FEATURE_FLAGS.ENABLE_CONFIRMED_PULLBACKS) {
    console.log("\n--- PULLBACK PHASE 6 STATS ---");
    console.log(`Candidates: ${PullbackMetrics.candidates}`);
    console.log(`Confirmed:  ${PullbackMetrics.confirmed}`);
    console.log(`Blocked:    ${PullbackMetrics.blocked}`);
    console.log(`Reasons:    `, PullbackMetrics.reasons);
  }

  if (FEATURE_FLAGS.ENABLE_PARTIAL_TAKE_PROFIT) {
    const harvestedTrades = allTrades.filter((t) => t.isHarvestExecuted);
    const totalHarvestPnL = harvestedTrades.reduce((acc, t) => acc + (t.harvestPnL || 0), 0);
    const totalRunnerPnL = harvestedTrades.reduce((acc, t) => acc + (t.runnerPnL || 0), 0);
    
    // Impact calculations
    let simulatedBaselinePnL = 0;
    let reducedWinnersCount = 0;
    let savedLossesCount = 0;
    let simulatedMaxDD = 0;
    let simulatedEquity = 10000;
    let simulatedMaxEq = 10000;
    
    let simGrossProfit = 0;
    let simGrossLoss = 0;
    let topBaselineTrade = 0;
    let topCurrentTrade = 0;
    
    for (const t of allTrades) {
       let simPnL = t.pnl; // Default without harvest is the same
       if (t.isHarvestExecuted) {
          // Without harvest, the full size would have ridden the runner's path
          simPnL = (t.runnerPnL || 0) * 2;
          
          if (simPnL < 0 && t.pnl > 0) savedLossesCount++;
          // Large winner reduced
          if (simPnL > t.pnl && simPnL > 100) reducedWinnersCount++;
       }
       
       simulatedBaselinePnL += simPnL;
       simulatedEquity += simPnL;
       if (simulatedEquity > simulatedMaxEq) simulatedMaxEq = simulatedEquity;
       const dd = (simulatedMaxEq - simulatedEquity) / simulatedMaxEq;
       if (dd > simulatedMaxDD) simulatedMaxDD = dd;
       
       if (simPnL > 0) simGrossProfit += simPnL;
       if (simPnL < 0) simGrossLoss += Math.abs(simPnL);
       if (simPnL > topBaselineTrade) topBaselineTrade = simPnL;
       if (t.pnl > topCurrentTrade) topCurrentTrade = t.pnl;
    }
    
    const currentGrossProfit = allTrades.filter(t => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
    const currentGrossLoss = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((a, b) => a + b.pnl, 0));
    const currentPF = currentGrossLoss > 0 ? (currentGrossProfit / currentGrossLoss).toFixed(2) : "N/A";
    const simPF = simGrossLoss > 0 ? (simGrossProfit / simGrossLoss).toFixed(2) : "N/A";

    console.log("\n--- HARVEST PHASE 8 STATS ---");
    console.log(`Harvested Trades: ${harvestedTrades.length}`);
    console.log(`Total Harvest Component PnL: $${totalHarvestPnL.toFixed(2)}`);
    console.log(`Total Runner Component PnL: $${totalRunnerPnL.toFixed(2)}`);
    console.log(`Trades where Harvest saved a Loss: ${savedLossesCount}`);
    console.log(`Trades where Harvest reduced a Big Winner (> $100): ${reducedWinnersCount}`);
    console.log(`Simulated Baseline PnL (Without Harvest): $${simulatedBaselinePnL.toFixed(2)}`);
    console.log(`Actual PnL (With Harvest): $${(globalEquity - 10000).toFixed(2)}`);
    console.log(`Impact on Profit Factor: ${simPF} -> ${currentPF}`);
    console.log(`Impact on Max DD: ${(simulatedMaxDD * 100).toFixed(2)}% -> [Calculated Below]%`);
    console.log(`Impact on Top Trade: $${topBaselineTrade.toFixed(2)} -> $${topCurrentTrade.toFixed(2)}`);
  }

  if (FEATURE_FLAGS.ENABLE_BREAKOUT_RETEST) {
    console.log("\n--- BREAKOUT RETEST (FASE 7) STATS ---");
    console.log(`Candidates: ${BreakoutRetestMetrics.candidates}`);
    console.log(`Confirmed:  ${BreakoutRetestMetrics.confirmed}`);
    console.log(`Blocked:    ${BreakoutRetestMetrics.blocked}`);
    console.log(`Reasons:    `, BreakoutRetestMetrics.reasons);
  }

  if (FEATURE_FLAGS.enableProgressiveEdgeDecay) {
    const earlyExits = allTrades.filter(t => t.reason === "EDGE_DECAY_EARLY" || t.reason === "EDGE_DECAY_EXTREME_UNCHANGED" || t.reason === "EDGE_DECAY_NORMAL_LESS_AGGRESSIVE");
    let extremeUnchangedCount = allTrades.filter(t => t.reason === "EDGE_DECAY_EXTREME_UNCHANGED").length;
    let normalLessAggressiveCount = allTrades.filter(t => t.reason === "EDGE_DECAY_NORMAL_LESS_AGGRESSIVE").length;
    const classicDecays = allTrades.filter(t => t.reason === "EDGE_DECAY");
    
    let savedPnL = 0;
    let prematureExitsPnL = 0;
    let prematureLossesCount = 0;

    earlyExits.forEach(t => {
      // If the trade was closed early and its PnL is > 0, it means it was a premature successful trade (potentially)
      // or if it was > 0 we cut it too early and missed more, but actually if mfeR < 1, it wasn't great yet.
      // If PnL < 0, we saved ourselves from further pain or EDGE_DECAY stop out.
      if (t.pnl < 0) {
        savedPnL += Math.abs(t.pnl);
      } else {
        prematureExitsPnL += t.pnl;
        prematureLossesCount++;
      }
    });

    console.log("\n--- PROGRESSIVE EDGE DECAY (FASE 9) STATS ---");
    console.log(`Trades Closed by EDGE_DECAY_EARLY: ${earlyExits.length} (Normal: ${normalLessAggressiveCount}, Extreme: ${extremeUnchangedCount})`);
    console.log(`Classical EDGE_DECAY (48 bars): ${classicDecays.length}`);
    console.log(`PnL 'Saved' from negative delayed exits: $${savedPnL.toFixed(2)}`);
    console.log(`Positive PnL cut short (Premature exits): $${prematureExitsPnL.toFixed(2)} (on ${prematureLossesCount} trades)`);
  }

  if (FEATURE_FLAGS.enableTradeBudgetPerCandle) {
    console.log("\n--- TRADE BUDGET & CORRELATION (FASE 11) STATS ---");
    console.log(`Total Valid Signals Generated: ${TradeBudgetMetrics.totalValidSignals}`);
    console.log(`Executed Signals: ${TradeBudgetMetrics.executedSignals}`);
    console.log(`Skipped Signals (Budget Exceeded): ${TradeBudgetMetrics.skippedSignals}`);
    console.log(`New Positions Per Candle Distribution:`);
    Object.keys(TradeBudgetMetrics.newPositionsDistribution).sort().forEach(k => {
      console.log(`  [${k} positions]: ${TradeBudgetMetrics.newPositionsDistribution[Number(k)]} candles`);
    });
  }

  // --- ADVANCED STATS CALCULATION ---
  let stats;
  try {
    const startEquity = 10000;
    allTrades.sort(
      (a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime(),
    );

    const startDate = new Date("2023-01-01T00:00:00Z");
    const endDate = new Date("2026-04-25T20:00:00Z");
    const days = Math.round(
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    let currentEq = startEquity;
    let dailyEquity: number[] = [startEquity];
    let tradeIdx = 0;

    for (let i = 1; i <= days; i++) {
      let currentDate = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      while (
        tradeIdx < allTrades.length &&
        new Date(allTrades[tradeIdx].exitTime) <= currentDate
      ) {
        currentEq += allTrades[tradeIdx].pnl;
        tradeIdx++;
      }
      dailyEquity.push(currentEq);
    }

    const dailyReturns = [];
    for (let i = 1; i < dailyEquity.length; i++) {
      dailyReturns.push(
        (dailyEquity[i] - dailyEquity[i - 1]) / dailyEquity[i - 1],
      );
    }

    const meanRet =
      dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const stdDev =
      Math.sqrt(
        dailyReturns.reduce((a, b) => a + Math.pow(b - meanRet, 2), 0) /
          dailyReturns.length,
      ) || 0.0001;
    const sharpe = (meanRet / stdDev) * Math.sqrt(365);

    const negReturns = dailyReturns.filter((r) => r < 0);
    const sortinoStdDev =
      Math.sqrt(
        negReturns.reduce((a, b) => a + Math.pow(b, 2), 0) /
          (negReturns.length || 1),
      ) || 0.0001;
    const sortino = (meanRet / sortinoStdDev) * Math.sqrt(365);

    let reportMaxDD = 0;
    let peak = startEquity;
    let dds = [];
    let currentDDBars = 0;
    let maxDDBars = 0;

    for (let eq of dailyEquity) {
      if (eq > peak) {
        peak = eq;
        currentDDBars = 0;
      } else {
        currentDDBars++;
        let dd = (peak - eq) / peak;
        if (dd > reportMaxDD) reportMaxDD = dd;
        dds.push(dd);
        if (currentDDBars > maxDDBars) maxDDBars = currentDDBars;
      }
    }

    const avgDD = dds.length ? dds.reduce((a, b) => a + b, 0) / dds.length : 0;
    const ulcer = Math.sqrt(
      dds.reduce((a, b) => a + b * 100 * b * 100, 0) / (dds.length || 1),
    );

    const totalRet = (currentEq - startEquity) / startEquity;
    const annRet = Math.pow(1 + totalRet, 365 / days) - 1;
    const calmar = globalMaxDDTracker === 0 ? 0 : annRet / globalMaxDDTracker;

    const trailingStops = allTrades.filter((t) =>
      t.reason.includes("TRAILING"),
    ).length;
    const hitRateNum =
      allTrades.length > 0
        ? allTrades.filter((t) => t.pnl > 0).length / allTrades.length
        : 0;

    const grossWin = allTrades
      .filter((t) => t.pnl > 0)
      .reduce((a, b) => a + b.pnl, 0);
    const grossLoss = Math.abs(
      allTrades.filter((t) => t.pnl < 0).reduce((a, b) => a + b.pnl, 0),
    );
    const profFactorNum = grossLoss === 0 ? grossWin : grossWin / grossLoss;

    const avgWin =
      allTrades.filter((t) => t.pnl > 0).length > 0
        ? grossWin / allTrades.filter((t) => t.pnl > 0).length
        : 0;
    const avgLoss =
      allTrades.filter((t) => t.pnl < 0).length > 0
        ? grossLoss / allTrades.filter((t) => t.pnl < 0).length
        : 0;

    const pct = (n: number) => (n * 100).toFixed(1) + "%";
    const dec = (n: number) => n.toFixed(2);

    const exitReasonCounts = allTrades.reduce(
      (acc, currentTrade) => {
        acc[currentTrade.reason as string] =
          (acc[currentTrade.reason as string] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    stats = {
      totalRet: pct(totalRet),
      annRet: pct(annRet),
      sharpe: dec(sharpe),
      sortino: dec(sortino),
      calmar: dec(calmar),
      maxDD: pct(reportMaxDD),
      avgDD: pct(avgDD),
      ulcer: dec(ulcer),
      maxDDDuration: `${maxDDBars} bars`,
      maxDDRecovery: `Computed locally`,
      trades: allTrades.length,
      trailStops: trailingStops,
      hitRate: pct(hitRateNum),
      trailPct: pct(trailingStops / (allTrades.length || 1)),
      profFactor: dec(profFactorNum),
      avgWin: dec(avgWin),
      avgLoss: dec(avgLoss),
      exitReasonBreakdown: exitReasonCounts,
    };
  } catch (e) {
    console.error("Stats fail", e);
  }

  const validTrades = allTrades.filter((t) => !t.isContaminated);
  const contaminatedTrades = allTrades.filter((t) => t.isContaminated);
  const cleanPnL = validTrades.reduce((a, b) => a + b.pnl, 0);
  const contaminatedPnL = contaminatedTrades.reduce((a, b) => a + b.pnl, 0);
  const symbolsWithGaps = Array.from(
    new Set(contaminatedTrades.map((t) => t.symbol)),
  );
  const topContaminatedTrades = [...contaminatedTrades]
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
    .slice(0, 5);

  const advancedStats = generateAdvancedAggregations(
    allTrades as any,
    globalEquity - 10000,
  );

  const latestFileName = 'backtest_report_latest.json';
  const previousFileName = 'backtest_report_previous.json';

  if (fs.existsSync(latestFileName)) {
    fs.renameSync(latestFileName, previousFileName);
  }

  const fileName = latestFileName;

  const configUsed = {
    symbols: SYMBOLS,
    timeframe: "1H/4H features calculated from 15m ticks",
    period: "2023-01-01T00:00:00Z to 2026-04-25T20:00:00Z",
    initialCapital: 10000,
    fee: FEE_RATE,
    slippage: "Included in initial execution assumptions inside core",
    dataGapValidation: FEATURE_FLAGS.DATA_GAP_VALIDATION,
  };

  fs.writeFileSync(
    fileName,
    JSON.stringify(
      {
        config: configUsed,
        expectancyStats: ExpectancyTracker.stats,
        chopStats: {
           enabled: FEATURE_FLAGS.CHOP_REGIME,
           totalChopCandles,
           chopBlockedTradesCount,
           chopBlockedSymbols,
           chopBlockedSetups,
           theoreticalChopPnL,
           chopEntriesExecuted: chopEntries.length
        },
        engineStats: {
           extreme: extremeStatsLog,
           normal: normalStatsLog
        },
        pullbackStats: PullbackMetrics,
        breakoutRetestStats: BreakoutRetestMetrics,
        finalEquity: globalEquity,
        netPnL: globalEquity - 10000,
        cleanPnL,
        contaminatedPnL,
        tradeCount: allTrades.length,
        validTradesCount: validTrades.length,
        contaminatedTradesCount: contaminatedTrades.length,
        symbolsWithGaps,
        topContaminatedTrades,
        winRate:
          allTrades.length > 0
            ? allTrades.filter((t) => t.pnl > 0).length / allTrades.length
            : 0,
        stats,
        advanced: advancedStats,
        flags: FEATURE_FLAGS,
        architecture: "9-Layer Separation + Data Gap Validation",
        trades: allTrades,
      },
      null,
      2,
    ),
  );

  console.log(`Generated ${fileName}`);
}

runEventDrivenBacktest();

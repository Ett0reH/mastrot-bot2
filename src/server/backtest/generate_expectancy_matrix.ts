import fs from "fs";
import path from "path";

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
  maxUnrealizedPnlPercent?: number;
  maxNegativeExcursionPercent?: number;
  margin?: number;
  barsHeld?: number;
  isContaminated?: boolean;
}

interface SetupMetrics {
  trades: number;
  netPnL: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  expectancy: number;
  winRate: number;
  maxDrawdown?: number; // Not trivial right away from just trades unordered
  sampleSize: number;
  averageWin: number;
  averageLoss: number;
}

const reportsDir = process.cwd(); // Assume run from root where backtest_report_*.json are

function generateMatrix() {
  console.log("Scanning for backtest_report_*.json files...");
  const files = fs
    .readdirSync(reportsDir)
    .filter(
      (f) =>
        f.startsWith("backtest_report_") &&
        f.endsWith(".json") &&
        !f.includes("live"),
    );

  // Temporary storage for trades
  const matrixMap = new Map<string, TradeLog[]>();

  for (const file of files) {
    console.log(`Processing file: ${file}`);
    const filepath = path.join(reportsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filepath, "utf8"));
      if (data.trades && Array.isArray(data.trades)) {
        for (const trade of data.trades as TradeLog[]) {
          if (trade.entryRegime && trade.setup) {
            const key = `${trade.symbol}_${trade.entryRegime}_${trade.setup}`;
            if (!matrixMap.has(key)) {
              matrixMap.set(key, []);
            }
            matrixMap.get(key)!.push(trade);
          }
        }
      }
    } catch (e) {
      console.error(`Error reading ${file}:`, e);
    }
  }

  const outputMatrix: Record<string, SetupMetrics> = {};

  for (const [key, trades] of matrixMap.entries()) {
    let grossProfit = 0;
    let grossLoss = 0;
    let winners = 0;

    for (const t of trades) {
      if (t.pnl > 0) {
        grossProfit += t.pnl;
        winners++;
      } else {
        grossLoss += Math.abs(t.pnl);
      }
    }

    const netPnL = grossProfit - grossLoss;
    const profitFactor =
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
    const winRate = winners / trades.length;
    const averageWin = winners > 0 ? grossProfit / winners : 0;
    const averageLoss =
      trades.length - winners > 0 ? grossLoss / (trades.length - winners) : 0;
    const expectancy = winRate * averageWin - (1 - winRate) * averageLoss;

    outputMatrix[key] = {
      trades: trades.length,
      netPnL,
      grossProfit,
      grossLoss,
      profitFactor,
      expectancy,
      winRate,
      sampleSize: trades.length,
      averageWin,
      averageLoss,
    };
  }

  const outputFilePath = path.join(
    process.cwd(),
    "src",
    "server",
    "backtest",
    "data_cache",
    "setup_expectancy_matrix.json",
  );
  if (!fs.existsSync(path.dirname(outputFilePath))) {
    fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  }
  fs.writeFileSync(outputFilePath, JSON.stringify(outputMatrix, null, 2));
  console.log(`Matrix generated and saved to ${outputFilePath}`);
  console.log(`Total Keys: ${Object.keys(outputMatrix).length}`);
}

generateMatrix();

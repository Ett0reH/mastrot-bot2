import fs from 'fs';
import path from 'path';
import ccxt from 'ccxt';

const SYMBOLS = [
  "BTC/USD:USD",
  "ETH/USD:USD",
  "SOL/USD:USD",
  "AVAX/USD:USD",
  "XRP/USD:USD",
  "DOGE/USD:USD",
  "LINK/USD:USD",
  "ADA/USD:USD",
];

const start = "2022-01-01T00:00:00Z";
const end = "2026-05-09T00:00:00Z";

interface Bar {
    t: string; o: number; h: number; l: number; c: number; v: number;
}

async function fetchForSymbol(symbol: string) {
  const cacheDir = path.join(process.cwd(), "src", "server", "backtest", "data_cache");
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const cacheFileName = `${symbol.replace(/[\/:]/g, "_")}_15Min_KRAKEN_v2_${start.split("T")[0]}_${end.split("T")[0]}.json`;
  const cacheFilePath = path.join(cacheDir, cacheFileName);

  const binanceSymbol = symbol.split('/')[0] + '/USDT';

  let allBars: Bar[] = [];
  const tStart = new Date(start).getTime();
  const tEnd = new Date(end).getTime();
  const tFetchStart = tStart - 50 * 24 * 60 * 60 * 1000; // 50 days warmup
  let currentSince = tFetchStart;

  if (fs.existsSync(cacheFilePath)) {
     try {
         const data = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
         if (data.length > 0) {
             allBars = data;
             currentSince = new Date(allBars[allBars.length - 1].t).getTime() + 15 * 60 * 1000;
             console.log(`Resuming ${symbol} from ${new Date(currentSince).toISOString()} (${allBars.length} bars exist)`);
         }
     } catch (e) {
         console.log('Corrupt cache, starting fresh for ' + symbol);
     }
  }

  if (currentSince >= tEnd) {
      console.log(`Already complete for ${symbol}`);
      return;
  }

  const exchange = new ccxt.binance();
  let fetchCount = 0;
  let saveCount = 0;

  while (currentSince < tEnd) {
      try {
          const limit = 1000;
          const ohlcv = await exchange.fetchOHLCV(binanceSymbol, '15m', currentSince, limit);
          if (!ohlcv || ohlcv.length === 0) break;

          let lastTime = currentSince;
          for (const c of ohlcv) {
             const t = c[0];
             if (t > tEnd) continue;
             if (t < currentSince) continue;
             
             lastTime = t;
             if (allBars.length === 0 || new Date(allBars[allBars.length-1].t).getTime() < t) {
                allBars.push({ t: new Date(t).toISOString(), o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] });
             }
          }
          currentSince = lastTime + 15 * 60 * 1000;
          fetchCount++;
          saveCount++;

          if (fetchCount % 10 === 0) {
              console.log(`Fetched ${new Date(currentSince).toISOString()} for ${symbol} (${allBars.length} bars)`);
          }
          if (saveCount >= 20) {
              fs.writeFileSync(cacheFilePath, JSON.stringify(allBars));
              saveCount = 0;
          }

          if (ohlcv.length < limit - 5) break; 
          await new Promise(r => setTimeout(r, 200));
      } catch (e: any) {
          console.error(`Kraken err ${symbol}:`, e.message);
          await new Promise(r => setTimeout(r, 5000));
      }
  }
  fs.writeFileSync(cacheFilePath, JSON.stringify(allBars));
  console.log(`Completed ${symbol} with ${allBars.length} bars.`);
}

async function run() {
    const sym = process.argv[2];
    if (sym) {
       await fetchForSymbol(sym);
    } else {
       for (const s of SYMBOLS) {
          await fetchForSymbol(s);
       }
    }
}
run();

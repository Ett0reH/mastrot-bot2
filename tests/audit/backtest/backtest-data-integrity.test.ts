import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'src/server/backtest/data_cache');
const SYMBOLS = [
  "BTC_USD_USD", "ETH_USD_USD", "SOL_USD_USD", "LTC_USD_USD", 
  "XRP_USD_USD", "DOGE_USD_USD", "LINK_USD_USD", "ADA_USD_USD"
];

function testDataIntegrity() {
  const result = { pass: true, log: [] as string[] };
  result.log.push("Running Data Integrity Test...");
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.includes('KRAKEN_v2'));
  
  for (const sym of SYMBOLS) {
    try {
        const file = files.find(f => f.startsWith(sym) && f.includes('15Min'));
        if (!file) {
        result.log.push(`[WARN] Missing file for ${sym}`);
        continue;
        }
        const filePath = path.join(CACHE_DIR, file);
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        
        if (!Array.isArray(data)) {
            result.log.push(`[FAIL] Data for ${sym} is not an array. Type: ${typeof data}`);
            result.pass = false;
            continue;
        }

        if (data.length === 0) {
            result.log.push(`[FAIL] Data for ${sym} is empty.`);
            result.pass = false;
            continue;
        }

        let gaps = 0, nanCount = 0, sortErrors = 0;
        let maxGap = 0;

        for (let i = 1; i < data.length; i++) {
            const bar = data[i];
            const prevBar = data[i-1];
            
            const prev = prevBar.t ? new Date(prevBar.t).getTime() : NaN;
            const curr = bar.t ? new Date(bar.t).getTime() : NaN;
            
            if (isNaN(curr) || isNaN(prev)) {
               nanCount++;
               continue;
            }
            if (curr <= prev) {
                sortErrors++;
                result.pass = false;
            }
            const gap = curr - prev;
            if (gap > 15 * 60 * 1000) {
                gaps++;
                if (gap > maxGap) maxGap = gap;
            }

            if (isNaN(bar.o) || isNaN(bar.h) || isNaN(bar.l) || isNaN(bar.c) || isNaN(bar.v)) {
                nanCount++;
            }
        }

        if (sortErrors > 0) result.log.push(`[FAIL] ${sym} has ${sortErrors} unsorted/dup timestamps.`);
        if (nanCount > 0) {
            result.log.push(`[FAIL] ${sym} has ${nanCount} candles with missing/NaN values.`);
            result.pass = false;
        }
        result.log.push(`[INFO] ${sym} - Candles: ${data.length}, Gaps: ${gaps}, Max Gap (h): ${(maxGap / 3600000).toFixed(1)}`);
    } catch(e: any) {
        result.log.push(`[ERROR] processing ${sym}: ${e.message}`);
        result.pass = false;
    }
  }

  result.log.push(result.pass ? "PASS" : "FAIL");
  fs.writeFileSync('integrity_report.log', result.log.join('\n'));
  console.log("Integrity test finished. Check integrity_report.log");
  process.exit(result.pass ? 0 : 1);
}
testDataIntegrity();

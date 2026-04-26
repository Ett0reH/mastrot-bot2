import fs from 'fs';
import readline from 'readline';
import path from 'path';

const csvFilePath = path.join(process.cwd(), 'src/server/backtest/data_cache/XRP-USD+BTC-USD+DOGE-USD+ETH-USD+LINK-USD+ADA-USD+SOL-USD_4Hour_2015-01-01_2026-04-17.csv');

async function processData() {
  const fileStream = fs.createReadStream(csvFilePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let isHeader = true;
  const btcResults: any[] = [];
  const ethResults: any[] = [];
  const solResults: any[] = [];
  
  // Format: symbol,timestamp,open,high,low,close,volume
  // Expected JSON output: { t: string, o: number, h: number, l: number, c: number, v: number }

  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    
    const parts = line.split(',');
    if (parts.length < 7) continue;
    
    const symbol = parts[0];
    const timestampStr = parts[1];
    
    if (symbol !== 'BTC/USD' && symbol !== 'ETH/USD' && symbol !== 'SOL/USD') continue;
    
    const tsNum = parseInt(timestampStr, 10);
    const dateObj = new Date(tsNum);
    const tStr = dateObj.toISOString().slice(0, 10); // get YYYY-MM-DD
    
    // Filter by date: 2021-01-01 through 2023-12-31
    if (tStr >= '2021-01-01' && tStr <= '2023-12-31') {
       const row = {
         t: dateObj.toISOString(),
         o: parseFloat(parts[2]),
         h: parseFloat(parts[3]),
         l: parseFloat(parts[4]),
         c: parseFloat(parts[5]),
         v: parseFloat(parts[6])
       };
       if (symbol === 'BTC/USD') btcResults.push(row);
       if (symbol === 'ETH/USD') ethResults.push(row);
       if (symbol === 'SOL/USD') solResults.push(row);
    }
  }

  const save = (name: string, data: any[]) => {
    data.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
    fs.writeFileSync(path.join(process.cwd(), `src/server/backtest/data_cache/${name}`), JSON.stringify(data));
    console.log(`Saved ${data.length} rows to ${name}`);
  };

  save('BTC_FULL_CYCLE_21_23.json', btcResults);
  save('ETH_FULL_CYCLE_21_23.json', ethResults);
  save('SOL_FULL_CYCLE_21_23.json', solResults);
}

processData().catch(console.error);

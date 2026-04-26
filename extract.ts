import fs from 'fs';
import path from 'path';

const csvPath = path.join(process.cwd(), 'src/server/backtest/data_cache/XRP-USD+BTC-USD+DOGE-USD+ETH-USD+LINK-USD+ADA-USD+SOL-USD_4Hour_2015-01-01_2026-04-17.csv');
const outPath = path.join(process.cwd(), 'src/server/backtest/data_cache/BTC_2023_NORMAL.json');

const content = fs.readFileSync(csvPath, 'utf-8');
const lines = content.split('\n');
const result: any[] = [];
const START = 1672531200000; // Jan 1 2023
const END = 1703980800000;   // Dec 31 2023

for (const line of lines) {
  const parts = line.split(',');
  if (parts[0] !== 'BTC/USD') continue;
  const ts = parseInt(parts[1]);
  if (ts >= START && ts <= END) {
    result.push({
      t: new Date(ts).toISOString(),
      o: parseFloat(parts[2]),
      h: parseFloat(parts[3]),
      l: parseFloat(parts[4]),
      c: parseFloat(parts[5]),
      v: parseFloat(parts[6])
    });
  }
}

result.sort((a,b) => new Date(a.t).getTime() - new Date(b.t).getTime());
fs.writeFileSync(outPath, JSON.stringify(result));
console.log('Extracted ' + result.length + ' candles');

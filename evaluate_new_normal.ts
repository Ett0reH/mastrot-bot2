import * as fs from 'fs';

const reportPath = './backtest_report_latest.json';
const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

console.log("Normal Config:", data.engineStats.normalConfig);
console.log("Normal Stats Tracking:", data.engineStats.normalStats);

const normalTrades = data.stats.filter((t: any) => t.engine === 'NORMAL');
console.log("Total Normal Trades:", normalTrades.length);

const types = new Set(normalTrades.map((t: any) => t.setup));
console.log("Normal Setups found:", Array.from(types));

const reasons = new Set(normalTrades.map((t: any) => t.reason));
console.log("Normal Exit Reasons found:", Array.from(reasons));

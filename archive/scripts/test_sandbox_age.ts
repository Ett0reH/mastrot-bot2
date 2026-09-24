import { DerivativesClient } from '@siebly/kraken-api';
import "dotenv/config";

async function run() {
    const client = new DerivativesClient({
        apiKey: process.env.KRAKEN_API_KEY,
        apiSecret: process.env.KRAKEN_SECRET_KEY,
        strictParamValidation: true,
        testnet: true
    });
    const res = await client.getCandles({
        tickType: 'trade', 
        symbol: 'PF_XBTUSD',
        resolution: '1h' as any
    });
    const last = res.candles[res.candles.length - 1];
    console.log(last);
    console.log("Age in min:", (Date.now() - last.time) / 60000);
}
run();

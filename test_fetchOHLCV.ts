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
        resolution: '4h' as any
    });
    console.log("4h candles returned:", res?.candles?.length);
    const res1h = await client.getCandles({
        tickType: 'trade', 
        symbol: 'PF_XBTUSD',
        resolution: '1h' as any
    });
    console.log("1h candles returned:", res1h?.candles?.length);
}
run();

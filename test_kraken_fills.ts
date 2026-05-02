import "dotenv/config";
import { DerivativesClient } from '@siebly/kraken-api';

async function test() {
    const client = new DerivativesClient({
        apiKey: process.env.KRAKEN_API_KEY,
        apiSecret: process.env.KRAKEN_SECRET_KEY,
        testnet: process.env.KRAKEN_SANDBOX === 'true' || process.env.KRAKEN_SANDBOX === undefined
    });
    try {
        const logs = await client.getAccountLog();
        const trades = logs.logs.filter((l: any) => l.info === 'trade' || l.realized_pnl !== null);
        console.log("TRADES:", JSON.stringify(trades, null, 2));
    } catch(e) {
        console.log(e);
    }
}
test();

import "dotenv/config";
import { DerivativesClient } from '@siebly/kraken-api';

const client = new DerivativesClient({
    apiKey: process.env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_SECRET_KEY,
    strictParamValidation: true,
    testnet: process.env.KRAKEN_SANDBOX === 'true'
});

async function run() {
    try {
        const tick = await client.getTickers();
        console.log(tick ? "Tickers ok" : "Tickers issue");
    } catch (e: any) {
        console.log("Error in getTickers: " + e.message);
    }
}
run();

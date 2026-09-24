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
        const obs = await (client as any).getOpenOrders();
        console.log("getOpenOrders ok", obs ? obs.openOrders.length : null);
    } catch (e: any) {
        console.log("Error in getOpenOrders: " + e.message);
    }
}
run();

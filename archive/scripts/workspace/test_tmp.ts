import "dotenv/config";
import { DerivativesClient } from '@siebly/kraken-api';

async function run() {
    const client = new DerivativesClient({
        apiKey: process.env.KRAKEN_API_KEY,
        apiSecret: process.env.KRAKEN_API_SECRET,
        testnet: process.env.KRAKEN_SANDBOX === 'true' || process.env.KRAKEN_SANDBOX === undefined
    });

    try {
        const { openPositions } = await client.getOpenPositions();
        console.log("OPEN POSITIONS:", JSON.stringify(openPositions, null, 2));
    } catch(e) {
        console.error(e);
    }
}
run();

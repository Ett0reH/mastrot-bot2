import "dotenv/config";
import { DerivativesClient } from '@siebly/kraken-api';

async function test() {
    const client = new DerivativesClient({
        apiKey: process.env.KRAKEN_API_KEY,
        apiSecret: process.env.KRAKEN_SECRET_KEY,
        testnet: process.env.KRAKEN_SANDBOX === 'true' || process.env.KRAKEN_SANDBOX === undefined
    });
    try {
        const res = await client.getAccounts();
        console.log(JSON.stringify(res.accounts.flex, null, 2));
    } catch(e) {
        console.log(e);
    }
}
test();

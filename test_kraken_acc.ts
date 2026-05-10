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
        console.log("KRAKEN SDK:", !!process.env.KRAKEN_API_KEY);
        const accs = await client.getAccounts();
        console.log(JSON.stringify(accs, null, 2));
    } catch (e) {
        console.error(e);
    }
}
run();

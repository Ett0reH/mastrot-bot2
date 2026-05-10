import "dotenv/config";
import { DerivativesClient } from '@siebly/kraken-api';

async function test() {
    const client = new DerivativesClient({
        apiKey: process.env.KRAKEN_API_KEY || "",
        apiSecret: process.env.KRAKEN_SECRET_KEY || ""
    });
    try {
        const res = await client.getAccounts();
        console.log(JSON.stringify(res, null, 2));
    } catch (e: any) {
        console.error("FAIL", e.message);
    }
}
test();

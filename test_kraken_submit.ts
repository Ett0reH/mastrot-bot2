import "dotenv/config";
import { DerivativesClient } from '@siebly/kraken-api';

async function testSubmit() {
    const isSandbox = process.env.KRAKEN_SANDBOX !== 'false';
    const client = new DerivativesClient({
        apiKey: process.env.KRAKEN_API_KEY,
        apiSecret: process.env.KRAKEN_SECRET_KEY,
        testnet: isSandbox
    });
    try {
        const payload: any = {
            symbol: "PF_XRPUSD",
            side: "buy",
            size: 32.36,
            orderType: "lmt",
            limitPrice: 1.44
        };
        console.log("Submitting order:", payload);
        const res = await client.submitOrder(payload);
        console.log("Response:", JSON.stringify(res, null, 2));
    } catch (e: any) {
        console.error("Error:", e.body ? JSON.stringify(e.body, null, 2) : e);
    }
}
testSubmit().catch(console.error);

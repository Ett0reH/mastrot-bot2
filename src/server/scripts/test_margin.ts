import { DerivativesClient } from '@siebly/kraken-api';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../../.env') });

async function test() {
    const isSandbox = process.env.KRAKEN_SANDBOX !== 'false';
    const client = new DerivativesClient({
        apiKey: process.env.KRAKEN_API_KEY!,
        apiSecret: process.env.KRAKEN_SECRET_KEY!,
        testnet: isSandbox
    });
    
    try {
        const res = await client.getAccounts();
        console.log("getAccounts:", JSON.stringify(res, null, 2));
    } catch (e: any) {
        console.error("Error:", e.message);
    }
}
test();

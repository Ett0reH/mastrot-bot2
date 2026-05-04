import { DerivativesClient } from '@siebly/kraken-api';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const isSandbox = process.env.KRAKEN_SANDBOX !== 'false';
const client = new DerivativesClient({
    apiKey: process.env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_SECRET_KEY,
    testnet: isSandbox
});

async function check() {
    console.log("Fetching open orders...");
    const openOrders = await client.getOpenOrders();
    console.log(JSON.stringify(openOrders.openOrders, null, 2));
}

check().catch(console.error);

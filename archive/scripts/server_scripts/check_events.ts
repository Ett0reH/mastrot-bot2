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

async function events() {
    console.log("Fetching recent order events...");
    const res = await client.getOrderEvents();
    const events = res.elements.slice(0, 10);
    console.log(JSON.stringify(events, null, 2));
}

events().catch(console.error);

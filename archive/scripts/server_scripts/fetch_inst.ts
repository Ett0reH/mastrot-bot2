import { DerivativesClient } from '@siebly/kraken-api';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const isSandbox = process.env.KRAKEN_SANDBOX === 'true' || process.env.KRAKEN_SANDBOX === undefined;
const client = new DerivativesClient({
    apiKey: process.env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_SECRET_KEY,
    testnet: isSandbox
});

async function getLimits() {
    try {
        const instRes = await client.getInstruments();
        const inst: any = instRes.instruments.find((x: any) => x.symbol === 'PF_XBTUSD');
        console.log("PF_XBTUSD Info:", JSON.stringify(inst, null, 2));
    } catch(e: any) {
        console.error(e.message);
    }
}
getLimits();

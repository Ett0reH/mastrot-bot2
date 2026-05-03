import { DerivativesClient } from '@siebly/kraken-api';
import "dotenv/config";

async function run() {
    const client = new DerivativesClient({
        apiKey: process.env.KRAKEN_API_KEY,
        apiSecret: process.env.KRAKEN_SECRET_KEY,
        strictParamValidation: true,
        testnet: true
    });
    const data = await client.getInstruments();
    const pf = data.instruments.filter(x => x.symbol.includes('PF_') || x.symbol.includes('PI_')).map(x => x.symbol);
    console.log(pf);
}
run();

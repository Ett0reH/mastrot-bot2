import "dotenv/config";
import { DerivativesClient } from '@siebly/kraken-api';

async function testSubmit() {
    const isSandbox = process.env.KRAKEN_SANDBOX !== 'false';
    const client = new DerivativesClient({
        apiKey: process.env.KRAKEN_API_KEY,
        apiSecret: process.env.KRAKEN_SECRET_KEY,
        testnet: isSandbox
    });
    const res = await client.getInstruments();
    for (const sym of ['PF_XBTUSD', 'PF_ETHUSD', 'PF_SOLUSD', 'PF_LINKUSD', 'PF_ADAUSD', 'PF_XRPUSD', 'PF_DOGEUSD']) {
       const i = res.instruments.find(x => x.symbol === sym);
       console.log(`${sym.padEnd(12)} - tickSize: ${i?.tickSize.toString().padEnd(8)} precision: ${i?.contractValueTradePrecision}`);
    }
}
testSubmit().catch(console.error);

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
        const res = await client.getInstruments();
        const btc = res.instruments.find(i => i.symbol === 'PF_XBTUSD');
        const xrp = res.instruments.find(i => i.symbol === 'PF_XRPUSD');
        const doge = res.instruments.find(i => i.symbol === 'PF_DOGEUSD');
        const eth = res.instruments.find(i => i.symbol === 'PF_ETHUSD');
        const sol = res.instruments.find(i => i.symbol === 'PF_SOLUSD');
        const link = res.instruments.find(i => i.symbol === 'PF_LINKUSD');
        console.log("BTC:", btc);
        console.log("XRP:", xrp);
    } catch (e: any) {
        console.error("Error:", e);
    }
}
testSubmit().catch(console.error);

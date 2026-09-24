import { DerivativesClient } from '@siebly/kraken-api';
async function test() {
    const client = new DerivativesClient({
        testnet: false,
        baseUrl: 'https://futures.kraken.com/derivatives/api/v3'
    });
    try {
        const res = await client.getInstruments();
        const coins = ['PI_XBTUSD', 'PI_ETHUSD', 'PI_SOLUSD', 'PI_XRPUSD', 'PI_LINKUSD', 'PI_DOGEUSD'];
        const instruments = res.instruments.filter((i: any) => coins.includes(i.symbol));
        for(const i of instruments) {
          console.log(i.symbol, ": contractSize =", i.contractSize, ", tradeable =", i.tradeable);
          console.log(JSON.stringify(i, null, 2));
        }
    } catch(e: any) {
        console.error("Error:", e.message);
    }
}
test();

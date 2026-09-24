import { DerivativesClient } from '@siebly/kraken-api';
async function test() {
    const client = new DerivativesClient({
        testnet: false,
    });
    try {
        const res = await client.getInstruments();
        const coins = ['PF_XBTUSD', 'PF_ETHUSD', 'PF_SOLUSD', 'PF_XRPUSD', 'PF_LINKUSD', 'PF_DOGEUSD', 'PI_XBTUSD', 'PI_ETHUSD'];
        const instruments = res.instruments.filter((i: any) => coins.includes(i.symbol));
        for(const i of instruments) {
          if (i.symbol.startsWith('PF_')) {
             console.log(i.symbol, ": contractSize =", i.contractSize, "contractValueTradePrecision =", i.contractValueTradePrecision);
             console.log(JSON.stringify(i.marginLevels?.[0], null, 2));
          }
        }
    } catch(e: any) {
        console.error("Error:", e.message);
    }
}
test();

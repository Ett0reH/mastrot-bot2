import { DerivativesClient } from '@siebly/kraken-api';
async function test() {
    const client = new DerivativesClient({
        testnet: false,
        baseUrl: 'https://futures.kraken.com/derivatives/api/v3'
    });
    try {
        const res1 = await client.getCandles({
            tickType: 'trade', 
            symbol: 'PF_XBTUSD',
            resolution: '1m'
        });
        console.log("PF_XBTUSD:", res1.candles?.length);
    } catch(e: any) {
        console.error("Error PF_XBTUSD:", e.message);
    }
    
    try {
        const res2 = await client.getCandles({
            tickType: 'trade', 
            symbol: 'PI_XBTUSD',
            resolution: '1m'
        });
        console.log("PI_XBTUSD:", res2.candles?.length);
    } catch(e: any) {
        console.error("Error PI_XBTUSD:", e.message);
    }

    try {
        const res3 = await client.getCandles({
            tickType: 'trade', 
            symbol: 'pi_xbtusd',
            resolution: '1m'
        });
        console.log("pi_xbtusd:", res3.candles?.length);
    } catch(e: any) {
        console.error("Error pi_xbtusd:", e.message);
    }
}
test();

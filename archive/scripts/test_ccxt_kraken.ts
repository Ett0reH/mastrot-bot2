import { DerivativesClient } from '@siebly/kraken-api';
import ccxt from 'ccxt';

async function test() {
    const kraken = new ccxt.krakenfutures();
    try {
        const ohlcv = await kraken.fetchOHLCV('BTC/USD:USD', '4h', undefined, 300);
        console.log(`BTC 4H candles: ${ohlcv.length}`);
    } catch(e: any) {
        console.log("Error:", e.message);
    }
}
test();

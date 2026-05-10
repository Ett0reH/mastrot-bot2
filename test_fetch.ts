import ccxt from "ccxt";

async function test() {
   const exchange = new ccxt.krakenfutures();
   try {
     const since = new Date('2026-04-23T00:00:00Z').getTime();
     // PF_XBTUSD
     const c = await exchange.fetchOHLCV('BTC/USD:USD', '15m', since, 100);
     console.log('BTC OHLCV Success! Length:', c.length);
     if (c.length > 0) {
        console.log('First bar:', new Date(c[0][0]), c[0]);
     }
   } catch(e:any) {
     console.error('BTC OHLCV Error:', e.message);
   }
   process.exit(0);
}
test();

import { initExchange, exchange } from './src/server/liveEngine.ts';
async function test() {
   await initExchange();
   try {
     const c = await exchange.fetchOHLCV('BTC/USD:USD', '1h', undefined, 10);
     console.log('BTC OHLCV Success! Length:', c.length);
   } catch(e:any) {
     console.error('BTC OHLCV Error:', e.message);
   }
   process.exit(0);
}
test();

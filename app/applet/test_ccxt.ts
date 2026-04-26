import ccxt from 'ccxt';
async function test() {
  const ex = new ccxt.alpaca({ apiKey: 'PKD4NN6JNJGLBVQPL5YFLJ3RCP', secret: '5HMSSeUm3jLjNoik98vS8JUiWwdBWRxQcGJQkYtzL3Ba' });
  try {
     const data = await ex.fetchOHLCV('BTC/USD', '1h', undefined, 55);
     console.log("LENGTH 1H:", data.length);
     const data4 = await ex.fetchOHLCV('BTC/USD', '4h', undefined, 210);
     console.log("LENGTH 4H:", data4.length);
  } catch(e) { console.error('ERROR:', e.message); }
}
test();

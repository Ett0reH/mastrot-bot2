import "dotenv/config";
import ccxt from 'ccxt';
async function test() {
  const cleanApiKey = process.env.ALPACA_API_KEY?.replace(/^["']|["']$/g, '').trim();
  const cleanSecret = process.env.ALPACA_SECRET_KEY?.replace(/^["']|["']$/g, '').trim();
  const ex = new ccxt.alpaca({ apiKey: cleanApiKey, secret: cleanSecret });
  try {
     const data = await ex.fetchOHLCV('BTC/USD', '1h', undefined, 55);
     console.log("LENGTH 1H:", data.length);
     const data4 = await ex.fetchOHLCV('BTC/USD', '4h', undefined, 210);
     console.log("LENGTH 4H:", data4.length);
  } catch(e) { console.error('ERROR:', e.message); }
}
test();

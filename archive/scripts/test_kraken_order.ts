import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const apiKey = process.env.KRAKEN_API_KEY;
  const secret = process.env.KRAKEN_SECRET_KEY;

  if (!apiKey || !secret) {
      console.error("Missing KRAKEN_API_KEY or KRAKEN_SECRET_KEY in .env");
      return;
  }

  const exchange = new ccxt.krakenfutures({
      apiKey: apiKey,
      secret: secret,
      enableRateLimit: true
  });
  exchange.setSandboxMode(true);

  try {
      console.log("Connessione a Kraken demo-futures...");
      const balance = await exchange.fetchBalance();
      console.log("Connessione riuscita! Bilanci (total):");
      const balances = Object.keys(balance.total).filter(asset => balance.total[asset] > 0);
      if (balances.length > 0) {
        console.log(balances.map(asset => `${asset}: ${balance.total[asset]}`).join(', '));
      }
      
      await exchange.loadMarkets();
      
      // Mettiamo un ordine minimo usando DOGE o XRP (1 contratto)
      const targetSymbol = 'DOGE/USD:USD'; 
      const amount = 10; 
      
      console.log(`\nPiazzando ordine LIMIT (Fill or Kill in pratica, oppure lo lasciamo aperto) -> Mettiamo un MARKET buy per ${amount} contratti di ${targetSymbol}...`);
      
      const ticker = await exchange.fetchTicker(targetSymbol);
      const limitPrice = ticker.last;
      
      // Use limit order that is likely to be filled immediately, or market if collars permit
      // To avoid collars, a limit order slightly above current price acts like market.
      const order = await exchange.createLimitBuyOrder(targetSymbol, amount, limitPrice * 1.01);
      
      console.log("!!! ORDINE ESEGUITO CON SUCCESSO E LASCIATO APERTO !!!");
      console.log(`ID: ${order.id}`);
      console.log(`Status: ${order.status}`);
      console.log(`Prezzo: ${order.price}`);
      
  } catch(e: any) {
      console.error("\nErrore durante l'esecuzione del test:", e.message);
  }
}

run();

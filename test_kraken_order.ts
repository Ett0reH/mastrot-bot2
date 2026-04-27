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
  // Abilitiamo il sandbox (demo-futures.kraken.com)
  exchange.setSandboxMode(true);

  try {
      console.log("Connessione a Kraken demo-futures... (https://demo-futures.kraken.com/)");
      const balance = await exchange.fetchBalance();
      console.log("Connessione riuscita! Bilanci (total):");
      const balances = Object.keys(balance.total).filter(asset => balance.total[asset] > 0);
      if (balances.length > 0) {
        console.log(balances.map(asset => `${asset}: ${balance.total[asset]}`).join(', '));
      } else {
        console.log("Nessun bilancio positivo trovato (o balance.total è vuoto).");
      }
      
      await exchange.loadMarkets();
      // Kraken Futures solitamente formatta i perpetual su USD come XRP/USD:USD
      const markets = Object.keys(exchange.markets).filter(k => k.includes('XRP') && k.includes('USD') && exchange.markets[k].swap);
      
      const targetSymbol = markets.length > 0 ? markets[0] : 'XRP/USD:USD';
      const amount = 5; // size minima solitamente 1 o simile, mettiamo 5 contratti XRP
      
      console.log(`\nPiazzando ordine di BUY MARKET per ${amount} contratti di ${targetSymbol}...`);
      const order = await exchange.createMarketOrder(targetSymbol, 'buy', amount);
      
      console.log("!!! ORDINE ESEGUITO CON SUCCESSO !!!");
      console.log(`ID: ${order.id}`);
      console.log(`Status: ${order.status}`);
      console.log(`Prezzo riempito (avg): ${order.average}`);
      
      // Prova a chiudere la posizione
      console.log(`\nChiudendo la posizione aperta per pulizia (SELL ${amount} ${targetSymbol})...`);
      const closeOrder = await exchange.createMarketOrder(targetSymbol, 'sell', amount);
      console.log("!!! POSIZIONE CHIUSA !!!");
      console.log(`ID: ${closeOrder.id}`);
      console.log(`Status: ${closeOrder.status}`);
      console.log(`Prezzo riempito (avg): ${closeOrder.average}`);
      
  } catch(e: any) {
      console.error("\nErrore durante l'esecuzione del test:", e.message);
  }
}

run();

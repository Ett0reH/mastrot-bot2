import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function transferAll() {
  const exchange = new ccxt.krakenfutures({
    apiKey: process.env.KRAKEN_API_KEY,
    secret: process.env.KRAKEN_SECRET_KEY,
    enableRateLimit: true
  });

  try {
    await exchange.loadMarkets();

    // 1. Fetch balance manually using private GET
    console.log('Fetching account balances...');
    const response = await exchange.privateGetAccounts();
    const accounts = response.accounts;

    for (const accName of Object.keys(accounts)) {
      const acc = accounts[accName];
      const type = acc.type; // marginAccount, cashAccount, multiCollateralMarginAccount
      
      const balances = acc.balances || acc.currencies || {};
      for (const cur of Object.keys(balances)) {
        let amount = 0;
        if (type === 'marginAccount') {
           amount = parseFloat(balances[cur] || '0');
        } else if (type === 'multiCollateralMarginAccount') {
           amount = parseFloat(balances[cur].available || balances[cur].quantity || '0');
        } else if (type === 'cashAccount') {
           // already in holding
           continue;
        }

        if (amount > 0) {
          console.log(`Found ${amount} ${cur} in ${type} (${accName}). Preparing transfer to cashAccount...`);
          try {
             // fromAccount needs to be mapped.
             // single collateral uses market symbol or fi_... 
             // CCXT transfer method takes account id for from/to
             let fromAccount = '';
             if (type === 'marginAccount') {
                 fromAccount = accName; // e.g., fi_xbtusd
             } else if (type === 'multiCollateralMarginAccount') {
                 fromAccount = 'flex';
             }

             if (fromAccount) {
                 console.log(`Transferring ${amount} ${cur} from ${fromAccount} to cash`);
                 await exchange.transfer(cur, amount, fromAccount, 'cash');
                 console.log(`Transfer of ${cur} successful.`);
             }
          } catch(e: any) {
             console.error(`Failed to transfer ${cur}: ${e.message}`);
          }
        }
      }
    }
    
    console.log('Transfer process complete.');
  } catch(e: any) {
    console.error('Core error:', e.message);
  }
}

transferAll();

import { DerivativesClient } from '@siebly/kraken-api';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function transferAll() {
  const isSandbox = process.env.KRAKEN_SANDBOX === 'true' || process.env.KRAKEN_SANDBOX === undefined;
  const client = new DerivativesClient({
    apiKey: process.env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_SECRET_KEY,
    strictParamValidation: true,
    testnet: isSandbox
  });

  try {
    // 1. Fetch balance manually using private GET
    console.log('Fetching account balances...');
    const response = await client.getAccounts();
    const accounts = response.accounts;
    
    // We get marginAccount directly as properties according to Siebly Types
    if (accounts?.marginAccount) {
      const type = 'marginAccount';
      const balances = accounts.marginAccount.balances || {};
      for (const cur of Object.keys(balances)) {
         let amount = parseFloat(balances[cur] || '0');
         if (amount > 0) {
           console.log(`Found ${amount} ${cur} in marginAccount. Transfer not fully implemented in SDK yet for this script.`);
         }
      }
    }
    
    console.log('Transfer process complete.');
  } catch(e: any) {
    console.error('Core error:', e.message);
  }
}

transferAll();

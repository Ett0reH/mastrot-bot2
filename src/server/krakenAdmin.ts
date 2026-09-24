// Operazioni amministrative su Kraken (debug dei conti, chiusura d'emergenza + trasferimento
// al wallet cash), spostate da server.ts. Ambiente e chiavi arrivano SOLO dalla configurazione
// (TRADING_MODE): niente più default di sandbox divergenti tra percorsi (D02).
// Queste funzioni verranno sostituite dal kill switch e dall'adapter unico (F3/F5).
import { DerivativesClient } from '@siebly/kraken-api';
import * as ccxt from 'ccxt';
import type { EngineConfig } from '../engine/config/config';
import { krakenClientOptions } from '../engine/config/runtime';
import type { KrakenAdminApi } from './app';

function requireCredentials(config: EngineConfig) {
  if (!config.ordersEnabled || !config.kraken.credentials) {
    throw new Error('Operazione Kraken non disponibile senza credenziali (modalità shadow)');
  }
  return config.kraken.credentials;
}

export function createKrakenAdmin(config: EngineConfig): KrakenAdminApi {
  return {
    async debugAccounts() {
      requireCredentials(config);
      const client = new DerivativesClient(krakenClientOptions(config));
      const accounts = await client.getAccounts();
      const positions = await client.getOpenPositions();
      return { mode: config.mode, environment: config.kraken.tradingEnvironment, accounts, positions };
    },

    async emergencyCloseAndTransfer() {
      const creds = requireCredentials(config);
      const exchange = new ccxt.krakenfutures({ apiKey: creds.apiKey, secret: creds.apiSecret, enableRateLimit: true });
      if (config.kraken.tradingEnvironment === 'demo') exchange.setSandboxMode(true);
      await exchange.loadMarkets();

      const logs: string[] = [`Starting Emergency Close & Transfer (${config.mode})...`];

      // 1. Close all open positions on Kraken Futures
      try {
        const pos = await exchange.fetchPositions();
        logs.push(`Found ${pos.length} position objects.`);
        for (const p of pos) {
          const contracts = p.contracts ?? 0;
          if (Math.abs(contracts) > 0) {
            const side = contracts > 0 ? 'sell' : 'buy';
            logs.push(`Closing orphaned position: ${p.symbol} (${contracts}) with ${side}...`);
            await exchange.createMarketOrder(p.symbol, side, Math.abs(contracts), undefined, { reduceOnly: true });
            logs.push(`Successfully closed ${p.symbol}.`);
          }
        }
      } catch (err) {
        logs.push(`Position closing error: ${(err as Error).message}`);
      }

      // 2. Transfer all balances to Holding (cash)
      try {
        logs.push('Fetching account balances...');
        const response = await (exchange as any).privateGetAccounts();
        const accounts = response.accounts;
        for (const accName of Object.keys(accounts)) {
          const acc = accounts[accName];
          const type = acc.type;
          const balances = acc.balances || acc.currencies || {};
          for (const cur of Object.keys(balances)) {
            let amount = 0;
            if (type === 'marginAccount') {
              amount = parseFloat(balances[cur] || '0');
            } else if (type === 'multiCollateralMarginAccount') {
              amount = parseFloat(balances[cur].available || balances[cur].quantity || '0');
            } else if (type === 'cashAccount') {
              continue; // already in holding
            }
            if (amount > 0) {
              logs.push(`Found ${amount} ${cur} in ${type} (${accName}). Processing transfer...`);
              try {
                let fromAccount = '';
                if (type === 'marginAccount') fromAccount = accName;
                else if (type === 'multiCollateralMarginAccount') fromAccount = 'flex';
                if (fromAccount) {
                  let code = String(cur).toUpperCase();
                  if (code === 'XBT') code = 'BTC';
                  await exchange.transfer(code, amount, fromAccount, 'cash');
                  logs.push(`SUCCESS: Transferred ${amount} ${code} to Holding Wallet.`);
                }
              } catch (e) {
                logs.push(`ERROR transferring ${cur}: ${(e as Error).message}`);
              }
            }
          }
        }
      } catch (err) {
        logs.push(`Transfer error: ${(err as Error).message}`);
      }

      logs.push('Emergency process complete.');
      return { logs };
    },
  };
}

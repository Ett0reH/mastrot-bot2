// Operazioni amministrative su Kraken: debug dei conti e chiusura d'emergenza con trasferimento
// al wallet cash. Ambiente e chiavi arrivano SOLO dalla configurazione (D02) e tutto passa
// dall'adapter unico (F3, D33): niente più ccxt, ogni ordine ha un cliOrdId (D18).
// La chiusura d'emergenza: cancella gli ordini aperti, chiude ogni posizione reduceOnly, verifica
// che il conto sia flat e SOLO ALLORA trasferisce i fondi (togliere margine a una posizione
// ancora aperta potrebbe farla liquidare). Il kill switch completo arriva in F5.
import type { FuturesAccounts } from '@siebly/kraken-api';
import type { EngineConfig } from '../engine/config/config';
import { createKrakenFuturesApi, type KrakenFuturesApi } from '../engine/exchange/krakenApi';
import { KrakenAdapter } from '../engine/exchange/krakenAdapter';
import { OrderManager } from '../engine/exchange/orderManager';
import { InMemoryOrderStore, type OrderStore } from '../engine/exchange/orders';
import type { KrakenAdminApi } from './app';

export interface KrakenAdminDeps {
  api?: KrakenFuturesApi;
  store?: OrderStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function requireCredentials(config: EngineConfig): void {
  if (!config.ordersEnabled || !config.kraken.credentials) {
    throw new Error('Operazione Kraken non disponibile senza credenziali (modalità shadow)');
  }
}

/** Saldi trasferibili al wallet cash: conto flex (multi-collateral) e conti margin single-collateral. */
export function transferableBalances(accounts: FuturesAccounts): { fromAccount: string; unit: string; amount: number }[] {
  const out: { fromAccount: string; unit: string; amount: number }[] = [];
  for (const [name, account] of Object.entries(accounts)) {
    if (!account) continue;
    if (account.type === 'multiCollateralMarginAccount') {
      for (const [unit, c] of Object.entries(account.currencies)) if (c.quantity > 0) out.push({ fromAccount: 'flex', unit, amount: c.quantity });
    } else if (account.type === 'marginAccount') {
      for (const [unit, value] of Object.entries(account.balances)) {
        const amount = Number(value);
        if (Number.isFinite(amount) && amount > 0) out.push({ fromAccount: name, unit, amount });
      }
    }
  }
  return out;
}

export function createKrakenAdmin(config: EngineConfig, deps: KrakenAdminDeps = {}): KrakenAdminApi {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const build = () => {
    const adapter = new KrakenAdapter(deps.api ?? createKrakenFuturesApi(config), { now, sleep });
    const orders = new OrderManager(adapter, deps.store ?? new InMemoryOrderStore(), { now, processWindowMs: 5_000, graceMs: 2_000 });
    return { adapter, orders };
  };

  return {
    async debugAccounts() {
      requireCredentials(config);
      const { adapter } = build();
      return { mode: config.mode, environment: config.kraken.tradingEnvironment, accounts: await adapter.accounts(), positions: await adapter.openPositions() };
    },

    async emergencyCloseAndTransfer() {
      requireCredentials(config);
      const { adapter, orders } = build();
      const runId = new Date(now()).toISOString();
      const logs: string[] = [`Chiusura d'emergenza (${config.mode}, ${runId})`];

      const cancel = await adapter.cancelAllOrders(undefined, 'protective');
      logs.push(cancel.outcome === 'ok' ? `Ordini cancellati: ${cancel.value.cancelledOrders.length}` : `Cancellazione degli ordini fallita: ${cancel.error.message}`);

      const positions = await adapter.openPositions('protective');
      logs.push(`Posizioni aperte: ${positions.length}`);
      for (const p of positions) {
        const record = await orders.submit(
          { intentKey: `emergency-${runId}-${p.symbol}`, purpose: 'EMERGENCY_CLOSE', symbol: p.symbol, side: p.side === 'long' ? 'sell' : 'buy', orderType: 'mkt', size: p.size, reduceOnly: true },
          1,
          'protective',
        );
        logs.push(`${p.symbol}: chiusura ${record.cliOrdId} → ${record.state}${record.lastError ? ` (${record.lastError})` : ''}`);
      }
      // Gli esiti incerti si risolvono dopo processBefore: si attende e si riconcilia.
      for (let i = 0; i < 5 && (await orders.store.active()).length > 0; i++) {
        await sleep(3_000);
        for (const r of await orders.reconcileAll('protective')) logs.push(`${r.symbol}: riconciliato ${r.cliOrdId} → ${r.state}`);
      }

      const remaining = await adapter.openPositions('protective');
      if (remaining.length > 0) {
        logs.push(`ATTENZIONE: il conto NON è flat (${remaining.map((p) => `${p.symbol} ${p.side} ${p.size}`).join(', ')}): trasferimento annullato`);
        return { logs };
      }
      logs.push('Conto flat verificato.');

      for (const t of transferableBalances(await adapter.accounts())) {
        const res = await adapter.walletTransfer({ fromAccount: t.fromAccount, toAccount: 'cash', unit: t.unit, amount: t.amount });
        logs.push(res.outcome === 'ok' ? `Trasferiti ${t.amount} ${t.unit} da ${t.fromAccount} al wallet cash` : `Trasferimento di ${t.unit} fallito: ${res.error.message}`);
      }
      logs.push('Procedura completata.');
      return { logs };
    },
  };
}

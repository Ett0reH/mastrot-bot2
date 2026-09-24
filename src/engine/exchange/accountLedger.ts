// Ledger dall'account log di Kraken (F4: D23, D28; invariante I12).
//
// Ogni voce dell'account log (api/history/v3/account-log, tipo FuturesAccountLogEntry) viene
// salvata e classificata: fee dei trade, funding realizzato, trasferimenti (depositi e prelievi),
// altro. L'equity del bot resta CAPITAL_CAP_USD + PnL del bot: depositi e prelievi non la
// cambiano, ma sono registrati e segnalati in modo esplicito (e il collateral limita il sizing).
// Classificazione per campi documentati; i valori di `info` sono da verificare in demo.
import type { FuturesAccountLogEntry } from '@siebly/kraken-api';
import type { DocumentStore } from '../persistence/documentStore';
import type { KrakenAdapter } from './krakenAdapter';

export type LedgerKind = 'trade' | 'funding' | 'transfer' | 'other';

export interface LedgerEntry {
  id: number;
  kind: LedgerKind;
  date: string;
  info: string;
  asset: string;
  contract: string | null;
  fee: number | null;
  realizedPnl: number | null;
  realizedFunding: number | null;
  /** Variazione del saldo del conto (new_balance − old_balance). */
  balanceChange: number;
  execution: string | null;
}

export function classifyLedgerEntry(e: FuturesAccountLogEntry): LedgerKind {
  if (e.realized_funding !== null && e.realized_funding !== 0) return 'funding';
  if (e.execution !== null || e.trade_price !== null) return 'trade';
  if (/transfer|deposit|withdraw/i.test(e.info)) return 'transfer';
  return 'other';
}

export function toLedgerEntry(e: FuturesAccountLogEntry): LedgerEntry {
  return {
    id: e.id,
    kind: classifyLedgerEntry(e),
    date: e.date,
    info: e.info,
    asset: e.asset,
    contract: e.contract,
    fee: e.fee,
    realizedPnl: e.realized_pnl,
    realizedFunding: e.realized_funding,
    balanceChange: e.new_balance - e.old_balance,
    execution: e.execution,
  };
}

export interface LedgerSyncResult {
  added: LedgerEntry[];
  lastId: number;
}

export class AccountLedger {
  constructor(private readonly adapter: KrakenAdapter, private readonly docs: DocumentStore, private readonly onWrite: () => void = () => {}) {}

  /** Legge le voci successive a `lastId`, le salva e restituisce le nuove. */
  async sync(lastId: number): Promise<LedgerSyncResult> {
    const added: LedgerEntry[] = [];
    let cursor = lastId;
    for (let page = 0; page < 10; page++) {
      const logs = (await this.adapter.accountLog(cursor + 1)).filter((e) => e.id > cursor).sort((a, b) => a.id - b.id);
      if (logs.length === 0) break;
      for (const raw of logs) {
        const entry = toLedgerEntry(raw);
        await this.docs.set(`ledger/${String(entry.id).padStart(12, '0')}`, entry);
        this.onWrite();
        added.push(entry);
        cursor = entry.id;
      }
      if (logs.length < 500) break;
    }
    return { added, lastId: cursor };
  }
}

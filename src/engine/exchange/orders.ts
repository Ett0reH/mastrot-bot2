// Ordini: macchina a stati, cliOrdId deterministico e archivio (F3, invarianti I8 e I9).
//
//   INTENT_CREATED → SUBMITTED → ACKNOWLEDGED → PARTIAL → FILLED
//                        │            │           └──────→ CANCELED (con eventuale fill parziale)
//                        ├────────────┴──────────────────→ CANCELED / REJECTED
//                        └─→ UNKNOWN (esito incerto) → qualsiasi stato, solo dopo la riconciliazione
// Un ordine UNKNOWN non è mai considerato eseguito o chiuso per default.
import { createHash } from 'node:crypto';

export type OrderState = 'INTENT_CREATED' | 'SUBMITTED' | 'ACKNOWLEDGED' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'UNKNOWN';
export type OrderPurpose = 'ENTRY' | 'EXIT' | 'STOP' | 'EMERGENCY_CLOSE' | 'PROTECT';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'ioc' | 'lmt' | 'mkt' | 'stp';

export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set(['FILLED', 'CANCELED', 'REJECTED']);

const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  INTENT_CREATED: ['SUBMITTED'],
  SUBMITTED: ['ACKNOWLEDGED', 'PARTIAL', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN'],
  ACKNOWLEDGED: ['ACKNOWLEDGED', 'PARTIAL', 'FILLED', 'CANCELED', 'UNKNOWN'],
  PARTIAL: ['PARTIAL', 'FILLED', 'CANCELED', 'UNKNOWN'],
  UNKNOWN: ['ACKNOWLEDGED', 'PARTIAL', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN'],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
};

export class OrderStateError extends Error {}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!TRANSITIONS[from].includes(to)) throw new OrderStateError(`Transizione non ammessa: ${from} → ${to}`);
}

export interface OrderFill {
  fillId: string;
  price: number;
  size: number;
  time: string;
}

export interface OrderRecord {
  cliOrdId: string;
  /** Intento o posizione a cui appartiene (es. id della posizione del core). */
  intentKey: string;
  purpose: OrderPurpose;
  attempt: number;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  size: number;
  limitPrice: number | null;
  stopPrice: number | null;
  reduceOnly: boolean;
  state: OrderState;
  exchangeOrderId: string | null;
  filledSize: number;
  fills: OrderFill[];
  /** Oltre questo istante Kraken non elabora più l'ordine (parametro processBefore). */
  processBefore: string;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  history: { at: string; state: OrderState; note: string }[];
}

const PURPOSE_CODE: Record<OrderPurpose, string> = { ENTRY: 'e', EXIT: 'x', STOP: 's', EMERGENCY_CLOSE: 'k', PROTECT: 'p' };

/**
 * cliOrdId deterministico: stesso intento, scopo e tentativo → stesso id. Solo [a-z0-9-] e 24
 * caratteri, per stare nei limiti di Kraken (clientOrderIdTooBig / clientOrderIdInvalid).
 */
export function makeCliOrdId(intentKey: string, purpose: OrderPurpose, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 99) throw new Error(`Tentativo non valido: ${attempt}`);
  const digest = createHash('sha256').update(`${intentKey}|${purpose}`).digest('hex').slice(0, 16);
  return `mt-${PURPOSE_CODE[purpose]}-${digest}-${attempt}`;
}

export function isOwnCliOrdId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^mt-[exskp]-[0-9a-f]{16}-\d{1,2}$/.test(id);
}

export function averagePrice(fills: readonly OrderFill[]): number | null {
  const size = fills.reduce((a, f) => a + f.size, 0);
  if (size === 0) return null;
  // Con un solo prezzo il risultato è esatto (niente rumore di virgola mobile).
  if (fills.every((f) => f.price === fills[0].price)) return fills[0].price;
  return fills.reduce((a, f) => a + f.price * f.size, 0) / size;
}

/** Archivio degli ordini: il record viene salvato PRIMA dell'invio (I8). F4 lo rende persistente. */
export interface OrderStore {
  get(cliOrdId: string): Promise<OrderRecord | null>;
  save(record: OrderRecord): Promise<void>;
  /** Ordini non terminali. */
  active(): Promise<OrderRecord[]>;
  byIntent(intentKey: string): Promise<OrderRecord[]>;
}

export class InMemoryOrderStore implements OrderStore {
  readonly records = new Map<string, OrderRecord>();
  writes = 0;

  async get(cliOrdId: string): Promise<OrderRecord | null> {
    const r = this.records.get(cliOrdId);
    return r ? structuredClone(r) : null;
  }

  async save(record: OrderRecord): Promise<void> {
    this.writes++;
    this.records.set(record.cliOrdId, structuredClone(record));
  }

  async active(): Promise<OrderRecord[]> {
    return [...this.records.values()].filter((r) => !TERMINAL_STATES.has(r.state)).map((r) => structuredClone(r));
  }

  async byIntent(intentKey: string): Promise<OrderRecord[]> {
    return [...this.records.values()].filter((r) => r.intentKey === intentKey).map((r) => structuredClone(r));
  }
}

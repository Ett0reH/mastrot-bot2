// Costruzione del runtime per il server (F4). In demo e live la persistenza su Firestore è
// obbligatoria: senza, il server non parte. In shadow, senza Firestore, lo stato resta in memoria.
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { EngineConfig } from '../config/config';
import { AccountLedger } from '../exchange/accountLedger';
import { InstrumentRegistry } from '../exchange/instruments';
import { createKrakenFuturesApi } from '../exchange/krakenApi';
import { KrakenAdapter } from '../exchange/krakenAdapter';
import { FundingFromLedgerPending } from '../exchange/krakenExecutionPort';
import { OrderManager } from '../exchange/orderManager';
import { StopManager } from '../exchange/stopManager';
import { KrakenCandleSource } from '../live/krakenCandleSource';
import { type AlertSink, RecordingAlertSink } from '../ops/alerts';
import type { CycleContext, Logger } from '../ops/logger';
import { BotStore, WriteBudget } from '../persistence/botStore';
import { type DocumentStore, MemoryDocumentStore } from '../persistence/documentStore';
import { createFirestore } from '../persistence/firebase';
import { FirestoreDocumentStore } from '../persistence/firestoreStore';
import { BotRuntime } from './botRuntime';
import { LeaseManager } from './lease';

export interface RuntimeBundle {
  runtime: BotRuntime;
  persistence: 'firestore' | 'memory';
  instanceId: string;
}

export function makeInstanceId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

/** Verifica che Firestore risponda (lettura dello stato con timeout). */
async function probe(docs: DocumentStore, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      docs.get('bot_runtime/state'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`nessuna risposta in ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createBotRuntime(config: EngineConfig, channel: AlertSink, logger: Logger, cycle?: CycleContext): Promise<RuntimeBundle> {
  // Un solo registro degli alert per runtime, porta Kraken e StopManager (dashboard e health).
  const alerts = new RecordingAlertSink(channel);
  const now = () => Date.now();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let docs: DocumentStore;
  let persistence: RuntimeBundle['persistence'];
  try {
    const firestore = new FirestoreDocumentStore(createFirestore(config));
    await probe(firestore, 15_000);
    docs = firestore;
    persistence = 'firestore';
  } catch (err) {
    if (config.mode !== 'shadow') throw new Error(`Persistenza obbligatoria in ${config.mode}: Firestore non disponibile (${(err as Error).message})`);
    logger.warn(`Firestore non disponibile (${(err as Error).message}): stato shadow solo in memoria`);
    docs = new MemoryDocumentStore();
    persistence = 'memory';
  }
  const instanceId = makeInstanceId();
  const budget = new WriteBudget(config.persistence.dailyWriteBudget, now);
  const store = new BotStore(docs, budget, now);
  const lease = new LeaseManager(docs, instanceId, { now, onWrite: () => budget.recordWrite() });
  const source = new KrakenCandleSource({ now });
  let kraken;
  if (config.mode !== 'shadow') {
    const adapter = new KrakenAdapter(createKrakenFuturesApi(config), {
      now,
      sleep,
      canWrite: () => lease.canWrite(),
      log: (e) => logger.log(e.level, e.message, e.context),
    });
    const orders = new OrderManager(adapter, store.orders, { now, logger });
    const instruments = new InstrumentRegistry(() => adapter.instruments(), now);
    const stops = new StopManager(orders, adapter, instruments, alerts, { now });
    const ledger = new AccountLedger(adapter, docs, () => budget.recordWrite());
    kraken = { adapter, orders, stops, instruments, funding: new FundingFromLedgerPending(), ledger };
  }
  const runtime = new BotRuntime({ config, now, store, lease, source, alerts, kraken, logger, cycle });
  return { runtime, persistence, instanceId };
}

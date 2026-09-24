// Lease d'istanza (F4: D26, invariante I11).
//
// Un documento `bot_runtime/lease` dice quale istanza può operare: { holder, epoch, expiresAt }.
// Acquisizione e rinnovo avvengono in una transazione (compare-and-set). Un'istanza che non
// detiene il lease, o che non riesce a rinnovarlo, non invia ordini: la verifica locale
// (`canWrite`) avviene prima di ogni scrittura verso Kraken e usa un margine di sicurezza, così
// un'istanza rimasta ferma (GC, freeze, deploy con revisioni sovrapposte) smette di scrivere
// prima che il lease possa passare a un'altra.
import type { DocumentStore } from '../persistence/documentStore';

export interface LeaseRecord {
  holder: string;
  epoch: number;
  expiresAt: number;
  acquiredAt: number;
}

export interface LeaseOptions {
  now: () => number;
  /** Durata del lease. */
  ttlMs?: number;
  /** Margine: si smette di scrivere quando mancano meno di `safetyMarginMs` alla scadenza. */
  safetyMarginMs?: number;
  /** Intervallo minimo tra due rinnovi (ogni rinnovo è una scrittura sull'archivio). */
  renewIntervalMs?: number;
  /** Chiamato a ogni scrittura del lease (per il budget giornaliero delle scritture). */
  onWrite?: () => void;
  path?: string;
}

export class LeaseManager {
  private current: LeaseRecord | null = null;
  readonly ttlMs: number;
  readonly safetyMarginMs: number;
  readonly renewIntervalMs: number;
  private readonly path: string;

  constructor(private readonly docs: DocumentStore, readonly instanceId: string, private readonly options: LeaseOptions) {
    // Default: lease di 3 minuti rinnovato ogni minuto (1.440 scritture al giorno); si smette di
    // scrivere su Kraken a 60 s dalla scadenza. Un'istanza morta viene sostituita entro 3 minuti.
    this.ttlMs = options.ttlMs ?? 180_000;
    this.safetyMarginMs = options.safetyMarginMs ?? 60_000;
    this.renewIntervalMs = options.renewIntervalMs ?? Math.floor(this.ttlMs / 3);
    this.path = options.path ?? 'bot_runtime/lease';
    if (this.safetyMarginMs >= this.ttlMs) throw new Error('Il margine del lease deve essere minore della durata');
    if (this.renewIntervalMs >= this.ttlMs - this.safetyMarginMs) throw new Error('Il lease va rinnovato prima di entrare nel margine di sicurezza');
  }

  get lease(): LeaseRecord | null {
    return this.current ? { ...this.current } : null;
  }

  /** Acquisisce il lease se è libero, scaduto o già suo. */
  async acquire(): Promise<boolean> {
    const now = this.options.now();
    const result = await this.docs.transact<LeaseRecord>(this.path, (existing) => {
      if (existing && existing.holder !== this.instanceId && existing.expiresAt > now) return null;
      const sameHolder = existing?.holder === this.instanceId;
      return {
        holder: this.instanceId,
        epoch: sameHolder ? existing.epoch : (existing?.epoch ?? 0) + 1,
        expiresAt: now + this.ttlMs,
        acquiredAt: sameHolder ? existing.acquiredAt : now,
      };
    });
    if (result && result.holder === this.instanceId && result.expiresAt === now + this.ttlMs) this.options.onWrite?.();
    this.current = result && result.holder === this.instanceId && result.expiresAt > now ? result : null;
    return this.current !== null;
  }

  /** Rinnova il lease; false se è stato perso (un'altra istanza lo ha preso o è scaduto). */
  async renew(): Promise<boolean> {
    const held = this.current;
    if (!held) return false;
    const now = this.options.now();
    // Rinnovato da poco: nessuna scrittura (il budget giornaliero conta anche il lease).
    if (now < held.expiresAt - this.ttlMs + this.renewIntervalMs) return true;
    try {
      const result = await this.docs.transact<LeaseRecord>(this.path, (existing) => {
        if (!existing || existing.holder !== this.instanceId || existing.epoch !== held.epoch) return null;
        return { ...existing, expiresAt: now + this.ttlMs };
      });
      if (!result || result.holder !== this.instanceId || result.epoch !== held.epoch) {
        this.current = null;
        return false;
      }
      this.options.onWrite?.();
      this.current = result;
      return true;
    } catch {
      // Archivio non raggiungibile: il lease locale resta valido solo fino alla sua scadenza.
      return this.canWrite() === null;
    }
  }

  async release(): Promise<void> {
    const held = this.current;
    this.current = null;
    if (!held) return;
    await this.docs.transact<LeaseRecord>(this.path, (existing) =>
      existing && existing.holder === this.instanceId && existing.epoch === held.epoch ? { ...existing, expiresAt: 0 } : null,
    );
  }

  /** null se questa istanza può scrivere su Kraken ora, altrimenti il motivo. */
  canWrite(): string | null {
    if (!this.current) return 'lease non detenuto da questa istanza';
    const remaining = this.current.expiresAt - this.options.now();
    if (remaining <= this.safetyMarginMs) return `lease in scadenza o scaduto (${Math.max(0, Math.round(remaining / 1000))} s)`;
    return null;
  }
}

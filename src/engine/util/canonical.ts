// Serializzazione JSON canonica (chiavi ordinate) e hash, per confronti deterministici
// tra run di backtest (golden) e tra backtest e replay live.
import { createHash } from 'node:crypto';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** JSON con chiavi ordinate ricorsivamente; `indent` solo per i file leggibili. */
export function canonicalStringify(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

// Porta con il controllo degli ingressi (F4-F5): ogni intento OPEN passa dal guard (pausa,
// persistenza, lease, RiskGuard) nell'ordine in cui il core li ha decisi; quelli respinti tornano
// al core come rifiutati. Uscite e aggiornamenti degli stop passano sempre: ridurre il rischio è
// sempre consentito.
import type { Intent, OpenIntent } from '../core/types';
import type { Candle } from '../data/dataset';
import type { ExecutionPort, ExecutionReport, FundingCharge, FundingPosition } from '../live/ports';

/** null = ingresso consentito; altrimenti il motivo del rifiuto. */
export type EntryGuard = (intent: OpenIntent, approved: readonly OpenIntent[]) => string | null;

export class GatedExecutionPort implements ExecutionPort {
  constructor(private readonly inner: ExecutionPort, private readonly guard: EntryGuard) {}

  settle(slotTime: number, candles: Readonly<Record<string, Candle | undefined>>): Promise<ExecutionReport> {
    return this.inner.settle(slotTime, candles);
  }

  funding(hourCloseSlot: number, positions: readonly FundingPosition[]): Promise<FundingCharge[]> {
    return this.inner.funding(hourCloseSlot, positions);
  }

  async execute(intents: readonly Intent[]): Promise<ExecutionReport> {
    const approved: OpenIntent[] = [];
    const rejected: ExecutionReport['rejected'] = [];
    const allowed: Intent[] = [];
    for (const intent of intents) {
      if (intent.kind !== 'OPEN') {
        allowed.push(intent);
        continue;
      }
      const reason = this.guard(intent, approved);
      if (reason === null) {
        approved.push(intent);
        allowed.push(intent);
      } else {
        rejected.push({ positionId: intent.positionId, reason: `ingresso bloccato: ${reason}` });
      }
    }
    const report = allowed.length > 0 ? await this.inner.execute(allowed) : { fills: [], rejected: [] };
    return { fills: report.fills, rejected: [...rejected, ...report.rejected] };
  }
}

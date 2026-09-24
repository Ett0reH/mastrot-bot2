// Porta con blocco degli ingressi (F4; in F5 vi si aggiunge il RiskGuard).
// Se `entryBlock` restituisce un motivo, gli intenti OPEN vengono rifiutati con quel motivo;
// uscite e aggiornamenti degli stop passano sempre: ridurre il rischio è sempre consentito.
import type { Intent } from '../core/types';
import type { ExecutionPort, ExecutionReport, FundingCharge, FundingPosition } from '../live/ports';
import type { Candle } from '../data/dataset';

export class GatedExecutionPort implements ExecutionPort {
  constructor(private readonly inner: ExecutionPort, private readonly entryBlock: () => string | null) {}

  settle(slotTime: number, candles: Readonly<Record<string, Candle | undefined>>): Promise<ExecutionReport> {
    return this.inner.settle(slotTime, candles);
  }

  funding(hourCloseSlot: number, positions: readonly FundingPosition[]): Promise<FundingCharge[]> {
    return this.inner.funding(hourCloseSlot, positions);
  }

  async execute(intents: readonly Intent[]): Promise<ExecutionReport> {
    const reason = intents.some((i) => i.kind === 'OPEN') ? this.entryBlock() : null;
    if (reason === null) return this.inner.execute(intents);
    const rejected = intents.filter((i) => i.kind === 'OPEN').map((i) => ({ positionId: i.positionId, reason: `ingresso bloccato: ${reason}` }));
    const report = await this.inner.execute(intents.filter((i) => i.kind !== 'OPEN'));
    return { fills: report.fills, rejected: [...rejected, ...report.rejected] };
  }
}

import { DerivativesClient } from '@siebly/kraken-api';
// Try to assign something invalid to see the full type in error
const params: Parameters<DerivativesClient['submitOrder']>[0] = {
    orderType: 'stp',
    symbol: 'pi_xbtusd',
    side: 'buy',
    size: 1,
    limitPrice: 1000,
    stopPrice: 1000,
    triggerSignal: 'mark',
    reduceOnly: true,
    cliOrdId: '123'
};
console.log(params);

import { DerivativesClient } from '@siebly/kraken-api';
// Try to assign something invalid to see the full type in error
const params1: Parameters<DerivativesClient['cancelOrder']>[0] = {
    order_id: '123',
    cliOrdId: '123',
    // @ts-expect-error
    invalid: 1
};
console.log(params1);

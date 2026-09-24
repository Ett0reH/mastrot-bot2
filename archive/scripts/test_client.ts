import { DerivativesClient } from '@siebly/kraken-api';
// Ignore initialization, just reflect
console.log(Object.getOwnPropertyNames(DerivativesClient.prototype));

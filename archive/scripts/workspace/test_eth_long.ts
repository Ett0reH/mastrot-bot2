import { 
   initExchange, 
   exchange, 
   createProtectedLimitEntryOrder,
   attachNativeProtections,
   state
} from './src/server/liveEngine.ts';

async function test() {
    process.env.LIVE_TRADING_ENABLED = 'true';
    await initExchange();

    const symbol = 'ETH/USD:USD';
    const amount = 0.005; // 0.005 ETH to be safe
    const ticker = await exchange.fetchTicker(symbol);
    const lastPrice = ticker.last;

    const positionId = `pos_ETH_${Date.now()}`;
    const clientOrderId = `entry_${positionId.substring(4)}`;

    console.log(`Setting up LONG for ${symbol} with minimum size...`);

    // Ensure state map is initialized
    if (!state.positionLedger) state.positionLedger = {};
    state.positionLedger[positionId] = {
        positionId,
        symbol,
        status: 'PENDING',
        nativeEntryOrderId: clientOrderId
    };

    const entryRes = await createProtectedLimitEntryOrder({
        symbol,
        side: 'buy',
        amount: amount,
        lastPrice: lastPrice,
        slippageBuffer: 0.05, // 5% buffer to guarantee execution
        timeoutMs: 15000,
        clientOrderId,
        positionId
    });

    console.log("Entry Response:", entryRes);

    if (entryRes.success) {
        state.positionLedger[positionId].status = 'FILLED';
        const pMock = { id: positionId, symbol, direction: 'LONG', stopLoss: lastPrice * 0.90 }; // 10% stop loss
        const attached = await attachNativeProtections(pMock as any, entryRes.filledAmount);
        console.log("Protections Attached:", attached);
        if (attached && state.positionLedger[positionId].nativeStopLossOrderId) {
            console.log("SL Order ID:", state.positionLedger[positionId].nativeStopLossOrderId);
        }
    }
    process.exit(0);
}
test();

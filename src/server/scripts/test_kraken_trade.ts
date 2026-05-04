import { DerivativesClient } from '@siebly/kraken-api';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const isSandbox = process.env.KRAKEN_SANDBOX === 'true' || process.env.KRAKEN_SANDBOX === undefined;
const client = new DerivativesClient({
    apiKey: process.env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_SECRET_KEY,
    testnet: isSandbox
});

async function run() {
    try {
        console.log("Canceling all open orders...");
        await client.cancelAllOrders();

        // Close any existing position
        const positionsRes = await client.getOpenPositions();
        const btcPos = positionsRes.openPositions?.find((p: any) => p.symbol === 'PF_XBTUSD');
        if (btcPos && btcPos.size > 0) {
             console.log(`Closing existing position of ${btcPos.size} ${btcPos.side}`);
             await client.submitOrder({
                 orderType: 'mkt',
                 symbol: 'PF_XBTUSD',
                 side: btcPos.side === 'long' ? 'sell' : 'buy',
                 size: btcPos.size,
                 reduceOnly: true
             });
        }

        console.log("\nSetting leverage to 5x...");
        try {
            await client.setLeverageSettings({
                symbol: 'PF_XBTUSD',
                maxLeverage: 5
            });
            console.log("Leverage set to 5x successfully.");
        } catch (e: any) {
            console.log("Leverage set failed (might already be 5x or unsupported in sandbox):", e.message);
        }

        const entryPrice = 40000;
        const tpPrice = 70000;
        const targetValueUsd = 1000;
        const contractSize = targetValueUsd / entryPrice;
        const sizeFixed = Number(contractSize.toFixed(4));
        
        console.log(`\nPlacing LIMIT BUY Order at ${entryPrice} (Long entry) with size ${sizeFixed}...`);
        const buyRes = await client.submitOrder({
            orderType: 'lmt',
            symbol: 'PF_XBTUSD',
            side: 'buy',
            size: sizeFixed,
            limitPrice: entryPrice
        });
        console.log("Limit Buy Response:", JSON.stringify(buyRes.sendStatus, null, 2));

        console.log(`\nPlacing Take Profit Order (SELL) at ${tpPrice} with size ${sizeFixed}...`);
        const tpRes = await client.submitOrder({
            orderType: 'take_profit',
            symbol: 'PF_XBTUSD',
            side: 'sell',
            size: sizeFixed,
            stopPrice: tpPrice,
            reduceOnly: true,
            triggerSignal: 'mark'
        });
        console.log("Take Profit Response:", JSON.stringify(tpRes.sendStatus, null, 2));

        console.log("\nTest trade successfully configured.");
    } catch (e: any) {
        console.error("Test trade failed:", e.message);
        if (e.response) {
            console.error("Details:", e.response.data);
        }
    }
}

run();

import { DerivativesClient } from '@siebly/kraken-api';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

async function checkKraken() {
    console.log("=== Kraken API Functionality Check ===");
    const key = process.env.KRAKEN_API_KEY;
    const secret = process.env.KRAKEN_SECRET_KEY;
    const isSandbox = process.env.KRAKEN_SANDBOX === 'true' || process.env.KRAKEN_SANDBOX === undefined;
    
    console.log(`Using Sandbox: ${isSandbox}`);
    
    if (!key || !secret) {
        console.error("Missing KRAKEN_API_KEY or KRAKEN_SECRET_KEY");
        return;
    }

    const client = new DerivativesClient({
        apiKey: key,
        apiSecret: secret,
        strictParamValidation: true,
        testnet: isSandbox
    });

    try {
        console.log("\n1. Testing Authentication / Account Balances");
        const accountsRes = await client.getAccounts();
        console.log("Accounts status:", accountsRes.result === 'success' ? "OK" : "FAILED");
        const marginAcc = accountsRes.accounts?.marginAccount as any;
        if (marginAcc) {
            console.log("Margin Account Balances:", Object.keys(marginAcc.balances).filter(k => parseFloat(marginAcc.balances[k]) > 0).join(', ') || "None");
        }

        console.log("\n2. Testing Public Tickers");
        const tickersRes = await client.getTickers();
        console.log("Tickers fetched:", tickersRes.tickers ? tickersRes.tickers.length : 0);
        const btcTicker = tickersRes.tickers?.find(t => t.symbol === 'PI_XBTUSD' || t.symbol === 'PF_XBTUSD');
        console.log("BTC Ticker:", btcTicker?.symbol, "Price:", btcTicker?.last);

        console.log("\n3. Testing OHLCV / Candles");
        try {
           const tickTypes = await client.getTickTypes();
           
           const candles = await client.getCandles({
               tickType: tickTypes[0],
               symbol: btcTicker?.symbol || 'PI_XBTUSD',
               resolution: '1h'
           });
           console.log("Candles fetched:", candles?.candles?.length);
        } catch(e:any) {
           console.error("Error fetching candles:", e.message);
        }

        console.log("\n4. Testing Open Positions");
        const posRes = await client.getOpenPositions();
        console.log("Positions fetched:", posRes.openPositions ? posRes.openPositions.length : 0);

        console.log("\n5. Testing Dummy Market Order Creation (Sandbox Only)");
        if (isSandbox) {
            try {
                // Submit a dummy order with a tiny size to sandbox
                console.log("Attempting to place a small LONG market order on PI_XBTUSD...");
                const sendRes = await client.submitOrder({
                    symbol: 'PI_XBTUSD',
                    side: 'buy',
                    size: 1,
                    orderType: 'mkt'
                });
                console.log("Order submission response:", sendRes.result);
                if (sendRes.sendStatus?.order_id) {
                     console.log("Cancelling the dummy order (if not filled instantly)...");
                     await client.cancelOrder({ order_id: sendRes.sendStatus.order_id });
                     console.log("Dummy order cleaned up.");
                } else if ((sendRes.sendStatus as any)?.orderEvents?.[0]?.order?.orderId) {
                     const orderId = (sendRes.sendStatus as any).orderEvents[0].order.orderId;
                     console.log("Order submitted with ID:", orderId);
                     // If it's a market order it might fill instantly, let's just close all positions
                     console.log("Exiting by sending a reduceOnly order...");
                     await client.submitOrder({
                         symbol: 'PI_XBTUSD',
                         side: 'sell',
                         size: 1,
                         orderType: 'mkt',
                         reduceOnly: true
                     });
                     console.log("Dummy position closed via reduceOnly.");
                }
            } catch(e:any) {
                console.error("Order test failed:", e.message || e);
            }
        }

        console.log("\n=== Check Complete ===");
    } catch(e:any) {
        console.error("Diagnostic failed:", e);
    }
}

checkKraken();

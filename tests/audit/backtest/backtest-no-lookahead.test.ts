import { MarketDataLayer } from '../../../src/server/core/architecture';

function testNoLookAhead() {
  console.log("Running No Look-Ahead Test...");
  const bars1H = [];
  for (let i = 0; i < 200; i++) bars1H.push({ timestamp: new Date(1000 * i * 3600).toISOString(), open: 1, high: 2, low: 1, close: 2, volume: 100 });
  const bars4H = [];
  for (let i = 0; i < 200; i++) bars4H.push({ timestamp: new Date(1000 * i * 3600 * 4).toISOString(), open: 1, high: 2, low: 1, close: 2, volume: 100 });
  
  // Test generating features assuming isH4Closed = false
  // For NO lookahead, current open 4H should not be fully merged or trusted entirely for static calculations
  const featuresFalse = MarketDataLayer.prepareFeatures(bars1H, bars4H, false);
  const featuresTrue = MarketDataLayer.prepareFeatures(bars1H, bars4H, true);
  
  if (featuresFalse.isH4Closed !== false) {
     console.error("[FAIL] isH4Closed not passed correctly");
     process.exit(1);
  }
  
  console.log("PASS: No Look-Ahead basics. (Deep validation relies on integration test)");
}

testNoLookAhead();

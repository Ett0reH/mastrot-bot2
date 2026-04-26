// Basic Math & Synthetic Data Generators for In-Browser ML Simulation

export interface OHLCV {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export function generateSyntheticOHLCV(bars: number): OHLCV {
  const ohlcv: OHLCV = {
    time: new Array(bars),
    open: new Array(bars),
    high: new Array(bars),
    low: new Array(bars),
    close: new Array(bars),
    volume: new Array(bars)
  };
  
  let price = 50000;
  const now = Date.now();
  
  for (let i = 0; i < bars; i++) {
    const volatility = 0.02 * price;
    const delta = (Math.random() - 0.5) * volatility;
    const isUp = delta > 0;
    
    ohlcv.time[i] = now - ((bars - i) * 86400000);
    ohlcv.open[i] = price;
    ohlcv.high[i] = price + (isUp ? delta + Math.random()*volatility*0.5 : Math.random()*volatility*0.5);
    ohlcv.low[i] = price - (isUp ? Math.random()*volatility*0.5 : Math.abs(delta) + Math.random()*volatility*0.5);
    ohlcv.close[i] = price + delta;
    ohlcv.volume[i] = Math.random() * 1000 + 100;
    
    price = ohlcv.close[i];
  }
  
  return ohlcv;
}

export function extractFeatures(ohlcv: OHLCV): { X: number[][], y: number[] } {
  const n = ohlcv.close.length;
  const X: number[][] = [];
  const y: number[] = [];
  
  // Basic feature extraction (RSI, Return 1d, Return 5d)
  let gains = 0, losses = 0;
  for (let i = 1; i < 15 && i < n; i++) {
    const diff = ohlcv.close[i] - ohlcv.close[i-1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  
  for (let i = 15; i < n - 1; i++) {
    // RSI
    const diff = ohlcv.close[i] - ohlcv.close[i-1];
    if (diff > 0) {
      gains = (gains * 13 + diff) / 14;
      losses = (losses * 13) / 14;
    } else {
      gains = (gains * 13) / 14;
      losses = (losses * 13 - diff) / 14;
    }
    let rs = losses === 0 ? 100 : gains / losses;
    let rsi = losses === 0 ? 100 : 100 - (100 / (1 + rs));
    
    const ret1 = (ohlcv.close[i] - ohlcv.close[i-1]) / ohlcv.close[i-1];
    const ret5 = (ohlcv.close[i] - ohlcv.close[i-5]) / ohlcv.close[i-5];
    
    // Normalize features simply
    const featRsi = (rsi - 50) / 25;
    const featRet1 = ret1 * 20; 
    const featRet5 = ret5 * 10;
    
    X.push([1, featRsi, featRet1, featRet5]); // Include bias term
    
    // Target: Next candle is UP (1) or DOWN (0)
    y.push(ohlcv.close[i+1] > ohlcv.close[i] ? 1 : 0);
  }
  
  return { X, y };
}

export class SGDClassifier {
  weights: number[];
  lr: number;
  
  constructor(featureCount: number, lr: number = 0.005) {
    this.weights = new Array(featureCount).fill(0).map(() => (Math.random() - 0.5) * 0.1);
    this.lr = lr;
  }
  
  sigmoid(z: number): number {
    if (z > 10) return 0.99999;
    if (z < -10) return 0.00001;
    return 1 / (1 + Math.exp(-z));
  }
  
  predictProbability(x: number[]): number {
    let z = 0;
    for (let i = 0; i < x.length; i++) z += this.weights[i] * x[i];
    return this.sigmoid(z);
  }
  
  predict(x: number[]): number {
    return this.predictProbability(x) > 0.5 ? 1 : 0;
  }
  
  trainOnBatch(X: number[][], y: number[]): number {
    let loss = 0;
    for (let i = 0; i < X.length; i++) {
      const prob = this.predictProbability(X[i]);
      const target = y[i];
      
      // Update weights
      const error = prob - target;
      for (let j = 0; j < this.weights.length; j++) {
        // gradient is X[j] * error
        this.weights[j] -= this.lr * error * X[i][j];
      }
      
      // log loss calculation
      loss -= target * Math.log(prob + 1e-15) + (1 - target) * Math.log(1 - prob + 1e-15);
    }
    return loss / X.length;
  }
  
  evaluate(X: number[][], y: number[]): number {
    let correct = 0;
    for (let i = 0; i < X.length; i++) {
      if (this.predict(X[i]) === y[i]) correct++;
    }
    return correct / X.length;
  }
}

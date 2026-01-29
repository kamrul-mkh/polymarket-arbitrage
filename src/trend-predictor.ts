/**
 * Early Trend Prediction System
 * Detects UP/DOWN trends at 80-85% probability using multiple techniques
 * FOR SIMULATION/DISPLAY ONLY - Does not trigger trades
 * Includes 15-minute direction prediction based on candles and MA
 */

export interface TrendSignal {
  direction: 'UP' | 'DOWN' | null;
  confidence: number; // 0-100, confidence in prediction
  probability: number; // 0-100, predicted final probability
  reason: string;
  indicators: {
    momentum?: number;
    rsi?: number;
    priceDivergence?: number;
    movingAverage?: number;
    volumeSignal?: number;
  };
  /** 15-minute outlook from candle/MA analysis */
  shortTerm15Min?: ShortTermPrediction;
  timestamp: number;
}

/** Prediction for next ~15 minutes based on candles and moving averages */
export interface ShortTermPrediction {
  direction: 'UP' | 'DOWN' | null;
  confidence: number; // 0-100
  reason: string;
  candlesUsed: number;
  maShort: number;
  maLong: number;
  lastCandleBullish: boolean;
}

export interface PriceDataPoint {
  timestamp: number;
  value: number; // BTC price
  yesPrice?: number; // YES token price (0-100)
  noPrice?: number; // NO token price (0-100)
}

/** OHLC candle for a time bucket */
export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number; // bucket start (e.g. Unix sec)
}

export class TrendPredictor {
  private priceHistory: PriceDataPoint[] = [];
  private readonly maxHistorySize = 400; // Keep enough for 15+ min of 1-min candles
  private readonly minHistorySize = 10; // Need at least 10 points for analysis
  private onSignalUpdate: ((signal: TrendSignal | null) => void) | null = null;
  /** Build 1-min candles; need at least this many candles for 15-min prediction */
  private readonly minCandlesFor15Min = 5;

  /**
   * Set callback for signal updates
   */
  setOnSignalUpdate(callback: (signal: TrendSignal | null) => void): void {
    this.onSignalUpdate = callback;
  }

  /**
   * Add a new price data point
   */
  addPricePoint(data: PriceDataPoint): void {
    this.priceHistory.push(data);
    if (this.priceHistory.length > this.maxHistorySize) {
      this.priceHistory.shift();
    }
  }

  /**
   * Clear price history
   */
  clearHistory(): void {
    this.priceHistory = [];
  }

  /**
   * Get current price history
   */
  getHistory(): PriceDataPoint[] {
    return [...this.priceHistory];
  }

  /**
   * Build OHLC candles from price history (bucket by interval seconds).
   * Uses BTC price (value) for OHLC.
   */
  buildCandles(intervalSeconds: number): Candle[] {
    if (this.priceHistory.length < 2) return [];

    const buckets = new Map<number, number[]>();
    for (const p of this.priceHistory) {
      const tsSec = p.timestamp >= 1e12 ? p.timestamp / 1000 : p.timestamp;
      const bucket = Math.floor(tsSec / intervalSeconds) * intervalSeconds;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(p.value);
    }

    const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
    const candles: Candle[] = [];
    for (const [ts, values] of sortedBuckets) {
      const open = values[0];
      const close = values[values.length - 1];
      const high = Math.max(...values);
      const low = Math.min(...values);
      candles.push({ open, high, low, close, timestamp: ts });
    }
    return candles;
  }

  /**
   * Predict direction for the next ~15 minutes using 1-min candles and MA.
   * Uses: candle closes for SMA(5) vs SMA(10), last candle bias, and recent trend.
   */
  predictDirection15Min(
    _priceToBeat: number,
    currentBTCPrice: number
  ): ShortTermPrediction | null {
    const oneMinCandles = this.buildCandles(60);
    if (oneMinCandles.length < this.minCandlesFor15Min) {
      return null;
    }

    const closes = oneMinCandles.map(c => c.close);
    const shortPeriod = 5;
    const longPeriod = Math.min(10, oneMinCandles.length);

    const shortMA = closes.slice(-shortPeriod).reduce((a, b) => a + b, 0) / shortPeriod;
    const longMA = closes.slice(-longPeriod).reduce((a, b) => a + b, 0) / longPeriod;

    const lastCandle = oneMinCandles[oneMinCandles.length - 1];
    const lastCandleBullish = lastCandle.close >= lastCandle.open;
    const priceAboveShortMA = currentBTCPrice > shortMA;
    const shortAboveLong = shortMA > longMA;

    const reasons: string[] = [];
    let upScore = 0;
    let downScore = 0;

    if (shortAboveLong) {
      upScore += 35;
      reasons.push(`MA(5) > MA(${longPeriod})`);
    } else {
      downScore += 35;
      reasons.push(`MA(5) < MA(${longPeriod})`);
    }

    if (lastCandleBullish) {
      upScore += 25;
      reasons.push('Last candle bullish');
    } else {
      downScore += 25;
      reasons.push('Last candle bearish');
    }

    if (priceAboveShortMA) {
      upScore += 20;
      reasons.push('Price above MA(5)');
    } else {
      downScore += 20;
      reasons.push('Price below MA(5)');
    }

    const recentTrend = closes.length >= 3
      ? (closes[closes.length - 1] - closes[closes.length - 3]) / closes[closes.length - 3]
      : 0;
    if (recentTrend > 0.001) {
      upScore += 20;
      reasons.push('Recent closes rising');
    } else if (recentTrend < -0.001) {
      downScore += 20;
      reasons.push('Recent closes falling');
    }

    const direction = upScore > downScore ? 'UP' : downScore > upScore ? 'DOWN' : null;
    const confidence = Math.min(100, Math.abs(upScore - downScore));

    return {
      direction,
      confidence,
      reason: reasons.join('; ') || 'Insufficient candle data',
      candlesUsed: oneMinCandles.length,
      maShort: shortMA,
      maLong: longMA,
      lastCandleBullish,
    };
  }

  /**
   * Predict trend direction with confidence score
   * Returns signal when confidence >= 80%
   */
  predictTrend(priceToBeat: number, currentBTCPrice: number, currentYesPrice?: number, currentNoPrice?: number): TrendSignal | null {
    if (this.priceHistory.length < this.minHistorySize) {
      if (this.onSignalUpdate) {
        this.onSignalUpdate(null);
      }
      return null; // Not enough data
    }

    const recent = this.priceHistory.slice(-20); // Last 20 data points
    const yesPrice = currentYesPrice || recent[recent.length - 1]?.yesPrice;
    const noPrice = currentNoPrice || recent[recent.length - 1]?.noPrice;

    if (!yesPrice || !noPrice) {
      if (this.onSignalUpdate) {
        this.onSignalUpdate(null);
      }
      return null; // Missing token prices
    }

    // Calculate multiple indicators
    const momentum = this.calculateMomentum(recent, priceToBeat, currentBTCPrice);
    const rsi = this.calculateRSI(recent);
    const priceDivergence = this.calculatePriceDivergence(recent, priceToBeat, currentBTCPrice);
    const movingAverage = this.calculateMovingAverageSignal(recent, priceToBeat, currentBTCPrice);
    const volumeSignal = this.estimateVolumeSignal(recent);

    // Combine indicators to determine direction and confidence
    const indicators = {
      momentum,
      rsi,
      priceDivergence,
      movingAverage,
      volumeSignal,
    };

    // Determine direction based on strongest signals
    let upScore = 0;
    let downScore = 0;
    const reasons: string[] = [];

    // Momentum analysis (40% weight)
    if (momentum > 0.7) {
      upScore += 40;
      reasons.push(`Strong UP momentum (${(momentum * 100).toFixed(0)}%)`);
    } else if (momentum < -0.7) {
      downScore += 40;
      reasons.push(`Strong DOWN momentum (${(Math.abs(momentum) * 100).toFixed(0)}%)`);
    } else if (Math.abs(momentum) > 0.3) {
      if (momentum > 0) {
        upScore += 20;
        reasons.push(`Moderate UP momentum (${(momentum * 100).toFixed(0)}%)`);
      } else {
        downScore += 20;
        reasons.push(`Moderate DOWN momentum (${(Math.abs(momentum) * 100).toFixed(0)}%)`);
      }
    }

    // RSI analysis (20% weight)
    if (rsi > 70) {
      upScore += 20;
      reasons.push(`RSI overbought (${rsi.toFixed(0)}) - UP trend`);
    } else if (rsi < 30) {
      downScore += 20;
      reasons.push(`RSI oversold (${rsi.toFixed(0)}) - DOWN trend`);
    } else if (rsi > 60) {
      upScore += 10;
      reasons.push(`RSI bullish (${rsi.toFixed(0)})`);
    } else if (rsi < 40) {
      downScore += 10;
      reasons.push(`RSI bearish (${rsi.toFixed(0)})`);
    }

    // Price divergence (20% weight)
    if (priceDivergence > 0.5) {
      upScore += 20;
      reasons.push(`Price divergence UP (${(priceDivergence * 100).toFixed(0)}%)`);
    } else if (priceDivergence < -0.5) {
      downScore += 20;
      reasons.push(`Price divergence DOWN (${(Math.abs(priceDivergence) * 100).toFixed(0)}%)`);
    } else if (priceDivergence > 0.2) {
      upScore += 10;
      reasons.push(`Mild divergence UP (${(priceDivergence * 100).toFixed(0)}%)`);
    } else if (priceDivergence < -0.2) {
      downScore += 10;
      reasons.push(`Mild divergence DOWN (${(Math.abs(priceDivergence) * 100).toFixed(0)}%)`);
    }

    // Moving average (15% weight)
    if (movingAverage > 0.6) {
      upScore += 15;
      reasons.push(`MA crossover UP (${(movingAverage * 100).toFixed(0)}%)`);
    } else if (movingAverage < -0.6) {
      downScore += 15;
      reasons.push(`MA crossover DOWN (${(Math.abs(movingAverage) * 100).toFixed(0)}%)`);
    } else if (movingAverage > 0.3) {
      upScore += 8;
      reasons.push(`MA bullish (${(movingAverage * 100).toFixed(0)}%)`);
    } else if (movingAverage < -0.3) {
      downScore += 8;
      reasons.push(`MA bearish (${(movingAverage * 100).toFixed(0)}%)`);
    }

    // Volume signal (5% weight)
    if (volumeSignal > 0.5) {
      upScore += 5;
      reasons.push(`Volume supports UP`);
    } else if (volumeSignal < -0.5) {
      downScore += 5;
      reasons.push(`Volume supports DOWN`);
    }

    const totalScore = upScore + downScore;
    const confidence = totalScore;
    const direction = upScore > downScore ? 'UP' : downScore > upScore ? 'DOWN' : null;

    // Create signal (even if confidence < 80% for display purposes)
    const baseProbability = direction === 'UP' ? yesPrice : direction === 'DOWN' ? noPrice : 50;
    const momentumBoost = direction === 'UP' ? momentum * 5 : direction === 'DOWN' ? Math.abs(momentum) * 5 : 0;
    const predictedProbability = Math.min(100, Math.max(0, baseProbability + momentumBoost));

    const shortTerm15Min = this.predictDirection15Min(priceToBeat, currentBTCPrice);

    const signal: TrendSignal = {
      direction,
      confidence,
      probability: predictedProbability,
      reason: reasons.length > 0 ? reasons.join('; ') : 'Insufficient signals',
      indicators,
      shortTerm15Min: shortTerm15Min ?? undefined,
      timestamp: Date.now(),
    };

    // Notify callback
    if (this.onSignalUpdate) {
      this.onSignalUpdate(signal);
    }

    return signal;
  }

  /**
   * Calculate momentum (price velocity and acceleration)
   * Returns -1 to 1 (negative = DOWN, positive = UP)
   */
  private calculateMomentum(
    recent: PriceDataPoint[],
    priceToBeat: number,
    currentBTCPrice: number
  ): number {
    if (recent.length < 5) return 0;

    // Calculate BTC price velocity (rate of change)
    const btcPrices = recent.map(p => p.value);
    const velocity = (btcPrices[btcPrices.length - 1] - btcPrices[0]) / btcPrices[0];

    // Calculate acceleration (change in velocity)
    const midPoint = Math.floor(btcPrices.length / 2);
    const firstHalfVelocity = (btcPrices[midPoint] - btcPrices[0]) / btcPrices[0];
    const secondHalfVelocity = (btcPrices[btcPrices.length - 1] - btcPrices[midPoint]) / btcPrices[midPoint];
    const acceleration = secondHalfVelocity - firstHalfVelocity;

    // Calculate distance from Price to Beat
    const distanceFromPTB = (currentBTCPrice - priceToBeat) / priceToBeat;

    // Combine: strong momentum if moving away from PTB with acceleration
    const momentum = (velocity * 0.4) + (acceleration * 0.4) + (distanceFromPTB * 0.2);

    // Normalize to -1 to 1
    return Math.max(-1, Math.min(1, momentum * 10));
  }

  /**
   * Calculate RSI (Relative Strength Index)
   * Returns 0-100 (70+ = overbought/UP, 30- = oversold/DOWN)
   */
  private calculateRSI(recent: PriceDataPoint[], period: number = 14): number {
    if (recent.length < period + 1) return 50; // Neutral

    const prices = recent.map(p => p.value);
    const changes = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    const gains = changes.filter(c => c > 0);
    const losses = changes.filter(c => c < 0).map(c => Math.abs(c));

    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

    if (avgLoss === 0) return 100; // All gains

    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    return rsi;
  }

  /**
   * Calculate price divergence
   * Compares BTC price movement vs token price movement
   * Returns -1 to 1 (negative = DOWN, positive = UP)
   */
  private calculatePriceDivergence(
    recent: PriceDataPoint[],
    _priceToBeat: number,
    _currentBTCPrice: number
  ): number {
    if (recent.length < 5) return 0;

    const firstYesPrice = recent[0]?.yesPrice || 50;
    const lastYesPrice = recent[recent.length - 1]?.yesPrice || 50;
    const yesChange = (lastYesPrice - firstYesPrice) / 100;

    const firstNoPrice = recent[0]?.noPrice || 50;
    const lastNoPrice = recent[recent.length - 1]?.noPrice || 50;
    const noChange = (lastNoPrice - firstNoPrice) / 100;

    // If BTC moved up but YES token didn't move up proportionally, bearish divergence
    // If BTC moved up and YES token moved up more, bullish convergence
    const divergence = yesChange - noChange;

    return Math.max(-1, Math.min(1, divergence * 2));
  }

  /**
   * Calculate moving average crossover signal
   * Returns -1 to 1 (negative = DOWN, positive = UP)
   */
  private calculateMovingAverageSignal(
    recent: PriceDataPoint[],
    priceToBeat: number,
    currentBTCPrice: number
  ): number {
    if (recent.length < 10) return 0;

    const prices = recent.map(p => p.value);
    
    // Short-term MA (5 periods)
    const shortMA = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
    
    // Long-term MA (10 periods)
    const longMA = prices.slice(-10).reduce((a, b) => a + b, 0) / 10;

    // Golden cross (short > long) = bullish, Death cross (short < long) = bearish
    const maSignal = (shortMA - longMA) / longMA;

    // Also check if price is above/below Price to Beat
    const priceSignal = (currentBTCPrice - priceToBeat) / priceToBeat;

    // Combine signals
    const combined = (maSignal * 0.6) + (priceSignal * 0.4);

    return Math.max(-1, Math.min(1, combined * 5));
  }

  /**
   * Estimate volume signal from price volatility
   * Higher volatility = higher volume (estimated)
   * Returns -1 to 1
   */
  private estimateVolumeSignal(recent: PriceDataPoint[]): number {
    if (recent.length < 5) return 0;

    // Calculate volatility (standard deviation of price changes)
    const prices = recent.map(p => p.value);
    const changes = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(Math.abs(prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
    const variance = changes.reduce((sum, c) => sum + Math.pow(c - avgChange, 2), 0) / changes.length;
    const volatility = Math.sqrt(variance);

    // High volatility with upward price trend = bullish volume
    // High volatility with downward price trend = bearish volume
    const priceTrend = (prices[prices.length - 1] - prices[0]) / prices[0];
    const volumeSignal = volatility * (priceTrend > 0 ? 1 : -1);

    return Math.max(-1, Math.min(1, volumeSignal * 10));
  }

  /**
   * Get current trend strength (0-100)
   */
  getTrendStrength(): number {
    if (this.priceHistory.length < 5) return 0;

    const recent = this.priceHistory.slice(-10);
    const prices = recent.map(p => p.value);
    
    const trend = (prices[prices.length - 1] - prices[0]) / prices[0];
    const strength = Math.abs(trend) * 1000; // Scale up

    return Math.min(100, strength);
  }
}

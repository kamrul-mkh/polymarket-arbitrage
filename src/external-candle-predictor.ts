/**
 * Next 15-min candle prediction using Binance 15m klines + Chainlink (or Binance) price,
 * and previous 15-min outcomes for calibration.
 * FOR DISPLAY ONLY - does not trigger trades.
 */

import type { PredictionOutcomeRecord } from './trading-types';

export interface Next15mPrediction {
  direction: 'UP' | 'DOWN' | null;
  confidence: number;
  reason: string;
  sources: {
    binanceCandles: number;
    priceSource: 'chainlink' | 'binance';
    price: number;
    pastOutcomesUsed: number;
  };
  maShort: number;
  maLong: number;
  lastCandleBullish: boolean;
  timestamp: number;
  error?: string;
}

interface BinanceKlineRow {
  0: number;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
}

function parseKlines(klines: unknown[]): Array<{ open: number; high: number; low: number; close: number; timestamp: number }> {
  const out: Array<{ open: number; high: number; low: number; close: number; timestamp: number }> = [];
  for (const row of klines) {
    const r = row as BinanceKlineRow;
    if (!r || typeof r[0] !== 'number') continue;
    const open = parseFloat(r[1]);
    const high = parseFloat(r[2]);
    const low = parseFloat(r[3]);
    const close = parseFloat(r[4]);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    out.push({
      open,
      high: Number.isFinite(high) ? high : open,
      low: Number.isFinite(low) ? low : open,
      close,
      timestamp: Math.floor(r[0] / 1000),
    });
  }
  return out;
}

/**
 * Fetch Binance 15m klines via single /api/market-data (saves Vercel function count).
 */
async function fetchBinance15mKlines(limit: number = 50): Promise<Array<{ open: number; high: number; low: number; close: number; timestamp: number }>> {
  const base = typeof window !== 'undefined' ? '' : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
  const url = `${base}/api/market-data?type=klines&symbol=BTCUSDT&interval=15m&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Klines: ${res.status}`);
  const data = await res.json();
  const raw = data?.klines ?? data;
  if (!Array.isArray(raw)) throw new Error('Invalid klines response');
  return parseKlines(raw);
}

/**
 * Fetch BTC/USD price from Chainlink (or Binance fallback) via /api/market-data.
 */
async function fetchBtcPrice(): Promise<{ price: number; source: 'chainlink' | 'binance' }> {
  const base = typeof window !== 'undefined' ? '' : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
  const res = await fetch(`${base}/api/market-data?type=price`);
  if (!res.ok) throw new Error(`Price API: ${res.status}`);
  const data = await res.json();
  const price = Number(data?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price');
  return { price, source: (data?.source === 'chainlink' ? 'chainlink' : 'binance') };
}

/**
 * Predict next 15-min candle direction using:
 * - Binance 15m klines (MA crossover, last candle, trend)
 * - Chainlink or Binance current price
 * - Previous 15-min outcomes to optionally adjust confidence
 */
export async function predictNext15mCandle(
  previousOutcomes: PredictionOutcomeRecord[] = []
): Promise<Next15mPrediction> {
  const timestamp = Date.now();
  try {
    const [candles, priceData] = await Promise.all([
      fetchBinance15mKlines(50),
      fetchBtcPrice(),
    ]);

    if (candles.length < 5) {
      return {
        direction: null,
        confidence: 0,
        reason: 'Not enough Binance 15m candles',
        sources: {
          binanceCandles: candles.length,
          priceSource: priceData.source,
          price: priceData.price,
          pastOutcomesUsed: 0,
        },
        maShort: 0,
        maLong: 0,
        lastCandleBullish: false,
        timestamp,
      };
    }

    const closes = candles.map((c) => c.close);
    const shortPeriod = 5;
    const longPeriod = Math.min(10, candles.length);
    const maShort = closes.slice(-shortPeriod).reduce((a, b) => a + b, 0) / shortPeriod;
    const maLong = closes.slice(-longPeriod).reduce((a, b) => a + b, 0) / longPeriod;

    const lastCandle = candles[candles.length - 1];
    const lastCandleBullish = lastCandle.close >= lastCandle.open;
    const priceAboveShortMA = priceData.price > maShort;
    const shortAboveLong = maShort > maLong;

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
      reasons.push('Last 15m candle bullish');
    } else {
      downScore += 25;
      reasons.push('Last 15m candle bearish');
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
    if (recentTrend > 0.002) {
      upScore += 20;
      reasons.push('Recent closes rising');
    } else if (recentTrend < -0.002) {
      downScore += 20;
      reasons.push('Recent closes falling');
    }

    // Use previous 15-min outcomes: if we have a high correct rate, slightly boost confidence
    const withOutcome = previousOutcomes.filter((r) => r.outcomeAt15Min && r.predictedAt8Min);
    let pastOutcomesUsed = 0;
    if (withOutcome.length >= 3) {
      const correct = withOutcome.filter((r) => r.correct === true).length;
      const rate = correct / withOutcome.length;
      pastOutcomesUsed = withOutcome.length;
      if (rate >= 0.6) {
        const boost = Math.min(10, Math.round((rate - 0.5) * 20));
        upScore += boost;
        downScore += boost;
        reasons.push(`Past outcomes: ${correct}/${withOutcome.length} correct`);
      }
    }

    const direction = upScore > downScore ? 'UP' : downScore > upScore ? 'DOWN' : null;
    const confidence = Math.min(100, Math.abs(upScore - downScore));

    return {
      direction,
      confidence,
      reason: reasons.join('; ') || 'Insufficient signals',
      sources: {
        binanceCandles: candles.length,
        priceSource: priceData.source,
        price: priceData.price,
        pastOutcomesUsed,
      },
      maShort,
      maLong,
      lastCandleBullish,
      timestamp,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Unknown error';
    return {
      direction: null,
      confidence: 0,
      reason: `Error: ${error}`,
      sources: {
        binanceCandles: 0,
        priceSource: 'binance',
        price: 0,
        pastOutcomesUsed: previousOutcomes.length,
      },
      maShort: 0,
      maLong: 0,
      lastCandleBullish: false,
      timestamp,
      error,
    };
  }
}

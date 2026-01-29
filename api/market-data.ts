import type { VercelRequest, VercelResponse } from '@vercel/node';

const BINANCE_KLINES = 'https://data-api.binance.vision/api/v3/klines';
const BINANCE_TICKER = 'https://data-api.binance.vision/api/v3/ticker/price';

/**
 * GET /api/market-data?type=klines&symbol=BTCUSDT&interval=15m&limit=50
 * GET /api/market-data?type=price
 * Single serverless function for Binance/Chainlink market data (saves Vercel Hobby function count).
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const type = (req.query.type as string) || '';

  if (type === 'klines') {
    const symbol = (req.query.symbol as string) || 'BTCUSDT';
    const interval = (req.query.interval as string) || '15m';
    const limit = Math.min(1000, Math.max(1, parseInt((req.query.limit as string) || '50', 10) || 50));
    try {
      const url = `${BINANCE_KLINES}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
      const response = await fetch(url);
      if (!response.ok) {
        const text = await response.text();
        return res.status(response.status).json({ error: text || 'Binance API error' });
      }
      const data = await response.json();
      return res.status(200).json({ klines: data });
    } catch (e) {
      console.error('[market-data klines]', e);
      return res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to fetch klines' });
    }
  }

  if (type === 'price') {
    try {
      const chainlinkRes = await fetch(
        'https://api.chain.link/v2/reference/feeds/ethereum-mainnet/btc-usd/latest',
        { signal: AbortSignal.timeout(5000) }
      ).catch(() => null);

      if (chainlinkRes?.ok) {
        const data = await chainlinkRes.json();
        const price = data?.data?.attributes?.price ?? data?.price ?? data?.answer;
        if (typeof price === 'number' && price > 0) {
          return res.status(200).json({ price, source: 'chainlink', timestamp: Date.now() });
        }
      }

      const binanceRes = await fetch(`${BINANCE_TICKER}?symbol=BTCUSDT`, { signal: AbortSignal.timeout(5000) });
      if (!binanceRes.ok) throw new Error('Binance price failed');
      const binance = await binanceRes.json();
      const price = parseFloat(binance?.price);
      if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid Binance price');
      return res.status(200).json({ price, source: 'binance', timestamp: Date.now() });
    } catch (e) {
      console.error('[market-data price]', e);
      return res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to fetch price' });
    }
  }

  return res.status(400).json({ error: 'Use ?type=klines or ?type=price' });
}

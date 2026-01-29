import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Single health/status endpoint (replaces /api/hello and /api/test).
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  return res.status(200).json({
    message: 'API proxy is working',
    timestamp: new Date().toISOString(),
    query: req.query,
    url: req.url,
    environment: process.env.NODE_ENV || 'production',
  });
}

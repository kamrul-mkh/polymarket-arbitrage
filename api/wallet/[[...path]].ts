import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, providers, Contract } from 'ethers';
import { keccak256, getCreate2Address, encodePacked } from 'viem';
import { ClobClient } from '@polymarket/clob-client';

const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052' as const;
const PROXY_INIT_CODE_HASH = '0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b' as const;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CLOB_API_URL = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

const ERC20_ABI = [
  { constant: true, inputs: [{ name: '_owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], type: 'function' },
];

function deriveProxyAddress(eoaAddress: string): string {
  try {
    return getCreate2Address({
      bytecodeHash: PROXY_INIT_CODE_HASH,
      from: PROXY_FACTORY,
      salt: keccak256(encodePacked(['address'], [eoaAddress.toLowerCase() as `0x${string}`])),
    });
  } catch (error) {
    console.error('[deriveProxyAddress] Error:', error);
    throw new Error(`Failed to derive proxy address: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = (req.query.path as string[] | undefined) ?? [];
  const segment = path[0];

  if (segment === 'balance') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const privateKey = process.env.POLYMARKET_MAGIC_PK;
    if (!privateKey) return res.status(500).json({ error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables' });
    try {
      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const eoaAddress = wallet.address;
      const proxyAddress = deriveProxyAddress(eoaAddress.toLowerCase());
      const usdcContract = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
      const balance = await usdcContract.balanceOf(proxyAddress);
      const balanceFormatted = parseFloat(balance.toString()) / 1e6;
      return res.status(200).json({ balance: balanceFormatted, balanceRaw: balance.toString(), address: proxyAddress, currency: 'USDC.e' });
    } catch (error) {
      console.error('Balance fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch balance', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  if (segment === 'initialize') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const privateKey = process.env.POLYMARKET_MAGIC_PK;
    if (!privateKey) return res.status(500).json({ error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables' });
    try {
      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const clobClient = new ClobClient(CLOB_API_URL, POLYGON_CHAIN_ID, wallet);
      let apiCredentials;
      try {
        const derivedCreds = await clobClient.deriveApiKey();
        if (derivedCreds?.key && derivedCreds?.secret && derivedCreds?.passphrase) apiCredentials = derivedCreds;
      } catch {
        // fall through to create
      }
      if (!apiCredentials) apiCredentials = await clobClient.createApiKey();
      if (!apiCredentials?.key || !apiCredentials?.secret || !apiCredentials?.passphrase) {
        return res.status(500).json({ error: 'Failed to create API credentials' });
      }
      return res.status(200).json({
        success: true,
        credentials: { key: apiCredentials.key, secret: apiCredentials.secret, passphrase: apiCredentials.passphrase },
        message: 'Trading session initialized successfully',
      });
    } catch (error) {
      console.error('Trading session initialization error:', error);
      return res.status(500).json({ error: 'Failed to initialize trading session', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  if (segment === 'private-key') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const privateKey = process.env.POLYMARKET_MAGIC_PK;
    if (!privateKey) return res.status(500).json({ error: 'Private key not configured' });
    return res.status(200).json({
      privateKey,
      warning: 'This endpoint exposes the private key. Consider using a browser wallet extension in production.',
    });
  }

  // Base /api/wallet (no segment or unknown): GET wallet info (EOA + proxy)
  if (req.method === 'GET') {
    const privateKey = process.env.POLYMARKET_MAGIC_PK;
    if (!privateKey) {
      return res.status(500).json({ error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables' });
    }
    try {
      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const eoaAddress = wallet.address;
      const proxyAddress = deriveProxyAddress(eoaAddress.toLowerCase());
      return res.status(200).json({ eoaAddress, proxyAddress, success: true });
    } catch (error) {
      console.error('[Wallet API] Error during wallet derivation:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      let userFriendlyError = 'Failed to derive wallet info';
      if (errorMessage.includes('Cannot find module') || errorMessage.includes('Module not found')) userFriendlyError = 'Missing dependency. Ensure viem package is installed.';
      else if (errorMessage.includes('invalid private key') || errorMessage.includes('invalid hex')) userFriendlyError = 'Invalid private key format. Check POLYMARKET_MAGIC_PK environment variable.';
      else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('network')) userFriendlyError = 'Network error. Check POLYGON_RPC_URL configuration.';
      return res.status(500).json({ error: userFriendlyError, message: errorMessage });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

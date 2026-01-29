import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, providers, Contract } from 'ethers';
import { keccak256, getCreate2Address, encodePacked } from 'viem';

// Polymarket Polygon Proxy Contract Addresses
const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052' as const;
const PROXY_INIT_CODE_HASH = '0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b' as const;

// Polygon RPC URL and contract addresses
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
// CTF (Conditional Token Framework) contract address on Polygon
// This is the main CTF contract that handles token redemption
const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097acE5Ea0476045';

/**
 * Derive Polymarket Non-Safe Proxy Wallet address from EOA address
 */
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

// CTF Contract ABI for redeemPositions
const CTF_ABI = [
  {
    constant: false,
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'uint256' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    name: 'redeemPositions',
    outputs: [],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const privateKey = process.env.POLYMARKET_MAGIC_PK;

  if (!privateKey) {
    return res.status(500).json({
      error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables',
    });
  }

  try {
    const { conditionId, indexSets, eventSlug, direction } = req.body;

    if (!conditionId || !indexSets || !Array.isArray(indexSets) || indexSets.length === 0) {
      return res.status(400).json({
        error: 'Missing required parameters: conditionId and indexSets (array)',
      });
    }

    const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
    const wallet = new Wallet(privateKey, provider);
    
    // Get proxy address using proper derivation
    const eoaAddress = wallet.address;
    const proxyAddress = deriveProxyAddress(eoaAddress.toLowerCase());

    // Connect to CTF contract
    const ctfContract = new Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, wallet);

    // Convert conditionId to uint256 (it might be a hex string or number)
    let conditionIdUint: string;
    if (typeof conditionId === 'string' && conditionId.startsWith('0x')) {
      conditionIdUint = conditionId;
    } else {
      // Convert to hex if it's a number or decimal string
      conditionIdUint = `0x${BigInt(conditionId).toString(16).padStart(64, '0')}`;
    }

    // Convert indexSets to uint256 array
    const indexSetsUint = indexSets.map((idx: number | string) => {
      if (typeof idx === 'string' && idx.startsWith('0x')) {
        return idx;
      }
      return `0x${BigInt(idx).toString(16).padStart(64, '0')}`;
    });

    // parentCollectionId is null (bytes32(0)) for Polymarket
    const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000';

    console.log('[Claim] Redeeming positions:', {
      proxyAddress,
      conditionId: conditionIdUint,
      indexSets: indexSetsUint,
      eventSlug,
      direction,
    });

    // Call redeemPositions on CTF contract
    // Note: The conditional tokens should be in the proxy wallet
    // If the proxy is a contract wallet, we may need to use its execute method
    // For now, we attempt the call directly - if tokens are in proxy, this will fail
    // and we'll need to implement proxy contract execution
    const tx = await ctfContract.redeemPositions(
      USDC_E_ADDRESS, // collateralToken
      parentCollectionId, // parentCollectionId (null for Polymarket)
      conditionIdUint, // conditionId
      indexSetsUint // indexSets
    );

    console.log('[Claim] Transaction sent:', tx.hash);

    // Wait for transaction confirmation
    const receipt = await tx.wait();

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      success: true,
      transactionHash: tx.hash,
      receipt: {
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed.toString(),
      },
      eventSlug,
      direction,
    });
  } catch (error) {
    console.error('[Claim] Error:', error);
    return res.status(500).json({
      error: 'Failed to claim tokens',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

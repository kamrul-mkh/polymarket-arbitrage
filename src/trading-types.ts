export interface StrategyConfig {
  enabled: boolean;
  // Entry price for limit order (0-100 scale for Polymarket binary markets)
  entryPrice: number; // e.g., 96
  // Profit target price (0-100 scale)
  profitTargetPrice: number; // e.g., 100
  // Stop loss price (0-100 scale)
  stopLossPrice: number; // e.g., 91
  // Trade size (in USD)
  tradeSize: number;
  // Price Difference (in USD) - Strategy only activates when |Price to Beat - Current BTC Price| equals this value
  // If not set (null/undefined), strategy works without this condition
  priceDifference?: number | null; // e.g., 100 (only trade if BTC price moved $100 from Price to Beat)
  // Direction is automatically determined by which token (UP/DOWN) reaches entry price first
  // Use limit sell for stop loss - order stays on book until filled, ensuring all shares are sold
  useLimitOrderForStopLoss?: boolean;
  // For trade size > threshold, place BUY limit order at (entry - discount) instead of market (e.g. entry 92 → limit at 90)
  useLimitOrderForLargeEntry?: boolean;
  entryLimitOrderAboveSize?: number; // Use limit order when trade size > this (default 70)
  entryLimitOrderDiscount?: number; // Limit price = entry - this (default 2, so 92 → 90)
  // Use percentage of balance for position sizing instead of fixed amount
  usePercentagePositionSize?: boolean;
  // Position size as percentage of balance (2-5% recommended)
  positionSizePercent?: number;
  // NEW: Arbitrage detection
  enableArbitrage?: boolean; // Enable arbitrage detection (risk-free profit)
  arbitrageThreshold?: number; // Minimum arbitrage opportunity (default 0.02 = 2%)
  // NEW: Volatility capture
  enableVolatilityCapture?: boolean; // Enable volatility capture in first 2 minutes
  volatilityDropThreshold?: number; // Price drop % to trigger (default 0.10 = 10%)
  volatilityPositionSizePercent?: number; // Position size for volatility trades (default 1-2%)
  // NEW: Trailing stop
  useTrailingStop?: boolean; // Use trailing stop instead of fixed profit target
  trailingStopDistance?: number; // Distance from peak for trailing stop (default 2%)
  // NEW: Liquidity filters
  enableLiquidityFilter?: boolean; // Check bid-ask spread before trading
  maxSpreadPercent?: number; // Maximum allowed spread (default 2%)
  // NEW: Time-based position sizing
  enableTimeBasedSizing?: boolean; // Adjust position size based on event time
  // NEW: Confidence-based sizing
  useConfidenceMultiplier?: boolean; // Use price difference as confidence multiplier
  // NEW: Mean reversion strategy
  enableMeanReversion?: boolean; // Enter when price moves far from 50% (expects reversion)
  meanReversionThreshold?: number; // Price distance from 50% to trigger (default 20% = enter at 30% or 70%)
  // NEW: Early exit on reversal
  enableEarlyExitOnReversal?: boolean; // Exit if price reverses after entry
  reversalExitThreshold?: number; // Price reversal % to trigger exit (default 0.05 = 5%)
  // NEW: Partial profit taking
  enablePartialProfitTaking?: boolean; // Take 50% profit early, let rest run
  partialProfitTarget?: number; // First profit target (default 96%)
  partialProfitPercent?: number; // Percentage of position to close at first target (default 50%)
  // NEW: Momentum confirmation
  enableMomentumConfirmation?: boolean; // Only enter if price is moving in direction
  momentumLookbackSeconds?: number; // Seconds to look back for momentum (default 30)
  // NEW: Event phase strategy
  enableEventPhaseStrategy?: boolean; // Different rules for different event phases
  earlyPhaseEntryPrice?: number; // Entry price for first 5 minutes (default 92%)
  middlePhaseEntryPrice?: number; // Entry price for middle 5 minutes (default 93%)
  latePhaseEntryPrice?: number; // Entry price for last 5 minutes (default 95%)
  latePhaseMaxPositionPercent?: number; // Max position size in last 5 minutes (default 1%)
}

export interface Trade {
  id: string;
  eventSlug: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number; // Price in 0-100 scale
  timestamp: number;
  status: 'pending' | 'filled' | 'failed' | 'cancelled';
  transactionHash?: string;
  profit?: number;
  reason: string; // Why the trade was executed
  orderType: 'LIMIT' | 'MARKET';
  limitPrice?: number; // Limit price if orderType is LIMIT
  direction?: 'UP' | 'DOWN'; // Direction determined automatically (UP = YES token, DOWN = NO token)
}

export interface Position {
  id: string; // Unique position ID
  eventSlug: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  entryPrice: number; // Entry price in 0-100 scale
  size: number; // Position size in USD
  currentPrice?: number; // Price in 0-100 scale
  unrealizedProfit?: number;
  direction?: 'UP' | 'DOWN'; // Direction (UP = YES token, DOWN = NO token)
  filledOrders?: Array<{
    orderId: string;
    price: number; // Fill price in 0-100 scale
    size: number; // Size in USD
    timestamp: number;
  }>; // Track individual filled orders for large positions
  entryTimestamp: number; // When position was entered
  // Auto-claim tracking fields
  eventEndTimestamp?: number; // When the event ended (for auto-claim)
  conditionId?: string; // CTF condition ID for redemption
  priceToBeat?: number; // Price to Beat for this event (for determining winner)
  claimed?: boolean; // Whether tokens have been claimed after resolution
  claimTimestamp?: number; // When tokens were claimed
  isWinner?: boolean; // Whether this position won (determined after event resolution)
}

export interface TradingStatus {
  isActive: boolean;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalProfit: number;
  pendingLimitOrders: number;
  positions: Position[]; // Array of positions (changed from single currentPosition)
  totalPositionSize?: number; // Total size across all positions
  walletBalance?: number; // Current wallet balance
  maxPositionSize?: number; // 50% of wallet balance
  // Keep currentPosition for backward compatibility during transition
  currentPosition?: {
    eventSlug: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    size: number;
    currentPrice?: number;
    unrealizedProfit?: number;
    direction?: 'UP' | 'DOWN';
    filledOrders?: Array<{
      orderId: string;
      price: number;
      size: number;
      timestamp: number;
    }>;
  };
}

export interface TradeExecutionResult {
  success: boolean;
  trade?: Trade;
  error?: string;
  transactionHash?: string;
}

/** Snapshot of prediction at 8th minute (by event start time) */
export interface PredictionAt8Min {
  direction: 'UP' | 'DOWN' | null;
  confidence: number;
  probability: number;
  reason: string;
  timestamp: number;
}

/** Snapshot of actual outcome at 15th minute */
export interface OutcomeAt15Min {
  direction: 'UP' | 'DOWN';
  yesPrice: number;
  noPrice: number;
  btcPrice?: number;
  timestamp: number;
}

/** Per-event record: predicted at 8 min vs outcome at 15 min */
export interface PredictionOutcomeRecord {
  eventSlug: string;
  eventTitle?: string;
  predictedAt8Min?: PredictionAt8Min;
  outcomeAt15Min?: OutcomeAt15Min;
  /** True if predicted direction matched outcome (when both exist) */
  correct?: boolean;
}

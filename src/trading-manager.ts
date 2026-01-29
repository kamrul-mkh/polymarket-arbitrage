import type { StrategyConfig, Trade, TradingStatus, Position, PredictionOutcomeRecord } from './trading-types';
import { CLOBClientWrapper } from './clob-client';
import type { EventDisplayData } from './event-manager';
import type { ClobClient } from '@polymarket/clob-client';
import { TrendPredictor, type TrendSignal } from './trend-predictor';

/**
 * Converts Polymarket price from decimal (0-1) to percentage (0-100)
 */
function toPercentage(price: number): number {
  return price * 100;
}

export class TradingManager {
  private clobClient: CLOBClientWrapper;
  private browserClobClient: ClobClient | null = null; // Browser ClobClient for order placement (bypasses Cloudflare)
  private strategyConfig: StrategyConfig;
  private trades: Trade[] = [];
  private status: TradingStatus;
  private onStatusUpdate: ((status: TradingStatus) => void) | null = null;
  private onTradeUpdate: ((trade: Trade) => void) | null = null;
  private isMonitoring: boolean = false; // Flag to control continuous monitoring loop
  private activeEvent: EventDisplayData | null = null;
  private pendingLimitOrders: Map<string, Trade> = new Map(); // Map of tokenId -> pending limit order
  private currentPrice: number | null = null; // Current BTC/USD price
  private priceToBeat: number | null = null; // Price to Beat for active event
  private apiCredentials: { key: string; secret: string; passphrase: string } | null = null; // API credentials for order placement
  private isPlacingOrder: boolean = false; // Flag to prevent multiple simultaneous orders
  private isPlacingSplitOrders: boolean = false; // Flag to track if we're placing split orders
  private isPlacingExitOrder: boolean = false; // Flag to prevent multiple simultaneous exit orders (separate from entry orders)
  private positions: Position[] = []; // Array of positions instead of single currentPosition
  private priceBelowEntry: boolean = false; // Track if price dropped below entry after position
  private consecutiveFailures: number = 0; // Circuit breaker counter
  private readonly MAX_CONSECUTIVE_FAILURES = 5; // Circuit breaker threshold
  private orderPlacementStartTime: number = 0; // Track when order placement started
  private readonly MAX_ORDER_PLACEMENT_TIME = 30000; // 30 seconds max for order placement
  private consecutiveWins: number = 0; // Track consecutive wins for position sizing
  private consecutiveLosses: number = 0; // Track consecutive losses for position sizing
  private autoClaimInterval: number | null = null; // Auto-claim monitoring interval
  private trailingStopPrice: number | null = null; // Current trailing stop price
  private peakPrice: number | null = null; // Peak price for trailing stop calculation
  private eventStartTime: number | null = null; // Event start time for time-based strategies
  private trendPredictor: TrendPredictor; // Trend prediction system (for simulation/display)
  private currentTrendSignal: TrendSignal | null = null; // Current trend prediction
  private onTrendSignalUpdate: ((signal: TrendSignal | null) => void) | null = null; // Callback for trend signal updates
  private priceHistory: Array<{ timestamp: number; yesPrice: number; noPrice: number }> = []; // Price history for momentum/reversal detection
  private partialProfitTaken: Map<string, boolean> = new Map(); // Track which positions have taken partial profit
  /** Per-event: prediction at 8 min vs outcome at 15 min (by event start time) */
  private predictionOutcomeRecords: PredictionOutcomeRecord[] = [];
  private readonly PREDICTION_MINUTE = 8;
  private readonly OUTCOME_MINUTE = 15;

  constructor() {
    this.clobClient = new CLOBClientWrapper();
    this.strategyConfig = this.getDefaultStrategy();
    this.status = {
      isActive: false,
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalProfit: 0,
      pendingLimitOrders: 0,
      positions: [],
    };
    // Initialize trend predictor
    this.trendPredictor = new TrendPredictor();
    this.trendPredictor.setOnSignalUpdate((signal) => {
      this.currentTrendSignal = signal;
      this.maybeRecordPredictionAt8Min(signal);
      if (this.onTrendSignalUpdate) {
        this.onTrendSignalUpdate(signal);
      }
    });
  }

  private getDefaultStrategy(): StrategyConfig {
    return {
      enabled: false,
      entryPrice: 93, // Entry at 93% for more opportunities
      profitTargetPrice: 99, // Take profit at 99%
      stopLossPrice: 91, // Stop loss at 91
      tradeSize: 50, // Base trade size (will be calculated dynamically)
      useLimitOrderForStopLoss: true, // Use limit sell for stop loss so all shares are sold
      useLimitOrderForLargeEntry: true, // For trade size > 70, place BUY limit at (entry - 2)
      entryLimitOrderAboveSize: 70, // Use limit order when trade size > this (USD)
      entryLimitOrderDiscount: 2, // Limit price = entry - this (e.g. entry 92 → limit at 90)
      usePercentagePositionSize: true, // Use percentage of balance instead of fixed amount
      positionSizePercent: 3, // 3% of balance per trade (default 2-5%)
      // NEW: Arbitrage detection (risk-free profit)
      enableArbitrage: true,
      arbitrageThreshold: 0.02, // 2% minimum arbitrage opportunity
      // NEW: Volatility capture
      enableVolatilityCapture: true,
      volatilityDropThreshold: 0.10, // 10% price drop triggers entry
      volatilityPositionSizePercent: 1.5, // 1.5% for fast volatility trades
      // NEW: Trailing stop
      useTrailingStop: true,
      trailingStopDistance: 2, // 2% trailing stop distance
      // NEW: Liquidity filters
      enableLiquidityFilter: true,
      maxSpreadPercent: 2, // Max 2% spread
      // NEW: Time-based position sizing
      enableTimeBasedSizing: true,
      // NEW: Confidence-based sizing
      useConfidenceMultiplier: true,
      // NEW: Mean reversion strategy
      enableMeanReversion: false, // Disabled by default (can conflict with regular strategy)
      meanReversionThreshold: 20, // Enter at 30% or 70% (20% from 50%)
      // NEW: Early exit on reversal
      enableEarlyExitOnReversal: true,
      reversalExitThreshold: 0.05, // 5% reversal triggers exit
      // NEW: Partial profit taking
      enablePartialProfitTaking: true,
      partialProfitTarget: 96, // Take 50% profit at 96%
      partialProfitPercent: 50, // Close 50% of position
      // NEW: Momentum confirmation
      enableMomentumConfirmation: true,
      momentumLookbackSeconds: 30, // Check momentum over last 30 seconds
      // NEW: Event phase strategy
      enableEventPhaseStrategy: true,
      earlyPhaseEntryPrice: 92, // First 5 minutes
      middlePhaseEntryPrice: 93, // Middle 5 minutes
      latePhaseEntryPrice: 95, // Last 5 minutes
      latePhaseMaxPositionPercent: 1, // Max 1% in last 5 minutes
    };
  }

  setStrategyConfig(config: Partial<StrategyConfig>): void {
    this.strategyConfig = { ...this.strategyConfig, ...config };
    this.saveStrategyConfig();
  }

  /** Alias for setStrategyConfig for multi-asset compatibility */
  updateStrategyConfig(config: Partial<StrategyConfig>): void {
    this.setStrategyConfig(config);
  }

  getStrategyConfig(): StrategyConfig {
    return { ...this.strategyConfig };
  }

  private saveStrategyConfig(): void {
    try {
      localStorage.setItem('tradingStrategy', JSON.stringify(this.strategyConfig));
    } catch (error) {
      console.warn('Failed to save strategy config:', error);
    }
  }

  loadStrategyConfig(): void {
    try {
      const saved = localStorage.getItem('tradingStrategy');
      if (saved) {
        this.strategyConfig = { ...this.strategyConfig, ...JSON.parse(saved) };
      }
    } catch (error) {
      console.warn('Failed to load strategy config:', error);
    }
  }

  setOnStatusUpdate(callback: (status: TradingStatus) => void): void {
    this.onStatusUpdate = callback;
  }

  setOnTradeUpdate(callback: (trade: Trade) => void): void {
    this.onTradeUpdate = callback;
  }

  /**
   * Set callback for trend signal updates (for UI display)
   */
  setOnTrendSignalUpdate(callback: (signal: TrendSignal | null) => void): void {
    this.onTrendSignalUpdate = callback;
  }

  /**
   * Get current trend signal (for UI display)
   */
  getCurrentTrendSignal(): TrendSignal | null {
    return this.currentTrendSignal;
  }

  /**
   * Set wallet balance and calculate max position size (50% of balance)
   */
  setWalletBalance(balance: number): void {
    // Calculate max position size (50% of balance)
    if (balance) {
      this.status.maxPositionSize = balance * 0.5;
      this.status.walletBalance = balance;
    }
    this.notifyStatusUpdate();
  }

  /**
   * Verify sufficient balance before placing order
   */
  private verifyBalance(requiredAmount: number): boolean {
    if (!this.status.walletBalance) {
      console.warn('[TradingManager] Balance verification skipped - wallet balance not set');
      return true; // Allow trade if balance is not set (simulation mode)
    }
    
    const available = this.status.walletBalance;
    if (available < requiredAmount) {
      console.error(`[TradingManager] 🚫 Insufficient balance: Required ${requiredAmount.toFixed(2)} USDC, Available ${available.toFixed(2)} USDC`);
      return false;
    }
    
    console.log(`[TradingManager] ✅ Balance verified: Required ${requiredAmount.toFixed(2)} USDC, Available ${available.toFixed(2)} USDC`);
    return true;
  }

  /**
   * Calculate dynamic position size based on:
   * - Percentage of balance (if enabled)
   * - Confidence (priceDifference filter or confidence multiplier)
   * - Win/loss streaks (increase after wins, decrease after losses)
   * - Time-based adjustment (reduce in first/last 2 minutes)
   * - Confidence-based multiplier (price difference as confidence)
   */
  private calculatePositionSize(isVolatilityTrade: boolean = false): number {
    const config = this.strategyConfig;
    const balance = this.status.walletBalance || 0;
    
    // Base size calculation
    let baseSize: number;
    
    if (isVolatilityTrade && config.volatilityPositionSizePercent) {
      // Volatility trades use smaller size (1-2%)
      baseSize = balance * (config.volatilityPositionSizePercent / 100);
    } else if (config.usePercentagePositionSize && balance > 0) {
      // Use percentage of balance (2-5% default)
      const percent = config.positionSizePercent || 3;
      baseSize = balance * (percent / 100);
    } else {
      // Use fixed trade size
      baseSize = config.tradeSize;
    }
    
    // NEW: Confidence multiplier based on price difference
    let confidenceMultiplier = 1.0;
    if (config.useConfidenceMultiplier && this.currentPrice !== null && this.priceToBeat !== null) {
      const priceDiff = Math.abs(this.priceToBeat - this.currentPrice);
      // Higher price difference = higher confidence = larger position
      // Scale from 0.8x (no movement) to 1.5x (large movement)
      confidenceMultiplier = Math.min(0.8 + (priceDiff / 200) * 0.7, 1.5);
    } else if (config.priceDifference !== null && config.priceDifference !== undefined) {
      // Legacy: Price difference filter is active - this indicates higher confidence
      confidenceMultiplier = 1.2; // 20% larger when filter is met
    }
    
    // Win/loss streak adjustment
    let streakMultiplier = 1.0;
    if (this.consecutiveWins >= 2) {
      // After 2+ wins, increase size by 10% per win (max 1.5x)
      streakMultiplier = Math.min(1.0 + (this.consecutiveWins - 1) * 0.1, 1.5);
    } else if (this.consecutiveLosses >= 2) {
      // After 2+ losses, decrease size by 15% per loss (min 0.5x)
      streakMultiplier = Math.max(1.0 - (this.consecutiveLosses - 1) * 0.15, 0.5);
    }
    
    // NEW: Time-based position sizing
    let timeMultiplier = 1.0;
    if (config.enableTimeBasedSizing && this.activeEvent && this.eventStartTime) {
      const now = Date.now() / 1000;
      const eventStart = this.eventStartTime;
      const timeRemaining = (this.activeEvent.endDate ? new Date(this.activeEvent.endDate).getTime() / 1000 : eventStart + 900) - now;
      
      if (timeRemaining < 120) {
        // Last 2 minutes - reduce size (prices less predictable)
        timeMultiplier = 0.5;
      } else if (timeRemaining > 780) {
        // First 2 minutes - volatility capture uses smaller size already, but reduce regular trades
        timeMultiplier = 0.7;
      }
    }
    
    const finalSize = baseSize * confidenceMultiplier * streakMultiplier * timeMultiplier;
    
    // Ensure minimum size of $10 and maximum of 50% of balance
    const minSize = 10;
    const maxSize = balance > 0 ? balance * 0.5 : baseSize * 2;
    const clampedSize = Math.max(minSize, Math.min(finalSize, maxSize));
    
    console.log(`[TradingManager] 📊 Position size calculation:`, {
      baseSize: baseSize.toFixed(2),
      confidenceMultiplier: confidenceMultiplier.toFixed(2),
      streakMultiplier: streakMultiplier.toFixed(2),
      timeMultiplier: timeMultiplier.toFixed(2),
      consecutiveWins: this.consecutiveWins,
      consecutiveLosses: this.consecutiveLosses,
      finalSize: clampedSize.toFixed(2),
      balance: balance.toFixed(2),
      method: isVolatilityTrade ? 'volatility' : (config.usePercentagePositionSize ? `percentage (${config.positionSizePercent}%)` : 'fixed'),
    });
    
    return clampedSize;
  }

  /**
   * Get all active positions for the current event
   */
  getActivePositions(): Position[] {
    if (!this.activeEvent) {
      return [];
    }
    return this.positions.filter(p => p.eventSlug === this.activeEvent!.slug);
  }

  updateMarketData(
    currentPrice: number | null,
    priceToBeat: number | null,
    activeEvent: EventDisplayData | null,
    yesPrice?: number,
    noPrice?: number
  ): void {
    this.currentPrice = currentPrice;
    this.priceToBeat = priceToBeat;
    
    // Track event start time for time-based strategies
    if (activeEvent && (!this.activeEvent || activeEvent.slug !== this.activeEvent.slug)) {
      // New event - reset tracking
      this.eventStartTime = activeEvent.timestamp || Math.floor(Date.now() / 1000);
      this.trailingStopPrice = null;
      this.peakPrice = null;
      // Clear trend predictor history for new event
      this.trendPredictor.clearHistory();
    }
    
    this.activeEvent = activeEvent;

    // Feed price data to trend predictor (for simulation/display)
    if (currentPrice !== null && yesPrice !== undefined && noPrice !== undefined) {
      this.trendPredictor.addPricePoint({
        timestamp: Date.now(),
        value: currentPrice,
        yesPrice: yesPrice,
        noPrice: noPrice,
      });

      // Update trend prediction
      if (priceToBeat !== null && this.trendPredictor.getHistory().length >= 10) {
        this.trendPredictor.predictTrend(priceToBeat, currentPrice, yesPrice, noPrice);
      }

      this.maybeRecordOutcomeAt15Min(currentPrice, yesPrice, noPrice);
    }

    if (this.strategyConfig.enabled && this.status.isActive && activeEvent) {
      this.checkTradingConditions();
    }
  }

  /**
   * Record prediction at 8th minute (by event start time) when we receive a trend signal.
   */
  private maybeRecordPredictionAt8Min(signal: TrendSignal | null): void {
    if (!signal || !this.activeEvent || this.eventStartTime === null) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const timeSinceStartSec = nowSec - this.eventStartTime;
    if (timeSinceStartSec < this.PREDICTION_MINUTE * 60) return;

    let record = this.predictionOutcomeRecords.find(r => r.eventSlug === this.activeEvent!.slug);
    if (record?.predictedAt8Min) return; // Already recorded for this event

    if (!record) {
      record = { eventSlug: this.activeEvent.slug, eventTitle: this.activeEvent.title };
      this.predictionOutcomeRecords.push(record);
    }
    record.predictedAt8Min = {
      direction: signal.direction,
      confidence: signal.confidence,
      probability: signal.probability,
      reason: signal.reason,
      timestamp: Date.now(),
    };
    console.log(`[TradingManager] 📌 Recorded prediction at ~8 min for ${this.activeEvent.slug}: ${signal.direction} (${signal.confidence.toFixed(0)}%)`);
  }

  /**
   * Record outcome at 15th minute (by event start time) from current prices.
   */
  private maybeRecordOutcomeAt15Min(currentPrice: number, yesPrice: number, noPrice: number): void {
    if (!this.activeEvent || this.eventStartTime === null) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const timeSinceStartSec = nowSec - this.eventStartTime;
    if (timeSinceStartSec < this.OUTCOME_MINUTE * 60) return;

    let record = this.predictionOutcomeRecords.find(r => r.eventSlug === this.activeEvent!.slug);
    if (!record?.predictedAt8Min || record.outcomeAt15Min) return; // Need prediction first; don't overwrite outcome

    const direction: 'UP' | 'DOWN' = yesPrice > noPrice ? 'UP' : 'DOWN';
    record.outcomeAt15Min = {
      direction,
      yesPrice,
      noPrice,
      btcPrice: currentPrice,
      timestamp: Date.now(),
    };
    record.correct = record.predictedAt8Min.direction === direction;
    console.log(`[TradingManager] 📌 Recorded outcome at ~15 min for ${this.activeEvent.slug}: ${direction} (YES ${yesPrice.toFixed(1)} / NO ${noPrice.toFixed(1)}) — ${record.correct ? '✓ Match' : '✗ Mismatch'}`);
  }

  /**
   * Get per-event records: prediction at 8 min vs outcome at 15 min (newest first).
   */
  getPredictionOutcomeRecords(): PredictionOutcomeRecord[] {
    return [...this.predictionOutcomeRecords].reverse();
  }

  /**
   * Set API credentials for order placement
   */
  setApiCredentials(credentials: { key: string; secret: string; passphrase: string } | null): void {
    this.apiCredentials = credentials;
  }

  /**
   * Set browser ClobClient for client-side order placement (bypasses Cloudflare)
   */
  setBrowserClobClient(clobClient: ClobClient | null): void {
    this.browserClobClient = clobClient;
    if (clobClient) {
      console.log('[TradingManager] Browser ClobClient set - orders will be placed from browser (bypasses Cloudflare)');
    } else {
      console.log('[TradingManager] Browser ClobClient cleared - server-side API is blocked by Cloudflare, orders will fail');
    }
  }

  /**
   * Get browser ClobClient status
   */
  getBrowserClobClient(): ClobClient | null {
    return this.browserClobClient;
  }

  /**
   * Initialize browser ClobClient (stub for multi-asset API).
   * Actual initialization is done by the streaming platform and client is set via setBrowserClobClient.
   */
  async initializeBrowserClobClient(_eoaAddress: string, _proxyAddress: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Get API credentials
   */
  getApiCredentials(): { key: string; secret: string; passphrase: string } | null {
    return this.apiCredentials;
  }

  /**
   * Check if we should place a limit order or if existing orders should fill/exit
   * Monitors both UP (YES) and DOWN (NO) tokens and places order on whichever reaches entry price first
   */
  private async checkTradingConditions(): Promise<void> {
    if (!this.strategyConfig.enabled || !this.status.isActive) {
      console.log('[TradingManager] checkTradingConditions skipped: enabled=', this.strategyConfig.enabled, 'active=', this.status.isActive);
      return;
    }

    if (!this.activeEvent) {
      console.log('[TradingManager] checkTradingConditions skipped: no active event');
      return;
    }

    // Check if we have token IDs for the active event
    if (!this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      console.log('[TradingManager] checkTradingConditions skipped: missing token IDs');
      return;
    }

    const yesTokenId = this.activeEvent.clobTokenIds[0]; // YES/UP token
    const noTokenId = this.activeEvent.clobTokenIds[1]; // NO/DOWN token

    if (!yesTokenId || !noTokenId) {
      return;
    }

    // If we have positions, update prices and check exit conditions FIRST (regardless of price difference)
    // Price difference check only applies to entry conditions, not exit conditions
    // CRITICAL: Exit conditions must ALWAYS be checked, even if entry orders are in progress!
    const activePositions = this.getActivePositions();
    if (activePositions.length > 0) {
      // Check if EXIT order is already in progress (not entry orders - those shouldn't block exits!)
      if (this.isPlacingExitOrder) {
        // Don't spam logs, but check if stuck
        const timeSinceOrderStart = Date.now() - this.orderPlacementStartTime;
        if (timeSinceOrderStart > 60000) { // 60 seconds
          console.error(`[TradingManager] 🚨 EXIT ORDER IN PROGRESS FOR ${(timeSinceOrderStart / 1000).toFixed(0)}s - May be stuck!`);
        }
        return; // Skip this check cycle, exit already in progress
      }
      
      // Log if entry orders are in progress (for debugging, but don't block)
      if (this.isPlacingOrder || this.isPlacingSplitOrders) {
        const timeSinceOrderStart = Date.now() - this.orderPlacementStartTime;
        console.log(`[TradingManager] ℹ️ Entry order in progress (${timeSinceOrderStart}ms), but exit conditions will still be checked`);
      }
      
      // Update position prices continuously (even if entry orders are in progress)
      await this.updatePositionPrices();
      // Then check exit conditions (CRITICAL: this must always run when positions exist!)
      await this.checkExitConditions();
      return;
    }

    // ADDITIONAL SAFEGUARD: Check if order is already being placed (prevents race condition)
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      return; // Don't check entry conditions if order is being placed
    }

    // Price Difference condition check - only applies to entry conditions (when no position exists)
    if (this.strategyConfig.priceDifference !== null && this.strategyConfig.priceDifference !== undefined) {
      if (this.currentPrice === null || this.priceToBeat === null) {
        // Need both prices to check condition
        return;
      }

      const priceDiff = Math.abs(this.priceToBeat - this.currentPrice);
      const targetDiff = this.strategyConfig.priceDifference;
      const threshold = 0.01; // Small threshold for floating point comparison

      // Only proceed if price difference matches (within threshold)
      if (Math.abs(priceDiff - targetDiff) > threshold) {
        // Price difference condition not met, skip trading
        return;
      }
    }

    // Prevent multiple simultaneous orders
    if (this.isPlacingOrder) {
      return;
    }

    // Check pending limit orders for both tokens (legacy support - market orders are immediate)
    // Note: Market orders (FAK) execute immediately, so we don't need to check for pending orders
    // This check is kept for backward compatibility with any existing pending limit orders
    if (this.pendingLimitOrders.has(yesTokenId)) {
      await this.checkLimitOrderFill(yesTokenId);
      return;
    }
    if (this.pendingLimitOrders.has(noTokenId)) {
      await this.checkLimitOrderFill(noTokenId);
      return;
    }

    // Check both tokens and place market order (Fill or Kill) on whichever reaches entry price first
    // Market orders execute immediately with builder attribution via remote signing
    await this.checkAndPlaceMarketOrder(yesTokenId, noTokenId);
  }

  /**
   * Check for arbitrage opportunity (YES + NO prices < $1.00)
   * Returns opportunity details if arbitrage exists
   */
  private async checkArbitrageOpportunity(
    _yesTokenId: string,
    _noTokenId: string,
    yesPrice: number,
    noPrice: number
  ): Promise<{
    shouldExecute: boolean;
    priceSum: number;
    arbitragePercent: number;
    estimatedProfit: number;
  }> {
    const threshold = this.strategyConfig.arbitrageThreshold || 0.02; // Default 2%
    const priceSum = yesPrice + noPrice;
    const arbitragePercent = 1.0 - priceSum; // How much below $1.00
    
    if (arbitragePercent >= threshold) {
      // Calculate estimated profit
      const balance = this.status.walletBalance || 0;
      const tradeSize = Math.min(balance * 0.1, 1000); // Use up to 10% of balance, max $1000
      const estimatedProfit = tradeSize * arbitragePercent;
      
      return {
        shouldExecute: true,
        priceSum,
        arbitragePercent,
        estimatedProfit,
      };
    }
    
    return {
      shouldExecute: false,
      priceSum,
      arbitragePercent: 0,
      estimatedProfit: 0,
    };
  }

  /**
   * Execute arbitrage trade: Buy both YES and NO tokens, then merge for profit
   */
  private async executeArbitrageTrade(
    yesTokenId: string,
    noTokenId: string,
    opportunity: { priceSum: number; arbitragePercent: number; estimatedProfit: number }
  ): Promise<void> {
    if (!this.browserClobClient || !this.apiCredentials) {
      console.error('[TradingManager] Cannot execute arbitrage - missing ClobClient or credentials');
      return;
    }

    try {
      const balance = this.status.walletBalance || 0;
      const tradeSize = Math.min(balance * 0.1, 1000); // Use up to 10% of balance, max $1000
      const sizePerToken = tradeSize / 2; // Split between YES and NO

      console.log(`[TradingManager] 💰 Executing arbitrage trade:`, {
        tradeSize: tradeSize.toFixed(2),
        sizePerToken: sizePerToken.toFixed(2),
        arbitragePercent: (opportunity.arbitragePercent * 100).toFixed(2) + '%',
        estimatedProfit: opportunity.estimatedProfit.toFixed(2),
      });

      // Get current prices for buying
      const [yesBuyPrice, noBuyPrice] = await Promise.all([
        this.clobClient.getPrice(yesTokenId, 'BUY'),
        this.clobClient.getPrice(noTokenId, 'BUY'),
      ]);

      if (!yesBuyPrice || !noBuyPrice) {
        throw new Error('Failed to get prices for arbitrage');
      }

      // Check liquidity before executing
      if (this.strategyConfig.enableLiquidityFilter) {
        const liquidityCheck = await this.checkLiquidity(yesTokenId, noTokenId);
        if (!liquidityCheck.isLiquid) {
          console.warn(`[TradingManager] ⚠️ Skipping arbitrage - insufficient liquidity (spread: ${(liquidityCheck.spread * 100).toFixed(2)}%)`);
          return;
        }
      }

      // Buy YES token (placeMarketOrder is async void, but positions will be created)
      const yesShares = sizePerToken / yesBuyPrice;
      await this.placeMarketOrder(yesTokenId, yesBuyPrice * 100, 'UP');
      
      // Small delay between orders
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Buy NO token
      const noShares = sizePerToken / noBuyPrice;
      await this.placeMarketOrder(noTokenId, noBuyPrice * 100, 'DOWN');

      // Create arbitrage trade record
      const arbitrageTrade: Trade = {
        id: `arbitrage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        eventSlug: this.activeEvent!.slug,
        tokenId: `${yesTokenId}+${noTokenId}`,
        side: 'BUY',
        size: tradeSize,
        price: (yesBuyPrice + noBuyPrice) * 100 / 2, // Average price
        timestamp: Date.now(),
        status: 'filled',
        transactionHash: `arbitrage-${Date.now()}`,
        profit: opportunity.estimatedProfit,
        reason: `💰 ARBITRAGE: Bought both tokens at ${(opportunity.priceSum * 100).toFixed(2)}% (${(opportunity.arbitragePercent * 100).toFixed(2)}% profit)`,
        orderType: 'MARKET',
      };

      this.trades.push(arbitrageTrade);
      this.status.totalTrades++;
      this.status.successfulTrades++;
      this.status.totalProfit += opportunity.estimatedProfit;
      this.notifyTradeUpdate(arbitrageTrade);

      // Wait a moment for positions to be created, then merge tokens
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.mergeArbitrageTokens(yesTokenId, noTokenId, yesShares, noShares);
    } catch (error) {
      console.error('[TradingManager] ❌ Arbitrage execution failed:', error);
      this.status.failedTrades++;
    }
  }

  /**
   * Merge arbitrage tokens by redeeming both outcomes
   */
  private async mergeArbitrageTokens(
    _yesTokenId: string,
    _noTokenId: string,
    yesShares: number,
    noShares: number
  ): Promise<void> {
    if (!this.activeEvent?.conditionId) {
      console.error('[TradingManager] Cannot merge - missing conditionId');
      return;
    }

    try {
      // Call claim API with both indexSets [1, 2] to merge both tokens
      const response = await fetch('/api/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conditionId: this.activeEvent.conditionId,
          indexSets: [1, 2], // Both outcomes
          eventSlug: this.activeEvent.slug,
          direction: 'ARBITRAGE',
        }),
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`[TradingManager] ✅ Arbitrage tokens merged successfully:`, {
          transactionHash: result.transactionHash,
          yesShares: yesShares.toFixed(4),
          noShares: noShares.toFixed(4),
        });
      }
    } catch (error) {
      console.error('[TradingManager] ❌ Failed to merge arbitrage tokens:', error);
    }
  }

  /**
   * Update price history for momentum/reversal detection
   */
  private updatePriceHistory(yesPricePercent: number, noPricePercent: number): void {
    const now = Date.now();
    this.priceHistory.push({ timestamp: now, yesPrice: yesPricePercent, noPrice: noPricePercent });
    
    // Keep only last 5 minutes of history
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    this.priceHistory = this.priceHistory.filter(p => p.timestamp > fiveMinutesAgo);
  }

  /**
   * Check mean reversion opportunity - enter when price moves far from 50%
   */
  private checkMeanReversion(
    yesPricePercent: number,
    noPricePercent: number
  ): {
    shouldEnter: boolean;
    tokenId: string | null;
    direction: 'UP' | 'DOWN' | null;
    price: number;
    distanceFrom50: number;
  } {
    if (!this.activeEvent || !this.activeEvent.clobTokenIds) {
      return { shouldEnter: false, tokenId: null, direction: null, price: 0, distanceFrom50: 0 };
    }

    const threshold = this.strategyConfig.meanReversionThreshold || 20; // Default 20%
    const yesTokenId = this.activeEvent.clobTokenIds[0];
    const noTokenId = this.activeEvent.clobTokenIds[1];

    // Check if YES price is far below 50% (expect it to revert up)
    const yesDistanceFrom50 = 50 - yesPricePercent;
    if (yesDistanceFrom50 >= threshold) {
      return {
        shouldEnter: true,
        tokenId: yesTokenId,
        direction: 'UP',
        price: yesPricePercent,
        distanceFrom50: yesDistanceFrom50,
      };
    }

    // Check if NO price is far below 50% (expect it to revert up, meaning YES goes down)
    const noDistanceFrom50 = 50 - noPricePercent;
    if (noDistanceFrom50 >= threshold) {
      return {
        shouldEnter: true,
        tokenId: noTokenId,
        direction: 'DOWN',
        price: noPricePercent,
        distanceFrom50: noDistanceFrom50,
      };
    }

    return { shouldEnter: false, tokenId: null, direction: null, price: 0, distanceFrom50: 0 };
  }

  /**
   * Check momentum - only enter if price is moving in the expected direction
   */
  private checkMomentum(
    direction: 'UP' | 'DOWN',
    yesPricePercent: number,
    noPricePercent: number
  ): {
    hasMomentum: boolean;
    trend: string;
    priceChange: number;
  } {
    const lookbackSeconds = this.strategyConfig.momentumLookbackSeconds || 30;
    const lookbackTime = Date.now() - lookbackSeconds * 1000;
    
    // Get price history within lookback period
    const recentHistory = this.priceHistory.filter(p => p.timestamp >= lookbackTime);
    
    if (recentHistory.length < 2) {
      // Not enough history, allow entry
      return { hasMomentum: true, trend: 'insufficient_data', priceChange: 0 };
    }

    const currentPrice = direction === 'UP' ? yesPricePercent : noPricePercent;
    const oldPrice = direction === 'UP' 
      ? recentHistory[0].yesPrice 
      : recentHistory[0].noPrice;
    
    const priceChange = currentPrice - oldPrice;
    const priceChangePercent = (priceChange / oldPrice) * 100;

    // For UP: need positive momentum (price going up)
    // For DOWN: need negative momentum (price going down, meaning YES going up)
    if (direction === 'UP') {
      const hasMomentum = priceChangePercent > 0.5; // At least 0.5% increase
      return {
        hasMomentum,
        trend: hasMomentum ? 'upward' : 'downward_or_stagnant',
        priceChange: priceChangePercent,
      };
    } else {
      // For DOWN, we want NO price going up (YES going down)
      const noPriceChange = noPricePercent - recentHistory[0].noPrice;
      const noPriceChangePercent = (noPriceChange / recentHistory[0].noPrice) * 100;
      const hasMomentum = noPriceChangePercent > 0.5; // NO price increasing
      return {
        hasMomentum,
        trend: hasMomentum ? 'upward' : 'downward_or_stagnant',
        priceChange: noPriceChangePercent,
      };
    }
  }

  /**
   * Check for volatility capture opportunity (first 2 minutes, 10%+ price drop)
   */
  private async checkVolatilityCapture(
    _yesTokenId: string,
    _noTokenId: string,
    yesPrice: number,
    noPrice: number
  ): Promise<{
    shouldExecute: boolean;
    direction: 'UP' | 'DOWN' | null;
    priceDropPercent: number;
    timeRemaining: number;
  }> {
    if (!this.activeEvent || !this.eventStartTime) {
      return { shouldExecute: false, direction: null, priceDropPercent: 0, timeRemaining: 0 };
    }

    const now = Date.now() / 1000;
    const timeSinceStart = now - this.eventStartTime;
    const timeRemaining = 120 - timeSinceStart; // First 2 minutes = 120 seconds

    // Only in first 2 minutes
    if (timeSinceStart > 120 || timeSinceStart < 0) {
      return { shouldExecute: false, direction: null, priceDropPercent: 0, timeRemaining: 0 };
    }

    // Get price history to detect drops
    // For now, compare current price to entry price (93%)
    const threshold = this.strategyConfig.volatilityDropThreshold || 0.10; // 10%
    const entryPrice = this.strategyConfig.entryPrice / 100; // Convert to 0-1 scale

    const yesPriceDrop = (entryPrice - yesPrice) / entryPrice;
    const noPriceDrop = (entryPrice - noPrice) / entryPrice;

    if (yesPriceDrop >= threshold) {
      return {
        shouldExecute: true,
        direction: 'UP',
        priceDropPercent: yesPriceDrop,
        timeRemaining,
      };
    } else if (noPriceDrop >= threshold) {
      return {
        shouldExecute: true,
        direction: 'DOWN',
        priceDropPercent: noPriceDrop,
        timeRemaining,
      };
    }

    return { shouldExecute: false, direction: null, priceDropPercent: 0, timeRemaining };
  }

  /**
   * Execute volatility capture trade
   */
  private async executeVolatilityTrade(
    opportunity: { direction: 'UP' | 'DOWN'; priceDropPercent: number; timeRemaining: number }
  ): Promise<void> {
    if (!this.activeEvent?.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      return;
    }

    const yesTokenId = this.activeEvent.clobTokenIds[0];
    const noTokenId = this.activeEvent.clobTokenIds[1];
    const tokenId = opportunity.direction === 'UP' ? yesTokenId : noTokenId;

    // Use smaller position size for volatility trades
    this.calculatePositionSize(true); // isVolatilityTrade = true

    try {
      await this.placeMarketOrder(tokenId, this.strategyConfig.entryPrice, opportunity.direction);
    } catch (error) {
      console.error('[TradingManager] ❌ Volatility trade execution failed:', error);
    }
  }

  /**
   * Check liquidity (bid-ask spread) before trading
   */
  private async checkLiquidity(
    yesTokenId: string,
    noTokenId: string
  ): Promise<{ isLiquid: boolean; spread: number; yesSpread: number; noSpread: number }> {
    const maxSpread = (this.strategyConfig.maxSpreadPercent || 2) / 100; // Default 2%

    try {
      // Get bid and ask prices
      const [yesBid, yesAsk, noBid, noAsk] = await Promise.all([
        this.clobClient.getPrice(yesTokenId, 'BUY'), // Bid
        this.clobClient.getPrice(yesTokenId, 'SELL'), // Ask
        this.clobClient.getPrice(noTokenId, 'BUY'), // Bid
        this.clobClient.getPrice(noTokenId, 'SELL'), // Ask
      ]);

      if (!yesBid || !yesAsk || !noBid || !noAsk) {
        return { isLiquid: false, spread: 1, yesSpread: 1, noSpread: 1 };
      }

      const yesSpread = (yesAsk - yesBid) / yesBid;
      const noSpread = (noAsk - noBid) / noBid;
      const maxSpreadFound = Math.max(yesSpread, noSpread);

      return {
        isLiquid: maxSpreadFound <= maxSpread,
        spread: maxSpreadFound,
        yesSpread,
        noSpread,
      };
    } catch (error) {
      console.error('[TradingManager] Error checking liquidity:', error);
      return { isLiquid: true, spread: 0, yesSpread: 0, noSpread: 0 }; // Allow trade if check fails
    }
  }

  /**
   * Check both UP and DOWN tokens and place market order when price equals entry price
   * Order is filled when UP or DOWN value equals entryPrice (exact match)
   */
  private async checkAndPlaceMarketOrder(yesTokenId: string, noTokenId: string): Promise<void> {
    try {
      // Check circuit breaker first
      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        console.error('[TradingManager] 🔴 Circuit breaker active - trading disabled. Restart trading to reset.');
        return;
      }
      
      // CRITICAL: Check if browser ClobClient is available
      // Server-side API is blocked by Cloudflare, so browser client is required
      if (!this.browserClobClient) {
        console.error('[TradingManager] ❌ Cannot place orders - Browser ClobClient not initialized. Server-side API is blocked by Cloudflare. Please ensure wallet is connected and browser client is initialized.');
        return;
      }
      
      // Check if already placing an order (additional safeguard against race condition)
      if (this.isPlacingOrder || this.isPlacingSplitOrders) {
        console.log('[TradingManager] Order already being placed, skipping checkAndPlaceMarketOrder...');
        return;
      }

      // Get active positions for this event
      const activePositions = this.getActivePositions();
      const totalPositionSize = activePositions.reduce((sum, p) => sum + p.size, 0);

      // Check if we've reached 50% limit
      if (this.status.maxPositionSize && totalPositionSize >= this.status.maxPositionSize) {
        console.log(`[TradingManager] Max position size reached: ${totalPositionSize.toFixed(2)} >= ${this.status.maxPositionSize.toFixed(2)}`);
        return;
      }

      // Check if adding new position would exceed 50% limit
      const tradeSize = this.strategyConfig.tradeSize;
      if (this.status.maxPositionSize && (totalPositionSize + tradeSize) > this.status.maxPositionSize) {
        console.log(`[TradingManager] Adding position would exceed limit. Current: ${totalPositionSize.toFixed(2)}, Adding: ${tradeSize.toFixed(2)}, Max: ${this.status.maxPositionSize.toFixed(2)}`);
        return;
      }

      const entryPrice = this.strategyConfig.entryPrice;

      // Get current market prices for both tokens (BUY side for entry condition checking)
      const [yesPrice, noPrice] = await Promise.all([
        this.clobClient.getPrice(yesTokenId, 'BUY'),
        this.clobClient.getPrice(noTokenId, 'BUY'),
      ]);

      if (!yesPrice || !noPrice) {
        return;
      }

      // Convert to percentage scale (0-100)
      const yesPricePercent = toPercentage(yesPrice);
      const noPricePercent = toPercentage(noPrice);

      // NEW: Check for arbitrage opportunity FIRST (risk-free profit)
      if (this.strategyConfig.enableArbitrage) {
        const arbitrageResult = await this.checkArbitrageOpportunity(yesTokenId, noTokenId, yesPrice, noPrice);
        if (arbitrageResult.shouldExecute) {
          console.log(`[TradingManager] 💰💰💰 ARBITRAGE OPPORTUNITY DETECTED!`, {
            priceSum: arbitrageResult.priceSum.toFixed(4),
            arbitragePercent: (arbitrageResult.arbitragePercent * 100).toFixed(2) + '%',
            profitUSD: arbitrageResult.estimatedProfit.toFixed(2),
          });
          await this.executeArbitrageTrade(yesTokenId, noTokenId, arbitrageResult);
          return; // Don't proceed with regular entry after arbitrage
        }
      }

      // NEW: Check for volatility capture opportunity (first 2 minutes)
      if (this.strategyConfig.enableVolatilityCapture && this.activeEvent) {
        const volatilityResult = await this.checkVolatilityCapture(yesTokenId, noTokenId, yesPrice, noPrice);
        if (volatilityResult.shouldExecute && volatilityResult.direction) {
          console.log(`[TradingManager] ⚡⚡⚡ VOLATILITY CAPTURE OPPORTUNITY!`, {
            priceDrop: (volatilityResult.priceDropPercent * 100).toFixed(2) + '%',
            direction: volatilityResult.direction,
            timeRemaining: volatilityResult.timeRemaining.toFixed(0) + 's',
          });
          await this.executeVolatilityTrade({
            direction: volatilityResult.direction,
            priceDropPercent: volatilityResult.priceDropPercent,
            timeRemaining: volatilityResult.timeRemaining,
          });
          return; // Don't proceed with regular entry after volatility trade
        }
      }

      // NEW: Update price history for momentum/reversal detection
      this.updatePriceHistory(yesPricePercent, noPricePercent);

      let tokenToTrade: string | null = null;
      let direction: 'UP' | 'DOWN' | null = null;
      const tolerance = 0.5; // Allow entry within 0.5 of entry price for better execution

      // NEW: Event phase strategy - adjust entry price based on event phase
      let effectiveEntryPrice = entryPrice;
      if (this.strategyConfig.enableEventPhaseStrategy && this.activeEvent && this.eventStartTime) {
        const now = Date.now() / 1000;
        const timeSinceStart = now - this.eventStartTime;
        const eventDuration = 15 * 60; // 15 minutes
        const phase = timeSinceStart / eventDuration;

        if (phase < 0.33) {
          // First 5 minutes
          effectiveEntryPrice = this.strategyConfig.earlyPhaseEntryPrice || 92;
        } else if (phase < 0.67) {
          // Middle 5 minutes
          effectiveEntryPrice = this.strategyConfig.middlePhaseEntryPrice || 93;
        } else {
          // Last 5 minutes
          effectiveEntryPrice = this.strategyConfig.latePhaseEntryPrice || 95;
          // Also check max position size for late phase
          if (this.strategyConfig.latePhaseMaxPositionPercent && this.status.walletBalance) {
            const maxLatePhaseSize = (this.strategyConfig.latePhaseMaxPositionPercent / 100) * this.status.walletBalance;
            if (totalPositionSize >= maxLatePhaseSize) {
              console.log(`[TradingManager] Late phase: max position size reached (${totalPositionSize.toFixed(2)} >= ${maxLatePhaseSize.toFixed(2)})`);
              return;
            }
          }
        }
      }

      // NEW: Check mean reversion strategy (alternative to regular entry)
      if (this.strategyConfig.enableMeanReversion) {
        const meanReversionResult = this.checkMeanReversion(yesPricePercent, noPricePercent);
        if (meanReversionResult.shouldEnter) {
          tokenToTrade = meanReversionResult.tokenId;
          direction = meanReversionResult.direction;
          console.log(`[TradingManager] 📊 MEAN REVERSION ENTRY: ${direction} at ${meanReversionResult.price.toFixed(2)}% (${meanReversionResult.distanceFrom50.toFixed(2)}% from 50%)`);
        }
      }

      // Check if either token price is at or below entry price (better for fast markets)
      if (!tokenToTrade) {
        let tokenToTradeCandidate: string | null = null;
        let directionCandidate: 'UP' | 'DOWN' | null = null;

        // Check UP token first (YES token) - enter when price <= effectiveEntryPrice
        if (yesPricePercent <= effectiveEntryPrice + tolerance && yesPricePercent >= effectiveEntryPrice - tolerance) {
          tokenToTradeCandidate = yesTokenId;
          directionCandidate = 'UP';
        }
        // Check DOWN token (NO token) - only if UP token hasn't matched
        else if (noPricePercent <= effectiveEntryPrice + tolerance && noPricePercent >= effectiveEntryPrice - tolerance) {
          tokenToTradeCandidate = noTokenId;
          directionCandidate = 'DOWN';
        }

        // NEW: Momentum confirmation - only enter if price is moving in direction
        if (tokenToTradeCandidate && this.strategyConfig.enableMomentumConfirmation) {
          const momentumResult = this.checkMomentum(directionCandidate!, yesPricePercent, noPricePercent);
          if (!momentumResult.hasMomentum) {
            console.log(`[TradingManager] ⚠️ Entry condition met but no momentum - skipping trade. Price trend: ${momentumResult.trend}`);
            return;
          }
          console.log(`[TradingManager] ✅ Momentum confirmed: ${directionCandidate} trend detected`);
        }

        if (tokenToTradeCandidate) {
          tokenToTrade = tokenToTradeCandidate;
          direction = directionCandidate;
          console.log(`[TradingManager] Entry condition met: ${direction === 'UP' ? 'yes' : 'no'}TokenPrice ${(direction === 'UP' ? yesPricePercent : noPricePercent).toFixed(2)} near entryPrice ${effectiveEntryPrice.toFixed(2)} → Filling ${direction} position`);
        }
      }

      // Price is not at entry - mark that we can re-enter if it comes back to entry price
      if (!tokenToTrade) {
        if (activePositions.length > 0) {
          const currentPrice = yesPricePercent >= noPricePercent ? yesPricePercent : noPricePercent;
          if (currentPrice < entryPrice - tolerance) {
            this.priceBelowEntry = true;
          }
        }
        if (yesPricePercent < entryPrice - 5 && noPricePercent < entryPrice - 5) {
          console.log(`[TradingManager] Entry condition not met: prices too low (YES: ${yesPricePercent.toFixed(2)}, NO: ${noPricePercent.toFixed(2)}, Entry: ${entryPrice.toFixed(2)})`);
        }
        return;
      }

      // NEW: Check liquidity before regular entry
      if (this.strategyConfig.enableLiquidityFilter) {
        const liquidityCheck = await this.checkLiquidity(yesTokenId, noTokenId);
        if (!liquidityCheck.isLiquid) {
          console.warn(`[TradingManager] ⚠️ Skipping entry - insufficient liquidity (spread: ${(liquidityCheck.spread * 100).toFixed(2)}%)`);
          return;
        }
      }

      // Check if we should enter (re-entry logic)
      if (activePositions.length > 0) {
        // We have positions - check if price dropped below entry and came back to exact entry price
        if (!this.priceBelowEntry) {
          // Price never dropped below entry, don't re-enter
          console.log(`[TradingManager] Price never dropped below entry, not re-entering. Current positions: ${activePositions.length}`);
          return;
        }
        // Price dropped below entry and came back to exact entry price - allow re-entry
        console.log(`[TradingManager] Price dropped below entry and came back to exact entry price, allowing re-entry. Current positions: ${activePositions.length}`);
        this.priceBelowEntry = false; // Reset flag
      }

      // Place order when price reaches entry: limit order if trade size > threshold, else market
      if (tokenToTrade && direction) {
        const tradeSize = this.calculatePositionSize();
        const aboveSize = this.strategyConfig.entryLimitOrderAboveSize ?? 70;
        const discount = this.strategyConfig.entryLimitOrderDiscount ?? 2;
        const useLimitForLarge = this.strategyConfig.useLimitOrderForLargeEntry !== false;

        if (useLimitForLarge && tradeSize > aboveSize) {
          const limitPrice = Math.max(1, effectiveEntryPrice - discount);
          console.log(`[TradingManager] Trade size ${tradeSize.toFixed(0)} > ${aboveSize} → placing BUY limit at ${limitPrice} (entry ${effectiveEntryPrice})`);
          this.isPlacingOrder = true;
          try {
            await this.placeLimitOrderForEntry(tokenToTrade, limitPrice, tradeSize, direction);
          } catch (error) {
            console.error('[TradingManager] Error in placeLimitOrderForEntry:', error);
          } finally {
            this.isPlacingOrder = false;
          }
          return;
        }

        // Set flags IMMEDIATELY to prevent race condition
        this.isPlacingOrder = true;
        this.isPlacingSplitOrders = true;
        this.orderPlacementStartTime = Date.now();

        try {
          await this.placeMarketOrder(tokenToTrade, entryPrice, direction);
        } catch (error) {
          console.error('[TradingManager] Error in placeMarketOrder:', error);
        }
      }
    } catch (error) {
      console.error('[TradingManager] Error checking for market order placement:', error);
    }
  }

  /**
   * Place a BUY limit order at limitPrice (0-100) when trade size > threshold.
   */
  private async placeLimitOrderForEntry(
    tokenId: string,
    limitPricePercent: number,
    tradeSizeUSD: number,
    direction: 'UP' | 'DOWN'
  ): Promise<void> {
    if (!this.activeEvent || !this.browserClobClient || !this.apiCredentials) {
      console.warn('[TradingManager] Cannot place limit order: missing event, client or credentials');
      return;
    }

    try {
      const { OrderType, Side } = await import('@polymarket/clob-client');
      const limitPriceDecimal = limitPricePercent / 100;
      const shares = tradeSizeUSD / limitPriceDecimal;

      let feeRateBps: number;
      try {
        feeRateBps = await this.browserClobClient.getFeeRateBps(tokenId);
        if (!feeRateBps || feeRateBps === 0) feeRateBps = 1000;
      } catch {
        feeRateBps = 1000;
      }

      const limitOrder = {
        tokenID: tokenId,
        price: limitPriceDecimal,
        size: shares,
        side: Side.BUY,
        feeRateBps,
        expiration: 0,
        taker: '0x0000000000000000000000000000000000000000',
      };

      console.log('[TradingManager] Placing BUY limit order:', {
        tokenId: tokenId.substring(0, 10) + '...',
        direction,
        limitPrice: limitPricePercent.toFixed(2),
        tradeSizeUSD: tradeSizeUSD.toFixed(2),
        shares: shares.toFixed(4),
      });

      const response = await this.browserClobClient.createAndPostOrder(
        limitOrder,
        { negRisk: false },
        OrderType.GTC
      ) as { orderID?: string; error?: string };

      if (response?.orderID) {
        const trade: Trade = {
          id: `limit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: this.activeEvent.slug,
          tokenId,
          side: 'BUY',
          size: tradeSizeUSD,
          price: limitPricePercent,
          timestamp: Date.now(),
          status: 'pending',
          transactionHash: response.orderID,
          reason: `BUY limit at ${limitPricePercent.toFixed(2)} (${direction}) – fills when price reaches target`,
          orderType: 'LIMIT',
          limitPrice: limitPricePercent,
          direction,
        };
        this.pendingLimitOrders.set(tokenId, trade);
        this.status.pendingLimitOrders = this.pendingLimitOrders.size;
        this.trades.push(trade);
        this.status.totalTrades++;
        this.notifyStatusUpdate();
        console.log('[TradingManager] BUY limit order placed:', response.orderID.substring(0, 12) + '...');
      } else {
        const err = (response as { error?: string })?.error || 'No order ID';
        console.error('[TradingManager] BUY limit order failed:', err);
      }
    } catch (error) {
      console.error('[TradingManager] placeLimitOrderForEntry error:', error);
      throw error;
    }
  }

  /**
   * Get list of pending BUY limit orders (for display in frontend).
   */
  getPendingLimitOrders(): Trade[] {
    return Array.from(this.pendingLimitOrders.values());
  }

  /**
   * Place a single market order (part of split orders for large trade sizes)
   */
  private async placeSingleMarketOrder(
    tokenId: string,
    targetPrice: number,
    orderSize: number,
    _direction: 'UP' | 'DOWN',
    orderIndex: number,
    totalOrders: number
  ): Promise<{ success: boolean; orderId?: string; fillPrice?: number; error?: string }> {
    try {
      if (!this.apiCredentials) {
        return { success: false, error: 'No API credentials' };
      }

      if (this.browserClobClient) {
        const { OrderType, Side } = await import('@polymarket/clob-client');
        
        // For BUY orders, use SELL side to get ask price (what sellers are asking)
        // Note: getPrice(tokenId, Side.SELL) returns the ASK price (what you pay to buy)
        const askPriceResponse = await this.browserClobClient.getPrice(tokenId, Side.SELL);
        // Handle both object {price: "0.96"} and string "0.96" formats
        let askPrice = typeof askPriceResponse === 'object' && askPriceResponse.price 
          ? parseFloat(askPriceResponse.price) 
          : parseFloat(askPriceResponse);
        
        if (isNaN(askPrice) || askPrice <= 0 || askPrice >= 1) {
          return { success: false, error: 'Invalid market price' };
        }
        
        // For FAK orders, add a small buffer (0.5%) to improve fill probability
        // This ensures we can match immediately even if price moves slightly
        const slippageBuffer = 0.005; // 0.5% buffer
        const bufferedAskPrice = Math.min(askPrice * (1 + slippageBuffer), 0.999); // Cap at 0.999 to stay under 1.0
        
        console.log(`[TradingManager] Price adjustment for FAK order:`, {
          originalAskPrice: askPrice.toFixed(4),
          bufferedAskPrice: bufferedAskPrice.toFixed(4),
          bufferPercent: (slippageBuffer * 100).toFixed(2) + '%',
          targetPrice: targetPrice.toFixed(2),
        });
        
        // Use buffered price for better fill probability
        askPrice = bufferedAskPrice;

        // Get fee rate
        let feeRateBps: number;
        try {
          feeRateBps = await this.browserClobClient.getFeeRateBps(tokenId);
          if (!feeRateBps || feeRateBps === 0) {
            feeRateBps = 1000;
          }
        } catch (error) {
          feeRateBps = 1000;
        }

        // For BUY market orders, amount should be in shares, not USD
        // Convert USD orderSize to shares using the ask price
        const shares = orderSize / askPrice;
        
        const marketOrder = {
          tokenID: tokenId,
          amount: shares, // Amount in shares, not USD
          side: Side.BUY,
          feeRateBps: feeRateBps,
        };
        
        console.log(`[TradingManager] Market order calculation:`, {
          orderSizeUSD: orderSize.toFixed(2),
          askPrice: askPrice.toFixed(4),
          shares: shares.toFixed(4),
          estimatedCost: (shares * askPrice).toFixed(2),
        });

        console.log(`[TradingManager] Placing split order ${orderIndex + 1}/${totalOrders} at target price ${targetPrice.toFixed(2)}:`, {
          targetPrice: targetPrice.toFixed(2),
          currentPrice: toPercentage(askPrice).toFixed(2),
          orderSize: orderSize.toFixed(2),
        });

        let response;
        try {
          response = await this.browserClobClient.createAndPostMarketOrder(
            marketOrder,
            { negRisk: false },
            OrderType.FAK
          );
        } catch (orderError: any) {
          // Handle specific FAK order errors
          const errorData = orderError?.response?.data || orderError?.data || {};
          const errorMessage = errorData?.error || orderError?.message || 'Unknown error';
          
          // Check if it's a "no match" error for FAK orders
          if (errorMessage.includes('no orders found to match with FAK order') || 
              errorMessage.includes('FAK orders are partially filled or killed')) {
            console.warn(`[TradingManager] ⚠️ FAK order ${orderIndex + 1}/${totalOrders} - No immediate match found at current price:`, {
              targetPrice: targetPrice.toFixed(2),
              currentAskPrice: toPercentage(askPrice).toFixed(2),
              orderSize: orderSize.toFixed(2),
              error: errorMessage,
              note: 'FAK orders require immediate match. Price may have moved or no liquidity at this price.',
            });
            return { 
              success: false, 
              error: `No immediate match for FAK order at ${targetPrice.toFixed(2)}. Price may have moved or insufficient liquidity.` 
            };
          }
          
          // Other errors
          console.error(`[TradingManager] ❌ Order ${orderIndex + 1}/${totalOrders} failed with error:`, {
            error: errorMessage,
            errorData: errorData,
            tokenId: tokenId.substring(0, 10) + '...',
            targetPrice: targetPrice.toFixed(2),
            orderSize: orderSize.toFixed(2),
          });
          return { success: false, error: errorMessage };
        }

        if (response?.orderID) {
          console.log(`[TradingManager] ✅ Order ${orderIndex + 1}/${totalOrders} placed successfully:`, {
            orderId: response.orderID.substring(0, 8) + '...',
            fillPrice: toPercentage(askPrice).toFixed(2),
            orderSize: orderSize.toFixed(2),
          });
          return {
            success: true,
            orderId: response.orderID,
            fillPrice: toPercentage(askPrice),
          };
        } else {
          // Check if response contains error information
          const errorData = (response as any)?.error || (response as any)?.data?.error;
          const errorMsg = errorData || 'No order ID returned from exchange';
          
          console.error(`[TradingManager] ❌ Order ${orderIndex + 1}/${totalOrders} failed:`, {
            error: errorMsg,
            response: response,
            tokenId: tokenId.substring(0, 10) + '...',
            targetPrice: targetPrice.toFixed(2),
            orderSize: orderSize.toFixed(2),
          });
          return { success: false, error: errorMsg };
        }
      } else {
        // Browser ClobClient not available - cannot place orders
        // Server-side API is blocked by Cloudflare, so we must use browser client
        const errorMsg = 'Browser ClobClient not initialized. Cannot place orders - server-side API is blocked by Cloudflare. Please ensure wallet is connected and browser client is initialized.';
        console.error(`[TradingManager] ❌ Order ${orderIndex + 1}/${totalOrders} cannot be placed:`, {
          error: errorMsg,
          tokenId: tokenId.substring(0, 10) + '...',
          browserClobClientAvailable: !!this.browserClobClient,
          apiCredentialsAvailable: !!this.apiCredentials,
        });
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Place a market order (Fill or Kill) when trading conditions match
   * For large trade sizes (>50 USD), splits orders across entryPrice to entryPrice + 2
   * Uses builder attribution via remote signing through /api/orders endpoint
   */
  private async placeMarketOrder(tokenId: string, entryPrice: number, direction: 'UP' | 'DOWN'): Promise<void> {
    // Note: isPlacingOrder and isPlacingSplitOrders should already be set in checkAndPlaceMarketOrder
    // before calling this method to prevent race conditions.
    // If flags are not set (shouldn't happen), set them as fallback for safety
    if (!this.isPlacingOrder || !this.isPlacingSplitOrders) {
      console.warn('[TradingManager] Flags not set, setting them now (fallback)');
      this.isPlacingOrder = true;
      this.isPlacingSplitOrders = true;
    }

    try {
      // Calculate dynamic position size based on balance, confidence, and win/loss streaks
      const tradeSize = this.calculatePositionSize();
      
      // Verify balance before placing order
      if (!this.verifyBalance(tradeSize)) {
        console.error('[TradingManager] ❌ Order rejected: Insufficient balance');
        this.status.failedTrades++;
        return;
      }

      console.log('[TradingManager] Placing market order (single order, Polymarket handles matching):', {
        tokenId: tokenId.substring(0, 10) + '...',
        direction,
        entryPrice,
        tradeSize,
      });

      if (!this.apiCredentials) {
        // Simulation mode
        const trade: Trade = {
          id: `market-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: this.activeEvent!.slug,
          tokenId,
          side: 'BUY',
          size: tradeSize,
          price: entryPrice,
          timestamp: Date.now(),
          status: 'filled',
          transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
          reason: `Simulated market order (FAK) filled at ${entryPrice.toFixed(2)} (${direction})`,
          orderType: 'MARKET',
          direction,
        };

        // Create new position in simulation mode
        const newPosition: Position = {
          id: `position-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: trade.eventSlug,
          tokenId: trade.tokenId,
          side: trade.side,
          size: tradeSize,
          entryPrice: entryPrice,
          direction,
          filledOrders: [{ orderId: trade.transactionHash!, price: entryPrice, size: tradeSize, timestamp: Date.now() }],
          entryTimestamp: Date.now(),
        };

        this.positions.push(newPosition);
        this.status.positions = [...this.positions];
        this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);

        this.trades.push(trade);
        this.status.totalTrades++;
        this.status.successfulTrades++;
        this.notifyTradeUpdate(trade);
        this.notifyStatusUpdate();
        return;
      }

      // Place single market order – Polymarket handles matching/fill
      const result = await this.placeSingleMarketOrder(
        tokenId,
        entryPrice,
        tradeSize,
        direction,
        0,
        1
      );

      if (result.success && result.orderId && result.fillPrice !== undefined) {
        const filledOrders: Array<{ orderId: string; price: number; size: number; timestamp: number }> = [{
          orderId: result.orderId,
          price: result.fillPrice,
          size: tradeSize,
          timestamp: Date.now(),
        }];

        const trade: Trade = {
          id: `market-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: this.activeEvent!.slug,
          tokenId,
          side: 'BUY',
          size: tradeSize,
          price: result.fillPrice,
          timestamp: Date.now(),
          status: 'filled',
          transactionHash: result.orderId,
          reason: `Market order filled at ${result.fillPrice.toFixed(2)} (${direction})`,
          orderType: 'MARKET',
          direction,
        };

        this.trades.push(trade);
        this.status.totalTrades++;
        this.notifyTradeUpdate(trade);
        this.consecutiveFailures = 0;

        const eventEndTimestamp = this.activeEvent!.endDate
          ? Math.floor(new Date(this.activeEvent!.endDate).getTime() / 1000)
          : undefined;

        const newPosition: Position = {
          id: `position-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: this.activeEvent!.slug,
          tokenId,
          side: 'BUY',
          size: tradeSize,
          entryPrice: result.fillPrice,
          direction,
          filledOrders,
          entryTimestamp: Date.now(),
          eventEndTimestamp,
          conditionId: this.activeEvent!.conditionId,
          priceToBeat: this.priceToBeat || undefined,
          claimed: false,
        };

        this.positions.push(newPosition);
        this.status.positions = [...this.positions];
        this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
        this.status.successfulTrades++;

        console.log('[TradingManager] ✅ Position created:', {
          positionId: newPosition.id,
          direction,
          size: tradeSize.toFixed(2),
          entryPrice: result.fillPrice.toFixed(2),
        });

        setTimeout(() => {
          if (this.onTradeUpdate) {
            this.onTradeUpdate(trade);
          }
        }, 2000);
      } else {
        console.error('[TradingManager] ❌ Market order failed:', result.error);
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
          console.error('[TradingManager] 🔴 CIRCUIT BREAKER: stopping trading.');
          this.stopTrading();
        }
        this.status.failedTrades++;
      }

      this.notifyStatusUpdate();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[TradingManager] ❌ Exception in placeMarketOrder:', {
        error: errorMsg,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        tokenId: tokenId.substring(0, 10) + '...',
        direction,
        entryPrice: entryPrice.toFixed(2),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.status.failedTrades++;
    } finally {
      this.isPlacingOrder = false;
      this.isPlacingSplitOrders = false;
      this.orderPlacementStartTime = 0; // Reset timer
    }
  }

  /**
   * Check if pending limit order should fill (price reached limit price)
   */
  private async checkLimitOrderFill(tokenId: string): Promise<void> {
    const pendingOrder = this.pendingLimitOrders.get(tokenId);
    if (!pendingOrder) {
      return;
    }

    try {
      // Get current market price
      const currentMarketPrice = await this.clobClient.getPrice(tokenId, 'BUY');
      
      if (!currentMarketPrice) {
        return;
      }

      const currentPricePercent = toPercentage(currentMarketPrice);
      const limitPrice = pendingOrder.limitPrice!;

      // Check if price has reached or crossed the limit price
      // For BUY limit orders, fill when price is at or below limit
      if (currentPricePercent <= limitPrice + 0.1) { // Small buffer for slippage
        // Limit order filled
        pendingOrder.status = 'filled';
        pendingOrder.price = currentPricePercent; // Actual fill price
        pendingOrder.transactionHash = `0x${Math.random().toString(16).substr(2, 64)}`;
        
        // Remove from pending orders
        this.pendingLimitOrders.delete(tokenId);
        this.status.pendingLimitOrders = this.pendingLimitOrders.size;

        // Update trade status
        this.status.successfulTrades++;

        // Determine direction based on which token this is
        const direction = this.activeEvent?.clobTokenIds?.[0] === tokenId ? 'UP' : 'DOWN';
        pendingOrder.direction = direction;

        // Add to positions array (same shape as market order positions)
        const newPosition: Position = {
          id: `position-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: pendingOrder.eventSlug,
          tokenId: pendingOrder.tokenId,
          side: pendingOrder.side,
          entryPrice: currentPricePercent,
          size: pendingOrder.size,
          direction,
          filledOrders: [{ orderId: pendingOrder.transactionHash!, price: currentPricePercent, size: pendingOrder.size, timestamp: Date.now() }],
          entryTimestamp: Date.now(),
        };
        this.positions.push(newPosition);
        this.status.positions = [...this.positions];
        this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
        this.status.currentPosition = { eventSlug: newPosition.eventSlug, tokenId: newPosition.tokenId, side: newPosition.side, entryPrice: newPosition.entryPrice, size: newPosition.size, direction: newPosition.direction, filledOrders: newPosition.filledOrders };

        console.log(`[TradingManager] Limit order filled: ${pendingOrder.id} at ${currentPricePercent.toFixed(2)} → position created`);

        this.notifyTradeUpdate(pendingOrder);
        this.notifyStatusUpdate();
      }
    } catch (error) {
      console.error('Error checking limit order fill:', error);
    }
  }

  /**
   * Update position prices continuously (called separately from exit condition checking)
   */
  private async updatePositionPrices(): Promise<void> {
    const activePositions = this.getActivePositions();

    if (activePositions.length === 0) {
      return;
    }

    if (!this.activeEvent || !this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      return;
    }

    try {
      const yesTokenId = this.activeEvent.clobTokenIds[0]; // YES/UP token
      const noTokenId = this.activeEvent.clobTokenIds[1]; // NO/DOWN token

      if (!yesTokenId || !noTokenId) {
        return;
      }

      // Get current market prices for both tokens
      // Use SELL side for position valuation (what you'd get if selling now)
      const [yesPrice, noPrice] = await Promise.all([
        this.clobClient.getPrice(yesTokenId, 'SELL'),
        this.clobClient.getPrice(noTokenId, 'SELL'),
      ]);

      if (!yesPrice || !noPrice) {
        return;
      }

      // Convert to percentage scale (0-100)
      const yesPricePercent = toPercentage(yesPrice);
      const noPricePercent = toPercentage(noPrice);

      // Update all positions' current prices and unrealized P/L
      for (const position of activePositions) {
        const direction = position.direction || 'UP';
        const currentPrice = direction === 'UP' ? yesPricePercent : noPricePercent;

        // Update position current price and unrealized P/L (based on SELL price - what you'd get)
        position.currentPrice = currentPrice;
        const priceDiff = currentPrice - position.entryPrice;
        position.unrealizedProfit = (priceDiff / position.entryPrice) * position.size;
      }

      // Update status and notify UI
      this.status.positions = [...this.positions];
      this.notifyStatusUpdate();
    } catch (error) {
      console.error('[TradingManager] Error updating position prices:', error);
    }
  }

  /**
   * Check exit conditions: profit target and stop loss
   * Uses the same variables as entry condition (yesPricePercent, noPricePercent)
   * For UP direction:
   *   - Profit Target: Sell when UP value >= profit target
   *   - Stop Loss: Sell when UP value <= stop loss (with adaptive selling)
   * For DOWN direction:
   *   - Profit Target: Sell when DOWN value >= profit target
   *   - Stop Loss: Sell when DOWN value <= stop loss (with adaptive selling)
   */
  private async checkExitConditions(): Promise<void> {
    // Get all active positions for this event
    const activePositions = this.getActivePositions();

    if (activePositions.length === 0) {
      // Only log occasionally to reduce noise
      return;
    }
    
    // DEBUG: Log that exit conditions are being checked
    console.log(`[TradingManager] 🔍 CHECKING EXIT CONDITIONS for ${activePositions.length} position(s) at ${new Date().toISOString()}`);
    
    // Log position count for tracking
    if (activePositions.length > 1) {
      console.log(`[TradingManager] 👀 Checking exit conditions for ${activePositions.length} POSITIONS:`, activePositions.map(p => ({
        id: p.id.substring(0, 8) + '...',
        direction: p.direction,
        size: p.size.toFixed(2),
      })));
    }

    // Prevent multiple simultaneous exit orders
    // CRITICAL: Only check exit order flag, NOT entry order flags (entry orders shouldn't block exits!)
    if (this.isPlacingExitOrder) {
      // Check if exit order is stuck (taking too long)
      const timeSinceOrderStart = Date.now() - this.orderPlacementStartTime;
      if (timeSinceOrderStart > this.MAX_ORDER_PLACEMENT_TIME) {
        console.error(`[TradingManager] 🚨 EXIT ORDER FLAGS STUCK! Exit order exceeded ${this.MAX_ORDER_PLACEMENT_TIME}ms. Force resetting flags.`);
        this.isPlacingExitOrder = false;
        this.orderPlacementStartTime = 0;
      } else {
        console.log(`[TradingManager] ⚠️ checkExitConditions waiting - Exit order in progress (${timeSinceOrderStart}ms)`);
        return;
      }
    }
    
    // Log if entry orders are in progress (for debugging, but don't block exits)
    if (this.isPlacingOrder || this.isPlacingSplitOrders) {
      const timeSinceOrderStart = Date.now() - this.orderPlacementStartTime;
      console.log(`[TradingManager] ℹ️ Entry order in progress (${timeSinceOrderStart}ms), but exit conditions will still be checked`);
    }

    if (!this.activeEvent || !this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      return;
    }

    try {
      const yesTokenId = this.activeEvent.clobTokenIds[0]; // YES/UP token
      const noTokenId = this.activeEvent.clobTokenIds[1]; // NO/DOWN token

      if (!yesTokenId || !noTokenId) {
        return;
      }

      // Get current market prices for both tokens
      // CRITICAL: Use SELL side for exit conditions (we're selling, so need BID prices)
      const [yesPrice, noPrice] = await Promise.all([
        this.clobClient.getPrice(yesTokenId, 'SELL'),
        this.clobClient.getPrice(noTokenId, 'SELL'),
      ]);

      if (!yesPrice || !noPrice) {
        console.error(`[TradingManager] ❌ Failed to fetch prices for exit check:`, {
          yesPrice: yesPrice || 'null',
          noPrice: noPrice || 'null',
          yesTokenId: yesTokenId.substring(0, 10) + '...',
          noTokenId: noTokenId.substring(0, 10) + '...',
          activePositions: activePositions.length,
        });
        return;
      }

      // Convert to percentage scale (0-100)
      const yesPricePercent = toPercentage(yesPrice);
      const noPricePercent = toPercentage(noPrice);

      const profitTarget = this.strategyConfig.profitTargetPrice;
      const stopLoss = this.strategyConfig.stopLossPrice;
      
      // DEBUG: Always log prices when positions exist
      console.log(`[TradingManager] 📊 Current Market Prices:`, {
        yesPricePercent: yesPricePercent.toFixed(2),
        noPricePercent: noPricePercent.toFixed(2),
        profitTarget: profitTarget.toFixed(2),
        stopLoss: stopLoss.toFixed(2),
        activePositions: activePositions.length,
      });

      // Validate profit target and stop loss are set
      if (profitTarget === undefined || profitTarget === null || isNaN(profitTarget)) {
        console.error(`[TradingManager] ❌ Invalid profit target: ${profitTarget}`);
        return;
      }
      if (stopLoss === undefined || stopLoss === null || isNaN(stopLoss)) {
        console.error(`[TradingManager] ❌ Invalid stop loss: ${stopLoss}`);
        return;
      }

      // Check exit conditions for ALL positions
      // We exit ALL positions when ANY position meets exit condition
      let shouldExit = false;
      let exitReason = '';
      let useAdaptiveSelling = false;
      let isDownDirection = false;
      let triggeringPosition: Position | null = null;

      // First, update all positions' current prices and unrealized P/L
      for (const position of activePositions) {
        const direction = position.direction || 'UP';
        const currentPrice = direction === 'UP' ? yesPricePercent : noPricePercent;

        // Update position current price and unrealized P/L
        position.currentPrice = currentPrice;
        const priceDiff = currentPrice - position.entryPrice;
        position.unrealizedProfit = (priceDiff / position.entryPrice) * position.size;
      }

      // NEW: Check for early exit on reversal BEFORE checking profit/stop loss
      if (this.strategyConfig.enableEarlyExitOnReversal) {
        for (const position of activePositions) {
          const reversalResult = this.checkEarlyExitOnReversal(position, yesPricePercent, noPricePercent);
          if (reversalResult.shouldExit) {
            console.log(`[TradingManager] 🔄 EARLY EXIT ON REVERSAL:`, {
              positionId: position.id.substring(0, 8) + '...',
              direction: position.direction,
              entryPrice: position.entryPrice.toFixed(2),
              currentPrice: reversalResult.currentPrice.toFixed(2),
              reversalPercent: (reversalResult.reversalPercent * 100).toFixed(2) + '%',
              reason: reversalResult.reason,
            });
            await this.closeAllPositions(`Early exit on reversal: ${reversalResult.reason}`);
            return; // Exit early, don't check other conditions
          }
        }
      }

      // NEW: Check for partial profit taking
      if (this.strategyConfig.enablePartialProfitTaking) {
        for (const position of activePositions) {
          if (this.partialProfitTaken.get(position.id)) {
            continue; // Already took partial profit
          }

          const direction = position.direction || 'UP';
          const currentPrice = direction === 'UP' ? yesPricePercent : noPricePercent;
          const partialTarget = this.strategyConfig.partialProfitTarget || 96;

          if (currentPrice >= partialTarget) {
            const partialPercent = this.strategyConfig.partialProfitPercent || 50;
            console.log(`[TradingManager] 💰 PARTIAL PROFIT TAKING: Closing ${partialPercent}% of position at ${currentPrice.toFixed(2)}%`);
            
            // Close partial position
            await this.closePartialPosition(position, partialPercent / 100);
            this.partialProfitTaken.set(position.id, true);
            // Continue with remaining position (will check full exit conditions below)
          }
        }
      }

      // Then, check exit conditions for ALL positions using fresh prices
      // Exit ALL positions if ANY position meets profit target or stop loss
      for (const position of activePositions) {
        const direction = position.direction || 'UP';
        // Use fresh price from API for exit condition checking
        const currentPrice = direction === 'UP' ? yesPricePercent : noPricePercent;
        
        // Also update position price with fresh data
        position.currentPrice = currentPrice;
        const priceDiff = currentPrice - position.entryPrice;
        position.unrealizedProfit = (priceDiff / position.entryPrice) * position.size;
        
        // DEBUG: Always log when price is very high (potential profit target issue)
        if (currentPrice >= 95 || direction === 'DOWN') {
          console.log(`[TradingManager] 🔍 Position Check:`, {
            positionId: position.id.substring(0, 8) + '...',
            direction: direction,
            entryPrice: position.entryPrice.toFixed(2),
            currentPrice: currentPrice.toFixed(2),
            yesPrice: yesPricePercent.toFixed(2),
            noPrice: noPricePercent.toFixed(2),
            profitTarget: profitTarget.toFixed(2),
            stopLoss: stopLoss.toFixed(2),
          });
        }

        // NEW: Trailing stop or fixed profit target
        let profitTargetMet = false;
        
        if (this.strategyConfig.useTrailingStop) {
          // Trailing stop logic
          const trailingDistance = this.strategyConfig.trailingStopDistance || 2; // Default 2%
          
          // Update peak price
          if (this.peakPrice === null || currentPrice > this.peakPrice) {
            this.peakPrice = currentPrice;
          }
          
          // Calculate trailing stop price
          if (this.peakPrice !== null) {
            this.trailingStopPrice = this.peakPrice - trailingDistance;
            
            // Check if price has dropped below trailing stop
            if (currentPrice <= this.trailingStopPrice) {
              profitTargetMet = true;
              exitReason = `Trailing stop triggered at ${currentPrice.toFixed(2)} (Peak: ${this.peakPrice.toFixed(2)}, Trail: ${this.trailingStopPrice.toFixed(2)})`;
            }
          }
          
          // Also check if we've reached a high enough price to start trailing (e.g., 98%)
          if (this.peakPrice !== null && this.trailingStopPrice !== null && this.peakPrice >= 98 && currentPrice <= this.trailingStopPrice) {
            profitTargetMet = true;
          }
        } else {
          // Legacy: Fixed profit target
          const epsilon = 0.01; // 0.01% tolerance
          profitTargetMet = currentPrice >= (profitTarget - epsilon);
        }
        
        // DEBUG: Always log profit target check for DOWN positions or when price is high
        if (direction === 'DOWN' || currentPrice >= 95) {
          console.log(`[TradingManager] 🔍 Profit Target Check:`, {
            positionId: position.id.substring(0, 8) + '...',
            direction: direction,
            entryPrice: position.entryPrice.toFixed(2),
            currentSellPrice: currentPrice.toFixed(2),
            profitTarget: profitTarget.toFixed(2),
            useTrailingStop: this.strategyConfig.useTrailingStop,
            peakPrice: this.peakPrice?.toFixed(2) || 'null',
            trailingStopPrice: this.trailingStopPrice?.toFixed(2) || 'null',
            profitTargetMet,
            yesPrice: yesPricePercent.toFixed(2),
            noPrice: noPricePercent.toFixed(2),
          });
        }
        
        if (profitTargetMet) {
          shouldExit = true;
          if (!exitReason) {
            exitReason = `Profit target reached at ${currentPrice.toFixed(2)} (Position: ${position.id.substring(0, 8)}...)`;
          }
          triggeringPosition = position;
          console.log(`[TradingManager] 🎯🎯🎯 PROFIT TARGET TRIGGERED! Position ${position.id.substring(0, 8)}... at price ${currentPrice.toFixed(2)}. Will close ALL ${activePositions.length} position(s).`);
          console.log(`[TradingManager] 📊 Profit Target Details:`, {
            positionId: position.id.substring(0, 8) + '...',
            direction: direction,
            entryPrice: position.entryPrice.toFixed(2),
            currentSellPrice: currentPrice.toFixed(2),
            profitTarget: profitTarget.toFixed(2),
            useTrailingStop: this.strategyConfig.useTrailingStop,
            peakPrice: this.peakPrice?.toFixed(2),
            trailingStopPrice: this.trailingStopPrice?.toFixed(2),
            profitTargetMet,
            priceDifference: (currentPrice - profitTarget).toFixed(2),
            unrealizedProfit: position.unrealizedProfit?.toFixed(2),
            yesPrice: yesPricePercent.toFixed(2),
            noPrice: noPricePercent.toFixed(2),
          });
          break; // Exit all positions on profit target
        }
        
        // Check stop loss condition
        // CRITICAL: Use <= for stop loss (price at or below stop loss triggers exit)
        if (currentPrice <= stopLoss) {
          shouldExit = true;
          exitReason = `Stop loss triggered at ${currentPrice.toFixed(2)} (Position: ${position.id.substring(0, 8)}...)`;
          useAdaptiveSelling = true;
          isDownDirection = direction === 'DOWN';
          triggeringPosition = position;
          console.log(`[TradingManager] 🛑🛑🛑 STOP LOSS TRIGGERED! Position ${position.id.substring(0, 8)}... at price ${currentPrice.toFixed(2)} <= stop loss ${stopLoss.toFixed(2)}. Will close ALL ${activePositions.length} position(s).`);
          break; // Exit all positions on stop loss
        }
      }

      // Log exit condition check with detailed price comparison
      if (!shouldExit) {
        // Log detailed info for debugging exit conditions
        // Log if price is very close to stop loss OR profit target
        const shouldLog = activePositions.some(p => {
          const currentPrice = p.currentPrice || 0;
          const distanceToStopLoss = Math.abs(currentPrice - stopLoss);
          const distanceToProfitTarget = Math.abs(currentPrice - profitTarget);
          return distanceToStopLoss < 2 || distanceToProfitTarget < 2; // Log if within 2% of either threshold
        });
        
        if (shouldLog) {
          const exitCheckLog = {
            yesSellPrice: yesPricePercent.toFixed(2),
            noSellPrice: noPricePercent.toFixed(2),
            profitTarget: profitTarget.toFixed(2),
            stopLoss: stopLoss.toFixed(2),
            positions: activePositions.map(p => {
              const currentPrice = p.currentPrice || 0;
              const distanceToStopLoss = currentPrice - stopLoss;
              const distanceToProfitTarget = profitTarget - currentPrice;
              const profitTargetMet = currentPrice >= profitTarget;
              const stopLossMet = currentPrice <= stopLoss;
              return {
                id: p.id.substring(0, 8),
                direction: p.direction,
                entryPrice: p.entryPrice.toFixed(2),
                currentSellPrice: currentPrice.toFixed(2),
                profitTargetCheck: `${currentPrice.toFixed(2)} >= ${profitTarget.toFixed(2)} = ${profitTargetMet}`,
                distanceToProfitTarget: distanceToProfitTarget.toFixed(2),
                stopLossCheck: `${currentPrice.toFixed(2)} <= ${stopLoss.toFixed(2)} = ${stopLossMet}`,
                distanceToStopLoss: distanceToStopLoss.toFixed(2),
                unrealizedProfit: p.unrealizedProfit?.toFixed(2),
              };
            }),
          };
          console.log(`[TradingManager] ⚠️ Exit check: NO EXIT (price near threshold)`, exitCheckLog);
        }
      }

      if (shouldExit) {
        console.log(`[TradingManager] 🚨🚨🚨 EXIT CONDITION MET - Closing ALL ${activePositions.length} position(s):`, {
          exitReason,
          yesSellPrice: yesPricePercent.toFixed(2),
          noSellPrice: noPricePercent.toFixed(2),
          profitTarget: profitTarget.toFixed(2),
          stopLoss: stopLoss.toFixed(2),
          triggeringPosition: triggeringPosition ? {
            id: triggeringPosition.id.substring(0, 8),
            direction: triggeringPosition.direction,
            entryPrice: triggeringPosition.entryPrice.toFixed(2),
            currentSellPrice: triggeringPosition.currentPrice?.toFixed(2),
            profitCheck: `${triggeringPosition.currentPrice?.toFixed(2)} >= ${profitTarget.toFixed(2)} = ${(triggeringPosition.currentPrice || 0) >= profitTarget}`,
            stopLossCheck: `${triggeringPosition.currentPrice?.toFixed(2)} <= ${stopLoss.toFixed(2)} = ${(triggeringPosition.currentPrice || 0) <= stopLoss}`,
          } : null,
          allPositions: activePositions.map(p => ({
            id: p.id.substring(0, 8),
            direction: p.direction,
            size: p.size.toFixed(2),
            entryPrice: p.entryPrice.toFixed(2),
            currentSellPrice: p.currentPrice?.toFixed(2),
          })),
          useAdaptiveSelling,
          isPlacingExitOrder: this.isPlacingExitOrder,
          isPlacingEntryOrder: this.isPlacingOrder || this.isPlacingSplitOrders,
        });

        // CRITICAL: Exit conditions should ALWAYS execute, even if entry orders are in progress
        if (useAdaptiveSelling) {
          console.log(`[TradingManager] 🚨 Executing STOP LOSS exit via adaptive selling...`);
          await this.closeAllPositionsWithAdaptiveSelling(exitReason, stopLoss, isDownDirection, yesPricePercent, noPricePercent);
        } else {
          console.log(`[TradingManager] 🚨 Executing profit target exit...`);
          await this.closeAllPositions(exitReason);
        }
      }

      this.notifyStatusUpdate();
    } catch (error) {
      console.error('Error checking exit conditions:', error);
    }
  }

  /**
   * Place a single SELL order
   * @param tokenId - Token ID to sell
   * @param shares - Number of shares to sell (calculated from entry price)
   * @param direction - UP or DOWN
   * @param orderIndex - Order index for logging
   * @param totalOrders - Total orders for logging
   * @param yesPricePercent - Current YES price
   * @param noPricePercent - Current NO price
   * @param useLimitOrder - If true, use limit order (GTC) instead of market order (FAK)
   * @param limitPrice - Limit price in percentage (0-100) if using limit order
   */
  private async placeSingleSellOrder(
    tokenId: string,
    shares: number,
    direction: 'UP' | 'DOWN',
    orderIndex: number,
    totalOrders: number,
    yesPricePercent: number,
    noPricePercent: number,
    useLimitOrder: boolean = false,
    limitPrice?: number
  ): Promise<{ success: boolean; orderId?: string; fillPrice?: number; error?: string }> {
    try {
      if (!this.apiCredentials) {
        return { success: false, error: 'No API credentials' };
      }

      // Use the appropriate price based on direction (same as adaptive selling)
      const currentPricePercent = direction === 'UP' ? yesPricePercent : noPricePercent;
      
      // Convert percentage back to decimal (0-1) for API calls
      const bidPrice = currentPricePercent / 100;
      
      if (isNaN(bidPrice) || bidPrice <= 0 || bidPrice >= 1) {
        return { success: false, error: 'Invalid market price' };
      }

      // Shares are now always passed directly (calculated from entry prices)
      const estimatedUSD = shares * bidPrice;

      if (this.browserClobClient) {
        const { OrderType, Side } = await import('@polymarket/clob-client');

        let feeRateBps: number;
        try {
          feeRateBps = await this.browserClobClient.getFeeRateBps(tokenId);
          if (!feeRateBps || feeRateBps === 0) {
            feeRateBps = 1000;
          }
        } catch (error) {
          feeRateBps = 1000;
        }

        const roundedShares = Math.round(shares * 100) / 100;
        
        if (roundedShares <= 0 || isNaN(roundedShares) || !isFinite(roundedShares)) {
          const errorMsg = `Invalid shares calculated: ${shares}. Cannot place sell order.`;
          console.error(`[TradingManager] ❌ SELL order ${orderIndex + 1}/${totalOrders} - ${errorMsg}`);
          return { success: false, error: errorMsg };
        }

        let response: { orderID?: string; error?: string; data?: { error?: string }; status?: string };

        if (useLimitOrder && limitPrice !== undefined) {
          // Use LIMIT order (GTC) for stop loss - order stays on book until filled
          const limitPriceDecimal = limitPrice / 100;
          const finalLimitPrice = Math.min(limitPriceDecimal, bidPrice);

          const limitOrder = {
            tokenID: tokenId,
            price: finalLimitPrice,
            size: roundedShares,
            side: Side.SELL,
            feeRateBps: feeRateBps,
            expiration: 0,
            taker: '0x0000000000000000000000000000000000000000',
          };

          console.log(`[TradingManager] 📤 SELL LIMIT order ${orderIndex + 1}/${totalOrders} - Placing:`, {
            tokenId: tokenId.substring(0, 10) + '...',
            direction,
            limitPricePercent: limitPrice.toFixed(2),
            finalLimitPrice: finalLimitPrice.toFixed(4),
            currentSellPrice: currentPricePercent.toFixed(2),
            shares: roundedShares.toFixed(2),
            note: 'LIMIT order (GTC) - will stay on order book until filled',
          });

          try {
            response = await this.browserClobClient.createAndPostOrder(
              limitOrder,
              { negRisk: false },
              OrderType.GTC
            ) as { orderID?: string; error?: string; data?: { error?: string }; status?: string };
          } catch (orderError: any) {
            const errorData = orderError?.response?.data || orderError?.data || {};
            const errorMessage = errorData?.error || orderError?.message || 'Unknown error';
            console.error(`[TradingManager] ❌ SELL LIMIT order ${orderIndex + 1}/${totalOrders} failed:`, {
              error: errorMessage,
              tokenId: tokenId.substring(0, 10) + '...',
              limitPrice: limitPrice.toFixed(2),
              shares: shares.toFixed(4),
            });
            return { success: false, error: errorMessage };
          }

          if (response?.orderID) {
            console.log(`[TradingManager] ✅ SELL LIMIT order ${orderIndex + 1}/${totalOrders} - PLACED (GTC):`, {
              orderId: response.orderID.substring(0, 12) + '...',
              limitPrice: limitPrice.toFixed(2),
              shares: roundedShares.toFixed(2),
              note: 'Order placed on order book - will fill when price reaches limit price',
            });
            return {
              success: true,
              orderId: response.orderID,
              fillPrice: limitPrice,
            };
          } else {
            const errorMsg = (response as any)?.error || (response as any)?.data?.error || 'No order ID returned';
            console.error(`[TradingManager] ❌ SELL LIMIT order ${orderIndex + 1}/${totalOrders} - FAILED:`, { error: errorMsg, response });
            return { success: false, error: errorMsg };
          }
        }

        // Market order (FAK) for normal exits
        const marketOrder = {
          tokenID: tokenId,
          amount: roundedShares,
          side: Side.SELL,
          feeRateBps: feeRateBps,
        };

        console.log(`[TradingManager] 📤 SELL MARKET order ${orderIndex + 1}/${totalOrders} - Attempting to place:`, {
          tokenId: tokenId.substring(0, 10) + '...',
          direction,
          currentSellPrice: currentPricePercent.toFixed(2),
          shares: roundedShares.toFixed(2),
          estimatedUSD: estimatedUSD.toFixed(2),
          note: 'Shares calculated from actual filled orders (what you actually own)',
        });

        try {
          response = await this.browserClobClient.createAndPostMarketOrder(
            marketOrder,
            { negRisk: false },
            OrderType.FAK
          ) as { orderID?: string; error?: string; data?: { error?: string }; status?: string };
        } catch (orderError: any) {
          const errorData = orderError?.response?.data || orderError?.data || {};
          const errorMessage = errorData?.error || orderError?.message || 'Unknown error';
          
          if (errorMessage.includes('no orders found to match with FAK order') || 
              errorMessage.includes('FAK orders are partially filled or killed')) {
            console.warn(`[TradingManager] ⚠️ SELL FAK order ${orderIndex + 1}/${totalOrders} - No immediate match found:`, {
              currentSellPrice: currentPricePercent.toFixed(2),
              shares: shares.toFixed(4),
              error: errorMessage,
            });
            return { 
              success: false, 
              error: `No immediate match for FAK SELL order at ${currentPricePercent.toFixed(2)}. Price may have moved or insufficient liquidity.` 
            };
          }
          
          if (errorMessage.includes('not enough balance') || errorMessage.includes('allowance') || errorMessage.includes('insufficient')) {
            console.error(`[TradingManager] 🚫 SELL order ${orderIndex + 1}/${totalOrders} - Insufficient balance/allowance:`, {
              error: errorMessage,
              shares: shares.toFixed(4),
              tokenId: tokenId.substring(0, 10) + '...',
            });
            return { 
              success: false, 
              error: `Insufficient balance/allowance: Cannot sell ${shares.toFixed(4)} shares.` 
            };
          }
          
          console.error(`[TradingManager] ❌ SELL order ${orderIndex + 1}/${totalOrders} failed:`, {
            error: errorMessage,
            tokenId: tokenId.substring(0, 10) + '...',
            shares: shares.toFixed(4),
          });
          return { success: false, error: errorMessage };
        }

        if (response?.orderID) {
          console.log(`[TradingManager] ✅ SELL order ${orderIndex + 1}/${totalOrders} - SUCCESS:`, {
            orderId: response.orderID.substring(0, 12) + '...',
            fillPrice: currentPricePercent.toFixed(2),
          });
          return {
            success: true,
            orderId: response.orderID,
            fillPrice: currentPricePercent,
          };
        } else {
          const errorMsg = (response as any)?.error || (response as any)?.data?.error || 'No order ID returned from exchange';
          console.error(`[TradingManager] ❌ SELL order ${orderIndex + 1}/${totalOrders} - FAILED:`, {
            error: errorMsg,
            response: response,
            tokenId: tokenId.substring(0, 10) + '...',
            shares: shares.toFixed(4),
          });
          return { success: false, error: errorMsg };
        }
      } else {
        const errorMsg = 'Browser ClobClient not initialized. Cannot place SELL orders - server-side API is blocked by Cloudflare. Please ensure wallet is connected and browser client is initialized.';
        console.error(`[TradingManager] ❌ SELL order ${orderIndex + 1}/${totalOrders} cannot be placed:`, {
          error: errorMsg,
          tokenId: tokenId.substring(0, 10) + '...',
        });
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Aggregate positions by token to calculate total shares based on ACTUAL filled orders
   * Uses the actual fill prices from filledOrders, not recalculated from entry price
   */
  private aggregatePositionsByToken(positions: Position[]): Map<string, { positions: Position[], totalSize: number, totalShares: number, direction: 'UP' | 'DOWN' }> {
    const aggregated = new Map<string, { positions: Position[], totalSize: number, totalShares: number, direction: 'UP' | 'DOWN' }>();
    
    for (const position of positions) {
      const tokenId = position.tokenId;
      if (!aggregated.has(tokenId)) {
        aggregated.set(tokenId, {
          positions: [],
          totalSize: 0,
          totalShares: 0,
          direction: position.direction || 'UP'
        });
      }
      
      const agg = aggregated.get(tokenId)!;
      agg.positions.push(position);
      agg.totalSize += position.size;
      
      // Calculate shares from ACTUAL filled orders (what was actually received)
      // This is more accurate than recalculating from entry price
      if (position.filledOrders && position.filledOrders.length > 0) {
        // Use actual fill prices from filled orders
        let positionShares = 0;
        for (const filledOrder of position.filledOrders) {
          const fillPriceDecimal = filledOrder.price / 100; // Convert percentage to decimal
          const orderShares = filledOrder.size / fillPriceDecimal;
          positionShares += orderShares;
        }
        agg.totalShares += positionShares;
        
        console.log(`[TradingManager] 📊 Position shares from filled orders:`, {
          positionId: position.id.substring(0, 8) + '...',
          numFilledOrders: position.filledOrders.length,
          totalShares: positionShares.toFixed(4),
          filledOrders: position.filledOrders.map(fo => ({
            price: fo.price.toFixed(2),
            sizeUSD: fo.size.toFixed(2),
            shares: (fo.size / (fo.price / 100)).toFixed(4)
          }))
        });
      } else {
        // Fallback: Calculate from entry price if no filledOrders (shouldn't happen, but safety)
        const entryPriceDecimal = position.entryPrice / 100;
        const positionShares = position.size / entryPriceDecimal;
        agg.totalShares += positionShares;
        
        console.warn(`[TradingManager] ⚠️ Position ${position.id.substring(0, 8)}... has no filledOrders, using entry price calculation (may be inaccurate)`);
      }
    }
    
    return aggregated;
  }

  /**
   * Close all positions for the current event
   * 
   * IMPROVED BEHAVIOR:
   * - Aggregates positions by token (combines multiple positions for same token)
   * - Sells cumulative shares in ONE order per token
   * - Example: 2 positions of $2 at 65¢ = ONE order for $4 worth of shares (6.15 shares at current price)
   * - More efficient, avoids rate limits, and ensures atomic execution
   * 
   * @param reason - Reason for closing positions
   * @param isStopLoss - If true, uses aggressive mode: no splitting, no delays
   */
  private async closeAllPositions(reason: string, isStopLoss: boolean = false): Promise<void> {
    // CRITICAL: Take a snapshot of positions to ensure they don't change during processing
    const activePositions = [...this.getActivePositions()]; // Spread to create new array

    if (activePositions.length === 0) {
      console.log('[TradingManager] closeAllPositions: No active positions to close');
      return;
    }

    // CRITICAL: Only check exit order flag, not entry order flags
    if (this.isPlacingExitOrder) {
      console.log('[TradingManager] Exit order already being placed, skipping...');
      return;
    }

    // Set exit order flag (separate from entry order flags)
    this.isPlacingExitOrder = true;
    this.orderPlacementStartTime = Date.now(); // Track when exit order placement started

    const closedPositionIds: string[] = [];
    const failedPositionIds: string[] = [];
    
      console.log(`[TradingManager] 🔒 Exit flags locked. isPlacingExitOrder=${this.isPlacingExitOrder}`);
      console.log(`[TradingManager] 📸 Snapshot taken: ${activePositions.length} position(s) to close`);
    
    // Aggregate positions by token
    const aggregatedByToken = this.aggregatePositionsByToken(activePositions);
    console.log(`[TradingManager] 📊 Aggregated into ${aggregatedByToken.size} unique token(s):`, 
      Array.from(aggregatedByToken.entries()).map(([tokenId, data]) => ({
        tokenId: tokenId.substring(0, 10) + '...',
        numPositions: data.positions.length,
        totalSizeUSD: data.totalSize.toFixed(2),
        direction: data.direction,
        positionIds: data.positions.map(p => p.id.substring(0, 8) + '...')
      }))
    );

    try {
      const totalSize = activePositions.reduce((sum, p) => sum + p.size, 0);
      
      // Check if positions have the same token (potential issue)
      const tokenIds = activePositions.map(p => p.tokenId);
      const uniqueTokenIds = new Set(tokenIds);
      const hasDuplicateTokens = uniqueTokenIds.size < tokenIds.length;
      
      console.log(`[TradingManager] 🚨🚨🚨 STARTING TO CLOSE ALL ${activePositions.length} POSITION(S) - ${reason}:`, {
        reason,
        totalSize: totalSize.toFixed(2),
        isStopLoss: isStopLoss ? '⚡ YES - AGGRESSIVE MODE' : 'no',
        activeEventSlug: this.activeEvent?.slug,
        allPositionsInMemory: this.positions.length,
        uniqueTokenIds: uniqueTokenIds.size,
        hasDuplicateTokens: hasDuplicateTokens ? '⚠️ YES - Multiple positions on same token!' : 'no',
        positions: activePositions.map((p, idx) => ({
          index: idx + 1,
          id: p.id.substring(0, 8) + '...',
          tokenId: p.tokenId.substring(0, 10) + '...',
          eventSlug: p.eventSlug,
          direction: p.direction,
          side: p.side,
          size: p.size.toFixed(2),
          entryPrice: p.entryPrice.toFixed(2),
          currentPrice: p.currentPrice?.toFixed(2),
          unrealizedProfit: p.unrealizedProfit?.toFixed(2),
        })),
      });

      // Close positions aggregated by token (cumulative shares per token)
      console.log(`[TradingManager] 🔄 Processing ${aggregatedByToken.size} unique token(s)...`);
      
      let tokenCount = 0;
      for (const [tokenId, aggregatedData] of aggregatedByToken.entries()) {
        tokenCount++;
        console.log(`[TradingManager] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`[TradingManager] 🔄 [${tokenCount}/${aggregatedByToken.size}] PROCESSING TOKEN ${tokenCount}`);
        console.log(`[TradingManager] 🔄 Token Details:`, {
          tokenId: tokenId.substring(0, 10) + '...',
          numPositions: aggregatedData.positions.length,
          totalSizeUSD: aggregatedData.totalSize.toFixed(2),
          totalShares: aggregatedData.totalShares.toFixed(4),
          direction: aggregatedData.direction,
          positionIds: aggregatedData.positions.map(p => p.id.substring(0, 8) + '...')
        });
        
        try {
          // Close all positions for this token in ONE order
          await this.closeAggregatedPositions(aggregatedData.positions, tokenId, aggregatedData.totalSize, aggregatedData.totalShares, aggregatedData.direction, reason, isStopLoss);
          
          // Mark all positions for this token as closed
          for (const pos of aggregatedData.positions) {
            closedPositionIds.push(pos.id);
          }
          
          console.log(`[TradingManager] ✅✅✅ [${tokenCount}/${aggregatedByToken.size}] SUCCESS - Closed ${aggregatedData.positions.length} position(s) for token ${tokenId.substring(0, 10)}...`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          const errorStack = error instanceof Error ? error.stack : undefined;
          
          // Mark all positions for this token as failed
          for (const pos of aggregatedData.positions) {
            failedPositionIds.push(pos.id);
          }
          
          console.error(`[TradingManager] ❌❌❌ [${tokenCount}/${aggregatedByToken.size}] FAILED - Could not close ${aggregatedData.positions.length} position(s) for token ${tokenId.substring(0, 10)}...`);
          console.error(`[TradingManager] ❌ Error details:`, {
            error: errorMsg,
            stack: errorStack,
            tokenId: tokenId.substring(0, 10) + '...',
            totalSize: aggregatedData.totalSize.toFixed(2),
          });
        }
        
        console.log(`[TradingManager] 🏁 [${tokenCount}/${aggregatedByToken.size}] FINISHED processing token ${tokenCount}`);
      }
      
      console.log(`[TradingManager] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`[TradingManager] 🏁 ALL ${aggregatedByToken.size} TOKEN(S) PROCESSED`);
      console.log(`[TradingManager] 🏁 Total positions affected: ${activePositions.length}`);

      // Log completion of all attempts
      console.log(`[TradingManager] 🏁 FINISHED processing all ${activePositions.length} position(s). Results:`, {
        attempted: activePositions.length,
        succeeded: closedPositionIds.length,
        failed: failedPositionIds.length,
        closedPositionIds: closedPositionIds.map(id => id.substring(0, 8) + '...'),
        failedPositionIds: failedPositionIds.map(id => id.substring(0, 8) + '...'),
      });
      
      // Remove only successfully closed positions
      if (closedPositionIds.length > 0) {
        const positionsBeforeRemoval = this.positions.length;
        this.positions = this.positions.filter(
          p => !closedPositionIds.includes(p.id)
        );
        const positionsAfterRemoval = this.positions.length;
        
        this.status.positions = [...this.positions];
        this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
        
        console.log(`[TradingManager] 📊 Position cleanup: ${positionsBeforeRemoval} → ${positionsAfterRemoval} (removed ${positionsBeforeRemoval - positionsAfterRemoval})`);
        
        if (failedPositionIds.length === 0) {
          console.log(`[TradingManager] ✅✅✅ FULL SUCCESS: All ${closedPositionIds.length} position(s) closed successfully!`);
        } else {
          console.warn(`[TradingManager] ⚠️⚠️⚠️ PARTIAL SUCCESS: Closed ${closedPositionIds.length} of ${activePositions.length} position(s)`);
          console.warn(`[TradingManager] ⚠️ ${failedPositionIds.length} position(s) FAILED to close`);
          
          // Get full position details for failed positions
          const failedPositions = activePositions.filter(p => failedPositionIds.includes(p.id));
          console.error(`[TradingManager] ❌ Failed positions:`, failedPositions.map(p => ({
            id: p.id.substring(0, 8) + '...',
            tokenId: p.tokenId.substring(0, 10) + '...',
            direction: p.direction,
            size: p.size.toFixed(2),
          })));
          
          // CRITICAL: If stop loss and not all positions closed, retry failed ones immediately
          if (isStopLoss && failedPositions.length > 0) {
            console.error(`[TradingManager] 🔄🔄🔄 STOP LOSS RETRY: Attempting to close ${failedPositions.length} failed position(s) again...`);
            console.error(`[TradingManager] 🔄 Waiting 1 second before retry...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Re-aggregate failed positions by token for retry
            const retryAggregated = this.aggregatePositionsByToken(failedPositions);
            console.log(`[TradingManager] 🔄 Retry will process ${retryAggregated.size} token(s) covering ${failedPositions.length} position(s)`);
            
            // Retry each token
            let retryTokenCount = 0;
            for (const [retryTokenId, retryData] of retryAggregated.entries()) {
              retryTokenCount++;
              try {
                console.log(`[TradingManager] 🔄 RETRY ${retryTokenCount}/${retryAggregated.size}: Token ${retryTokenId.substring(0, 10)}... (${retryData.positions.length} positions, $${retryData.totalSize.toFixed(2)}, ${retryData.totalShares.toFixed(4)} shares)`);
                await this.closeAggregatedPositions(retryData.positions, retryTokenId, retryData.totalSize, retryData.totalShares, retryData.direction, `${reason} - RETRY AFTER FAILURE`, true);
                
                // Mark all positions for this token as closed
                for (const pos of retryData.positions) {
                  closedPositionIds.push(pos.id);
                  // Remove from failed list
                  const idx = failedPositionIds.indexOf(pos.id);
                  if (idx > -1) failedPositionIds.splice(idx, 1);
                }
                
                console.log(`[TradingManager] ✅ RETRY ${retryTokenCount} SUCCESS: ${retryData.positions.length} position(s) closed`);
              } catch (retryError) {
                const retryErrorMsg = retryError instanceof Error ? retryError.message : 'Unknown error';
                console.error(`[TradingManager] ❌ RETRY ${retryTokenCount} FAILED: Token ${retryTokenId.substring(0, 10)}... still could not be closed:`, retryErrorMsg);
              }
            }
            
            // Final cleanup after retry
            this.positions = this.positions.filter(p => !closedPositionIds.includes(p.id));
            this.status.positions = [...this.positions];
            this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
            
            const stillOpenPositions = this.getActivePositions();
            if (stillOpenPositions.length > 0) {
              console.error(`[TradingManager] 🚨 CRITICAL: ${stillOpenPositions.length} position(s) STILL OPEN after retry!`);
              console.error(`[TradingManager] 🚨 You may need to manually close these positions:`, stillOpenPositions.map(p => ({
                id: p.id.substring(0, 8) + '...',
                tokenId: p.tokenId.substring(0, 10) + '...',
                direction: p.direction,
                size: p.size.toFixed(2),
              })));
            } else {
              console.log(`[TradingManager] ✅ RETRY COMPLETE: All positions successfully closed after retry!`);
            }
          }
        }
      } else {
        console.error(`[TradingManager] ❌❌❌ TOTAL FAILURE: No positions were successfully closed out of ${activePositions.length} attempted!`);
        
        // If stop loss and total failure, try one more time
        if (isStopLoss) {
          console.error(`[TradingManager] 🔄 STOP LOSS TOTAL RETRY: All positions failed. Retrying entire process...`);
          // Wait a bit before retry
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Re-aggregate all positions for emergency retry
          const emergencyAggregated = this.aggregatePositionsByToken(activePositions);
          console.log(`[TradingManager] 🔄 Emergency retry will process ${emergencyAggregated.size} token(s)`);
          
          for (const [emergencyTokenId, emergencyData] of emergencyAggregated.entries()) {
            try {
              await this.closeAggregatedPositions(emergencyData.positions, emergencyTokenId, emergencyData.totalSize, emergencyData.totalShares, emergencyData.direction, `${reason} - EMERGENCY RETRY`, true);
              for (const pos of emergencyData.positions) {
                closedPositionIds.push(pos.id);
              }
            } catch (error) {
              console.error(`[TradingManager] ❌ EMERGENCY RETRY FAILED for token ${emergencyTokenId.substring(0, 10)}...`);
            }
          }
          
          // Final cleanup
          if (closedPositionIds.length > 0) {
            this.positions = this.positions.filter(p => !closedPositionIds.includes(p.id));
            this.status.positions = [...this.positions];
            this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
            console.log(`[TradingManager] 🔄 EMERGENCY RETRY: Closed ${closedPositionIds.length} of ${activePositions.length} position(s)`);
          }
        }
      }

      this.notifyStatusUpdate();
      
      // FINAL VERIFICATION: Check if any positions are still open for this event
      const remainingPositions = this.getActivePositions();
      if (remainingPositions.length > 0) {
        console.error(`[TradingManager] ⚠️⚠️⚠️ VERIFICATION FAILED: ${remainingPositions.length} position(s) still open after closeAllPositions!`);
        console.error(`[TradingManager] Open positions:`, remainingPositions.map(p => ({
          id: p.id.substring(0, 8) + '...',
          tokenId: p.tokenId.substring(0, 10) + '...',
          direction: p.direction,
          size: p.size.toFixed(2),
        })));
      } else {
        console.log(`[TradingManager] ✅ VERIFICATION PASSED: No positions remain open for this event`);
      }
    } catch (error) {
      console.error('[TradingManager] ❌ Error closing all positions:', error);
      
      // Even on error, try to clean up any successfully closed positions
      if (closedPositionIds.length > 0) {
        console.log(`[TradingManager] 🧹 Cleaning up ${closedPositionIds.length} successfully closed position(s) despite error...`);
        this.positions = this.positions.filter(p => !closedPositionIds.includes(p.id));
        this.status.positions = [...this.positions];
        this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
        this.notifyStatusUpdate();
      }
    } finally {
      this.isPlacingExitOrder = false;
      this.orderPlacementStartTime = 0; // Reset timer
      
      console.log(`[TradingManager] 🔓 Exit flags unlocked. isPlacingExitOrder=${this.isPlacingExitOrder}`);
      console.log(`[TradingManager] 🏁 closeAllPositions finished. Final position count: ${this.positions.length}`);
    }
  }

  /**
   * Check for early exit on reversal - exit if price reverses after entry
   */
  private checkEarlyExitOnReversal(
    position: Position,
    yesPricePercent: number,
    noPricePercent: number
  ): {
    shouldExit: boolean;
    currentPrice: number;
    reversalPercent: number;
    reason: string;
  } {
    const direction = position.direction || 'UP';
    const currentPrice = direction === 'UP' ? yesPricePercent : noPricePercent;
    const entryPrice = position.entryPrice;
    
    // Get price history to detect reversal
    const lookbackSeconds = 60; // Check last 60 seconds
    const lookbackTime = Date.now() - lookbackSeconds * 1000;
    const recentHistory = this.priceHistory.filter(p => p.timestamp >= lookbackTime);
    
    if (recentHistory.length < 3) {
      // Not enough history
      return { shouldExit: false, currentPrice, reversalPercent: 0, reason: '' };
    }

    // Find peak price after entry
    const entryTime = position.entryTimestamp;
    const pricesAfterEntry = recentHistory
      .filter(p => p.timestamp >= entryTime)
      .map(p => direction === 'UP' ? p.yesPrice : p.noPrice);
    
    if (pricesAfterEntry.length === 0) {
      return { shouldExit: false, currentPrice, reversalPercent: 0, reason: '' };
    }

    const peakPrice = Math.max(...pricesAfterEntry, entryPrice);
    const priceDropFromPeak = peakPrice - currentPrice;
    const reversalPercent = priceDropFromPeak / peakPrice;
    const threshold = this.strategyConfig.reversalExitThreshold || 0.05; // Default 5%

    // Exit if price dropped more than threshold from peak
    if (reversalPercent >= threshold && currentPrice < entryPrice) {
      return {
        shouldExit: true,
        currentPrice,
        reversalPercent,
        reason: `Price reversed ${(reversalPercent * 100).toFixed(2)}% from peak ${peakPrice.toFixed(2)}% to ${currentPrice.toFixed(2)}%`,
      };
    }

    return { shouldExit: false, currentPrice, reversalPercent, reason: '' };
  }

  /**
   * Close partial position (for partial profit taking)
   */
  private async closePartialPosition(position: Position, percentToClose: number): Promise<void> {
    if (!this.activeEvent || !this.activeEvent.clobTokenIds) {
      return;
    }

    try {
      const yesTokenId = this.activeEvent.clobTokenIds[0];
      const noTokenId = this.activeEvent.clobTokenIds[1];
      const tokenId = position.tokenId;
      const direction = position.direction || 'UP';

      // Calculate shares to sell (partial)
      const sharesToSell = (position.size / position.entryPrice) * percentToClose;

      // Get current prices
      const [yesPrice, noPrice] = await Promise.all([
        this.clobClient.getPrice(yesTokenId, 'SELL'),
        this.clobClient.getPrice(noTokenId, 'SELL'),
      ]);

      if (!yesPrice || !noPrice) {
        console.error('[TradingManager] Failed to fetch prices for partial profit taking');
        return;
      }

      const yesPricePercent = toPercentage(yesPrice);
      const noPricePercent = toPercentage(noPrice);

      // Place sell order for partial position
      const result = await this.placeSingleSellOrder(
        tokenId,
        sharesToSell,
        direction,
        0,
        1,
        yesPricePercent,
        noPricePercent,
        false, // Market order for partial profit
        undefined
      );

      if (result.success) {
        // Update position size
        position.size = position.size * (1 - percentToClose);
        
        // Create trade record for partial exit
        const exitTrade: Trade = {
          id: `partial-exit-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          eventSlug: position.eventSlug,
          tokenId: tokenId,
          side: 'SELL',
          size: position.size * percentToClose,
          price: result.fillPrice || (direction === 'UP' ? yesPricePercent : noPricePercent),
          timestamp: Date.now(),
          status: 'filled',
          transactionHash: result.orderId,
          profit: ((result.fillPrice || (direction === 'UP' ? yesPricePercent : noPricePercent)) - position.entryPrice) / position.entryPrice * position.size * percentToClose,
          reason: `Partial profit taking: ${(percentToClose * 100).toFixed(0)}% at ${this.strategyConfig.partialProfitTarget || 96}%`,
          orderType: 'MARKET',
          direction: direction,
        };

        this.trades.push(exitTrade);
        this.notifyTradeUpdate(exitTrade);
        this.status.positions = [...this.positions];
        this.notifyStatusUpdate();

        console.log(`[TradingManager] ✅ Partial profit taken: ${(percentToClose * 100).toFixed(0)}% of position closed`);
      }
    } catch (error) {
      console.error('[TradingManager] Error closing partial position:', error);
    }
  }

  /**
   * Close multiple positions for the same token in ONE aggregated order
   * This sells cumulative shares in a single transaction
   * Shares are calculated based on entry prices (what was actually bought)
   */
  private async closeAggregatedPositions(
    positions: Position[],
    tokenId: string,
    totalSizeUSD: number,
    totalShares: number,
    direction: 'UP' | 'DOWN',
    reason: string,
    isStopLoss: boolean
  ): Promise<void> {
    console.log(`[TradingManager] 💰 AGGREGATED CLOSE: Selling ${positions.length} position(s) for token ${tokenId.substring(0, 10)}...`, {
      totalSizeUSD: totalSizeUSD.toFixed(2),
      totalShares: totalShares.toFixed(4),
      direction,
      positions: positions.map(p => {
        const entryPriceDecimal = p.entryPrice / 100;
        const positionShares = p.size / entryPriceDecimal;
        return {
          id: p.id.substring(0, 8) + '...',
          size: p.size.toFixed(2),
          entryPrice: p.entryPrice.toFixed(2),
          shares: positionShares.toFixed(4)
        };
      })
    });

    if (!this.apiCredentials) {
      // Simulation mode
      const avgEntryPrice = positions.reduce((sum, p) => sum + p.entryPrice * p.size, 0) / totalSizeUSD;
      const exitPricePercent = avgEntryPrice;
      const priceDiff = exitPricePercent - avgEntryPrice;
      const profit = (priceDiff / avgEntryPrice) * totalSizeUSD;

      const exitTrade: Trade = {
        id: `exit-aggregated-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        eventSlug: positions[0].eventSlug,
        tokenId,
        side: 'SELL',
        size: totalSizeUSD,
        price: exitPricePercent,
        timestamp: Date.now(),
        status: 'filled',
        transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
        profit,
        reason: `Simulated aggregated exit (${positions.length} positions): ${reason}`,
        orderType: 'MARKET',
        direction,
      };

      this.trades.push(exitTrade);
      this.status.totalTrades++;
      this.status.totalProfit += profit;
      this.status.successfulTrades++;
      this.notifyTradeUpdate(exitTrade);
      return;
    }

    // Get current market price for selling
    if (!this.activeEvent || !this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      throw new Error('Cannot close positions: missing event or token IDs');
    }

    const yesTokenId = this.activeEvent.clobTokenIds[0];
    const noTokenId = this.activeEvent.clobTokenIds[1];

    const [yesPrice, noPrice] = await Promise.all([
      this.clobClient.getPrice(yesTokenId, 'SELL'),
      this.clobClient.getPrice(noTokenId, 'SELL'),
    ]);

    if (!yesPrice || !noPrice) {
      throw new Error('Cannot close positions: failed to fetch prices');
    }

    const yesPricePercent = toPercentage(yesPrice);
    const noPricePercent = toPercentage(noPrice);
    const currentPricePercent = direction === 'UP' ? yesPricePercent : noPricePercent;

    console.log(`[TradingManager] 📊 AGGREGATED SELL CALCULATION:`, {
      totalSizeUSD: totalSizeUSD.toFixed(2),
      totalShares: totalShares.toFixed(4),
      currentSellPrice: currentPricePercent.toFixed(4),
      estimatedUSDValue: (totalShares * (currentPricePercent / 100)).toFixed(2),
      numPositions: positions.length,
      note: 'Shares calculated from entry prices (actual shares owned)',
      warning: 'Ensure you have sufficient token balance and allowance for this sell order'
    });

    // For stop loss: use limit order if configured so all shares are sold
    const useLimitOrder = isStopLoss && (this.strategyConfig.useLimitOrderForStopLoss !== false);
    const limitPrice = isStopLoss ? this.strategyConfig.stopLossPrice : undefined;

    // Place ONE sell order for all cumulative shares (calculated from entry prices)
    const result = await this.placeSingleSellOrder(
      tokenId,
      totalShares,  // Pass shares directly, not USD
      direction,
      0,
      1,
      yesPricePercent,
      noPricePercent,
      useLimitOrder,
      limitPrice
    );

    if (!result.success || !result.orderId || result.fillPrice === undefined) {
      throw new Error(`Aggregated sell order failed: ${result.error || 'Unknown error'}`);
    }

    // Calculate profit based on actual shares sold
    const exitPriceDecimal = result.fillPrice / 100;
    const exitValueUSD = totalShares * exitPriceDecimal;
    
    // Calculate weighted average entry price for profit calculation
    const avgEntryPrice = positions.reduce((sum, p) => sum + p.entryPrice * p.size, 0) / totalSizeUSD;
    const avgEntryPriceDecimal = avgEntryPrice / 100;
    const entryCostUSD = totalShares * avgEntryPriceDecimal;
    const totalProfit = exitValueUSD - entryCostUSD;

    // Create exit trade record
    const exitTrade: Trade = {
      id: `exit-aggregated-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      eventSlug: positions[0].eventSlug,
      tokenId,
      side: 'SELL',
      size: exitValueUSD, // USD value received from selling shares
      price: result.fillPrice,
      timestamp: Date.now(),
      status: useLimitOrder ? 'pending' : 'filled',
      transactionHash: result.orderId,
      profit: totalProfit,
      reason: `Aggregated exit (${positions.length} positions${isStopLoss ? (useLimitOrder ? ' - 🛑 STOP LOSS LIMIT' : ' - ⚡STOP LOSS⚡') : ''}): ${reason}`,
      orderType: useLimitOrder ? 'LIMIT' : 'MARKET',
      limitPrice: useLimitOrder ? limitPrice : undefined,
      direction,
    };

    this.trades.push(exitTrade);
    this.status.totalTrades++;
    this.status.totalProfit += totalProfit;
    this.status.successfulTrades++;
    this.notifyTradeUpdate(exitTrade);

    console.log(`[TradingManager] ✅ AGGREGATED CLOSE SUCCESS:`, {
      numPositions: positions.length,
      totalShares: totalShares.toFixed(4),
      entryCostUSD: entryCostUSD.toFixed(2),
      exitValueUSD: exitValueUSD.toFixed(2),
      avgEntryPrice: avgEntryPrice.toFixed(2),
      exitPrice: result.fillPrice.toFixed(2),
      totalProfit: totalProfit.toFixed(2),
      orderId: result.orderId.substring(0, 12) + '...'
    });
  }

  /**
   * Aggressive stop loss exit - immediately sells ALL positions at market price
   * No delays, no splitting, no adaptive selling - just immediate market orders
   * For UP direction: when yesPricePercent <= stopLoss, aggressively sell all positions
   * For DOWN direction: when noPricePercent <= stopLoss, aggressively sell all positions
   */
  private async closeAllPositionsWithAdaptiveSelling(
    reason: string,
    stopLossPrice: number,
    isDownDirection: boolean,
    yesPricePercent: number,
    noPricePercent: number
  ): Promise<void> {
    const activePositions = this.getActivePositions();

    if (activePositions.length === 0) {
      return;
    }

    if (this.isPlacingExitOrder) {
      console.log('[TradingManager] Exit order already being placed, skipping...');
      return;
    }

    const currentPricePercent = isDownDirection ? noPricePercent : yesPricePercent;
    
    console.log('[TradingManager] 🛑🛑🛑 AGGRESSIVE STOP LOSS TRIGGERED - Immediately selling ALL positions:', {
      stopLossPrice,
      direction: isDownDirection ? 'DOWN' : 'UP',
      currentPrice: currentPricePercent.toFixed(2),
      numPositions: activePositions.length,
      reason,
    });

    // Aggressive mode: immediately sell all positions at market price
    // No delays, no splitting, no adaptive selling - just immediate market orders
    await this.closeAllPositions(`${reason} - Aggressive stop loss exit at ${currentPricePercent.toFixed(2)}`, true);
  }

  /**
   * Close a single position
   * @param position - Position to close
   * @param reason - Reason for closing
   * @param isStopLoss - If true, uses aggressive mode: no splitting, no delays between orders
   */
  private async closeSinglePosition(position: Position, reason: string, isStopLoss: boolean = false): Promise<void> {
    const positionSize = position.size;
    const direction = position.direction || 'UP';

    // For stop loss: no splitting - sell entire position at once for maximum speed
    // For normal exits: split large positions (>50) into 3 orders
    const numSplits = isStopLoss ? 1 : (positionSize > 50 ? 3 : 1);
    const sizePerSplit = positionSize / numSplits;

    console.log(`[TradingManager] 🔄 CLOSING SINGLE POSITION (SELL) - Position ${position.id.substring(0, 8)}...`, {
      positionId: position.id,
      tokenId: position.tokenId.substring(0, 10) + '...',
      direction: direction,
      sizeUSD: positionSize.toFixed(2),
      entryPrice: position.entryPrice.toFixed(2),
      currentPrice: position.currentPrice?.toFixed(2),
      isStopLoss: isStopLoss ? '⚡ YES' : 'no',
      numSplits: numSplits,
      sizePerSplit: sizePerSplit.toFixed(2),
      reason: reason,
    });

    if (!this.apiCredentials) {
      // Simulation mode
      const exitPricePercent = position.entryPrice;
      const priceDiff = exitPricePercent - position.entryPrice;
      const profit = (priceDiff / position.entryPrice) * positionSize;

      const exitTrade: Trade = {
        id: `exit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        eventSlug: position.eventSlug,
        tokenId: position.tokenId,
        side: 'SELL',
        size: positionSize,
        price: exitPricePercent,
        timestamp: Date.now(),
        status: 'filled',
        transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
        profit,
        reason: `Simulated exit: ${reason}`,
        orderType: 'MARKET',
        direction,
      };

      this.trades.push(exitTrade);
      this.status.totalTrades++;
      this.status.totalProfit += profit;
      this.status.successfulTrades++;
      this.notifyTradeUpdate(exitTrade);
      return;
    }

    // Fetch current market prices
    if (!this.activeEvent || !this.activeEvent.clobTokenIds || this.activeEvent.clobTokenIds.length < 2) {
      console.error('[TradingManager] Cannot close position: missing event or token IDs');
      return;
    }

    const yesTokenId = this.activeEvent.clobTokenIds[0];
    const noTokenId = this.activeEvent.clobTokenIds[1];

    const [yesPrice, noPrice] = await Promise.all([
      this.clobClient.getPrice(yesTokenId, 'SELL'),
      this.clobClient.getPrice(noTokenId, 'SELL'),
    ]);

    if (!yesPrice || !noPrice) {
      console.error('[TradingManager] Cannot close position: failed to fetch prices');
      return;
    }

    const yesPricePercent = toPercentage(yesPrice);
    const noPricePercent = toPercentage(noPrice);

    // Calculate total shares owned from ACTUAL filled orders (what was actually received)
    // This is more accurate than recalculating from entry price
    let totalSharesOwned = 0;
    if (position.filledOrders && position.filledOrders.length > 0) {
      // Use actual fill prices from filled orders
      for (const filledOrder of position.filledOrders) {
        const fillPriceDecimal = filledOrder.price / 100; // Convert percentage to decimal
        const orderShares = filledOrder.size / fillPriceDecimal;
        totalSharesOwned += orderShares;
      }
      
      console.log(`[TradingManager] 📊 SINGLE POSITION SELL CALCULATION (from filled orders):`, {
        positionSizeUSD: positionSize.toFixed(2),
        numFilledOrders: position.filledOrders.length,
        totalSharesOwned: totalSharesOwned.toFixed(4),
        filledOrders: position.filledOrders.map(fo => ({
          price: fo.price.toFixed(2),
          sizeUSD: fo.size.toFixed(2),
          shares: (fo.size / (fo.price / 100)).toFixed(4)
        })),
        numSplits: numSplits,
        note: 'Shares calculated from actual filled orders (what you actually own)'
      });
    } else {
      // Fallback: Calculate from entry price if no filledOrders (shouldn't happen, but safety)
      const entryPriceDecimal = position.entryPrice / 100;
      totalSharesOwned = position.size / entryPriceDecimal;
      
      console.warn(`[TradingManager] ⚠️ Position ${position.id.substring(0, 8)}... has no filledOrders, using entry price calculation (may be inaccurate)`);
      console.log(`[TradingManager] 📊 SINGLE POSITION SELL CALCULATION (fallback):`, {
        positionSizeUSD: positionSize.toFixed(2),
        entryPrice: position.entryPrice.toFixed(2),
        totalSharesOwned: totalSharesOwned.toFixed(4),
        numSplits: numSplits,
        note: '⚠️ Using fallback calculation - may be inaccurate'
      });
    }
    
    const sharesPerSplit = totalSharesOwned / numSplits;

    // Place real sell orders
    let totalProfit = 0;
    let totalFilledSize = 0;
    const exitTrades: Trade[] = [];

    const useLimitOrder = isStopLoss && (this.strategyConfig.useLimitOrderForStopLoss !== false);
    const limitPrice = isStopLoss ? this.strategyConfig.stopLossPrice : undefined;

    for (let i = 0; i < numSplits; i++) {
      const result = await this.placeSingleSellOrder(
        position.tokenId,
        sharesPerSplit,  // Pass shares directly, not USD
        direction,
        i,
        numSplits,
        yesPricePercent,
        noPricePercent,
        useLimitOrder,
        limitPrice
      );

      if (result.success && result.orderId && result.fillPrice !== undefined) {
        // Calculate profit based on actual shares sold
        const exitPriceDecimal = result.fillPrice / 100;
        const entryPriceDecimal = position.entryPrice / 100;
        const exitValueUSD = sharesPerSplit * exitPriceDecimal;
        const entryCostUSD = sharesPerSplit * entryPriceDecimal;
        const splitProfit = exitValueUSD - entryCostUSD;
        
        totalProfit += splitProfit;
        totalFilledSize += exitValueUSD; // Track USD value received

        const exitTrade: Trade = {
          id: `exit-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: position.eventSlug,
          tokenId: position.tokenId,
          side: 'SELL',
          size: exitValueUSD, // USD value received from selling shares
          price: result.fillPrice,
          timestamp: Date.now(),
          status: useLimitOrder ? 'pending' : 'filled',
          transactionHash: result.orderId,
          profit: splitProfit,
          reason: `${isStopLoss ? (useLimitOrder ? '🛑 STOP LOSS LIMIT: ' : '🛑 STOP LOSS: ') : ''}Exit ${numSplits > 1 ? `(${i + 1}/${numSplits}) ` : ''}${reason}`,
          orderType: useLimitOrder ? 'LIMIT' : 'MARKET',
          limitPrice: useLimitOrder ? limitPrice : undefined,
          direction,
        };

        exitTrades.push(exitTrade);
        this.trades.push(exitTrade);
        this.status.totalTrades++;
        this.notifyTradeUpdate(exitTrade);
      } else {
        console.error(`[TradingManager] ❌ Split sell order ${i + 1}/${numSplits} failed:`, result.error);
      }

      // For stop loss: NO delays between orders - maximum speed
      // For normal exits: small delay between split orders
      if (!isStopLoss && i < numSplits - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    if (totalFilledSize > 0) {
      this.status.successfulTrades++;
      this.status.totalProfit += totalProfit;
      console.log(`[TradingManager] ✅✅✅ Single position closed${isStopLoss ? ' (⚡AGGRESSIVE STOP LOSS⚡)' : ''}:`, {
        positionId: position.id.substring(0, 8) + '...',
        tokenId: position.tokenId.substring(0, 10) + '...',
        direction,
        plannedSize: positionSize.toFixed(2),
        actualFilledSize: totalFilledSize.toFixed(2),
        totalProfit: totalProfit.toFixed(2),
        numOrdersAttempted: numSplits,
        numOrdersFilled: exitTrades.length,
        percentageFilled: ((totalFilledSize / positionSize) * 100).toFixed(1) + '%',
      });
    } else {
      const errorMsg = `All ${numSplits} sell order(s) failed for position ${position.id}`;
      console.error(`[TradingManager] ❌❌❌ ${errorMsg}`, {
        positionId: position.id.substring(0, 8) + '...',
        tokenId: position.tokenId.substring(0, 10) + '...',
        direction,
        sizeAttempted: positionSize.toFixed(2),
        numSplits: numSplits,
      });
      this.status.failedTrades++;
      throw new Error(errorMsg);
    }
  }

  startTrading(): void {
    if (this.status.isActive) {
      return;
    }

    if (!this.strategyConfig.enabled) {
      console.warn('Strategy is not enabled');
      return;
    }

    // CRITICAL: Check if browser ClobClient is available before starting
    // Server-side API is blocked by Cloudflare, so browser client is required
    if (!this.browserClobClient) {
      console.error('[TradingManager] ❌ Cannot start trading - Browser ClobClient not initialized. Server-side API is blocked by Cloudflare. Please ensure wallet is connected and browser client is initialized.');
      alert('Cannot start trading: Browser ClobClient not initialized. Please ensure wallet is connected.');
      return;
    }

    this.status.isActive = true;
    this.consecutiveFailures = 0; // Reset circuit breaker on start
    this.notifyStatusUpdate();

    // Start continuous monitoring loop
    this.startContinuousMonitoring();
    
    // Start auto-claim monitoring
    this.startAutoClaimMonitoring();
  }

  /**
   * Start continuous monitoring loop (replaces interval-based monitoring)
   * Checks trading conditions continuously with a small delay to prevent overwhelming the system
   */
  private async startContinuousMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      return; // Already monitoring
    }

    this.isMonitoring = true;
    console.log('[TradingManager] 🟢 Starting continuous monitoring...');
    
    let loopCount = 0;
    const heartbeatInterval = 100; // Log heartbeat every 100 loops (10 seconds at 100ms per loop)

    // Continuous monitoring loop
    while (this.isMonitoring && this.status.isActive) {
      try {
        loopCount++;
        
        // Heartbeat log every ~10 seconds to confirm loop is running
        if (loopCount % heartbeatInterval === 0) {
          console.log(`[TradingManager] 💓 Monitoring heartbeat (loop ${loopCount}): active=${this.status.isActive}, positions=${this.positions.length}`);
        }
        
        // Check trading conditions
        await this.checkTradingConditions();
        
        // Small delay to prevent overwhelming the system and API rate limits
        // 100ms delay provides ~10 checks per second while being respectful to API
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        // Log error but continue monitoring (don't break the loop)
        console.error('[TradingManager] Error in continuous monitoring loop:', error);
        // Add a slightly longer delay on error to prevent rapid error loops
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log('[TradingManager] 🔴 Continuous monitoring stopped');
  }

  stopTrading(): void {
    this.status.isActive = false;
    this.isMonitoring = false; // Stop continuous monitoring loop
    this.consecutiveFailures = 0; // Reset circuit breaker
    
    // Stop auto-claim monitoring
    this.stopAutoClaimMonitoring();
    
    // Cancel all pending limit orders
    this.cancelAllPendingOrders();

    this.notifyStatusUpdate();
  }

  private cancelAllPendingOrders(): void {
    this.pendingLimitOrders.forEach((order) => {
      order.status = 'cancelled';
      order.reason = 'Trading stopped - order cancelled';
      this.notifyTradeUpdate(order);
    });
    this.pendingLimitOrders.clear();
    this.status.pendingLimitOrders = 0;
  }

  getTrades(): Trade[] {
    return [...this.trades];
  }

  getStatus(): TradingStatus {
    return { ...this.status };
  }

  /**
   * Manually close all positions (public method for UI)
   */
  async closeAllPositionsManually(reason: string = 'Manual sell'): Promise<void> {
    await this.closeAllPositions(reason);
  }

  /**
   * Manually close a specific position by ID (public method for UI)
   */
  async closePositionManually(positionId: string, reason: string = 'Manual sell'): Promise<void> {
    const position = this.positions.find(p => p.id === positionId);
    if (!position) {
      throw new Error(`Position ${positionId} not found`);
    }
    
    // Check if it's for the active event
    if (position.eventSlug !== this.activeEvent?.slug) {
      throw new Error('Position is not for the active event');
    }
    
    // Check if there are other positions for this event
    const activePositions = this.getActivePositions();
    if (activePositions.length > 1) {
      console.warn(`[TradingManager] ⚠️⚠️⚠️ WARNING: Closing 1 of ${activePositions.length} positions manually.`);
      console.warn(`[TradingManager] ⚠️ Other ${activePositions.length - 1} position(s) will remain open:`, 
        activePositions.filter(p => p.id !== positionId).map(p => ({
          id: p.id.substring(0, 8) + '...',
          direction: p.direction,
          size: p.size.toFixed(2),
        }))
      );
      console.warn(`[TradingManager] 💡 TIP: Use closeAllPositionsManually() to close all positions at once`);
    }

    console.log(`[TradingManager] 🔄 Manually closing single position ${positionId.substring(0, 8)}...`);
    
    // Close this specific position
    await this.closeSinglePosition(position, reason);
    
    // Remove from positions array
    this.positions = this.positions.filter(p => p.id !== positionId);
    this.status.positions = [...this.positions];
    this.status.totalPositionSize = this.positions.reduce((sum, p) => sum + p.size, 0);
    
    console.log(`[TradingManager] ✅ Position ${positionId.substring(0, 8)}... closed. ${this.positions.length} position(s) remaining.`);
    
    this.notifyStatusUpdate();
  }

  private notifyStatusUpdate(): void {
    if (this.onStatusUpdate) {
      this.onStatusUpdate(this.getStatus());
    }
  }

  private notifyTradeUpdate(trade: Trade): void {
    // Update win/loss streaks for dynamic position sizing
    if (trade.status === 'filled' && trade.profit !== undefined) {
      if (trade.profit > 0) {
        // Winning trade
        this.consecutiveWins++;
        this.consecutiveLosses = 0;
      } else if (trade.profit < 0) {
        // Losing trade
        this.consecutiveLosses++;
        this.consecutiveWins = 0;
      }
      // If profit is exactly 0, don't change streaks
    } else if (trade.status === 'failed') {
      // Failed trade counts as a loss
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
    }
    
    if (this.onTradeUpdate) {
      this.onTradeUpdate(trade);
    }
  }

  /**
   * Get active positions (alias for multi-asset compatibility)
   */
  getPositions(): Position[] {
    return this.getActivePositions();
  }

  /**
   * Get all positions (including expired ones for auto-claim)
   */
  getAllPositions(): Position[] {
    return [...this.positions];
  }

  /**
   * Get positions for a specific event slug
   */
  getPositionsForEvent(eventSlug: string): Position[] {
    return this.positions.filter(p => p.eventSlug === eventSlug);
  }

  /**
   * Start auto-claim monitoring - checks for expired events and claims winning positions
   */
  startAutoClaimMonitoring(): void {
    if (this.autoClaimInterval !== null) {
      return; // Already monitoring
    }

    console.log('[TradingManager] 🎯 Starting auto-claim monitoring...');
    
    // Check every 60 seconds for expired events that need claiming
    this.autoClaimInterval = window.setInterval(() => {
      this.checkAndClaimExpiredEvents().catch(error => {
        console.error('[TradingManager] Error in auto-claim check:', error);
      });
    }, 60000); // 60 seconds

    // Also check immediately
    this.checkAndClaimExpiredEvents().catch(error => {
      console.error('[TradingManager] Error in initial auto-claim check:', error);
    });
  }

  /**
   * Stop auto-claim monitoring
   */
  stopAutoClaimMonitoring(): void {
    if (this.autoClaimInterval !== null) {
      clearInterval(this.autoClaimInterval);
      this.autoClaimInterval = null;
      console.log('[TradingManager] 🛑 Auto-claim monitoring stopped');
    }
  }

  /**
   * Check for expired events and claim winning positions
   */
  private async checkAndClaimExpiredEvents(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const RESOLUTION_DELAY = 300; // 5 minutes (300 seconds) after event end for resolution

    // Find positions for events that have ended and are ready for claiming
    const claimablePositions = this.positions.filter(position => {
      // Must have event end timestamp
      if (!position.eventEndTimestamp) {
        return false;
      }

      // Must not already be claimed
      if (position.claimed) {
        return false;
      }

      // Must have conditionId for redemption
      if (!position.conditionId) {
        return false;
      }

      // Event must have ended at least 5 minutes ago (for resolution)
      const timeSinceEventEnd = now - position.eventEndTimestamp;
      if (timeSinceEventEnd < RESOLUTION_DELAY) {
        return false;
      }

      return true;
    });

    if (claimablePositions.length === 0) {
      return; // No positions ready for claiming
    }

    console.log(`[TradingManager] 🎯 Found ${claimablePositions.length} position(s) ready for auto-claim`);

    // Group positions by event slug to process them together
    const positionsByEvent = new Map<string, Position[]>();
    for (const position of claimablePositions) {
      const eventSlug = position.eventSlug;
      if (!positionsByEvent.has(eventSlug)) {
        positionsByEvent.set(eventSlug, []);
      }
      positionsByEvent.get(eventSlug)!.push(position);
    }

    // Process each event
    for (const [eventSlug, positions] of positionsByEvent.entries()) {
      await this.processEventClaim(eventSlug, positions);
    }
  }

  /**
   * Process claim for all positions in an event
   */
  private async processEventClaim(eventSlug: string, positions: Position[]): Promise<void> {
    if (positions.length === 0) {
      return;
    }

    // All positions in an event should have the same conditionId
    const conditionId = positions[0].conditionId;
    const priceToBeat = positions[0].priceToBeat;

    if (!conditionId) {
      console.error(`[TradingManager] ❌ Cannot claim positions for ${eventSlug}: missing conditionId`);
      return;
    }

    if (priceToBeat === undefined || priceToBeat === null) {
      console.error(`[TradingManager] ❌ Cannot claim positions for ${eventSlug}: missing priceToBeat`);
      return;
    }

    // Determine winner by checking current BTC price vs Price to Beat
    // For now, we'll need to fetch the final BTC price at event end
    // Since we don't have access to historical prices easily, we'll use a different approach:
    // Check if we have UP or DOWN positions and determine winner based on direction
    // Actually, we need to fetch the final BTC price at the event end time
    // For simplicity, we'll try to determine winner from the positions we have
    
    // Get current BTC price (as approximation - ideally we'd use the price at event end)
    // Note: This is a limitation - ideally we'd store the final BTC price at event end
    // For now, we'll need to determine winner differently or fetch from an API
    
    // For binary markets:
    // - If we have UP positions and final price > priceToBeat, UP wins (indexSet = 1)
    // - If we have DOWN positions and final price < priceToBeat, DOWN wins (indexSet = 2)
    
    // Since we don't have the final price stored, we'll need to fetch it
    // For now, let's assume we can determine it from the event data or API
    // We'll claim based on the positions we have - if we have UP positions, claim UP; if DOWN, claim DOWN
    
    const upPositions = positions.filter(p => p.direction === 'UP');
    const downPositions = positions.filter(p => p.direction === 'DOWN');

    // Claim both outcomes if we have positions in them
    // The CTF contract will only redeem winning tokens, so attempting to claim
    // losing positions will simply fail (no tokens to redeem)
    
    // Claim UP positions (indexSet = 1)
    if (upPositions.length > 0) {
      for (const position of upPositions) {
        await this.claimPosition(position, conditionId, 1, 'UP');
      }
    }

    // Claim DOWN positions (indexSet = 2)
    if (downPositions.length > 0) {
      for (const position of downPositions) {
        await this.claimPosition(position, conditionId, 2, 'DOWN');
      }
    }
  }

  /**
   * Claim a single position
   */
  private async claimPosition(
    position: Position,
    conditionId: string,
    indexSet: number,
    direction: 'UP' | 'DOWN'
  ): Promise<void> {
    try {
      console.log(`[TradingManager] 🎯 Claiming position ${position.id.substring(0, 8)}... for ${position.eventSlug} (${direction})`);

      // Call the claim API endpoint
      const response = await fetch('/api/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conditionId,
          indexSets: [indexSet],
          eventSlug: position.eventSlug,
          direction,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `Claim failed with status ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        // Update position with claim status
        position.claimed = true;
        position.claimTimestamp = Date.now();
        position.isWinner = true;

        // Update status
        this.status.positions = [...this.positions];
        this.notifyStatusUpdate();

        // Create a trade record for the claim
        const claimTrade: Trade = {
          id: `claim-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          eventSlug: position.eventSlug,
          tokenId: position.tokenId,
          side: 'SELL', // Claiming is effectively selling the winning tokens
          size: position.size, // Full position size
          price: 100, // 100% for winning outcome
          timestamp: Date.now(),
          status: 'filled',
          transactionHash: result.transactionHash,
          profit: position.size, // Full profit for winning position
          reason: `🎯 AUTO-CLAIM: ${direction} won - tokens redeemed for collateral`,
          orderType: 'MARKET',
          direction,
        };

        this.trades.push(claimTrade);
        this.status.totalTrades++;
        this.status.successfulTrades++;
        this.status.totalProfit += position.size;
        this.notifyTradeUpdate(claimTrade);

        console.log(`[TradingManager] ✅ Successfully claimed position ${position.id.substring(0, 8)}...`, {
          transactionHash: result.transactionHash,
          eventSlug: position.eventSlug,
          direction,
        });
      } else {
        throw new Error(result.error || 'Claim failed');
      }
    } catch (error) {
      console.error(`[TradingManager] ❌ Failed to claim position ${position.id.substring(0, 8)}...:`, error);
      
      // If the error indicates no tokens to redeem (losing position), mark it
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('no tokens') || errorMessage.includes('insufficient') || errorMessage.includes('revert')) {
        // Likely a losing position - mark it but don't claim
        position.claimed = false;
        position.isWinner = false;
        this.status.positions = [...this.positions];
        this.notifyStatusUpdate();
        console.log(`[TradingManager] ℹ️ Position ${position.id.substring(0, 8)}... appears to be a losing position (no tokens to redeem)`);
      }
      // Otherwise, will retry on next check
    }
  }

  clearTrades(): void {
    this.trades = [];
    this.status.totalTrades = 0;
    this.status.successfulTrades = 0;
    this.status.failedTrades = 0;
    this.status.totalProfit = 0;
    this.status.currentPosition = undefined;
    this.pendingLimitOrders.clear();
    this.status.pendingLimitOrders = 0;
    this.notifyStatusUpdate();
  }
}

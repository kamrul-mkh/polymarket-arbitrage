import { WebSocketClient } from './websocket-client';
import { MultiAssetEventManager } from './multi-asset-event-manager';
import { MultiAssetTradingManager } from './multi-asset-trading-manager';
import { predictNext15mCandle, type Next15mPrediction } from './external-candle-predictor';
import type { PriceUpdate, ConnectionStatus, AssetType } from './types';
import { ASSET_CONFIG } from './types';

/**
 * Multi-Asset Streaming Platform
 * Manages BTC, ETH, SOL, and XRP trading bots in one unified interface
 * Uses tabbed UI to switch between assets
 */
export class MultiAssetStreamingPlatform {
  private wsClient: WebSocketClient;
  private eventManager: MultiAssetEventManager;
  private tradingManager: MultiAssetTradingManager;
  private currentAsset: AssetType = 'btc'; // Currently selected asset tab
  private assetPrices: Map<AssetType, number | null> = new Map();
  private assetPriceHistory: Map<AssetType, Array<{ timestamp: number; value: number }>> = new Map();
  private maxHistorySize = 100;
  private currentStatus: ConnectionStatus = {
    connected: false,
    source: null,
    lastUpdate: null,
    error: null
  };
  private eventPriceToBeat: Map<string, number> = new Map(); // Map of event slug to price to beat
  private eventLastPrice: Map<string, number> = new Map(); // Map of event slug to last price
  private assetUpPrices: Map<AssetType, number | null> = new Map(); // Current UP token prices per asset
  private assetDownPrices: Map<AssetType, number | null> = new Map(); // Current DOWN token prices per asset
  private priceUpdateInterval: number | null = null;
  private countdownInterval: number | null = null;
  private readonly NEXT15M_REFRESH_MS = 60000; // 1 min

  // Wallet connection state (shared across all assets)
  private walletState: {
    eoaAddress: string | null;
    proxyAddress: string | null;
    isConnected: boolean;
    isLoading: boolean;
    error: string | null;
    balance: number | null;
    balanceLoading: boolean;
    apiCredentials: { key: string; secret: string; passphrase: string } | null;
  } = {
    eoaAddress: null,
    proxyAddress: null,
    isConnected: false,
    isLoading: false,
    error: null,
    balance: null,
    balanceLoading: false,
    apiCredentials: null,
  };

  // Session initialization state (per asset)
  private assetSessions: Map<AssetType, { isInitialized: boolean; isLoading: boolean; error: string | null }> = new Map();

  constructor() {
    this.wsClient = new WebSocketClient();
    this.eventManager = new MultiAssetEventManager();
    this.tradingManager = new MultiAssetTradingManager();
    
    // Setup trend signal callback for UI updates
    this.setupTrendSignalUpdates();
    
    // Initialize price maps and session state for all assets (BTC only for now)
    const assets: AssetType[] = ['btc'];
    for (const asset of assets) {
      this.assetPrices.set(asset, null);
      this.assetPriceHistory.set(asset, []);
      this.assetUpPrices.set(asset, null);
      this.assetDownPrices.set(asset, null);
      this.assetSessions.set(asset, {
        isInitialized: false,
        isLoading: false,
        error: null
      });
    }

    this.eventManager.setOnEventsUpdated(() => {
      this.renderEventsTable();
    });

    this.wsClient.setCallbacks(
      this.handlePriceUpdate.bind(this),
      this.handleStatusChange.bind(this)
    );

    this.tradingManager.setOnStatusUpdate((asset, _status) => {
      if (asset === this.currentAsset) {
        this.renderTradingSection();
      }
    });

    this.tradingManager.setOnTradeUpdate((asset, trade) => {
      if (asset === this.currentAsset) {
        this.renderTradingSection();
        if (trade.side === 'BUY' && trade.status === 'filled') {
          console.log(`[Orders] ${asset.toUpperCase()} Buy order filled, fetching order details...`);
          this.fetchAndDisplayOrders();
        }
      }
    });

    // Load strategy configs for all assets
    for (const asset of assets) {
      this.tradingManager.getManager(asset)?.loadStrategyConfig();
    }
  }

  async initialize(): Promise<void> {
    try {
      console.log('Initializing MultiAssetStreamingPlatform...');
      this.render();
      this.setupEventListeners();
      this.renderWalletSection();
      console.log('Loading events for all assets...');
      await this.eventManager.loadAllEvents(10);
      this.eventManager.startAutoRefreshAll(60000);
      this.renderTradingSection();
      this.startPriceUpdates();
      // Initialize trend prediction and prediction/outcome display
      const manager = this.tradingManager.getManager(this.currentAsset);
      if (manager) {
        const signal = manager.getCurrentTrendSignal?.();
        this.renderTrendPrediction(signal || null);
        this.renderPredictionOutcome();
      }
      await this.fetchNext15mPrediction();
      window.setInterval(() => this.fetchNext15mPrediction(), this.NEXT15M_REFRESH_MS);
      console.log('MultiAssetStreamingPlatform initialized successfully');
    } catch (error) {
      console.error('Error initializing MultiAssetStreamingPlatform:', error);
      throw error;
    }
  }

  private handlePriceUpdate(update: PriceUpdate): void {
    const symbol = update.payload.symbol.toLowerCase();
    
    // Determine which asset this price update is for
    let asset: AssetType | null = null;
    for (const [assetType, config] of Object.entries(ASSET_CONFIG)) {
      if (config.symbol.toLowerCase() === symbol) {
        asset = assetType as AssetType;
        break;
      }
    }

    if (!asset) {
      console.warn(`Unknown price symbol: ${symbol}`);
      return;
    }

    // Update price for this asset
    const price = update.payload.value;
    this.assetPrices.set(asset, price);
    
    const history = this.assetPriceHistory.get(asset) || [];
    history.push({
      timestamp: update.payload.timestamp,
      value: price
    });

    if (history.length > this.maxHistorySize) {
      history.shift();
    }
    this.assetPriceHistory.set(asset, history);

    // Update price display if this is the current asset
    if (asset === this.currentAsset) {
      this.updatePriceDisplay();
      this.capturePriceForActiveEvent(asset);
      this.capturePriceForExpiredEvent(asset);
      this.updateTradingManager(asset);
    }
  }

  private handleStatusChange(status: ConnectionStatus): void {
    this.currentStatus = status;
    this.updateConnectionStatus();
  }

  private capturePriceForActiveEvent(asset: AssetType): void {
    const price = this.assetPrices.get(asset);
    if (price == null) return;

    const events = this.eventManager.getEvents(asset);
    const activeEvent = events.find(e => e.status === 'active');
    
    if (activeEvent) {
      if (!this.eventPriceToBeat.has(activeEvent.slug)) {
        const activeEventIndex = events.findIndex(e => e.slug === activeEvent.slug);
        let priceToBeat: number | null = null;

        if (activeEventIndex > 0) {
          const previousEvent = events[activeEventIndex - 1];
          const lastPrice = this.eventLastPrice.get(previousEvent.slug);
          if (lastPrice !== undefined) {
            priceToBeat = lastPrice;
          }
        }

        if (priceToBeat === null) {
          priceToBeat = price;
        }

        if (priceToBeat != null) {
          this.eventPriceToBeat.set(activeEvent.slug, priceToBeat);
        }
        this.renderActiveEvent();
      }
    }
  }

  private capturePriceForExpiredEvent(asset: AssetType): void {
    const price = this.assetPrices.get(asset);
    if (price == null) return;

    const events = this.eventManager.getEvents(asset);
    
    events.forEach((event, index) => {
      if (index > 0) {
        const previousEvent = events[index - 1];
        
        if (previousEvent.status === 'expired' && !this.eventLastPrice.has(event.slug)) {
          this.eventLastPrice.set(event.slug, price);
          
          if (event.status === 'active' && !this.eventPriceToBeat.has(event.slug)) {
            this.eventPriceToBeat.set(event.slug, price);
          }
          
          if (asset === this.currentAsset) {
            this.renderEventsTable();
            this.renderActiveEvent();
          }
        }
      }
    });
  }

  private updateTradingManager(asset: AssetType): void {
    const events = this.eventManager.getEvents(asset);
    const activeEvent = events.find(e => e.status === 'active');
    const priceToBeat = activeEvent ? this.eventPriceToBeat.get(activeEvent.slug) : null;
    const currentPrice = this.assetPrices.get(asset) || null;
    const upPrice = this.assetUpPrices.get(asset);
    const downPrice = this.assetDownPrices.get(asset);

    // Update market data - includes UP/DOWN prices for trend prediction
    this.tradingManager.updateMarketData(
      asset,
      currentPrice,
      priceToBeat || null,
      activeEvent || null,
      upPrice !== null ? upPrice : undefined,
      downPrice !== null ? downPrice : undefined
    );
  }

  private setupTrendSignalUpdates(): void {
    // Set up trend signal callback for all assets
    const assets: AssetType[] = ['btc'];
    for (const asset of assets) {
      const manager = this.tradingManager.getManager(asset);
      if (manager) {
        manager.setOnTrendSignalUpdate((signal: any) => {
          if (asset === this.currentAsset) {
            this.renderTrendPrediction(signal);
            this.renderPredictionOutcome();
          }
        });
      }
    }
    
    // Also update when asset changes
    const originalSwitchAsset = this.switchAsset.bind(this);
    this.switchAsset = (asset: AssetType) => {
      originalSwitchAsset(asset);
      // Re-render trend prediction, prediction/outcome, and next 15m for new asset
      const manager = this.tradingManager.getManager(asset);
      if (manager) {
        const signal = manager.getCurrentTrendSignal?.();
        this.renderTrendPrediction(signal || null);
        this.renderPredictionOutcome();
      }
      this.fetchNext15mPrediction();
    };
  }

  private renderTrendPrediction(signal: any): void {
    const container = document.getElementById('trend-prediction-content');
    if (!container) return;

    if (!signal) {
      container.innerHTML = `
        <div class="trend-prediction-empty">
          <p>Collecting price data... (Need 10+ data points for analysis)</p>
        </div>
      `;
      return;
    }

    const confidenceColor = signal.confidence >= 80 ? '#10b981' : signal.confidence >= 60 ? '#f59e0b' : '#6b7280';
    const directionColor = signal.direction === 'UP' ? '#10b981' : signal.direction === 'DOWN' ? '#ef4444' : '#6b7280';
    const directionIcon = signal.direction === 'UP' ? '📈' : signal.direction === 'DOWN' ? '📉' : '➡️';

    // Format indicators
    const formatIndicator = (value: number | undefined, label: string, isRSI: boolean = false): string => {
      if (value === undefined) return '';
      let displayValue: string;
      let color: string;
      
      if (isRSI) {
        // RSI is already 0-100, show as-is
        displayValue = value.toFixed(1);
        color = value > 70 ? '#10b981' : value < 30 ? '#ef4444' : '#6b7280';
      } else {
        // Other indicators are -1 to 1, show as percentage
        color = value > 0 ? '#10b981' : value < 0 ? '#ef4444' : '#6b7280';
        const sign = value > 0 ? '+' : '';
        displayValue = `${sign}${(value * 100).toFixed(1)}%`;
      }
      
      return `
        <div class="indicator-item">
          <span class="indicator-label">${label}:</span>
          <span class="indicator-value" style="color: ${color}">${displayValue}</span>
        </div>
      `;
    };

    container.innerHTML = `
      <div class="trend-prediction-card">
        <div class="trend-prediction-main">
          <div class="trend-direction" style="border-left: 4px solid ${directionColor}">
            <div class="trend-direction-header">
              <span class="trend-icon">${directionIcon}</span>
              <span class="trend-label">Predicted Direction: <strong style="color: ${directionColor}">${signal.direction || 'NEUTRAL'}</strong></span>
            </div>
            <div class="trend-metrics">
              <div class="metric">
                <span class="metric-label">Confidence:</span>
                <span class="metric-value" style="color: ${confidenceColor}">${signal.confidence.toFixed(1)}%</span>
              </div>
              <div class="metric">
                <span class="metric-label">Predicted Probability:</span>
                <span class="metric-value" style="color: ${directionColor}">${signal.probability.toFixed(1)}%</span>
              </div>
            </div>
          </div>
          <div class="trend-reason">
            <strong>Analysis:</strong> ${signal.reason || 'No clear signals detected'}
          </div>
          ${signal.shortTerm15Min ? `
          <div class="trend-15min" style="margin-top: 12px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 6px; border-left: 4px solid ${signal.shortTerm15Min.direction === 'UP' ? '#10b981' : signal.shortTerm15Min.direction === 'DOWN' ? '#ef4444' : '#6b7280'}">
            <h4 style="margin: 0 0 8px 0; font-size: 0.95em;">15-min outlook (candles + MA)</h4>
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
              <span style="font-weight: 600; color: ${signal.shortTerm15Min.direction === 'UP' ? '#10b981' : signal.shortTerm15Min.direction === 'DOWN' ? '#ef4444' : '#9ca3af'}">${signal.shortTerm15Min.direction || 'NEUTRAL'}</span>
              <span style="color: #9ca3af; font-size: 0.9em;">${signal.shortTerm15Min.confidence.toFixed(0)}% confidence</span>
            </div>
            <div style="font-size: 0.85em; color: #9ca3af;">${signal.shortTerm15Min.reason}</div>
            <div style="font-size: 0.8em; color: #6b7280; margin-top: 6px;">MA(5): $${signal.shortTerm15Min.maShort.toFixed(2)} · MA(${signal.shortTerm15Min.candlesUsed >= 10 ? '10' : signal.shortTerm15Min.candlesUsed}): $${signal.shortTerm15Min.maLong.toFixed(2)} · ${signal.shortTerm15Min.candlesUsed} candles</div>
          </div>
          ` : ''}
        </div>
        <div class="trend-indicators">
          <h4>Technical Indicators:</h4>
          <div class="indicators-grid">
            ${formatIndicator(signal.indicators.momentum, 'Momentum')}
            ${formatIndicator(signal.indicators.rsi, 'RSI', true)}
            ${formatIndicator(signal.indicators.priceDivergence, 'Price Divergence')}
            ${formatIndicator(signal.indicators.movingAverage, 'Moving Average')}
            ${formatIndicator(signal.indicators.volumeSignal, 'Volume Signal')}
          </div>
          ${signal.confidence >= 80 ? `
            <div class="high-confidence-alert" style="background: #10b98120; border: 1px solid #10b981; padding: 10px; border-radius: 4px; margin-top: 10px;">
              <strong>🎯 High Confidence Signal (${signal.confidence.toFixed(0)}%)</strong>
              <p style="margin: 5px 0 0 0; font-size: 0.9em;">Strong trend detected - Early entry opportunity at ${signal.probability.toFixed(1)}% probability</p>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  private renderPredictionOutcome(): void {
    const container = document.getElementById('prediction-outcome-content');
    if (!container) return;

    const records = this.tradingManager.getPredictionOutcomeRecords(this.currentAsset);
    if (records.length === 0) {
      container.innerHTML = `
        <div class="prediction-outcome-empty">
          <p>Per-event: predicted at 8 min vs outcome at 15 min. Records appear as events reach those times.</p>
        </div>
      `;
      return;
    }

    const rows = records.map((r) => {
      const pred = r.predictedAt8Min;
      const outcome = r.outcomeAt15Min;
      const predDir = pred?.direction ?? '--';
      const predConf = pred != null ? `${pred.confidence.toFixed(0)}%` : '--';
      const outcomeDir = outcome?.direction ?? '--';
      const outcomePrices = outcome != null ? `Y ${outcome.yesPrice.toFixed(1)} / N ${outcome.noPrice.toFixed(1)}` : '--';
      const match = r.correct === true ? '✓' : r.correct === false ? '✗' : '--';
      const matchColor = r.correct === true ? '#10b981' : r.correct === false ? '#ef4444' : '#6b7280';
      const title = (r.eventTitle || r.eventSlug).length > 40 ? (r.eventTitle || r.eventSlug).slice(0, 40) + '…' : (r.eventTitle || r.eventSlug);
      return `
        <tr>
          <td class="cell-event" title="${r.eventSlug}">${title}</td>
          <td class="cell-pred"><span class="dir-badge dir-${(predDir || '').toLowerCase()}">${predDir}</span> ${predConf}</td>
          <td class="cell-outcome"><span class="dir-badge dir-${(outcomeDir || '').toLowerCase()}">${outcomeDir}</span> ${outcomePrices}</td>
          <td class="cell-match" style="color: ${matchColor}">${match}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <table class="data-table prediction-outcome-table">
        <thead>
          <tr>
            <th>Event</th>
            <th>Predicted (8 min)</th>
            <th>Outcome (15 min)</th>
            <th>Match</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  private async fetchNext15mPrediction(): Promise<void> {
    const container = document.getElementById('next15m-content');
    if (container) container.innerHTML = '<div class="next15m-loading">Loading Binance 15m + Chainlink...</div>';
    const previousOutcomes = this.tradingManager.getPredictionOutcomeRecords(this.currentAsset);
    const pred = await predictNext15mCandle(previousOutcomes);
    this.renderNext15mPrediction(pred);
  }

  private renderNext15mPrediction(pred: Next15mPrediction | null): void {
    const container = document.getElementById('next15m-content');
    if (!container) return;

    if (!pred) {
      container.innerHTML = '<div class="next15m-loading">No data</div>';
      return;
    }

    if (pred.error) {
      container.innerHTML = `
        <div class="next15m-error">
          <p>Error: ${pred.error}</p>
          <p>Check /api/market-data (type=klines, type=price) is available.</p>
        </div>
      `;
      return;
    }

    const dirColor = pred.direction === 'UP' ? '#10b981' : pred.direction === 'DOWN' ? '#ef4444' : '#6b7280';
    const dirLabel = pred.direction ?? 'NEUTRAL';
    container.innerHTML = `
      <div class="next15m-main" style="border-left: 4px solid ${dirColor}; padding-left: 10px;">
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
          <span style="font-weight: 700; font-size: 1.1em; color: ${dirColor}">${dirLabel}</span>
          <span style="color: #9ca3af;">${pred.confidence.toFixed(0)}% confidence</span>
        </div>
        <p style="font-size: 0.9em; color: #94a3b8; margin-bottom: 8px;">${pred.reason}</p>
        <div style="font-size: 0.8em; color: #6b7280;">
          MA(5): $${pred.maShort.toFixed(2)} · MA(${pred.maLong.toFixed(0)}): $${pred.maLong.toFixed(2)} · ${pred.sources.binanceCandles} Binance 15m candles · Price: ${pred.sources.priceSource} $${pred.sources.price.toFixed(2)}
          ${pred.sources.pastOutcomesUsed > 0 ? ` · ${pred.sources.pastOutcomesUsed} past outcomes used` : ''}
        </div>
      </div>
    `;
  }

  private setupEventListeners(): void {
    const connectBtn = document.getElementById('connect');
    const disconnectBtn = document.getElementById('disconnect');

    connectBtn?.addEventListener('click', () => {
      this.wsClient.connect();
    });

    disconnectBtn?.addEventListener('click', () => {
      this.wsClient.disconnect();
    });

    document.getElementById('next15m-refresh')?.addEventListener('click', () => {
      this.fetchNext15mPrediction();
    });

    // Asset tab switching (BTC only)
    const assets: AssetType[] = ['btc'];
    for (const asset of assets) {
      const tabBtn = document.getElementById(`asset-tab-${asset}`);
      tabBtn?.addEventListener('click', () => {
        this.switchAsset(asset);
      });
    }

    // Events section collapsible
    const eventsHeader = document.getElementById('events-section-header');
    const eventsContent = document.getElementById('events-section-content');
    const eventsChevron = document.getElementById('events-chevron');

    if (eventsHeader && eventsContent && eventsChevron) {
      eventsHeader.addEventListener('click', () => {
        const isCollapsed = eventsContent.classList.contains('collapsed');
        if (isCollapsed) {
          eventsContent.classList.remove('collapsed');
          eventsChevron.textContent = '▼';
        } else {
          eventsContent.classList.add('collapsed');
          eventsChevron.textContent = '▶';
        }
      });
    }

    // Wallet section collapsible
    const walletToggle = document.getElementById('wallet-section-toggle');
    const walletContent = document.getElementById('wallet-section-content');
    if (walletToggle && walletContent) {
      walletToggle.addEventListener('click', () => {
        walletContent.classList.toggle('collapsed');
        const chevron = walletToggle.querySelector('.chevron');
        if (chevron) {
          chevron.textContent = walletContent.classList.contains('collapsed') ? '▶' : '▼';
        }
      });
    }

    // Trading controls
    const startBtn = document.getElementById('start-trading');
    const stopBtn = document.getElementById('stop-trading');
    const saveConfigBtn = document.getElementById('save-strategy-config');

    startBtn?.addEventListener('click', async () => {
      await this.startTrading();
    });

    stopBtn?.addEventListener('click', () => {
      this.stopTrading();
    });

    saveConfigBtn?.addEventListener('click', () => {
      this.saveStrategyConfig();
    });

    // Wallet controls
    const connectWalletBtn = document.getElementById('connect-wallet');
    const disconnectWalletBtn = document.getElementById('disconnect-wallet');
    const initializeSessionBtn = document.getElementById('initialize-session');

    connectWalletBtn?.addEventListener('click', () => {
      this.connectWallet();
    });

    disconnectWalletBtn?.addEventListener('click', () => {
      this.disconnectWallet();
    });

    initializeSessionBtn?.addEventListener('click', () => {
      this.initializeTradingSession();
    });
  }

  private switchAsset(asset: AssetType): void {
    // Stop countdown for previous asset
    this.stopCountdown();
    
    this.currentAsset = asset;
    
    // Update trend prediction display for new asset
    const manager = this.tradingManager.getManager(asset);
    if (manager) {
      const signal = manager.getCurrentTrendSignal?.();
      this.renderTrendPrediction(signal || null);
    }
    
    // Update active tab styling (BTC only)
    const assets: AssetType[] = ['btc'];
    for (const a of assets) {
      const tab = document.getElementById(`asset-tab-${a}`);
      if (tab) {
        if (a === asset) {
          tab.classList.add('active');
        } else {
          tab.classList.remove('active');
        }
      }
    }

    // Update section headers to reflect current asset
    this.updateSectionHeaders();

    // Re-render all sections for the new asset
    this.updatePriceDisplay();
    this.renderEventsTable();
    this.renderActiveEvent();
    this.renderTradingSection();
    this.renderWalletSection();
    this.fetchAndDisplayOrders();
    
    // Restart price updates for new asset
    this.startPriceUpdates();
  }

  private updateSectionHeaders(): void {
    const eventsHeader = document.querySelector('.events-section .card-header h2');
    if (eventsHeader) {
      eventsHeader.textContent = `Events - ${ASSET_CONFIG[this.currentAsset].displayName}`;
    }

    const tradingSub = document.querySelector('.card-trading .card-sub');
    if (tradingSub) {
      tradingSub.textContent = ASSET_CONFIG[this.currentAsset].displayName;
    }

    const sessionSubtitle = document.querySelector('.section-subtitle');
    if (sessionSubtitle) {
      sessionSubtitle.textContent = `Session - ${ASSET_CONFIG[this.currentAsset].displayName}`;
    }
  }

  private render(): void {
    const app = document.getElementById('app');
    if (!app) {
      console.error('App element not found!');
      return;
    }

    app.innerHTML = `
      <div class="app-root">
        <!-- Top bar: brand, asset, connection, wallet, actions -->
        <header class="app-header">
          <div class="header-brand">
            <span class="logo-icon">◈</span>
            <div class="brand-text">
              <h1 class="app-title">Polymarket Bot</h1>
              <span class="app-subtitle">BTC 15m Up/Down</span>
            </div>
          </div>
          <div class="header-tabs">
            ${['btc'].map(asset => `
              <button id="asset-tab-${asset}" class="asset-tab ${asset === this.currentAsset ? 'active' : ''}">
                ${ASSET_CONFIG[asset as AssetType].displayName}
              </button>
            `).join('')}
          </div>
          <div class="header-status">
            <span id="connection-status" class="status-pill status-disconnected">Disconnected</span>
            <div id="error-message" class="header-error"></div>
          </div>
          <div class="header-actions">
            <button id="connect" class="btn btn-connect">Connect</button>
            <button id="disconnect" class="btn btn-disconnect">Disconnect</button>
          </div>
        </header>

        <!-- Price hero strip -->
        <section class="price-strip">
          <div class="price-strip-inner">
            <div class="price-main">
              <span class="price-label">${ASSET_CONFIG[this.currentAsset].displayName} Price</span>
              <span id="current-price" class="price-value">--</span>
            </div>
            <div class="price-meta">
              <span class="price-ts">Updated: <span id="price-timestamp">--</span></span>
              <span id="price-change" class="price-change">--</span>
            </div>
          </div>
        </section>

        <!-- Main trading grid -->
        <main class="main-grid">
          <!-- Left: Active event + Trend prediction -->
          <aside class="panel-left">
            <section class="card card-active-event" id="active-event-display">
              <div class="card-header">
                <h2>Active Event</h2>
              </div>
              <div class="card-body">
                <div class="active-event-empty">
                  <p>Loading events...</p>
                </div>
              </div>
            </section>
            <section class="card card-trend" id="trend-prediction-section">
              <div class="card-header">
                <h2>Trend Prediction</h2>
                <span class="card-badge">Simulation</span>
              </div>
              <div id="trend-prediction-content" class="card-body trend-prediction-content">
                <div class="trend-prediction-empty">
                  <p>Collecting price data...</p>
                </div>
              </div>
            </section>
            <section class="card card-prediction-outcome" id="prediction-outcome-section">
              <div class="card-header">
                <h2>Prediction vs Outcome</h2>
                <span class="card-badge">8 min → 15 min</span>
              </div>
              <div id="prediction-outcome-content" class="card-body card-body-table">
                <div class="prediction-outcome-empty">
                  <p>Per-event: predicted at 8 min vs outcome at 15 min. Records appear as events reach those times.</p>
                </div>
              </div>
            </section>
            <section class="card card-next15m" id="next15m-section">
              <div class="card-header">
                <h2>Next 15m Candle</h2>
                <span class="card-badge">Binance + Chainlink</span>
                <button type="button" id="next15m-refresh" class="btn btn-sm" style="margin-left: auto;">Refresh</button>
              </div>
              <div id="next15m-content" class="card-body">
                <div class="next15m-loading">Loading...</div>
              </div>
            </section>
          </aside>

          <!-- Center: Trading config, status, controls -->
          <section class="panel-center">
            <div class="card card-trading">
              <div class="card-header">
                <h2>Trading</h2>
                <span class="card-sub">${ASSET_CONFIG[this.currentAsset].displayName}</span>
              </div>
              <div class="card-body card-body-scroll">
                <div id="trading-config" class="trading-config-wrap"></div>
                <div id="trading-status" class="trading-status-wrap"></div>
                <div id="trading-controls" class="trading-controls-wrap"></div>
              </div>
            </div>
          </section>

          <!-- Right: Wallet + Session (collapsible) -->
          <aside class="panel-right">
            <section class="card card-wallet">
              <div class="card-header collapsible" id="wallet-section-toggle">
                <h2>Wallet & Session</h2>
                <span class="chevron">▼</span>
              </div>
              <div class="card-body wallet-section-content" id="wallet-section-content">
                <div id="wallet-display"></div>
                <h3 class="section-subtitle">Session - ${ASSET_CONFIG[this.currentAsset].displayName}</h3>
                <p class="session-note">Initialize session to place orders.</p>
                <div id="session-display"></div>
              </div>
            </section>
          </aside>
        </main>

        <!-- Orders & Trades row -->
        <section class="bottom-row">
          <div class="card card-orders">
            <div class="card-header">
              <h2>Orders & Positions</h2>
            </div>
            <div id="orders-display" class="card-body card-body-table"></div>
          </div>
          <div class="card card-trades">
            <div class="card-header">
              <h2>Trade History</h2>
            </div>
            <div id="trades-display" class="card-body card-body-table"></div>
          </div>
        </section>

        <!-- Events table (collapsible) -->
        <section class="events-section card">
          <div class="events-section-header card-header collapsible" id="events-section-header">
            <h2>Events</h2>
            <span class="events-chevron chevron" id="events-chevron">▼</span>
          </div>
          <div class="events-section-content collapsed" id="events-section-content">
            <div class="card-body">
              <table class="data-table events-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Status</th>
                    <th>Last Price</th>
                    <th>Condition ID</th>
                    <th>Question ID</th>
                    <th>Token IDs</th>
                    <th>Slug</th>
                  </tr>
                </thead>
                <tbody id="events-table-body">
                  <tr><td colspan="9" class="text-center">Loading events...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  private updatePriceDisplay(): void {
    const priceElement = document.getElementById('current-price');
    const timestampElement = document.getElementById('price-timestamp');
    const changeElement = document.getElementById('price-change');

    const price = this.assetPrices.get(this.currentAsset);
    
    if (priceElement) {
      priceElement.textContent = price != null ? `$${price.toFixed(2)}` : '--';
    }

    if (timestampElement) {
      const history = this.assetPriceHistory.get(this.currentAsset) || [];
      const lastUpdate = history.length > 0 ? history[history.length - 1].timestamp : null;
      if (lastUpdate) {
        timestampElement.textContent = new Date(lastUpdate * 1000).toLocaleTimeString();
      } else {
        timestampElement.textContent = '--';
      }
    }

    if (changeElement && price != null) {
      const history = this.assetPriceHistory.get(this.currentAsset) || [];
      if (history.length >= 2) {
        const prevPrice = history[history.length - 2].value;
        const change = price - prevPrice;
        const changePercent = (change / prevPrice) * 100;
        changeElement.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`;
        changeElement.className = `price-change ${change >= 0 ? 'positive' : 'negative'}`;
      }
    }
  }

  private renderEventsTable(): void {
    const events = this.eventManager.getEvents(this.currentAsset);
    const tableBody = document.getElementById('events-table-body');
    
    if (!tableBody) return;

    if (events.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">No events found</td></tr>';
      return;
    }

    tableBody.innerHTML = events.map((event, index) => {
      const isCurrent = index === this.eventManager.getCurrentEventIndex(this.currentAsset);
      const rowClass = isCurrent ? 'event-row current-event' : 'event-row';
      
      const statusClass = event.status === 'active' ? 'status-active' : 
                          event.status === 'expired' ? 'status-expired' : 'status-upcoming';
      const statusText = event.status === 'active' ? 'Active' : 
                        event.status === 'expired' ? 'Expired' : 'Upcoming';

      const lastPrice = this.eventLastPrice.get(event.slug) || event.lastPrice;
      const lastPriceDisplay = lastPrice !== undefined ? `$${lastPrice.toFixed(2)}` : '--';

      return `
        <tr class="${rowClass}">
          <td>${event.title}</td>
          <td>${event.formattedStartDate}</td>
          <td>${event.formattedEndDate}</td>
          <td><span class="${statusClass}">${statusText}</span></td>
          <td>${lastPriceDisplay}</td>
          <td>${event.conditionId || '--'}</td>
          <td>${event.questionId || '--'}</td>
          <td>${event.clobTokenIds ? event.clobTokenIds.join(', ') : '--'}</td>
          <td>${event.slug}</td>
        </tr>
      `;
    }).join('');
  }

  private renderActiveEvent(): void {
    const activeEventContainer = document.getElementById('active-event-display');
    const cardBody = activeEventContainer?.querySelector('.card-body');
    if (!cardBody) return;

    const events = this.eventManager.getEvents(this.currentAsset);
    const activeEvent = events.find(e => e.status === 'active');

    if (!activeEvent) {
      cardBody.innerHTML = `
        <div class="active-event-empty">
          <p>No active event for ${ASSET_CONFIG[this.currentAsset].displayName}</p>
        </div>
      `;
      return;
    }

    const priceToBeat = this.eventPriceToBeat.get(activeEvent.slug);
    const currentPrice = this.assetPrices.get(this.currentAsset);
    const priceToBeatDisplay = priceToBeat !== undefined 
      ? `$${priceToBeat.toFixed(2)}` 
      : (currentPrice != null ? `$${currentPrice.toFixed(2)} (current)` : 'Loading...');

    const upPrice = this.assetUpPrices.get(this.currentAsset);
    const downPrice = this.assetDownPrices.get(this.currentAsset);

    cardBody.innerHTML = `
      <div class="active-event">
        <h3 class="active-event-title">${activeEvent.title}</h3>
        <div class="active-event-info">
          <div class="info-row">
            <span class="info-label">Price to Beat</span>
            <span class="info-value">${priceToBeatDisplay}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Current Price</span>
            <span class="info-value">${currentPrice != null ? `$${currentPrice.toFixed(2)}` : 'Loading...'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Time Left</span>
            <span class="info-value countdown-value" id="countdown">Calculating...</span>
          </div>
          ${upPrice != null && downPrice != null ? `
            <div class="info-row">
              <span class="info-label">UP</span>
              <span class="info-value up-value">${upPrice.toFixed(2)}%</span>
            </div>
            <div class="info-row">
              <span class="info-label">DOWN</span>
              <span class="info-value down-value">${downPrice.toFixed(2)}%</span>
            </div>
          ` : ''}
          <div class="info-row slug-row">
            <span class="info-label">Slug</span>
            <span class="info-value slug-value">${activeEvent.slug}</span>
          </div>
        </div>
      </div>
    `;

    this.startCountdown(activeEvent);
  }

  private startCountdown(_event: unknown): void {
    this.stopCountdown();
    this.countdownInterval = window.setInterval(() => {
      this.updateCountdown();
    }, 1000);
    this.updateCountdown();
  }

  private stopCountdown(): void {
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  private updateCountdown(): void {
    const events = this.eventManager.getEvents(this.currentAsset);
    const activeEvent = events.find(e => e.status === 'active');
    const countdownElement = document.getElementById('countdown');
    
    if (!activeEvent || !countdownElement) {
      this.stopCountdown();
      return;
    }

    const endDate = new Date(activeEvent.endDate);
    const now = new Date();
    const timeLeft = Math.max(0, Math.floor((endDate.getTime() - now.getTime()) / 1000));
    
    countdownElement.textContent = this.formatCountdown(timeLeft);
    
    if (timeLeft === 0) {
      const price = this.assetPrices.get(this.currentAsset);
      if (price != null) {
        const activeIndex = events.findIndex(e => e.status === 'active');
        const nextEvent = events[activeIndex + 1];
        if (nextEvent && !this.eventLastPrice.has(nextEvent.slug)) {
          this.eventLastPrice.set(nextEvent.slug, price);
        }
      }
      this.stopCountdown();
      this.eventManager.loadEvents(this.currentAsset, 10).catch(console.error);
    }
  }

  private formatCountdown(seconds: number): string {
    if (seconds <= 0) {
      return '00:00:00';
    }
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  private renderTradingSection(): void {
    const configDiv = document.getElementById('trading-config');
    const statusDiv = document.getElementById('trading-status');
    const controlsDiv = document.getElementById('trading-controls');
    const tradesDiv = document.getElementById('trades-display');

    if (!configDiv || !statusDiv || !controlsDiv) return;

    const config = this.tradingManager.getStrategyConfig(this.currentAsset);
    const status = this.tradingManager.getStatus(this.currentAsset);
    const trades = this.tradingManager.getTrades(this.currentAsset);
    const sessionState = this.assetSessions.get(this.currentAsset);

    // Render config form
    configDiv.innerHTML = `
      <div class="strategy-config">
        <div class="config-item">
          <label>
            <input type="checkbox" id="strategy-enabled" ${config.enabled ? 'checked' : ''}>
            Enable Trading
          </label>
        </div>
        <div class="config-item">
          <label>
            Entry Price (0-100):
            <input type="number" id="entry-price" value="${config.entryPrice}" min="0" max="100" step="0.01">
            <small>When active order's UP or DOWN value reaches this price, the order is placed</small>
          </label>
        </div>
        <div class="config-item">
          <label>
            Profit Target (0-100):
            <input type="number" id="profit-target" value="${config.profitTargetPrice}" min="0" max="100" step="0.01">
            <small>When active order's UP or DOWN value reaches this price, the order is sold</small>
          </label>
        </div>
        <div class="config-item">
          <label>
            Stop Loss (0-100):
            <input type="number" id="stop-loss" value="${config.stopLossPrice}" min="0" max="100" step="0.01">
            <small>When UP or DOWN value reaches this price, the order is sold</small>
          </label>
        </div>
        <div class="config-item">
          <label>
            <input type="checkbox" id="use-limit-order-stop-loss" ${config.useLimitOrderForStopLoss !== false ? 'checked' : ''}>
            Use limit sell for stop loss
          </label>
          <small>When enabled, stop loss places a limit order at the stop loss price so all shares are sold (order stays on book until filled). When disabled, uses market order (FAK).</small>
        </div>
        <div class="config-item">
          <label>
            <input type="checkbox" id="use-limit-order-large-entry" ${config.useLimitOrderForLargeEntry !== false ? 'checked' : ''}>
            Use limit order for large entry (trade size &gt; threshold)
          </label>
          <small>When trade size &gt; threshold, place a BUY limit order at (entry − discount) instead of market. E.g. entry 92 → limit at 90. Order shows in Pending limit orders.</small>
        </div>
        <div class="config-item" id="limit-order-large-entry-params" style="${config.useLimitOrderForLargeEntry !== false ? '' : 'display: none;'}">
          <label>
            Threshold (USD): <input type="number" id="entry-limit-above-size" value="${config.entryLimitOrderAboveSize ?? 70}" min="50" max="500" step="1" style="width: 70px;">
            Discount: <input type="number" id="entry-limit-discount" value="${config.entryLimitOrderDiscount ?? 2}" min="1" max="10" step="1" style="width: 50px;">
            <small>Use limit when size &gt; threshold. Limit price = entry − discount (e.g. 92 − 2 = 90).</small>
          </label>
        </div>
        <div class="config-item">
          <label>
            <input type="checkbox" id="use-percentage-position-size" ${config.usePercentagePositionSize !== false ? 'checked' : ''}>
            Use percentage of balance for position sizing
          </label>
          <small>When enabled, position size is calculated as a percentage of wallet balance. When disabled, uses fixed trade size.</small>
        </div>
        <div class="config-item" id="position-size-percent-container" style="${config.usePercentagePositionSize !== false ? '' : 'display: none;'}">
          <label>
            Position Size (% of balance):
            <input type="number" id="position-size-percent" value="${config.positionSizePercent || 3}" min="1" max="10" step="0.1">
            <small>Recommended: 2-5% per trade. Bot will automatically increase size after wins and decrease after losses.</small>
          </label>
        </div>
        <div class="config-item" id="trade-size-container" style="${config.usePercentagePositionSize === false ? '' : 'display: none;'}">
          <label>
            Trade Size (USD):
            <input type="number" id="trade-size" value="${config.tradeSize}" min="1" step="0.01">
            <small>Fixed trade size in USD (only used when percentage sizing is disabled)</small>
          </label>
        </div>
        <div class="config-item">
          <label>
            Price Difference (USD):
            <input type="number" id="price-difference" value="${config.priceDifference || ''}" placeholder="Optional">
            <small>Only trade when |Price to Beat - Current ${ASSET_CONFIG[this.currentAsset].displayName} Price| equals this value. Leave empty to disable. When set, position size increases by 20% (higher confidence).</small>
          </label>
        </div>
        
        <h3 style="margin-top: 20px; border-top: 1px solid #ddd; padding-top: 15px;">Advanced Strategies</h3>
        
        <div class="config-item">
          <label>
            <input type="checkbox" id="enable-arbitrage" ${config.enableArbitrage !== false ? 'checked' : ''}>
            Enable Arbitrage Detection (Risk-Free Profit)
          </label>
          <small>Automatically detect and execute arbitrage opportunities (YES + NO < $1.00). Highest priority strategy.</small>
        </div>
        <div class="config-item" id="arbitrage-threshold-container" style="${config.enableArbitrage !== false ? '' : 'display: none;'}">
          <label>
            Arbitrage Threshold (%):
            <input type="number" id="arbitrage-threshold" value="${(config.arbitrageThreshold || 0.02) * 100}" min="0.5" max="5" step="0.1">
            <small>Minimum arbitrage opportunity to trigger (default: 2%). Lower = more opportunities but requires faster execution.</small>
          </label>
        </div>
        
        <div class="config-item">
          <label>
            <input type="checkbox" id="enable-volatility-capture" ${config.enableVolatilityCapture !== false ? 'checked' : ''}>
            Enable Volatility Capture
          </label>
          <small>Enter on significant price drops in first 2 minutes of event. Uses smaller position size.</small>
        </div>
        
        <div class="config-item">
          <label>
            <input type="checkbox" id="use-trailing-stop" ${config.useTrailingStop !== false ? 'checked' : ''}>
            Use Trailing Stop (Let Winners Run)
          </label>
          <small>Instead of fixed profit target, stop loss follows price up to lock in profits. Recommended for maximizing gains.</small>
        </div>
        <div class="config-item" id="trailing-stop-distance-container" style="${config.useTrailingStop !== false ? '' : 'display: none;'}">
          <label>
            Trailing Stop Distance (%):
            <input type="number" id="trailing-stop-distance" value="${config.trailingStopDistance || 2}" min="0.5" max="5" step="0.1">
            <small>Distance from peak price for trailing stop (default: 2%). Lower = tighter stop, higher = let winners run more.</small>
          </label>
        </div>
        
        <div class="config-item">
          <label>
            <input type="checkbox" id="enable-liquidity-filter" ${config.enableLiquidityFilter !== false ? 'checked' : ''}>
            Enable Liquidity Filter
          </label>
          <small>Only trade when bid-ask spread is tight (good liquidity). Prevents slippage losses.</small>
        </div>
        
        <div class="config-item">
          <label>
            <input type="checkbox" id="enable-early-exit-reversal" ${config.enableEarlyExitOnReversal !== false ? 'checked' : ''}>
            Enable Early Exit on Reversal
          </label>
          <small>Exit immediately if price reverses after entry. Minimizes losses from false signals.</small>
        </div>
        
        <div class="config-item">
          <label>
            <input type="checkbox" id="enable-partial-profit" ${config.enablePartialProfitTaking !== false ? 'checked' : ''}>
            Enable Partial Profit Taking
          </label>
          <small>Take 50% profit early at first target, let rest run with trailing stop. Best of both worlds.</small>
        </div>
        <div class="config-item" id="partial-profit-container" style="${config.enablePartialProfitTaking !== false ? '' : 'display: none;'}">
          <label>
            Partial Profit Target (%):
            <input type="number" id="partial-profit-target" value="${config.partialProfitTarget || 96}" min="90" max="99" step="0.1">
            <small>First profit target for partial exit (default: 96%). Remaining position continues with trailing stop.</small>
          </label>
        </div>
        
        <div class="config-item">
          <label>
            <input type="checkbox" id="enable-momentum-confirmation" ${config.enableMomentumConfirmation !== false ? 'checked' : ''}>
            Enable Momentum Confirmation
          </label>
          <small>Only enter if price is moving in the expected direction. Reduces false entries.</small>
        </div>
        
        <div class="config-item">
          <label>
            <input type="checkbox" id="enable-event-phase-strategy" ${config.enableEventPhaseStrategy !== false ? 'checked' : ''}>
            Enable Event Phase Strategy
          </label>
          <small>Use different entry prices for different event phases (early/middle/late). More conservative near event end.</small>
        </div>
        <div class="config-item" id="event-phase-container" style="${config.enableEventPhaseStrategy !== false ? '' : 'display: none;'}">
          <label>
            Early Phase Entry (%): <input type="number" id="early-phase-entry" value="${config.earlyPhaseEntryPrice || 92}" min="85" max="98" step="0.1" style="width: 80px;">
            Middle Phase Entry (%): <input type="number" id="middle-phase-entry" value="${config.middlePhaseEntryPrice || 93}" min="85" max="98" step="0.1" style="width: 80px;">
            Late Phase Entry (%): <input type="number" id="late-phase-entry" value="${config.latePhaseEntryPrice || 95}" min="85" max="98" step="0.1" style="width: 80px;">
          </label>
          <small>Entry prices for first 5 min / middle 5 min / last 5 min. Late phase also limits position size.</small>
        </div>
        
        <div class="config-item">
          <label>
            <input type="checkbox" id="enable-mean-reversion" ${config.enableMeanReversion === true ? 'checked' : ''}>
            Enable Mean Reversion Strategy (Alternative)
          </label>
          <small>Enter when price moves far from 50% (expects reversion). Conflicts with regular strategy - use one or the other.</small>
        </div>
        
        <button id="save-strategy-config" class="btn btn-primary">Save Configuration</button>
      </div>
    `;

    // Setup visibility toggles after form is rendered
    setTimeout(() => {
      // Position size toggle
      const usePercentageCheckbox = document.getElementById('use-percentage-position-size') as HTMLInputElement;
      const positionSizePercentContainer = document.getElementById('position-size-percent-container');
      const tradeSizeContainer = document.getElementById('trade-size-container');
      
      if (usePercentageCheckbox && positionSizePercentContainer && tradeSizeContainer) {
        const updatePositionSizeVisibility = () => {
          if (usePercentageCheckbox.checked) {
            positionSizePercentContainer!.style.display = '';
            tradeSizeContainer!.style.display = 'none';
          } else {
            positionSizePercentContainer!.style.display = 'none';
            tradeSizeContainer!.style.display = '';
          }
        };
        
        usePercentageCheckbox.removeEventListener('change', updatePositionSizeVisibility);
        usePercentageCheckbox.addEventListener('change', updatePositionSizeVisibility);
        updatePositionSizeVisibility();
      }

      const useLimitOrderLargeEntryCheckbox = document.getElementById('use-limit-order-large-entry') as HTMLInputElement;
      const limitOrderLargeEntryParams = document.getElementById('limit-order-large-entry-params');
      if (useLimitOrderLargeEntryCheckbox && limitOrderLargeEntryParams) {
        const updateLimitOrderLargeVisibility = () => {
          limitOrderLargeEntryParams.style.display = useLimitOrderLargeEntryCheckbox.checked ? '' : 'none';
        };
        useLimitOrderLargeEntryCheckbox.removeEventListener('change', updateLimitOrderLargeVisibility);
        useLimitOrderLargeEntryCheckbox.addEventListener('change', updateLimitOrderLargeVisibility);
        updateLimitOrderLargeVisibility();
      }

      // Arbitrage threshold toggle
      const enableArbitrageCheckbox = document.getElementById('enable-arbitrage') as HTMLInputElement;
      const arbitrageThresholdContainer = document.getElementById('arbitrage-threshold-container');
      if (enableArbitrageCheckbox && arbitrageThresholdContainer) {
        const updateArbitrageVisibility = () => {
          arbitrageThresholdContainer.style.display = enableArbitrageCheckbox.checked ? '' : 'none';
        };
        enableArbitrageCheckbox.removeEventListener('change', updateArbitrageVisibility);
        enableArbitrageCheckbox.addEventListener('change', updateArbitrageVisibility);
        updateArbitrageVisibility();
      }

      // Trailing stop distance toggle
      const useTrailingStopCheckbox = document.getElementById('use-trailing-stop') as HTMLInputElement;
      const trailingStopDistanceContainer = document.getElementById('trailing-stop-distance-container');
      if (useTrailingStopCheckbox && trailingStopDistanceContainer) {
        const updateTrailingStopVisibility = () => {
          trailingStopDistanceContainer.style.display = useTrailingStopCheckbox.checked ? '' : 'none';
        };
        useTrailingStopCheckbox.removeEventListener('change', updateTrailingStopVisibility);
        useTrailingStopCheckbox.addEventListener('change', updateTrailingStopVisibility);
        updateTrailingStopVisibility();
      }

      // Partial profit toggle
      const enablePartialProfitCheckbox = document.getElementById('enable-partial-profit') as HTMLInputElement;
      const partialProfitContainer = document.getElementById('partial-profit-container');
      if (enablePartialProfitCheckbox && partialProfitContainer) {
        const updatePartialProfitVisibility = () => {
          partialProfitContainer.style.display = enablePartialProfitCheckbox.checked ? '' : 'none';
        };
        enablePartialProfitCheckbox.removeEventListener('change', updatePartialProfitVisibility);
        enablePartialProfitCheckbox.addEventListener('change', updatePartialProfitVisibility);
        updatePartialProfitVisibility();
      }

      // Event phase toggle
      const enableEventPhaseCheckbox = document.getElementById('enable-event-phase-strategy') as HTMLInputElement;
      const eventPhaseContainer = document.getElementById('event-phase-container');
      if (enableEventPhaseCheckbox && eventPhaseContainer) {
        const updateEventPhaseVisibility = () => {
          eventPhaseContainer.style.display = enableEventPhaseCheckbox.checked ? '' : 'none';
        };
        enableEventPhaseCheckbox.removeEventListener('change', updateEventPhaseVisibility);
        enableEventPhaseCheckbox.addEventListener('change', updateEventPhaseVisibility);
        updateEventPhaseVisibility();
      }
    }, 0);

    // Render status
    statusDiv.innerHTML = `
      <div class="trading-status-display">
        <div class="status-item">
          <span class="status-label">Trading Active:</span>
          <span class="status-value">${status.isActive ? 'Yes' : 'No'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Total Trades:</span>
          <span class="status-value">${status.totalTrades}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Successful:</span>
          <span class="status-value">${status.successfulTrades}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Failed:</span>
          <span class="status-value">${status.failedTrades}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Total Profit:</span>
          <span class="status-value ${status.totalProfit >= 0 ? 'profit' : 'loss'}">$${status.totalProfit.toFixed(2)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Open Positions:</span>
          <span class="status-value">${status.positions?.length || 0}</span>
        </div>
      </div>
    `;

    // Render controls
    const canStartTrading = sessionState?.isInitialized && !status.isActive;
    controlsDiv.innerHTML = `
      <div class="trading-controls">
        <button id="start-trading" class="btn btn-success" ${!canStartTrading ? 'disabled' : ''}>
          Start ${ASSET_CONFIG[this.currentAsset].displayName} Trading
        </button>
        <button id="stop-trading" class="btn btn-danger" ${!status.isActive ? 'disabled' : ''}>
          Stop ${ASSET_CONFIG[this.currentAsset].displayName} Trading
        </button>
        ${!sessionState?.isInitialized ? `
          <p class="trading-warning">⚠️ Trading session not initialized. Please initialize session first.</p>
        ` : ''}
      </div>
    `;

    // Render trades
    if (tradesDiv) {
      if (trades.length === 0) {
        tradesDiv.innerHTML = '<p class="no-trades">No trades yet for ' + ASSET_CONFIG[this.currentAsset].displayName + '</p>';
      } else {
        tradesDiv.innerHTML = `
          <table class="trades-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Side</th>
                <th>Size</th>
                <th>Price</th>
                <th>Status</th>
                <th>Profit</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              ${trades.slice().reverse().map(trade => `
                <tr class="trade-row trade-${trade.status}">
                  <td>${new Date(trade.timestamp).toLocaleTimeString()}</td>
                  <td class="event-slug">${trade.eventSlug}</td>
                  <td><span class="side-${trade.side.toLowerCase()}">${trade.side}</span> ${trade.direction ? `<span class="direction-badge direction-${trade.direction.toLowerCase()}">${trade.direction}</span>` : ''}</td>
                  <td>$${trade.size.toFixed(2)}</td>
                  <td>${trade.price.toFixed(2)}${trade.orderType === 'LIMIT' && trade.limitPrice ? ` (limit: ${trade.limitPrice.toFixed(2)})` : ''}</td>
                  <td><span class="status-badge status-${trade.status}">${trade.status}</span> ${trade.orderType === 'LIMIT' ? '<span class="order-type">LIMIT</span>' : ''}</td>
                  <td class="${trade.profit !== undefined ? (trade.profit >= 0 ? 'profit' : 'loss') : ''}">
                    ${trade.profit !== undefined ? `$${trade.profit.toFixed(2)}` : '--'}
                  </td>
                  <td class="reason">${trade.reason}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }
    }
  }

  private renderWalletSection(): void {
    const walletDiv = document.getElementById('wallet-display');
    const sessionDiv = document.getElementById('session-display');
    
    if (walletDiv) {
      walletDiv.innerHTML = `
        <div class="wallet-info">
          <div class="wallet-status">
            <span class="status-label">Wallet:</span>
            <span class="status-value">${this.walletState.isConnected ? 'Connected' : 'Not Connected'}</span>
          </div>
          ${this.walletState.eoaAddress ? `
            <div class="wallet-address">
              <span class="label">EOA:</span>
              <span class="value">${this.walletState.eoaAddress.substring(0, 6)}...${this.walletState.eoaAddress.substring(38)}</span>
            </div>
          ` : ''}
          ${this.walletState.proxyAddress ? `
            <div class="wallet-address">
              <span class="label">Proxy:</span>
              <span class="value">${this.walletState.proxyAddress.substring(0, 6)}...${this.walletState.proxyAddress.substring(38)}</span>
            </div>
          ` : ''}
          ${this.walletState.balance !== null ? `
            <div class="wallet-balance">
              <span class="label">Balance:</span>
              <span class="value">$${this.walletState.balance.toFixed(2)}</span>
            </div>
          ` : ''}
          <div class="wallet-controls">
            ${!this.walletState.isConnected ? `
              <button id="connect-wallet" class="btn btn-primary" ${this.walletState.isLoading ? 'disabled' : ''}>Connect Wallet</button>
            ` : `
              <button id="disconnect-wallet" class="btn btn-secondary">Disconnect Wallet</button>
            `}
          </div>
          ${this.walletState.error ? `
            <div class="wallet-error">Error: ${this.walletState.error}</div>
          ` : ''}
        </div>
      `;
    }

    if (sessionDiv) {
      const sessionState = this.assetSessions.get(this.currentAsset) || { isInitialized: false, isLoading: false, error: null };
      sessionDiv.innerHTML = `
        <div class="session-info">
          <div class="session-status">
            <span class="status-label">${ASSET_CONFIG[this.currentAsset].displayName} Session:</span>
            <span class="status-value">${sessionState.isInitialized ? 'Initialized' : 'Not Initialized'}</span>
          </div>
          ${sessionState.error ? `
            <div class="session-error">Error: ${sessionState.error}</div>
          ` : ''}
          <div class="session-controls">
            <button id="initialize-session" class="btn btn-primary" 
              ${!this.walletState.isConnected || sessionState.isInitialized || sessionState.isLoading ? 'disabled' : ''}>
              ${sessionState.isLoading ? 'Initializing...' : `Initialize ${ASSET_CONFIG[this.currentAsset].displayName} Trading Session`}
            </button>
          </div>
        </div>
      `;
    }
  }

  private async startTrading(): Promise<void> {
    const sessionState = this.assetSessions.get(this.currentAsset);
    if (!sessionState?.isInitialized) {
      alert(`Please initialize ${ASSET_CONFIG[this.currentAsset].displayName} trading session first!`);
      return;
    }

    await this.tradingManager.startTrading(this.currentAsset);
    this.renderTradingSection();
  }

  private stopTrading(): void {
    this.tradingManager.stopTrading(this.currentAsset);
    this.renderTradingSection();
  }

  private saveStrategyConfig(): void {
    const enabled = (document.getElementById('strategy-enabled') as HTMLInputElement)?.checked || false;
    const entryPrice = parseFloat((document.getElementById('entry-price') as HTMLInputElement)?.value || '93');
    const profitTarget = parseFloat((document.getElementById('profit-target') as HTMLInputElement)?.value || '99');
    const stopLoss = parseFloat((document.getElementById('stop-loss') as HTMLInputElement)?.value || '91');
    const usePercentagePositionSize = (document.getElementById('use-percentage-position-size') as HTMLInputElement)?.checked !== false;
    const positionSizePercent = parseFloat((document.getElementById('position-size-percent') as HTMLInputElement)?.value || '3');
    const tradeSize = parseFloat((document.getElementById('trade-size') as HTMLInputElement)?.value || '50');
    const useLimitOrderForStopLoss = (document.getElementById('use-limit-order-stop-loss') as HTMLInputElement)?.checked !== false;
    const useLimitOrderForLargeEntry = (document.getElementById('use-limit-order-large-entry') as HTMLInputElement)?.checked !== false;
    const entryLimitOrderAboveSize = parseFloat((document.getElementById('entry-limit-above-size') as HTMLInputElement)?.value || '70');
    const entryLimitOrderDiscount = parseFloat((document.getElementById('entry-limit-discount') as HTMLInputElement)?.value || '2');
    const priceDifferenceInput = (document.getElementById('price-difference') as HTMLInputElement)?.value;
    const priceDifference = priceDifferenceInput && priceDifferenceInput.trim() !== '' 
      ? parseFloat(priceDifferenceInput) 
      : null;

    // Read new strategy options
    const enableArbitrage = (document.getElementById('enable-arbitrage') as HTMLInputElement)?.checked !== false;
    const arbitrageThreshold = parseFloat((document.getElementById('arbitrage-threshold') as HTMLInputElement)?.value || '2') / 100;
    const enableVolatilityCapture = (document.getElementById('enable-volatility-capture') as HTMLInputElement)?.checked !== false;
    const useTrailingStop = (document.getElementById('use-trailing-stop') as HTMLInputElement)?.checked !== false;
    const trailingStopDistance = parseFloat((document.getElementById('trailing-stop-distance') as HTMLInputElement)?.value || '2');
    const enableLiquidityFilter = (document.getElementById('enable-liquidity-filter') as HTMLInputElement)?.checked !== false;
    const enableEarlyExitOnReversal = (document.getElementById('enable-early-exit-reversal') as HTMLInputElement)?.checked !== false;
    const enablePartialProfitTaking = (document.getElementById('enable-partial-profit') as HTMLInputElement)?.checked !== false;
    const partialProfitTarget = parseFloat((document.getElementById('partial-profit-target') as HTMLInputElement)?.value || '96');
    const enableMomentumConfirmation = (document.getElementById('enable-momentum-confirmation') as HTMLInputElement)?.checked !== false;
    const enableEventPhaseStrategy = (document.getElementById('enable-event-phase-strategy') as HTMLInputElement)?.checked !== false;
    const earlyPhaseEntryPrice = parseFloat((document.getElementById('early-phase-entry') as HTMLInputElement)?.value || '92');
    const middlePhaseEntryPrice = parseFloat((document.getElementById('middle-phase-entry') as HTMLInputElement)?.value || '93');
    const latePhaseEntryPrice = parseFloat((document.getElementById('late-phase-entry') as HTMLInputElement)?.value || '95');
    const enableMeanReversion = (document.getElementById('enable-mean-reversion') as HTMLInputElement)?.checked === true;

    this.tradingManager.updateStrategyConfig(this.currentAsset, {
      enabled,
      entryPrice,
      profitTargetPrice: profitTarget,
      stopLossPrice: stopLoss,
      tradeSize,
      usePercentagePositionSize,
      positionSizePercent,
      useLimitOrderForStopLoss,
      useLimitOrderForLargeEntry,
      entryLimitOrderAboveSize,
      entryLimitOrderDiscount,
      priceDifference,
      // New strategies
      enableArbitrage,
      arbitrageThreshold,
      enableVolatilityCapture,
      useTrailingStop,
      trailingStopDistance,
      enableLiquidityFilter,
      enableEarlyExitOnReversal,
      enablePartialProfitTaking,
      partialProfitTarget,
      enableMomentumConfirmation,
      enableEventPhaseStrategy,
      earlyPhaseEntryPrice,
      middlePhaseEntryPrice,
      latePhaseEntryPrice,
      enableMeanReversion,
    });

    alert(`Strategy configuration saved for ${ASSET_CONFIG[this.currentAsset].displayName}!`);
  }

  private updateConnectionStatus(): void {
    const statusElement = document.getElementById('connection-status');
    const errorElement = document.getElementById('error-message');

    if (statusElement) {
      if (this.currentStatus.connected) {
        statusElement.textContent = 'Connected';
        statusElement.className = 'status-connected';
      } else {
        statusElement.textContent = 'Disconnected';
        statusElement.className = 'status-disconnected';
      }
    }

    if (errorElement) {
      if (this.currentStatus.error) {
        errorElement.textContent = this.currentStatus.error;
        errorElement.style.display = 'block';
      } else {
        errorElement.style.display = 'none';
      }
    }
  }

  private startPriceUpdates(): void {
    // Start updating UP/DOWN prices for current asset
    this.stopPriceUpdates();
    this.priceUpdateInterval = window.setInterval(() => {
      this.updateUpDownPrices();
    }, 5000); // Update every 5 seconds
    this.updateUpDownPrices(); // Update immediately
  }

  private stopPriceUpdates(): void {
    if (this.priceUpdateInterval !== null) {
      clearInterval(this.priceUpdateInterval);
      this.priceUpdateInterval = null;
    }
  }

  private async updateUpDownPrices(): Promise<void> {
    const events = this.eventManager.getEvents(this.currentAsset);
    const activeEvent = events.find(e => e.status === 'active');

    if (!activeEvent || !activeEvent.clobTokenIds || activeEvent.clobTokenIds.length < 2) {
      this.assetUpPrices.set(this.currentAsset, null);
      this.assetDownPrices.set(this.currentAsset, null);
      return;
    }

    try {
      const manager = this.tradingManager.getManager(this.currentAsset);
      if (!manager) return;

      const clobClient = (manager as any).clobClient;
      if (!clobClient) return;

      const [yesPrice, noPrice] = await Promise.all([
        clobClient.getPrice(activeEvent.clobTokenIds[0], 'SELL'),
        clobClient.getPrice(activeEvent.clobTokenIds[1], 'SELL'),
      ]);

      if (yesPrice && noPrice) {
        const upPricePercent = yesPrice * 100;
        const downPricePercent = noPrice * 100;
        this.assetUpPrices.set(this.currentAsset, upPricePercent);
        this.assetDownPrices.set(this.currentAsset, downPricePercent);
        
        // Trigger updateTradingManager to feed prices to trend predictor
        this.updateTradingManager(this.currentAsset);
      }
    } catch (error) {
      console.error(`[${this.currentAsset.toUpperCase()}] Error updating UP/DOWN prices:`, error);
    }
  }

  private async fetchAndDisplayOrders(): Promise<void> {
    const ordersDiv = document.getElementById('orders-display');
    if (!ordersDiv) return;

    const sessionState = this.assetSessions.get(this.currentAsset);
    if (!sessionState?.isInitialized || !this.walletState.apiCredentials || !this.walletState.proxyAddress) {
      ordersDiv.innerHTML = `
        <div class="orders-empty">
          <p>${ASSET_CONFIG[this.currentAsset].displayName} trading session not initialized. Please initialize session first.</p>
        </div>
      `;
      return;
    }

    ordersDiv.innerHTML = '<div class="orders-loading">Loading orders...</div>';

    try {
      const response = await fetch(
        `/api/orders?apiCredentials=${encodeURIComponent(JSON.stringify(this.walletState.apiCredentials))}&proxyAddress=${encodeURIComponent(this.walletState.proxyAddress)}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch orders');
      }

      const orders = data.orders || [];
      const positions = this.tradingManager.getPositions(this.currentAsset);
      const pendingLimitOrders = this.tradingManager.getPendingLimitOrders(this.currentAsset);
      this.tradingManager.getTrades(this.currentAsset);

      // Render pending limit orders (BUY at target – trade size > 70)
      const pendingLimitRows = pendingLimitOrders.map((t: { id: string; tokenId: string; transactionHash?: string; limitPrice?: number; price?: number; size: number; direction?: string }) => `
        <tr class="order-row order-pending-limit">
          <td class="order-id">${(t.transactionHash || t.id || '').toString().substring(0, 8)}...</td>
          <td class="token-id">${t.tokenId ? t.tokenId.substring(0, 10) + '...' : '--'}</td>
          <td>BUY ${t.direction || '--'}</td>
          <td><strong>${(t.limitPrice ?? t.price ?? 0).toFixed(2)}</strong></td>
          <td>${(t.size || 0).toFixed(2)} USD</td>
          <td><span class="status-badge status-pending">PENDING</span></td>
          <td>--</td>
        </tr>
      `).join('');

      // Render positions
      const positionRows = positions.map((position, index) => {
        const filledOrdersForPosition = position.filledOrders || [];
        const totalFilled = filledOrdersForPosition.reduce((sum, fo) => sum + fo.size, 0);
        const fillPercentage = position.size > 0 ? (totalFilled / position.size * 100).toFixed(1) : '0.0';
        const firstOrder = filledOrdersForPosition[0];
        const orderId = firstOrder?.orderId ? firstOrder.orderId.substring(0, 8) + '...' : `POS-${index + 1}`;
        const hash = firstOrder?.orderId ? firstOrder.orderId.substring(0, 16) + '...' : '--';
        const created = firstOrder?.timestamp ? new Date(firstOrder.timestamp).toLocaleString() : new Date(position.entryTimestamp).toLocaleString();

        return `
          <tr class="order-row order-position" data-position-id="${position.id}">
            <td class="order-id">${orderId}</td>
            <td class="token-id">${position.tokenId ? position.tokenId.substring(0, 10) + '...' : '--'}</td>
            <td>${hash}</td>
            <td>${totalFilled.toFixed(2)} (${fillPercentage}%)</td>
            <td><span class="status-badge status-position">ACTIVE</span></td>
            <td>${created}</td>
            <td>
              <button class="btn-sell-order btn-sell-position" 
                data-position-id="${position.id}"
                data-token-id="${position.tokenId || ''}" 
                data-size="${position.size || 0}"
                data-price="${position.entryPrice || 0}"
                data-direction="${position.direction || ''}">Sell</button>
            </td>
          </tr>
        `;
      }).join('');

      // Render orders
      const orderRows = orders.map((order: any) => {
        const orderStatus = (order.status || 'UNKNOWN').toUpperCase();
        const isFilled = orderStatus === 'FILLED' || orderStatus === 'EXECUTED' || orderStatus === 'CLOSED';
        const isLive = orderStatus === 'LIVE';
        const fillPercentage = order.original_size > 0 
          ? ((order.size_matched || 0) / order.original_size * 100).toFixed(1)
          : '0.0';

        return `
          <tr class="order-row ${isFilled ? 'order-filled' : isLive ? 'order-live' : ''}">
            <td class="order-id">${order.id ? order.id.substring(0, 8) + '...' : '--'}</td>
            <td class="token-id">${order.asset_id ? order.asset_id.substring(0, 10) + '...' : order.token_id ? order.token_id.substring(0, 10) + '...' : '--'}</td>
            <td>${(order.transaction_hash || order.hash || order.id || '--').substring(0, 16)}${(order.transaction_hash || order.hash || order.id || '').length > 16 ? '...' : ''}</td>
            <td>${parseFloat(order.size_matched || order.filled_size || 0).toFixed(2)} (${fillPercentage}%)</td>
            <td><span class="status-badge status-${orderStatus.toLowerCase()}">${order.status || 'UNKNOWN'}</span></td>
            <td>${order.created_at ? new Date(order.created_at * 1000).toLocaleString() : order.created_at_iso || '--'}</td>
            <td>
              ${isLive 
                ? `<button class="btn-cancel-order" data-order-id="${order.id}">Cancel</button>`
                : isFilled && order.side === 'BUY'
                ? `<button class="btn-sell-order" data-order-id="${order.id}" data-token-id="${order.asset_id || order.token_id || ''}" data-size="${order.size_matched || order.filled_size || order.original_size || order.size || 0}" data-price="${order.price || 0}">Sell</button>`
                : '--'
              }
            </td>
          </tr>
        `;
      }).join('');

      ordersDiv.innerHTML = `
        <div class="orders-summary">
          <p><strong>Positions:</strong> ${positions.length} | <strong>Orders:</strong> ${orders.length}${pendingLimitOrders.length > 0 ? ` | <strong>Pending limit:</strong> ${pendingLimitOrders.length}` : ''}</p>
        </div>
        ${pendingLimitOrders.length > 0 ? `
        <div class="pending-limit-orders-section">
          <h4 style="margin: 0 0 8px 0; font-size: 0.95em;">Pending limit orders (BUY at target)</h4>
          <p style="margin: 0 0 8px 0; font-size: 0.85em; color: var(--text-muted);">Trade size &gt; 70 USD: limit order placed below entry (e.g. entry 92 → limit at 90). Fills when price reaches target.</p>
          <table class="orders-table pending-limit-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Token</th>
                <th>Side</th>
                <th>Limit price</th>
                <th>Size</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${pendingLimitRows}</tbody>
          </table>
        </div>
        ` : ''}
        <table class="orders-table">
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Token ID</th>
              <th>Hash</th>
              <th>Filled</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${positionRows}
            ${orderRows}
            ${positions.length === 0 && orders.length === 0 && pendingLimitOrders.length === 0 ? '<tr><td colspan="7" class="orders-empty-cell">No orders or positions</td></tr>' : ''}
          </tbody>
        </table>
      `;

      // Add event listeners
      const sellButtons = ordersDiv.querySelectorAll('.btn-sell-order');
      sellButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const target = e.target as HTMLButtonElement;
          const positionId = target.getAttribute('data-position-id');
          if (positionId) {
            await this.sellPosition(positionId);
          }
        });
      });

      const cancelButtons = ordersDiv.querySelectorAll('.btn-cancel-order');
      cancelButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const orderId = (e.target as HTMLButtonElement).getAttribute('data-order-id');
          if (orderId) {
            await this.cancelOrder(orderId);
          }
        });
      });
    } catch (error) {
      console.error(`[${this.currentAsset.toUpperCase()}] Error fetching orders:`, error);
      ordersDiv.innerHTML = `
        <div class="orders-error">
          <p>Error loading orders: ${error instanceof Error ? error.message : 'Unknown error'}</p>
        </div>
      `;
    }
  }

  private async connectWallet(): Promise<void> {
    this.walletState.isLoading = true;
    this.walletState.error = null;
    this.renderWalletSection();

    try {
      console.log('[Wallet] Attempting to connect...');
      
      const response = await fetch('/api/wallet', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error (${response.status})`);
      }

      const data = await response.json();

      if (!data.eoaAddress || !data.proxyAddress) {
        throw new Error('Invalid wallet data received: missing eoaAddress or proxyAddress');
      }

      this.walletState.eoaAddress = data.eoaAddress;
      this.walletState.proxyAddress = data.proxyAddress;
      this.walletState.isConnected = true;
      this.walletState.error = null;

      // Fetch balance
      await this.fetchBalance();

      this.renderWalletSection();
      alert('Wallet connected successfully!');
    } catch (error) {
      console.error('[Wallet] Connection error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect wallet';
      this.walletState.error = errorMessage;
      this.walletState.isConnected = false;
      this.renderWalletSection();
    } finally {
      this.walletState.isLoading = false;
      this.renderWalletSection();
    }
  }

  private async fetchBalance(): Promise<void> {
    if (!this.walletState.isConnected) {
      return;
    }

    this.walletState.balanceLoading = true;
    this.renderWalletSection();

    try {
      const response = await fetch('/api/wallet/balance');
      const data = await response.json();

      if (response.ok && data.balance !== null && data.balance !== undefined) {
        this.walletState.balance = data.balance;
        // Update trading managers with balance (BTC only)
        const assets: AssetType[] = ['btc'];
        for (const asset of assets) {
          const manager = this.tradingManager.getManager(asset);
          if (manager) {
            (manager as any).setWalletBalance?.(data.balance);
          }
        }
      }
    } catch (error) {
      console.error('Balance fetch error:', error);
    } finally {
      this.walletState.balanceLoading = false;
      this.renderWalletSection();
    }
  }

  private disconnectWallet(): void {
    console.log('[Wallet] Disconnecting wallet...');
    
    // Stop trading for all assets
    this.tradingManager.stopAllTrading();
    
    // Reset wallet state
    this.walletState.isConnected = false;
    this.walletState.eoaAddress = null;
    this.walletState.proxyAddress = null;
    this.walletState.apiCredentials = null;
    this.walletState.balance = null;
    this.walletState.error = null;

    // Reset all asset sessions (BTC only)
    const assets: AssetType[] = ['btc'];
    for (const asset of assets) {
      this.assetSessions.set(asset, {
        isInitialized: false,
        isLoading: false,
        error: null
      });
      // Clear browser CLOB client for each asset
      const manager = this.tradingManager.getManager(asset);
      if (manager) {
        (manager as any).setBrowserClobClient?.(null);
      }
    }

    this.renderWalletSection();
    console.log('[Wallet] Wallet disconnected');
  }

  private async initializeTradingSession(): Promise<void> {
    if (!this.walletState.isConnected) {
      alert('Please connect wallet first');
      return;
    }

    const sessionState = this.assetSessions.get(this.currentAsset);
    if (!sessionState) return;

    sessionState.isLoading = true;
    sessionState.error = null;
    this.renderWalletSection();

    try {
      console.log(`[Session] Initializing ${this.currentAsset.toUpperCase()} trading session...`);

      const response = await fetch('/api/wallet/initialize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to initialize trading session');
      }

      // Store API credentials (shared)
      if (data.credentials) {
        this.walletState.apiCredentials = data.credentials;
        // Set credentials for current asset's trading manager
        this.tradingManager.setApiCredentials(this.currentAsset, data.credentials);
      }

      // Initialize browser CLOB client for THIS asset only
      if (this.walletState.eoaAddress && this.walletState.proxyAddress && data.credentials) {
        await this.initializeBrowserClobClient(this.currentAsset);
        
        // Verify browser client was initialized
        const browserClient = this.tradingManager.getBrowserClobClient(this.currentAsset);
        if (!browserClient) {
          throw new Error('Browser ClobClient initialization failed. Cannot place orders - server-side API is blocked by Cloudflare. Please try reconnecting your wallet.');
        }
      }

      sessionState.isInitialized = true;
      sessionState.error = null;

      // Fetch orders for this asset
      await this.fetchAndDisplayOrders();

      this.renderWalletSection();
      alert(`${ASSET_CONFIG[this.currentAsset].displayName} trading session initialized successfully!`);
    } catch (error) {
      console.error(`[Session] ${this.currentAsset.toUpperCase()} initialization error:`, error);
      sessionState.error = error instanceof Error ? error.message : 'Failed to initialize trading session';
      sessionState.isInitialized = false;
      this.renderWalletSection();
    } finally {
      sessionState.isLoading = false;
      this.renderWalletSection();
    }
  }

  private async initializeBrowserClobClient(asset: AssetType): Promise<void> {
    if (!this.walletState.isConnected || !this.walletState.apiCredentials || !this.walletState.eoaAddress || !this.walletState.proxyAddress) {
      console.warn(`[Browser ClobClient] Cannot initialize ${asset} - wallet not connected or credentials missing`);
      return;
    }

    try {
      const response = await fetch('/api/wallet/private-key', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.warn(`[Browser ClobClient] ${asset} - Private key endpoint not available`);
        return;
      }

      const data = await response.json();
      if (!data.privateKey) {
        throw new Error('Private key not returned from server');
      }

      const { initializeBrowserClobClient } = await import('./streaming-platform-clob-init');
      
      const browserClobClient = await initializeBrowserClobClient(
        data.privateKey,
        this.walletState.apiCredentials!,
        this.walletState.proxyAddress!
      );

      // Set in trading manager for THIS asset only
      const manager = this.tradingManager.getManager(asset);
      if (manager) {
        (manager as any).setBrowserClobClient?.(browserClobClient);
        console.log(`[Browser ClobClient] ✅ ${asset.toUpperCase()} session initialized successfully`);
      }
    } catch (error) {
      console.error(`[Browser ClobClient] ❌ ${asset.toUpperCase()} initialization failed:`, error);
      throw error;
    }
  }

  private async sellPosition(positionId: string): Promise<void> {
    const manager = this.tradingManager.getManager(this.currentAsset);
    if (!manager) return;

    try {
      await (manager as any).closePositionManually?.(positionId, 'Manual sell');
      await this.fetchAndDisplayOrders();
      this.renderTradingSection();
      alert('Position closed successfully!');
    } catch (error) {
      console.error('Error selling position:', error);
      alert(`Error: ${error instanceof Error ? error.message : 'Failed to sell position'}`);
    }
  }

  private async cancelOrder(orderId: string): Promise<void> {
    // Cancel order logic
    console.log(`Canceling order ${orderId} for ${this.currentAsset}`);
    // Implementation would call API to cancel order
    await this.fetchAndDisplayOrders();
  }
}

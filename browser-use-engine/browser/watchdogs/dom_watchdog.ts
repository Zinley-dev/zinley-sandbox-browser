/**
 * DOM watchdog for processing DOM snapshots and browser state management
 * Port from browser_use/browser/watchdogs/dom_watchdog.py (872 lines)
 */
import { EventEmitter } from 'events';
import { Page, CDPSession } from 'patchright';
import { getLogger } from '../../logging_config.js';
import { DOMService, PageState } from '../../dom/service.js';
import { EnhancedDOMTreeNode as DOMEnhancedNode, SerializedDOMState, DOMSelectorMap } from '../../dom/views.js';
import { EnhancedDOMTreeNode as EventEnhancedNode } from '../../events/browser-events.js';
import { BrowserEventNames, BrowserStateRequestEvent } from '../events.js';
import { BrowserStateSummary, PageInfo, NetworkRequest, PaginationButton, TabInfo } from '../views.js';

const logger = getLogger('browser-use.dom_watchdog');

/** Common ad/tracking domains to filter from network requests */
const AD_DOMAINS = [
	'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com',
	'facebook.net', 'analytics', 'ads', 'tracking', 'pixel',
	'hotjar.com', 'clarity.ms', 'mixpanel.com', 'segment.com',
	'demdex.net', 'omtrdc.net', 'adobedtm.com', 'ensighten.com',
	'newrelic.com', 'nr-data.net', 'google-analytics.com',
	'connect.facebook.net', 'platform.twitter.com', 'platform.linkedin.com',
];

/**
 * Create an empty serialized DOM state
 */
function createEmptyDOMState(): SerializedDOMState {
	return {
		root: null,
		selectorMap: new Map(),
	};
}

export interface DOMWatchdogOptions {
	/** Enable cross-origin iframes */
	crossOriginIframes?: boolean;
	/** Enable paint order filtering */
	paintOrderFiltering?: boolean;
	/** Maximum number of iframes to process */
	maxIframes?: number;
	/** Maximum iframe depth */
	maxIframeDepth?: number;
	/** Highlight elements in browser */
	highlightElements?: boolean;
	/** Enable adaptive network idle */
	enableAdaptiveNetworkIdle?: boolean;
	/** Network idle time in seconds */
	networkIdleTime?: number;
	/** Max in-flight requests for idle */
	networkIdleMaxInflight?: number;
	/** Network idle timeout in seconds */
	networkIdleTimeout?: number;
	/** Network idle poll interval in seconds */
	networkIdlePollInterval?: number;
	/** Minimum wait time before extracting DOM (seconds) */
	minimumWaitPageLoadTime?: number;
	/** Fixed wait time for network idle (seconds) - for dynamic content like iframes */
	waitForNetworkIdlePageLoadTime?: number;
}

export class DOMWatchdog {
	private isRunning: boolean = false;
	private page: Page | null = null;
	private cdpSession: CDPSession | null = null;
	private domService: DOMService | null = null;

	// Public properties for other watchdogs
	public selectorMap: Map<number, EventEnhancedNode> | null = null;
	public currentDomState: SerializedDOMState | null = null;
	public enhancedDomTree: DOMEnhancedNode | null = null;

	// Configuration
	private crossOriginIframes: boolean;
	private paintOrderFiltering: boolean;
	private maxIframes: number;
	private maxIframeDepth: number;
	private highlightElements: boolean;
	private enableAdaptiveNetworkIdle: boolean;
	private networkIdleTime: number;
	private networkIdleMaxInflight: number;
	private networkIdleTimeout: number;
	private networkIdlePollInterval: number;
	private minimumWaitPageLoadTime: number;
	private waitForNetworkIdlePageLoadTime: number;

	// Callbacks
	private getTabsCallback: (() => Promise<TabInfo[]>) | null = null;
	private getCurrentUrlCallback: (() => Promise<string>) | null = null;
	private getCurrentTitleCallback: (() => Promise<string>) | null = null;

	constructor(
		private eventBus: EventEmitter,
		options: DOMWatchdogOptions = {}
	) {
		this.crossOriginIframes = options.crossOriginIframes ?? true;
		this.paintOrderFiltering = options.paintOrderFiltering ?? true;
		this.maxIframes = options.maxIframes ?? 5;
		this.maxIframeDepth = options.maxIframeDepth ?? 3;
		this.highlightElements = options.highlightElements ?? false;
		this.enableAdaptiveNetworkIdle = options.enableAdaptiveNetworkIdle ?? true;
		this.networkIdleTime = options.networkIdleTime ?? 0.5;
		this.networkIdleMaxInflight = options.networkIdleMaxInflight ?? 2;
		this.networkIdleTimeout = options.networkIdleTimeout ?? 5.0;
		this.networkIdlePollInterval = options.networkIdlePollInterval ?? 0.2;
		this.minimumWaitPageLoadTime = options.minimumWaitPageLoadTime ?? 0;
		this.waitForNetworkIdlePageLoadTime = options.waitForNetworkIdlePageLoadTime ?? 0.5;
	}

	/**
	 * Set the page and CDP session to use
	 */
	setPage(page: Page): void {
		this.page = page;
		// Create DOM service with the page
		this.domService = new DOMService(page, {
			crossOriginIframes: this.crossOriginIframes,
			paintOrderFiltering: this.paintOrderFiltering,
			maxIframes: this.maxIframes,
			maxIframeDepth: this.maxIframeDepth,
		});
	}

	/**
	 * Set the CDP session to use
	 */
	setCDPSession(cdpSession: CDPSession): void {
		this.cdpSession = cdpSession;
	}

	/**
	 * Set callback functions for browser state
	 */
	setCallbacks(callbacks: {
		getTabs?: () => Promise<TabInfo[]>;
		getCurrentUrl?: () => Promise<string>;
		getCurrentTitle?: () => Promise<string>;
	}): void {
		if (callbacks.getTabs) this.getTabsCallback = callbacks.getTabs;
		if (callbacks.getCurrentUrl) this.getCurrentUrlCallback = callbacks.getCurrentUrl;
		if (callbacks.getCurrentTitle) this.getCurrentTitleCallback = callbacks.getCurrentTitle;
	}

	/**
	 * Get pending network requests using performance API
	 */
	async getPendingNetworkRequests(): Promise<NetworkRequest[]> {
		if (!this.cdpSession) return [];

		try {
			const jsCode = `
(function() {
	const now = performance.now();
	const resources = performance.getEntriesByType('resource');
	const pending = [];
	const adDomains = ${JSON.stringify(AD_DOMAINS)};

	for (const entry of resources) {
		if (entry.responseEnd === 0) {
			const url = entry.name;
			const isAd = adDomains.some(domain => url.includes(domain));
			if (isAd) continue;
			if (url.startsWith('data:') || url.length > 500) continue;

			const loadingDuration = now - entry.startTime;
			if (loadingDuration > 10000) continue;

			const resourceType = entry.initiatorType || 'unknown';
			const nonCriticalTypes = ['img', 'image', 'icon', 'font'];
			if (nonCriticalTypes.includes(resourceType) && loadingDuration > 3000) continue;

			const isImageUrl = /\\.(jpg|jpeg|png|gif|webp|svg|ico)(\\?|$)/i.test(url);
			if (isImageUrl && loadingDuration > 3000) continue;

			pending.push({
				url: url,
				method: 'GET',
				loading_duration_ms: Math.round(loadingDuration),
				resource_type: resourceType
			});
		}
	}

	return pending;
})()
`;

			const result = await this.cdpSession.send('Runtime.evaluate', {
				expression: jsCode,
				returnByValue: true,
			});

			if (result?.result?.value) {
				const pending = result.result.value as any[];
				return pending.slice(0, 20).map(req => ({
					url: req.url,
					method: req.method || 'GET',
					loadingDurationMs: req.loading_duration_ms || 0,
					resourceType: req.resource_type,
				}));
			}
		} catch (error: any) {
			logger.debug(`Failed to get pending network requests: ${error.message}`);
		}

		return [];
	}

	/**
	 * Wait for network to become idle
	 */
	async waitForNetworkIdle(): Promise<boolean> {
		const startTime = Date.now();
		let lastChangeTime = startTime;

		while (Date.now() - startTime < this.networkIdleTimeout * 1000) {
			try {
				const pending = await this.getPendingNetworkRequests();
				const currentInflight = pending.length;

				if (currentInflight <= this.networkIdleMaxInflight) {
					if (Date.now() - lastChangeTime >= this.networkIdleTime * 1000) {
						logger.debug(`Network idle achieved: ${currentInflight} requests`);
						return true;
					}
				} else {
					logger.debug(`Network busy: ${currentInflight} pending requests`);
					lastChangeTime = Date.now();
				}

				await new Promise(resolve => setTimeout(resolve, this.networkIdlePollInterval * 1000));
			} catch (error) {
				await new Promise(resolve => setTimeout(resolve, this.networkIdlePollInterval * 1000));
			}
		}

		logger.debug(`Network idle timeout after ${(Date.now() - startTime) / 1000}s`);
		return false;
	}

	/**
	 * Get comprehensive page info from CDP
	 */
	async getPageInfo(): Promise<PageInfo> {
		if (!this.cdpSession) {
			return {
				viewportWidth: 1280,
				viewportHeight: 720,
				pageWidth: 1280,
				pageHeight: 720,
				scrollX: 0,
				scrollY: 0,
				pixelsAbove: 0,
				pixelsBelow: 0,
				pixelsLeft: 0,
				pixelsRight: 0,
			};
		}

		try {
			const metrics = await this.cdpSession.send('Page.getLayoutMetrics');

			const layoutViewport = (metrics as any).layoutViewport || {};
			const visualViewport = (metrics as any).visualViewport || {};
			const cssVisualViewport = (metrics as any).cssVisualViewport || {};
			const cssLayoutViewport = (metrics as any).cssLayoutViewport || {};
			const contentSize = (metrics as any).contentSize || {};

			// Calculate device pixel ratio
			const cssWidth = cssVisualViewport.clientWidth || cssLayoutViewport.clientWidth || 1280;
			const deviceWidth = visualViewport.clientWidth || cssWidth;
			const devicePixelRatio = deviceWidth / cssWidth || 1;

			// Viewport dimensions in CSS pixels
			const viewportWidth = Math.round(cssLayoutViewport.clientWidth || layoutViewport.clientWidth || 1280);
			const viewportHeight = Math.round(cssLayoutViewport.clientHeight || layoutViewport.clientHeight || 720);

			// Page dimensions converted to CSS pixels
			const rawPageWidth = contentSize.width || viewportWidth * devicePixelRatio;
			const rawPageHeight = contentSize.height || viewportHeight * devicePixelRatio;
			const pageWidth = Math.round(rawPageWidth / devicePixelRatio);
			const pageHeight = Math.round(rawPageHeight / devicePixelRatio);

			// Scroll position in CSS pixels
			const scrollX = Math.round(cssVisualViewport.pageX || cssLayoutViewport.pageX || 0);
			const scrollY = Math.round(cssVisualViewport.pageY || cssLayoutViewport.pageY || 0);

			// Calculate scroll offsets
			const pixelsAbove = scrollY;
			const pixelsBelow = Math.max(0, pageHeight - viewportHeight - scrollY);
			const pixelsLeft = scrollX;
			const pixelsRight = Math.max(0, pageWidth - viewportWidth - scrollX);

			return {
				viewportWidth,
				viewportHeight,
				pageWidth,
				pageHeight,
				scrollX,
				scrollY,
				pixelsAbove,
				pixelsBelow,
				pixelsLeft,
				pixelsRight,
			};
		} catch (error: any) {
			logger.debug(`Failed to get page info: ${error.message}`);
			return {
				viewportWidth: 1280,
				viewportHeight: 720,
				pageWidth: 1280,
				pageHeight: 720,
				scrollX: 0,
				scrollY: 0,
				pixelsAbove: 0,
				pixelsBelow: 0,
				pixelsLeft: 0,
				pixelsRight: 0,
			};
		}
	}

	/**
	 * Build DOM tree using the DOM service
	 */
	async buildDomTree(): Promise<{ domState: SerializedDOMState; pageState: PageState | null }> {
		logger.debug('Building DOM tree');

		if (!this.domService) {
			logger.warn('No DOM service available, returning empty state');
			return { domState: createEmptyDOMState(), pageState: null };
		}

		try {
			// Get page state from DOM service
			const pageState = await this.domService.getPageState({
				useCDPAccessibility: true,
			});

			// Update cached state - use the selectorMap from PageState
			this.selectorMap = pageState.selectorMap;

			// Convert to SerializedDOMState format
			const domState: SerializedDOMState = {
				root: null,
				selectorMap: new Map(), // Empty map for now, would need proper conversion
			};

			this.currentDomState = domState;
			return { domState, pageState };
		} catch (error: any) {
			logger.warn(`DOM build failed: ${error.message}`);
			return { domState: createEmptyDOMState(), pageState: null };
		}
	}

	/**
	 * Detect pagination buttons from the DOM
	 */
	detectPaginationButtons(selectorMap: Map<number, EventEnhancedNode>): PaginationButton[] {
		const buttons: PaginationButton[] = [];

		// Common pagination patterns
		const paginationPatterns = [
			{ text: /^(next|→|>|>>|›)$/i, type: 'next' as const },
			{ text: /^(prev|previous|←|<|<<|‹)$/i, type: 'previous' as const },
			{ text: /^\d+$/, type: 'page' as const },
		];

		for (const [index, node] of selectorMap.entries()) {
			const tagName = node.nodeName?.toLowerCase() || '';
			if (!['a', 'button', 'span', 'li'].includes(tagName)) continue;

			// Use text or nodeValue for text content
			const text = (node.text || node.nodeValue || '').trim().toLowerCase();
			const ariaLabel = (node.attributes?.['aria-label'] || '').toLowerCase();

			for (const pattern of paginationPatterns) {
				if (pattern.text.test(text) || pattern.text.test(ariaLabel)) {
					const isDisabled = node.attributes?.['disabled'] === 'true' ||
						node.attributes?.['aria-disabled'] === 'true' ||
						(node.attributes?.['class'] || '').includes('disabled');

					buttons.push({
						buttonType: pattern.type,
						backendNodeId: node.backendNodeId || index,
						text: text || ariaLabel,
						selector: `[data-index="${index}"]`,
						isDisabled,
					});
					break;
				}
			}
		}

		return buttons;
	}

	/**
	 * Handle browser state request event
	 */
	async handleBrowserStateRequestEvent(
		event: BrowserStateRequestEvent & { _eventId?: string }
	): Promise<BrowserStateSummary> {
		logger.debug('DOMWatchdog: Starting browser state request');

		const includeDom = event.includeDom ?? true;
		const includeScreenshot = event.includeScreenshot ?? true;

		// Get current page URL
		let pageUrl = '';
		if (this.getCurrentUrlCallback) {
			try {
				pageUrl = await this.getCurrentUrlCallback();
			} catch (e) {
				pageUrl = '';
			}
		}

		const notAMeaningfulWebsite = !pageUrl.toLowerCase().startsWith('http');

		// Get pending network requests before waiting
		let pendingRequests: NetworkRequest[] = [];
		if (!notAMeaningfulWebsite) {
			pendingRequests = await this.getPendingNetworkRequests();
		}

		// Wait for page stability - Python-style conditional waiting
		// Only wait if there are actually pending requests (much faster than always waiting)
		if (!notAMeaningfulWebsite) {
			if (pendingRequests.length > 0) {
				// Python approach: Only wait 0.3s if there are pending requests
				// This is much faster than always waiting fixed times
				logger.debug(`⏳ ${pendingRequests.length} pending requests, waiting 0.3s for critical resources`);
				await new Promise(resolve => setTimeout(resolve, 300));
			} else {
				logger.debug('✅ No pending requests, skipping wait');
			}
		}

		// Get tabs info
		let tabsInfo: TabInfo[] = [];
		if (this.getTabsCallback) {
			try {
				tabsInfo = await this.getTabsCallback();
			} catch (e) {
				tabsInfo = [];
			}
		}

		// Get page info
		const pageInfo = await this.getPageInfo();

		// Handle empty/non-HTTP pages
		if (notAMeaningfulWebsite) {
			logger.debug(`Skipping DOM build for empty target: ${pageUrl}`);
			return {
				domState: createEmptyDOMState(),
				url: pageUrl,
				title: 'Empty Tab',
				tabs: tabsInfo,
				screenshot: null,
				pageInfo,
				pixelsAbove: 0,
				pixelsBelow: 0,
				browserErrors: [],
				isPdfViewer: false,
				recentEvents: null,
				pendingNetworkRequests: [],
				paginationButtons: [],
			};
		}

		// Build DOM and capture screenshot in parallel
		let domState: SerializedDOMState = createEmptyDOMState();
		let screenshotB64: string | null = null;

		const tasks: Promise<any>[] = [];

		if (includeDom) {
			tasks.push(
				this.buildDomTree().then(result => {
					domState = result.domState;
				}).catch(e => {
					logger.warn(`DOM build failed: ${e.message}`);
				})
			);
		}

		if (includeScreenshot && this.cdpSession) {
			tasks.push(
				this.cdpSession.send('Page.captureScreenshot', {
					format: 'jpeg',
					quality: 60,
					captureBeyondViewport: false,
				}).then(result => {
					screenshotB64 = (result as any)?.data || null;
				}).catch(e => {
					logger.warn(`Screenshot failed: ${e.message}`);
				})
			);
		}

		await Promise.all(tasks);

		// Get page title
		let title = 'Page';
		if (this.getCurrentTitleCallback) {
			try {
				title = await this.getCurrentTitleCallback();
			} catch (e) {
				title = 'Page';
			}
		}

		// Check for PDF viewer
		const isPdfViewer = pageUrl.endsWith('.pdf') || pageUrl.includes('/pdf/');

		// Detect pagination buttons
		let paginationButtons: PaginationButton[] = [];
		if (this.selectorMap) {
			paginationButtons = this.detectPaginationButtons(this.selectorMap);
		}

		const browserState: BrowserStateSummary = {
			domState,
			url: pageUrl,
			title,
			tabs: tabsInfo,
			screenshot: screenshotB64,
			pageInfo,
			pixelsAbove: pageInfo.pixelsAbove,
			pixelsBelow: pageInfo.pixelsBelow,
			browserErrors: [],
			isPdfViewer,
			recentEvents: null,
			pendingNetworkRequests: pendingRequests,
			paginationButtons,
		};

		logger.debug('DOMWatchdog: Browser state request completed');
		return browserState;
	}

	/**
	 * Get element by index from cached selector map
	 */
	getElementByIndex(index: number): EventEnhancedNode | null {
		if (!this.selectorMap) return null;
		return this.selectorMap.get(index) || null;
	}

	/**
	 * Clear cached DOM state
	 */
	clearCache(): void {
		this.selectorMap = null;
		this.currentDomState = null;
		this.enhancedDomTree = null;
	}

	/**
	 * Check if element is a file input
	 */
	isFileInput(element: EventEnhancedNode): boolean {
		return (
			element.nodeName?.toUpperCase() === 'INPUT' &&
			(element.attributes?.type || '').toLowerCase() === 'file'
		);
	}

	/**
	 * Start the watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;

		// Register event handler for browser state requests
		this.eventBus.on(
			BrowserEventNames.BROWSER_STATE_REQUEST,
			async (event: BrowserStateRequestEvent & { _eventId?: string }) => {
				try {
					const result = await this.handleBrowserStateRequestEvent(event);
					if (event._eventId) {
						(this.eventBus as any).respondToEvent?.(event._eventId, result);
					}
				} catch (error) {
					if (event._eventId) {
						(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
					}
				}
			}
		);

		logger.debug('[DOMWatchdog] Started monitoring');
	}

	/**
	 * Stop the watchdog
	 */
	async stop(): Promise<void> {
		this.isRunning = false;
		this.clearCache();
		this.page = null;
		this.cdpSession = null;
		this.domService = null;
		logger.debug('[DOMWatchdog] Stopped monitoring');
	}
}

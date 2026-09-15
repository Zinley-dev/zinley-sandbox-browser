/**
 * Crash watchdog for detecting and recovering from browser crashes
 * Port from browser_use/browser/watchdogs/crash_watchdog.py
 */
import { EventEmitter } from 'events';
import { Page, CDPSession } from 'patchright';

export interface NetworkRequestTracker {
	requestId: string;
	startTime: number;
	url: string;
	method: string;
	resourceType?: string;
}

export interface CrashWatchdogOptions {
	/** Network timeout in seconds */
	networkTimeoutSeconds?: number;
	/** Check interval in seconds */
	checkIntervalSeconds?: number;
}

export class CrashWatchdog {
	private isRunning: boolean = false;
	private monitoringInterval: NodeJS.Timeout | null = null;
	private activeRequests: Map<string, NetworkRequestTracker> = new Map();
	private page: Page | null = null;
	private cdpSession: CDPSession | null = null;
	private networkTimeoutSeconds: number;
	private checkIntervalSeconds: number;
	private sessionsWithListeners: Set<string> = new Set();

	constructor(
		private eventBus: EventEmitter,
		options: CrashWatchdogOptions = {}
	) {
		this.networkTimeoutSeconds = options.networkTimeoutSeconds ?? 10.0;
		this.checkIntervalSeconds = options.checkIntervalSeconds ?? 5.0;
	}

	/**
	 * Set the page to monitor
	 */
	setPage(page: Page): void {
		this.page = page;
		this.setupPageListeners();
	}

	/**
	 * Set up page crash listeners
	 */
	private setupPageListeners(): void {
		if (!this.page) return;

		// Listen for page crashes
		this.page.on('crash', () => {
			console.error('[CrashWatchdog] Page crashed!');
			this.eventBus.emit('browser:error', {
				errorType: 'PageCrash',
				message: 'Page has crashed',
				details: { url: this.page?.url() || 'unknown' },
			});
		});

		// Listen for page close
		this.page.on('close', () => {
			console.log('[CrashWatchdog] Page closed');
		});
	}

	/**
	 * Attach to a CDP session for crash monitoring
	 */
	async attachToCDPSession(cdpSession: CDPSession, sessionId?: string): Promise<void> {
		try {
			// Check if we already have listeners for this session
			const id = sessionId || 'default';
			if (this.sessionsWithListeners.has(id)) {
				return;
			}

			this.cdpSession = cdpSession;

			// Set up network event handlers for timeout detection
			cdpSession.on('Network.requestWillBeSent', (event: any) => {
				this.onNetworkRequest(event);
			});

			cdpSession.on('Network.responseReceived', (event: any) => {
				this.onNetworkResponse(event);
			});

			cdpSession.on('Network.loadingFailed', (event: any) => {
				this.onNetworkLoadingFailed(event);
			});

			cdpSession.on('Network.loadingFinished', (event: any) => {
				this.onNetworkLoadingFinished(event);
			});

			// Listen for target crashes via CDP
			cdpSession.on('Target.targetCrashed', async (event: any) => {
				await this.onTargetCrash(event);
			});

			// Track that we've added listeners
			this.sessionsWithListeners.add(id);

			// Enable network events
			await cdpSession.send('Network.enable').catch(() => {});

		} catch (error: any) {
			console.warn(`[CrashWatchdog] Failed to attach to CDP session: ${error.message}`);
		}
	}

	/**
	 * Handle network request
	 */
	private onNetworkRequest(event: any): void {
		const requestId = event.requestId || '';
		const request = event.request || {};

		this.activeRequests.set(requestId, {
			requestId,
			startTime: Date.now(),
			url: request.url || '',
			method: request.method || '',
			resourceType: event.type,
		});
	}

	/**
	 * Handle network response
	 */
	private onNetworkResponse(event: any): void {
		// Don't remove yet - wait for loadingFinished
	}

	/**
	 * Handle network loading failed
	 */
	private onNetworkLoadingFailed(event: any): void {
		const requestId = event.requestId || '';
		this.activeRequests.delete(requestId);
	}

	/**
	 * Handle network loading finished
	 */
	private onNetworkLoadingFinished(event: any): void {
		const requestId = event.requestId || '';
		this.activeRequests.delete(requestId);
	}

	/**
	 * Handle target crash
	 */
	private async onTargetCrash(event: any): Promise<void> {
		const targetId = event.targetId;
		console.error(`[CrashWatchdog] Target crashed: ${targetId}`);

		this.eventBus.emit('browser:error', {
			errorType: 'TargetCrash',
			message: `Target crashed: ${targetId}`,
			details: { targetId },
		});
	}

	/**
	 * Start the watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;

		// Start monitoring loop
		this.monitoringInterval = setInterval(async () => {
			try {
				await this.checkNetworkTimeouts();
				await this.checkBrowserHealth();
			} catch (error: any) {
				console.error(`[CrashWatchdog] Error in monitoring loop: ${error.message}`);
			}
		}, this.checkIntervalSeconds * 1000);

		console.log('[CrashWatchdog] Started monitoring');
	}

	/**
	 * Stop the watchdog
	 */
	async stop(): Promise<void> {
		this.isRunning = false;

		if (this.monitoringInterval) {
			clearInterval(this.monitoringInterval);
			this.monitoringInterval = null;
		}

		this.activeRequests.clear();
		this.sessionsWithListeners.clear();

		console.log('[CrashWatchdog] Stopped monitoring');
	}

	/**
	 * Check for network requests exceeding timeout
	 */
	private async checkNetworkTimeouts(): Promise<void> {
		const currentTime = Date.now();
		const timedOutRequests: Array<[string, NetworkRequestTracker]> = [];

		for (const [requestId, tracker] of this.activeRequests) {
			const elapsedSeconds = (currentTime - tracker.startTime) / 1000;
			if (elapsedSeconds >= this.networkTimeoutSeconds) {
				timedOutRequests.push([requestId, tracker]);
			}
		}

		// Emit events for timed out requests
		for (const [requestId, tracker] of timedOutRequests) {
			console.warn(
				`[CrashWatchdog] Network request timeout after ${this.networkTimeoutSeconds}s: ` +
				`${tracker.method} ${tracker.url.substring(0, 100)}...`
			);

			this.eventBus.emit('browser:error', {
				errorType: 'NetworkTimeout',
				message: `Network request timed out after ${this.networkTimeoutSeconds}s`,
				details: {
					url: tracker.url,
					method: tracker.method,
					resourceType: tracker.resourceType,
					elapsedSeconds: (currentTime - tracker.startTime) / 1000,
				},
			});

			// Remove from tracking
			this.activeRequests.delete(requestId);
		}
	}

	/**
	 * Check if browser and page are still responsive
	 */
	private async checkBrowserHealth(): Promise<void> {
		if (!this.page) return;

		try {
			// Quick ping to check if page is responsive
			await Promise.race([
				this.page.evaluate(() => 1 + 1),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('Health check timeout')), 5000)
				),
			]);
		} catch (error: any) {
			console.error(`[CrashWatchdog] Browser health check failed: ${error.message}`);

			this.eventBus.emit('browser:error', {
				errorType: 'BrowserUnresponsive',
				message: 'Browser is not responding',
				details: { error: error.message },
			});
		}
	}

	/**
	 * Check if URL is a new tab page
	 */
	static isNewTabPage(url: string): boolean {
		return ['about:blank', 'chrome://new-tab-page/', 'chrome://newtab/'].includes(url);
	}
}

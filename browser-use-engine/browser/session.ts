/**
 * Browser session management using Playwright
 */

import { chromium, Browser, BrowserContext, Page, CDPSession, ElementHandle } from 'patchright';
import { EventBus, TIMEOUTS } from '../events/base.js';
import {
	BrowserEventNames,
	NavigateToUrlEvent,
	ClickElementEvent,
	TypeTextEvent,
	ScrollEvent,
	ScreenshotEvent,
	GoBackEvent,
	GoForwardEvent,
	RefreshEvent,
	WaitEvent,
	SendKeysEvent,
	EnhancedDOMTreeNode,
	BrowserStateRequestEvent,
	UploadFileEvent,
	GetDropdownOptionsEvent,
	SelectDropdownOptionEvent,
} from '../events/browser-events.js';
import { BrowserStateSummary, TabInfo, PageInfo } from './views.js';
import { DOMService, PageState } from '../dom/service.js';
import { saveImportedProfile, getDefaultProfilePath, ImportedProfile } from './profile-import.js';
import { SerializedDOMState, SimplifiedNode, EnhancedDOMTreeNode as DOMEnhancedNode, NodeType } from '../dom/views.js';
import { getConfig } from '../config.js';
import { fontSizes } from '../typography.js';
import { v4 as uuidv4 } from 'uuid';
import { createHighlightedScreenshot } from '../screenshots/highlights.js';

/**
 * Get the default Chrome profile path for the current OS
 * Using real Chrome profile helps with Cloudflare bypass (existing cookies, history, fingerprint)
 */
export function getRealChromeProfilePath(): string {
	const platform = process.platform;
	const home = process.env.HOME || process.env.USERPROFILE || '';

	if (platform === 'darwin') {
		return `${home}/Library/Application Support/Google/Chrome`;
	} else if (platform === 'win32') {
		return `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`;
	} else {
		return `${home}/.config/google-chrome`;
	}
}

export interface BrowserSessionOptions {
	/** Session ID */
	id?: string;

	/** Launch browser in headless mode - WARNING: headless is much easier to detect */
	headless?: boolean;

	/** User data directory for persistent session */
	userDataDir?: string;

	/**
	 * Use real Chrome profile for maximum stealth
	 * This uses your actual Chrome cookies, history, and fingerprint
	 * WARNING: Close Chrome before using this, can't have two instances with same profile
	 */
	useRealChromeProfile?: boolean;

	/** Executable path to browser */
	executablePath?: string;

	/** Chrome channel (chrome, chrome-beta, chrome-dev, msedge, etc.) */
	channel?: string;

	/** Browser args */
	args?: string[];

	/** Viewport size */
	viewport?: { width: number; height: number };

	/** User agent */
	userAgent?: string;

	/** Accept downloads */
	acceptDownloads?: boolean;

	/** Downloads path */
	downloadsPath?: string;

	/** Disable security features (CORS, CSP, etc.) */
	disableSecurity?: boolean;

	/** Storage state (cookies, localStorage) to restore on launch */
	storageState?: { cookies: any[]; origins: any[] };
}

export class BrowserSession {
	public readonly id: string;
	public readonly eventBus: EventBus;

	private options: BrowserSessionOptions;
	private browser?: Browser;
	private context?: BrowserContext;
	private pages: Map<string, Page> = new Map();
	private currentPageId?: string;
	private started: boolean = false;

	// Cached selector map for element lookup by index (session-wide for single agent)
	private cachedSelectorMap: Map<number, EnhancedDOMTreeNode> = new Map();
	private cachedBrowserStateSummary: BrowserStateSummary | null = null;

	// Per-page selector maps for multi-agent support
	// Key: pageId, Value: selector map for that page
	private pageSelectorMaps: Map<string, Map<number, EnhancedDOMTreeNode>> = new Map();

	// Network idle detection
	private pendingRequests: Set<string> = new Set();
	private networkIdleConfig = {
		enabled: true,
		idleTime: 0.5, // Network must be idle for this duration (seconds)
		maxInflight: 2, // Maximum in-flight requests to consider "idle"
		timeout: 10.0, // Maximum time to wait for network idle (seconds)
		pollInterval: 0.1, // How often to check network state (seconds)
	};

	// Downloads tracking
	private _downloadedFiles: string[] = [];

	/** Messages from JavaScript dialogs auto-closed since the last browser state (Python _closed_popup_messages) */
	private closedPopupMessages: string[] = [];

	/** Screenshot size the LLM sees (set by the Agent when resizing is enabled) */
	llmScreenshotSize: [number, number] | null = null;
	/** Real viewport size matching the last screenshot (for coordinate conversion) */
	originalViewportSize: [number, number] | null = null;

	// CDP session cache (for single-agent backwards compatibility)
	private cdpSession: CDPSession | null = null;

	// Per-page CDP sessions for multi-agent support
	private pageCdpSessions: Map<string, CDPSession> = new Map();

	// Highlight state
	private highlightsAdded: boolean = false;

	constructor(options: BrowserSessionOptions = {}) {
		this.id = options.id || uuidv4();
		this.options = options;
		this.eventBus = new EventBus();

		// Register event handlers
		this.registerEventHandlers();
	}

	private registerEventHandlers() {
		// Navigation
		this.eventBus.on(BrowserEventNames.NAVIGATE_TO_URL, async (payload: any) => {
			await this.handleNavigateToUrl(payload);
		});

		// Interaction
		this.eventBus.on(BrowserEventNames.CLICK_ELEMENT, async (payload: any) => {
			await this.handleClickElement(payload);
		});

		this.eventBus.on(BrowserEventNames.TYPE_TEXT, async (payload: any) => {
			await this.handleTypeText(payload);
		});

		this.eventBus.on(BrowserEventNames.SCROLL, async (payload: any) => {
			await this.handleScroll(payload);
		});

		// Browser state
		this.eventBus.on(BrowserEventNames.BROWSER_STATE_REQUEST, async (payload: any) => {
			await this.handleBrowserStateRequest(payload);
		});

		this.eventBus.on(BrowserEventNames.SCREENSHOT, async (payload: any) => {
			await this.handleScreenshot(payload);
		});

		// History
		this.eventBus.on(BrowserEventNames.GO_BACK, async (payload: any) => {
			await this.handleGoBack(payload);
		});

		this.eventBus.on(BrowserEventNames.GO_FORWARD, async (payload: any) => {
			await this.handleGoForward(payload);
		});

		this.eventBus.on(BrowserEventNames.REFRESH, async (payload: any) => {
			await this.handleRefresh(payload);
		});

		// Utilities
		this.eventBus.on(BrowserEventNames.WAIT, async (payload: any) => {
			await this.handleWait(payload);
		});

		this.eventBus.on(BrowserEventNames.SEND_KEYS, async (payload: any) => {
			await this.handleSendKeys(payload);
		});

		// File upload
		this.eventBus.on(BrowserEventNames.UPLOAD_FILE, async (payload: any) => {
			await this.handleUploadFile(payload);
		});

		// Dropdown handling
		this.eventBus.on(BrowserEventNames.GET_DROPDOWN_OPTIONS, async (payload: any) => {
			await this.handleGetDropdownOptions(payload);
		});

		this.eventBus.on(BrowserEventNames.SELECT_DROPDOWN_OPTION, async (payload: any) => {
			await this.handleSelectDropdownOption(payload);
		});
	}

	/**
	 * Start the browser session
	 */
	async start(): Promise<void> {
		if (this.started) {
			return;
		}

		// Stealth args to avoid bot detection
		const stealthArgs = [
			'--disable-blink-features=AutomationControlled',
			'--disable-infobars',
			'--disable-dev-shm-usage',
			'--disable-browser-side-navigation',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows',
			'--disable-renderer-backgrounding',
			'--disable-component-update',
			'--disable-features=TranslateUI',
		];

		const launchOptions: any = {
			headless: this.options.headless ?? false,
			args: [...stealthArgs, ...(this.options.args || [])],
			// Remove automation indicators
			ignoreDefaultArgs: ['--enable-automation'],
			// Use real Chrome for better fingerprint (Patchright works best with Chrome, not Chromium)
			channel: this.options.channel || 'chrome',
		};

		if (this.options.executablePath) {
			launchOptions.executablePath = this.options.executablePath;
			// If custom executable, don't override with channel
			delete launchOptions.channel;
		}

		// Add security bypass args if requested
		if (this.options.disableSecurity) {
			launchOptions.args.push(
				'--disable-web-security',
				'--disable-features=IsolateOrigins,site-per-process'
			);
		}

		// Create context options
		// When viewport is null, don't emulate viewport (content adapts to window size - like Python's no_viewport)
		const contextOptions: any = {
			acceptDownloads: this.options.acceptDownloads ?? true,
		};

		// Only set viewport if explicitly provided (null means no viewport emulation)
		// This matches Python's behavior where no_viewport=True means viewport=None
		if (this.options.viewport) {
			contextOptions.viewport = this.options.viewport;
		} else if (this.options.headless) {
			// Headless mode needs a viewport for rendering
			contextOptions.viewport = { width: 1280, height: 720 };
		} else {
			// Headful mode: null viewport lets content adapt to window (Python default)
			contextOptions.viewport = null;
		}

		if (this.options.userAgent) {
			contextOptions.userAgent = this.options.userAgent;
		}

		if (this.options.downloadsPath) {
			contextOptions.downloadsPath = this.options.downloadsPath;
		}

		// Apply imported profile (cookies/localStorage) if provided
		if (this.options.storageState) {
			contextOptions.storageState = this.options.storageState;
			console.log(`🍪 [BrowserSession] Restoring profile with ${this.options.storageState.cookies?.length || 0} cookies`);
		}

		// Always use persistent context to preserve credentials, cookies, and session data
		const cfg = getConfig();
		let userDataDir: string;

		if (this.options.useRealChromeProfile) {
			// Use actual Chrome profile for maximum stealth
			// WARNING: Chrome must be closed, can't share profile
			userDataDir = getRealChromeProfilePath();
			console.log(`🔐 [BrowserSession] Using REAL Chrome profile for maximum stealth: ${userDataDir}`);
			console.log(`⚠️  [BrowserSession] Make sure Chrome is closed before starting!`);
		} else if (this.options.userDataDir) {
			userDataDir = this.options.userDataDir;
		} else {
			userDataDir = cfg.BROWSER_USE_DEFAULT_USER_DATA_DIR;
		}

		console.log(`🗂️ [BrowserSession] Using persistent user data directory: ${userDataDir}`);

		// Note: storageState option is NOT supported by launchPersistentContext
		// We need to apply cookies manually after context creation
		const { storageState: pendingStorageState, ...persistentContextOptions } = contextOptions;

		this.context = await chromium.launchPersistentContext(
			userDataDir,
			{
				...launchOptions,
				...persistentContextOptions,
			}
		);
		// For persistent context, browser is part of context
		this.browser = (this.context as any).browser?.() || null;

		// Apply imported cookies AFTER context creation (storageState option doesn't work with persistent context)
		if (pendingStorageState?.cookies && pendingStorageState.cookies.length > 0) {
			try {
				await this.context.addCookies(pendingStorageState.cookies);
				console.log(`🍪 [BrowserSession] Applied ${pendingStorageState.cookies.length} imported cookies to persistent context`);
			} catch (error: any) {
				console.warn(`⚠️ [BrowserSession] Failed to apply imported cookies: ${error.message}`);
			}
		}

		// Initial page: a persistent context already opens one about:blank tab.
		// Reuse it — creating another here left a stray blank tab in EVERY
		// session (visible to the user on takeover / in the desktop window).
		// Any further blank tabs the profile restored are closed; real restored
		// pages are left alone.
		const preOpened = this.context.pages();
		const page = preOpened.find(p => this.isNewTabPage(p.url())) ?? (await this.context.newPage());
		for (const extra of preOpened) {
			if (extra !== page && this.isNewTabPage(extra.url())) {
				await extra.close().catch(() => undefined);
			}
		}
		const pageId = this.generatePageId();
		this.pages.set(pageId, page);
		this.currentPageId = pageId;

		// Inject stealth scripts to avoid bot detection
		await this.injectStealthScripts(page);

		// Set up page event listeners
		this.setupPageListeners(page, pageId);

		// Listen for context close (user closes browser window, etc.)
		// Try to save storage state before connection is fully lost
		this.context.on('close', async () => {
			await this.saveStorageStateIfPossible();
		});

		this.started = true;
	}

	/**
	 * Save current storage state to profile (public method for manual saves)
	 * Call this after important actions like login to ensure persistence
	 */
	async saveStorageState(): Promise<boolean> {
		return this.saveStorageStateIfPossible();
	}

	/**
	 * Internal method to save storage state with error handling
	 */
	private async saveStorageStateIfPossible(): Promise<boolean> {
		if (!this.context) return false;

		try {
			const storageState = await this.context.storageState();
			if (storageState.cookies.length > 0 || storageState.origins.length > 0) {
				const profile: ImportedProfile = {
					cookies: storageState.cookies,
					origins: storageState.origins,
					importedAt: new Date().toISOString(),
					sourceType: 'running-chrome',
					cookieCount: storageState.cookies.length,
					originCount: storageState.origins.length,
				};
				await saveImportedProfile(profile, getDefaultProfilePath(), true);
				console.log(
					`[BrowserSession] Saved ${storageState.cookies.length} cookies`
				);
				return true;
			}
		} catch (error: any) {
			// Connection may already be lost - this is expected on forced close
			console.debug('[BrowserSession] Could not save storage state:', error.message);
		}
		return false;
	}

	/**
	 * Stop the browser session
	 */
	async stop(): Promise<void> {
		if (!this.started) {
			return;
		}

		// Auto-save storage state before closing (Atlas-like persistence)
		// This ensures credentials/cookies acquired during the session are preserved
		await this.saveStorageStateIfPossible();

		if (this.context) {
			await this.context.close();
		}

		if (this.browser) {
			await this.browser.close();
		}

		this.pages.clear();
		this.started = false;
	}

	/**
	 * Inject stealth scripts to avoid bot detection
	 * These scripts patch browser APIs that anti-bot systems check
	 */
	private async injectStealthScripts(page: Page): Promise<void> {
		try {
			await page.addInitScript(() => {
				// Remove webdriver property (main detection vector)
				Object.defineProperty(navigator, 'webdriver', {
					get: () => undefined,
				});

				// Fake plugins array (empty plugins = bot indicator)
				Object.defineProperty(navigator, 'plugins', {
					get: () => {
						const plugins = [
							{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
							{ name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
							{ name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
						];
						(plugins as any).item = (i: number) => plugins[i] || null;
						(plugins as any).namedItem = (name: string) => plugins.find(p => p.name === name) || null;
						(plugins as any).refresh = () => {};
						return plugins;
					},
				});

				// Fake languages (some bots have empty/unusual languages)
				Object.defineProperty(navigator, 'languages', {
					get: () => ['en-US', 'en'],
				});

				// Remove CDP artifacts from window
				const cdpProps = Object.getOwnPropertyNames(window).filter(
					prop => prop.startsWith('cdc_') || prop.startsWith('$cdc_')
				);
				cdpProps.forEach(prop => {
					try {
						delete (window as any)[prop];
					} catch {}
				});

				// Patch chrome.runtime to look like real Chrome
				if (!(window as any).chrome) {
					(window as any).chrome = {};
				}
				if (!(window as any).chrome.runtime) {
					(window as any).chrome.runtime = {
						connect: () => {},
						sendMessage: () => {},
						onMessage: { addListener: () => {} },
					};
				}

				// Fix permissions API
				const originalQuery = navigator.permissions?.query?.bind(navigator.permissions);
				if (originalQuery) {
					navigator.permissions.query = (parameters: any) => {
						if (parameters.name === 'notifications') {
							return Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus);
						}
						return originalQuery(parameters);
					};
				}

				// Console.debug doesn't trigger CDP serialization warning
				// This prevents detection via error object serialization
				const originalConsoleDebug = console.debug;
				console.debug = function(...args: any[]) {
					// Filter out CDP-related debug messages
					if (args.some(arg => String(arg).includes('Runtime.enable'))) {
						return;
					}
					return originalConsoleDebug.apply(console, args);
				};
			});

			console.log('🛡️ [BrowserSession] Stealth scripts injected');
		} catch (error: any) {
			console.warn(`[BrowserSession] Failed to inject stealth scripts: ${error.message}`);
		}
	}

	/**
	 * Handle Cloudflare Turnstile challenge by clicking the checkbox
	 * This simulates human-like interaction with the captcha
	 */
	async handleCloudflareTurnstile(page?: Page, options?: {
		timeout?: number;
		delayBeforeClick?: number;
	}): Promise<boolean> {
		const targetPage = page || this.getCurrentPage();
		const timeout = options?.timeout ?? 10000;
		const delayBeforeClick = options?.delayBeforeClick ?? 2000;

		try {
			console.log('🔐 [BrowserSession] Checking for Cloudflare Turnstile...');

			// Wait for Turnstile iframe to appear
			const turnstileSelectors = [
				'iframe[src*="challenges.cloudflare.com"]',
				'iframe[src*="turnstile"]',
				'.cf-turnstile iframe',
				'[data-turnstile-callback] iframe',
			];

			let turnstileFrame = null;
			for (const selector of turnstileSelectors) {
				try {
					const frame = await targetPage.waitForSelector(selector, { timeout: 3000 });
					if (frame) {
						turnstileFrame = frame;
						break;
					}
				} catch {
					// Try next selector
				}
			}

			if (!turnstileFrame) {
				console.log('🔐 [BrowserSession] No Turnstile detected, continuing...');
				return false;
			}

			console.log('🔐 [BrowserSession] Turnstile detected, waiting before click...');

			// Human-like delay before clicking
			await new Promise(r => setTimeout(r, delayBeforeClick + Math.random() * 1000));

			// Get iframe bounding box
			const box = await turnstileFrame.boundingBox();
			if (!box) {
				console.warn('🔐 [BrowserSession] Could not get Turnstile bounding box');
				return false;
			}

			// Calculate click position (center of checkbox area, with slight randomization)
			const clickX = box.x + 25 + Math.random() * 10;  // Checkbox is usually on the left
			const clickY = box.y + box.height / 2 + (Math.random() - 0.5) * 10;

			// Human-like mouse movement before click
			await this.humanLikeMouseMove(targetPage, clickX, clickY);

			// Small delay before click
			await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

			// Click with slight position variation
			await targetPage.mouse.click(clickX, clickY);

			console.log('🔐 [BrowserSession] Clicked Turnstile checkbox');

			// Wait for verification to complete
			await new Promise(r => setTimeout(r, 3000));

			// Check if challenge passed (look for success indicators)
			const passed = await targetPage.evaluate(() => {
				// Check if Turnstile shows success
				const successIndicators = [
					document.querySelector('[data-turnstile-success="true"]'),
					document.querySelector('.cf-turnstile-success'),
					document.querySelector('input[name="cf-turnstile-response"]'),
				];
				return successIndicators.some(el => el !== null);
			});

			if (passed) {
				console.log('✅ [BrowserSession] Turnstile challenge passed!');
			} else {
				console.warn('⚠️ [BrowserSession] Turnstile may require manual verification');
			}

			return passed;
		} catch (error: any) {
			console.warn(`[BrowserSession] Turnstile handling failed: ${error.message}`);
			return false;
		}
	}

	/**
	 * Perform human-like mouse movement to target position
	 */
	private async humanLikeMouseMove(page: Page, targetX: number, targetY: number): Promise<void> {
		// Get current mouse position (start from center if unknown)
		const viewport = page.viewportSize() || { width: 1280, height: 720 };
		let currentX = viewport.width / 2;
		let currentY = viewport.height / 2;

		// Generate bezier curve points for natural movement
		const steps = 20 + Math.floor(Math.random() * 10);
		const controlX = currentX + (targetX - currentX) * 0.5 + (Math.random() - 0.5) * 100;
		const controlY = currentY + (targetY - currentY) * 0.5 + (Math.random() - 0.5) * 100;

		for (let i = 0; i <= steps; i++) {
			const t = i / steps;
			// Quadratic bezier curve
			const x = Math.pow(1 - t, 2) * currentX + 2 * (1 - t) * t * controlX + Math.pow(t, 2) * targetX;
			const y = Math.pow(1 - t, 2) * currentY + 2 * (1 - t) * t * controlY + Math.pow(t, 2) * targetY;

			await page.mouse.move(x, y);
			// Variable delay between movements (faster in middle, slower at start/end)
			const delay = 5 + Math.random() * 15 * (1 - Math.abs(t - 0.5) * 2);
			await new Promise(r => setTimeout(r, delay));
		}
	}

	/**
	 * Navigate with automatic Cloudflare handling
	 * Use this instead of direct page.goto for sites with Cloudflare protection
	 */
	async navigateWithCloudflareBypass(url: string, page?: Page): Promise<void> {
		const targetPage = page || this.getCurrentPage();

		await targetPage.goto(url, { waitUntil: 'domcontentloaded' });

		// Wait a bit for any challenges to appear
		await new Promise(r => setTimeout(r, 2000));

		// Check for Cloudflare challenge page
		const isChallenged = await targetPage.evaluate(() => {
			const title = document.title.toLowerCase();
			const body = document.body?.innerText?.toLowerCase() || '';
			return (
				title.includes('just a moment') ||
				title.includes('attention required') ||
				body.includes('checking your browser') ||
				body.includes('verify you are human') ||
				document.querySelector('iframe[src*="challenges.cloudflare.com"]') !== null
			);
		});

		if (isChallenged) {
			console.log('🔐 [BrowserSession] Cloudflare challenge detected, attempting bypass...');
			await this.handleCloudflareTurnstile(targetPage);

			// Wait for redirect after successful challenge
			await new Promise(r => setTimeout(r, 3000));

			// Verify we're past the challenge
			const stillChallenged = await targetPage.evaluate(() => {
				return document.title.toLowerCase().includes('just a moment');
			});

			if (stillChallenged) {
				console.warn('⚠️ [BrowserSession] Still on Cloudflare challenge page - may need manual intervention');
			}
		}
	}

	/**
	 * Auto-detect and handle Cloudflare challenges after navigation
	 * Called automatically after every navigation
	 */
	private async autoHandleCloudflareIfNeeded(page: Page): Promise<void> {
		try {
			// Quick check for Cloudflare challenge indicators
			const isChallenged = await page.evaluate(() => {
				const title = document.title.toLowerCase();
				const bodyText = document.body?.innerText?.substring(0, 500).toLowerCase() || '';
				return (
					title.includes('just a moment') ||
					title.includes('attention required') ||
					title.includes('please wait') ||
					bodyText.includes('checking your browser') ||
					bodyText.includes('verify you are human') ||
					bodyText.includes('enable javascript and cookies') ||
					document.querySelector('iframe[src*="challenges.cloudflare.com"]') !== null ||
					document.querySelector('.cf-turnstile') !== null
				);
			});

			if (isChallenged) {
				console.log('🔐 [BrowserSession] Cloudflare challenge auto-detected');
				await this.handleCloudflareTurnstile(page);
			}
		} catch {
			// Silently ignore errors in auto-detection
		}
	}

	/**
	 * Get current page with automatic recovery (matching Python's fallback behavior)
	 * If current page is gone, tries to find another page or create a new one
	 */
	private getCurrentPage(): Page {
		// Try to get the current page
		if (this.currentPageId && this.pages.has(this.currentPageId)) {
			return this.pages.get(this.currentPageId)!;
		}

		// Current page is gone - try to find another existing page (like Python's fallback)
		const remainingPages = Array.from(this.pages.entries());
		if (remainingPages.length > 0) {
			const [pageId, page] = remainingPages[remainingPages.length - 1]; // Get last page
			console.warn(`🔄 Current page closed, switching to fallback page ${pageId}`);
			this.currentPageId = pageId;
			return page;
		}

		// No pages exist - throw (caller should handle by creating new page)
		throw new Error('No active page');
	}

	/**
	 * Ensure a page exists - creates one if necessary (matching Python's recovery pattern)
	 * Returns the current page, creating one if none exists
	 */
	async ensurePage(): Promise<Page> {
		try {
			return this.getCurrentPage();
		} catch {
			// No page exists - try to create one if context is available
			if (this.context) {
				console.warn('🔄 No active page, creating new one...');
				const newPage = await this.context.newPage();
				const newPageId = this.generatePageId();
				this.pages.set(newPageId, newPage);
				this.currentPageId = newPageId;
				await this.injectStealthScripts(newPage);
				this.setupPageListeners(newPage, newPageId);
				return newPage;
			}
			throw new Error('No active page and no browser context available');
		}
	}

	// ============================================================================
	// Multi-Tab Support for Parallel Agents
	// ============================================================================

	/**
	 * Get page by ID (for multi-agent support)
	 * Returns the page with the given ID, or undefined if not found
	 */
	getPage(pageId: string): Page | undefined {
		return this.pages.get(pageId);
	}

	/**
	 * Get page by ID or fallback to current page
	 * Used by agents that may or may not have a specific tab assigned
	 */
	getPageOrCurrent(pageId?: string): Page {
		if (pageId && this.pages.has(pageId)) {
			return this.pages.get(pageId)!;
		}
		return this.getCurrentPage();
	}

	/**
	 * Create a new tab for an agent
	 * Returns the new page ID and page object
	 * Does NOT change currentPageId - each agent works on its own tab
	 */
	async createTabForAgent(agentId?: string): Promise<{ pageId: string; page: Page }> {
		if (!this.context) {
			throw new Error('Browser context not available - call start() first');
		}

		const newPage = await this.context.newPage();
		const pageId = agentId ? `agent_${agentId}_${Date.now()}` : this.generatePageId();
		this.pages.set(pageId, newPage);
		await this.injectStealthScripts(newPage);
		this.setupPageListeners(newPage, pageId);

		console.log(`🆕 [BrowserSession] Created new tab ${pageId} for agent${agentId ? ` ${agentId}` : ''}`);
		console.log(`📊 [BrowserSession] Total tabs: ${this.pages.size}`);

		return { pageId, page: newPage };
	}

	/**
	 * Get browser state for a specific page (tab)
	 * Used by agents working on their own tabs
	 *
	 * IMPORTANT: This is thread-safe for multi-agent parallel execution.
	 * It directly uses the specified page without modifying currentPageId.
	 */
	async getStateForPage(pageId: string, options: {
		includeScreenshot?: boolean;
		includeDom?: boolean;
		includeRecentEvents?: boolean;
	} = {}): Promise<BrowserStateSummary> {
		const page = this.pages.get(pageId);
		if (!page) {
			throw new Error(`Page ${pageId} not found`);
		}

		// THREAD-SAFE: Directly extract state from the specific page
		// without modifying currentPageId (which would cause race conditions)
		const state = await this.getStateFromPage(page, options);

		// Cache the selector map for this specific page (multi-agent support)
		if (state.domState?.selectorMap) {
			this.pageSelectorMaps.set(pageId, state.domState.selectorMap as Map<number, EnhancedDOMTreeNode>);
		}

		return state;
	}

	/**
	 * Get selector map for a specific page (multi-agent support)
	 * Falls back to session-wide cache if page-specific map not found
	 */
	getSelectorMapForPage(pageId: string): Map<number, EnhancedDOMTreeNode> {
		const pageMap = this.pageSelectorMaps.get(pageId);
		if (pageMap) {
			return pageMap;
		}
		// Fallback to session-wide cache
		return this.cachedSelectorMap;
	}

	/**
	 * Get element by index for a specific page (multi-agent support)
	 */
	getElementByIndexForPage(pageId: string, index: number): EnhancedDOMTreeNode | null {
		const selectorMap = this.getSelectorMapForPage(pageId);
		if (selectorMap.has(index)) {
			return selectorMap.get(index)!;
		}
		return null;
	}

	/**
	 * Wait for page readiness before DOM extraction (like Python browser-use)
	 * Checks document.readyState, pending requests, and element count stability
	 */
	private async waitForPageReadiness(page: Page, options: {
		timeout?: number;
		minElements?: number;
		stabilityChecks?: number; // Number of stable checks before considering ready
	} = {}): Promise<{ ready: boolean; pendingRequests: number; readyState: string; elementCount: number }> {
		const timeout = options.timeout ?? 5000; // 5 second max wait
		const minElements = options.minElements ?? 10; // Minimum interactive elements expected
		const stabilityChecks = options.stabilityChecks ?? 2; // Element count must be stable for N checks
		const startTime = Date.now();

		let lastReadyState = 'unknown';
		let lastPendingCount = 0;
		let lastElementCount = 0;
		let stableCount = 0; // Track how many consecutive checks had the same element count

		while (Date.now() - startTime < timeout) {
			try {
				// Check document.readyState and pending requests (like Python)
				const pageStatus = await page.evaluate(() => {
					const readyState = document.readyState;

					// Count pending requests using Performance API (like Python)
					const pendingRequests = performance.getEntriesByType('resource')
						.filter((entry: any) => {
							// Resources that haven't finished loading
							return entry.responseEnd === 0 ||
								(entry.transferSize === 0 && entry.decodedBodySize === 0 && !entry.name.startsWith('data:'));
						}).length;

					// Count interactive elements
					const interactiveSelectors = 'a, button, input, select, textarea, [role="button"], [onclick], [tabindex]';
					const elementCount = document.querySelectorAll(interactiveSelectors).length;

					// Check for loading indicators (more comprehensive)
					const hasLoadingIndicator = !!(
						document.querySelector('[class*="loading"]') ||
						document.querySelector('[class*="skeleton"]') ||
						document.querySelector('[class*="spinner"]') ||
						document.querySelector('[class*="Spinner"]') ||
						document.querySelector('[class*="Loading"]') ||
						document.querySelector('[class*="Skeleton"]') ||
						document.querySelector('[aria-busy="true"]') ||
						document.querySelector('[data-loading="true"]') ||
						document.querySelector('.placeholder')
					);

					return { readyState, pendingRequests, elementCount, hasLoadingIndicator };
				});

				// Track element count stability
				if (pageStatus.elementCount === lastElementCount && pageStatus.elementCount > 0) {
					stableCount++;
				} else {
					stableCount = 0; // Reset if element count changed
				}

				lastReadyState = pageStatus.readyState;
				lastPendingCount = pageStatus.pendingRequests;
				lastElementCount = pageStatus.elementCount;

				// Page is ready when:
				// 1. readyState is 'complete' or 'interactive' with stable elements
				// 2. No (or few) pending requests
				// 3. Has minimum elements
				// 4. No loading indicators
				// 5. Element count is stable (hasn't changed for stabilityChecks iterations)
				const isReady =
					(pageStatus.readyState === 'complete' ||
						(pageStatus.readyState === 'interactive' && stableCount >= stabilityChecks)) &&
					pageStatus.pendingRequests <= 2 &&
					pageStatus.elementCount >= minElements &&
					!pageStatus.hasLoadingIndicator &&
					stableCount >= stabilityChecks;

				if (isReady) {
					console.debug(`✅ Page ready: readyState=${pageStatus.readyState}, pending=${pageStatus.pendingRequests}, elements=${pageStatus.elementCount}, stable=${stableCount}`);
					return { ready: true, pendingRequests: pageStatus.pendingRequests, readyState: pageStatus.readyState, elementCount: pageStatus.elementCount };
				}

				// Wait 100ms before next check (like Python's 0.1s poll interval)
				await new Promise(resolve => setTimeout(resolve, 100));

			} catch (error) {
				// Page might be navigating, wait and retry
				stableCount = 0; // Reset stability counter on error
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}

		// Timeout reached - return current state
		console.debug(`⚠️ Page readiness timeout: readyState=${lastReadyState}, pending=${lastPendingCount}, elements=${lastElementCount}, stable=${stableCount}`);
		return { ready: false, pendingRequests: lastPendingCount, readyState: lastReadyState, elementCount: lastElementCount };
	}

	/**
	 * Extract browser state directly from a specific page object
	 * Thread-safe - does not modify any shared state like currentPageId
	 */
	private async getStateFromPage(page: Page, options: {
		includeScreenshot?: boolean;
		includeDom?: boolean;
		includeRecentEvents?: boolean;
	} = {}): Promise<BrowserStateSummary> {
		// Wait for page readiness before extracting state (CRITICAL FIX)
		// This prevents extracting DOM while page is still loading
		const readinessResult = await this.waitForPageReadiness(page, {
			timeout: 5000, // 5 seconds max wait
			minElements: 5, // At least 5 interactive elements
		});

		if (!readinessResult.ready) {
			console.debug(`⚠️ Proceeding with DOM extraction despite page not fully ready (readyState=${readinessResult.readyState})`);
			// Add a small delay if page wasn't fully ready (like Python's 300ms delay)
			if (readinessResult.pendingRequests > 0) {
				await new Promise(resolve => setTimeout(resolve, 300));
			}
		}

		// Get page scroll info for pageInfo
		const scrollInfo = await page.evaluate(() => {
			return {
				scrollX: window.scrollX,
				scrollY: window.scrollY,
				viewportWidth: window.innerWidth,
				viewportHeight: window.innerHeight,
				pageWidth: document.documentElement.scrollWidth,
				pageHeight: document.documentElement.scrollHeight,
			};
		});

		const pageInfo: PageInfo = {
			viewportWidth: scrollInfo.viewportWidth,
			viewportHeight: scrollInfo.viewportHeight,
			pageWidth: scrollInfo.pageWidth,
			pageHeight: scrollInfo.pageHeight,
			scrollX: scrollInfo.scrollX,
			scrollY: scrollInfo.scrollY,
			pixelsAbove: scrollInfo.scrollY,
			pixelsBelow: Math.max(0, scrollInfo.pageHeight - scrollInfo.viewportHeight - scrollInfo.scrollY),
			pixelsLeft: scrollInfo.scrollX,
			pixelsRight: Math.max(0, scrollInfo.pageWidth - scrollInfo.viewportWidth - scrollInfo.scrollX),
		};

		// Create empty domState first
		let domState: SerializedDOMState = {
			root: null,
			selectorMap: new Map(),
		};

		// DOM extraction using DOMService
		if (options.includeDom !== false) {
			let domService: DOMService | null = null;
			try {
				domService = new DOMService(page, {
					paintOrderFiltering: true,
					crossOriginIframes: false,
				});
				const pageState = await domService.getPageState({
					includeScreenshot: false,
					useCDPAccessibility: true,
				});

				const domTree = pageState.domTree;
				const selectorMap = pageState.selectorMap;

				domState = {
					root: this.createSimplifiedNode(domTree, selectorMap as any),
					selectorMap: selectorMap as any,
					llmRepresentation: (includeAttributes: string[] = []) => {
						return domService!.formatDOMForLLM(domTree, 0, true, selectorMap);
					},
				};
			} catch (domError: any) {
				console.debug('DOM extraction failed:', domError.message);
			} finally {
				// Always detach the CDP session, even when extraction throws —
				// otherwise a failed step orphans the session at the Chromium level.
				// (formatDOMForLLM works on the already-materialized domTree, so the
				// llmRepresentation closure stays valid after close().)
				if (domService) {
					try { await domService.close(); } catch {}
				}
			}
		}

		// Build the full BrowserStateSummary
		const state: BrowserStateSummary = {
			domState,
			url: page.url(),
			title: await page.title(),
			tabs: await this.getAllTabs(),
			pageInfo,
			pixelsAbove: pageInfo.pixelsAbove,
			pixelsBelow: pageInfo.pixelsBelow,
			browserErrors: [],
			isPdfViewer: page.url().endsWith('.pdf') || (page.url().includes('chrome-extension://') && page.url().includes('pdf')),
			pendingNetworkRequests: [],
			paginationButtons: [],
		};

		// Capture screenshot
		if (options.includeScreenshot !== false) {
			try {
				const screenshot = await page.screenshot({ type: 'png' });
				state.screenshot = screenshot.toString('base64');
			} catch (screenshotError: any) {
				console.debug('Screenshot failed:', screenshotError.message);
			}
		}

		return state;
	}

	/**
	 * Switch to a specific page (make it the current active page)
	 */
	switchToPage(pageId: string): boolean {
		if (this.pages.has(pageId)) {
			this.currentPageId = pageId;
			console.log(`🔄 [BrowserSession] Switched to tab ${pageId}`);
			return true;
		}
		console.warn(`⚠️ [BrowserSession] Cannot switch to tab ${pageId} - not found`);
		return false;
	}

	/**
	 * Get the number of open tabs
	 */
	getTabCount(): number {
		return this.pages.size;
	}

	/**
	 * Get all tab IDs
	 */
	getAllTabIds(): string[] {
		return Array.from(this.pages.keys());
	}

	/**
	 * Get current page ID
	 */
	getCurrentPageId(): string | undefined {
		return this.currentPageId;
	}

	/**
	 * Check if a specific tab exists
	 */
	hasTab(pageId: string): boolean {
		return this.pages.has(pageId);
	}

	/**
	 * Generate unique page ID
	 */
	private generatePageId(): string {
		return `page_${Date.now()}_${Math.random().toString(36).substring(7)}`;
	}

	/**
	 * Set up page event listeners
	 */
	private setupPageListeners(page: Page, pageId: string) {
		page.on('close', () => {
			this.pages.delete(pageId);
			// Clean up per-page selector map (multi-agent support)
			this.pageSelectorMaps.delete(pageId);
			// Clean up per-page CDP session (multi-agent support)
			const cdpSession = this.pageCdpSessions.get(pageId);
			if (cdpSession) {
				cdpSession.detach().catch(() => {}); // Ignore detach errors
				this.pageCdpSessions.delete(pageId);
			}
			if (this.currentPageId === pageId) {
				// Switch to another page if available
				const remainingPages = Array.from(this.pages.keys());
				this.currentPageId = remainingPages[0];
				// Clear single-agent CDP session since current page changed
				this.cdpSession = null;
			}
			console.log(`🗑️ [BrowserSession] Page ${pageId} closed, cleaned up resources`);
		});

		// Clear CDP session and cached state on navigation (like Python's AgentFocusChangedEvent)
		page.on('framenavigated', (frame) => {
			// Only clear for main frame navigation
			if (frame === page.mainFrame()) {
				this.cdpSession = null;
				// CRITICAL: Clear cached selector map on navigation (element indices are now stale)
				// This matches Python's cache clearing on AgentFocusChangedEvent
				this.cachedSelectorMap.clear();
				// Clear per-page selector maps as well
				if (pageId) {
					const pageSelectorMap = this.pageSelectorMaps.get(pageId);
					if (pageSelectorMap) {
						pageSelectorMap.clear();
					}
				}
				console.debug(`🔄 [framenavigated] Cleared cached state for page ${pageId || 'main'}`);
			}
		});

		// Detect DOM content loaded to clear stale state (SPAs may not trigger framenavigated)
		page.on('domcontentloaded', () => {
			// Clear cached state when DOM is rebuilt
			this.cachedSelectorMap.clear();
			if (pageId) {
				const pageSelectorMap = this.pageSelectorMaps.get(pageId);
				if (pageSelectorMap) {
					pageSelectorMap.clear();
				}
			}
			console.debug(`🔄 [domcontentloaded] Cleared cached state for page ${pageId || 'main'}`);
		});

		// JavaScript dialogs: accept alert/confirm/beforeunload, cancel prompts (we cannot type into them),
		// and remember the message so the LLM sees it in the next browser state (Python PopupsWatchdog).
		page.on('dialog', async (dialog) => {
			const dialogType = dialog.type();
			const message = dialog.message();
			if (message) {
				this.closedPopupMessages.push(`[${dialogType}] ${message}`);
			}
			const shouldAccept = dialogType === 'alert' || dialogType === 'confirm' || dialogType === 'beforeunload';
			console.log(
				`🔔 JavaScript ${dialogType} dialog: '${message.slice(0, 100)}' - ${shouldAccept ? 'accepting (OK)' : 'dismissing (Cancel)'}...`
			);
			try {
				if (shouldAccept) {
					await dialog.accept();
				} else {
					await dialog.dismiss();
				}
			} catch (error: any) {
				console.debug(`Failed to handle ${dialogType} dialog: ${error?.message ?? error}`);
			}
		});

		// Network request tracking for idle detection
		page.on('request', (request) => {
			// Filter out data URLs and blob URLs
			const url = request.url();
			if (!url.startsWith('data:') && !url.startsWith('blob:')) {
				this.pendingRequests.add(url);
			}
		});

		page.on('requestfinished', (request) => {
			this.pendingRequests.delete(request.url());
		});

		page.on('requestfailed', (request) => {
			this.pendingRequests.delete(request.url());
		});

		// Download tracking
		page.on('download', async (download) => {
			try {
				const suggestedFilename = download.suggestedFilename();
				const downloadPath = this.options.downloadsPath
					? `${this.options.downloadsPath}/${suggestedFilename}`
					: suggestedFilename;
				await download.saveAs(downloadPath);
				this._downloadedFiles.push(downloadPath);
				console.log(`📥 Downloaded: ${downloadPath}`);
			} catch (error: any) {
				console.error(`Failed to save download: ${error.message}`);
			}
		});
	}

	/**
	 * Configure network idle detection
	 */
	setNetworkIdleConfig(config: Partial<typeof this.networkIdleConfig>): void {
		this.networkIdleConfig = { ...this.networkIdleConfig, ...config };
	}

	/**
	 * Get current number of pending network requests
	 */
	getPendingRequestCount(): number {
		return this.pendingRequests.size;
	}

	/**
	 * Wait for network to become idle
	 * Returns true if network became idle, false if timeout was reached
	 */
	async waitForNetworkIdle(options?: {
		idleTime?: number;
		maxInflight?: number;
		timeout?: number;
		pollInterval?: number;
	}): Promise<boolean> {
		const config = {
			idleTime: options?.idleTime ?? this.networkIdleConfig.idleTime,
			maxInflight: options?.maxInflight ?? this.networkIdleConfig.maxInflight,
			timeout: options?.timeout ?? this.networkIdleConfig.timeout,
			pollInterval: options?.pollInterval ?? this.networkIdleConfig.pollInterval,
		};

		const startTime = Date.now();
		let idleStartTime: number | null = null;

		while (true) {
			const elapsed = (Date.now() - startTime) / 1000;

			// Check for timeout
			if (elapsed >= config.timeout) {
				console.debug(`Network idle timeout after ${elapsed.toFixed(2)}s`);
				return false;
			}

			const currentInflight = this.pendingRequests.size;

			if (currentInflight <= config.maxInflight) {
				// Network is "idle" - check if it's been idle long enough
				if (idleStartTime === null) {
					idleStartTime = Date.now();
				}

				const idleDuration = (Date.now() - idleStartTime) / 1000;
				if (idleDuration >= config.idleTime) {
					console.debug(
						`Network idle achieved: ${currentInflight} requests for ${config.idleTime}s`
					);
					return true;
				}
			} else {
				// Network is busy - reset idle timer
				idleStartTime = null;
			}

			// Wait before next poll
			await new Promise((resolve) => setTimeout(resolve, config.pollInterval * 1000));
		}
	}

	/**
	 * Check if network is currently idle
	 */
	isNetworkIdle(maxInflight?: number): boolean {
		const max = maxInflight ?? this.networkIdleConfig.maxInflight;
		return this.pendingRequests.size <= max;
	}

	// ============================================================================
	// Event Handlers
	// ============================================================================

	/**
	 * Extract domain from URL for comparison
	 */
	private extractDomain(url: string): string {
		try {
			const urlObj = new URL(url);
			return urlObj.hostname;
		} catch {
			return '';
		}
	}

	/**
	 * Get smart navigation timeout based on domain (like Python session.py)
	 * FIXED: Previous 2-4s was too short, causing premature timeouts on slow pages
	 * Same domain = 8s (faster, cached resources), different domain = 15s (DNS, SSL, etc.)
	 * These values match the NAVIGATE_TO_URL event timeout (15s) from events/base.ts
	 */
	private getSmartNavigationTimeout(currentUrl: string, targetUrl: string): number {
		const currentDomain = this.extractDomain(currentUrl);
		const targetDomain = this.extractDomain(targetUrl);
		const sameDomain = currentDomain === targetDomain && currentDomain !== '';
		// CRITICAL FIX: Increased from 2s/4s to 8s/15s to handle real-world page loads
		const timeout = sameDomain ? 8000 : 15000; // 8s same domain, 15s different
		console.debug(`Smart navigation timeout: ${timeout}ms (${sameDomain ? 'same' : 'different'} domain)`);
		return timeout;
	}

	private async handleNavigateToUrl(event: NavigateToUrlEvent & { _eventId: string; pageId?: string }) {
		try {
			const waitUntil = event.waitUntil || 'load';
			let newTab = event.newTab || false;

			// Multi-agent support: use specific page if provided
			const pageId = (event as any).pageId as string | undefined;
			let page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();

			// Skip tab management logic in multi-agent mode (agent works on its own tab)
			if (!pageId) {
				// Tab reuse logic
				if (newTab) {
					// If we're already on a new tab page, reuse it instead of creating a new one
					const currentUrl = page.url();
					if (this.isNewTabPage(currentUrl)) {
						console.debug(`Already on new tab page (${currentUrl}), reusing instead of creating new tab`);
						newTab = false;
					}
				}

				// Check if URL is already open in another tab (skip if newTab requested)
				if (!newTab) {
					const existingTab = this.findTabByUrl(event.url);
					if (existingTab && existingTab !== this.currentPageId) {
						console.debug(`URL already open in tab ${existingTab}, switching to it`);
						this.currentPageId = existingTab;
						page = await this.ensurePage();
						this.eventBus.respondToEvent(event._eventId, null);
						return;
					}
				}

				// Handle new tab creation
				if (newTab) {
					// First, look for an existing about:blank tab to reuse
					let targetPage = await this.findOrCreateNewTab();
					if (targetPage) {
						page = targetPage;
					}
				}
			}

			// Smart navigation timeout based on domain (like Python)
			// Use provided timeout if specified, otherwise use smart domain-based timeout
			const currentUrl = page.url();
			const timeout = event.timeoutMs ?? this.getSmartNavigationTimeout(currentUrl, event.url);

			// Navigate to the URL
			await page.goto(event.url, {
				waitUntil: waitUntil as any,
				timeout: timeout,
			});

			// Auto-detect and handle Cloudflare challenge
			await this.autoHandleCloudflareIfNeeded(page);

			this.eventBus.respondToEvent(event._eventId, null);
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	/**
	 * Check if URL is a new tab page
	 */
	private isNewTabPage(url: string): boolean {
		return (
			url === 'about:blank' ||
			url === 'chrome://new-tab-page/' ||
			url === 'chrome://newtab/' ||
			url.startsWith('chrome://newtab')
		);
	}

	/**
	 * Find a tab by URL
	 */
	private findTabByUrl(url: string): string | null {
		for (const [pageId, page] of this.pages.entries()) {
			if (page.url() === url) {
				return pageId;
			}
		}
		return null;
	}

	/**
	 * Find an existing about:blank tab or create a new one
	 */
	private async findOrCreateNewTab(): Promise<Page | null> {
		// First, look for an existing about:blank tab to reuse
		for (const [pageId, page] of this.pages.entries()) {
			if (pageId !== this.currentPageId && this.isNewTabPage(page.url())) {
				console.debug(`Found existing about:blank tab ${pageId}, reusing it`);
				this.currentPageId = pageId;
				return page;
			}
		}

		// No reusable tab found, create a new one
		if (this.context) {
			try {
				const newPage = await this.context.newPage();
				const newPageId = this.generatePageId();
				this.pages.set(newPageId, newPage);
				this.currentPageId = newPageId;
				await this.injectStealthScripts(newPage);
				this.setupPageListeners(newPage, newPageId);
				console.debug(`Created new tab ${newPageId}`);
				return newPage;
			} catch (error) {
				console.error('Failed to create new tab:', error);
			}
		}

		return null;
	}

	private async handleClickElement(event: ClickElementEvent & { _eventId: string; pageId?: string }) {
		try {
			// Use page-specific page if provided (multi-agent support), otherwise fallback to current
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();
			const node = event.node;
			const button = event.button || 'left';

			// Validate element type - cannot click SELECT or file inputs
			const tagName = (node.nodeName || '').toLowerCase();
			const elementType = (node.attributes?.type || '').toLowerCase();

			if (tagName === 'select') {
				throw new Error(
					`Cannot click on <select> elements. Use dropdown options action instead.`
				);
			}

			if (tagName === 'input' && elementType === 'file') {
				throw new Error(
					`Cannot click on file input element. Use upload_file action instead.`
				);
			}

			// Get CDP session - use page-specific session for multi-agent support
			const cdp = pageId ? await this.getCdpSessionForPage(pageId) : await this.getCdpSession();

			// CRITICAL: Get viewport dimensions using CDP Page.getLayoutMetrics (like Python lines 103-105)
			// Python: layout_metrics = await self._client.send.Page.getLayoutMetrics(session_id=self._session_id)
			// Python: viewport_width = layout_metrics['layoutViewport']['clientWidth']
			let viewportSize = { width: 1280, height: 720 };
			try {
				const layoutMetrics = await cdp.send('Page.getLayoutMetrics');
				const layoutViewport = (layoutMetrics as any).layoutViewport || {};
				viewportSize = {
					width: layoutViewport.clientWidth || page.viewportSize()?.width || 1280,
					height: layoutViewport.clientHeight || page.viewportSize()?.height || 720,
				};
				console.debug(`📐 [click] Viewport from CDP: ${viewportSize.width}x${viewportSize.height}`);
			} catch (metricsError) {
				console.debug('Failed to get layout metrics, using page.viewportSize()');
				viewportSize = page.viewportSize() || { width: 1280, height: 720 };
			}

			// Use backendNodeId for CDP operations (like Python)
			const backendNodeId = node.backendNodeId;
			console.log(`🔍 [click] Using backendNodeId: ${backendNodeId} for element: ${tagName}`);

			if (backendNodeId && backendNodeId > 0) {
				// Try CDP-based click using backendNodeId (like Python)
				// CRITICAL: Python order is: getQuads -> calculate center -> clamp -> scroll -> click
				// This is different from what we had before!
				try {
					// Method 1: Try DOM.getContentQuads FIRST (like Python lines 110-118)
					// Python gets quads BEFORE scrolling
					let clickCoords: { x: number; y: number } | null = null;
					let quads: number[][] = [];

					try {
						const quadsResult = await cdp.send('DOM.getContentQuads', {
							backendNodeId: backendNodeId,
						});
						if ((quadsResult as any)?.quads?.length > 0) {
							quads = (quadsResult as any).quads;
							console.debug(`Got ${quads.length} quads from DOM.getContentQuads`);
						}
					} catch (quadsError: any) {
						console.debug('getContentQuads failed:', quadsError.message);
					}

					// Method 2: Fall back to DOM.getBoxModel (like Python lines 120-143)
					if (quads.length === 0) {
						try {
							const boxModel = await cdp.send('DOM.getBoxModel', {
								backendNodeId: backendNodeId,
							});

							if ((boxModel as any)?.model?.content) {
								const content = (boxModel as any).model.content;
								if (content.length >= 8) {
									quads = [[
										content[0], content[1], content[2], content[3],
										content[4], content[5], content[6], content[7],
									]];
									console.debug('Got quad from DOM.getBoxModel');
								}
							}
						} catch (boxError: any) {
							console.debug('getBoxModel failed:', boxError.message);
						}
					}

					// Method 3: Try Runtime.callFunctionOn with JS getBoundingClientRect (like Python lines 145-191)
					if (quads.length === 0) {
						try {
							const resolved = await cdp.send('DOM.resolveNode', {
								backendNodeId: backendNodeId,
							});
							const objectId = (resolved as any)?.object?.objectId;

							if (objectId) {
								const rectResult = await cdp.send('Runtime.callFunctionOn', {
									objectId: objectId,
									functionDeclaration: `function() {
										const rect = this.getBoundingClientRect();
										return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
									}`,
									returnByValue: true,
								});

								const rect = (rectResult as any)?.result?.value;
								if (rect) {
									const x = rect.x;
									const y = rect.y;
									const w = rect.width;
									const h = rect.height;
									quads = [[
										x, y,           // top-left
										x + w, y,       // top-right
										x + w, y + h,   // bottom-right
										x, y + h,       // bottom-left
									]];
									console.debug('Got quad from getBoundingClientRect');
								}
							}
						} catch (jsError: any) {
							console.debug('JS getBoundingClientRect failed:', jsError.message);
						}
					}

					// If no quads at all, try JS click immediately (like Python lines 193-213)
					if (quads.length === 0) {
						console.debug('Could not get element geometry from any method, falling back to JavaScript click');
						try {
							await this.fallbackJSClick(page, node, pageId);
							this.eventBus.respondToEvent(event._eventId, { success: true, method: 'js_click_no_quads' });
							return;
						} catch (jsError: any) {
							console.debug('JS click for no-quads case failed:', jsError.message);
							// Fall through to coordinate-based click with absolutePosition
						}
					}

					// Find the largest visible quad within viewport (like Python lines 215-249)
					if (quads.length > 0) {
						let bestQuad: number[] | null = null;
						let bestArea = 0;

						for (const quad of quads) {
							if (quad.length < 8) continue;

							// Calculate quad bounds (like Python lines 223-227)
							const xs = [quad[0], quad[2], quad[4], quad[6]];
							const ys = [quad[1], quad[3], quad[5], quad[7]];
							const minX = Math.min(...xs);
							const maxX = Math.max(...xs);
							const minY = Math.min(...ys);
							const maxY = Math.max(...ys);

							// Check if quad intersects with viewport (like Python lines 229-231)
							if (maxX < 0 || maxY < 0 || minX > viewportSize.width || minY > viewportSize.height) {
								continue; // Quad is completely outside viewport
							}

							// Calculate visible area (intersection with viewport) (like Python lines 233-241)
							const visibleMinX = Math.max(0, minX);
							const visibleMaxX = Math.min(viewportSize.width, maxX);
							const visibleMinY = Math.max(0, minY);
							const visibleMaxY = Math.min(viewportSize.height, maxY);

							const visibleWidth = visibleMaxX - visibleMinX;
							const visibleHeight = visibleMaxY - visibleMinY;
							const visibleArea = visibleWidth * visibleHeight;

							if (visibleArea > bestArea) {
								bestArea = visibleArea;
								bestQuad = quad;
							}
						}

						// CRITICAL FIX: If no visible quad, scroll FIRST then re-fetch
						// Don't click at clamped viewport edge when element is off-screen
						if (!bestQuad) {
							console.debug('🔄 [click] No visible quad found, scrolling element into view first...');

							// Scroll element into view FIRST
							try {
								await cdp.send('DOM.scrollIntoViewIfNeeded', {
									backendNodeId: backendNodeId,
								});
								await new Promise((r) => setTimeout(r, 100)); // Wait longer for scroll to settle
							} catch {
								// Ignore scroll errors
							}

							// Re-fetch quads after scroll
							try {
								const postScrollQuads = await cdp.send('DOM.getContentQuads', {
									backendNodeId: backendNodeId,
								});
								if ((postScrollQuads as any)?.quads?.length > 0) {
									quads = (postScrollQuads as any).quads;

									// Re-evaluate visible quads after scroll
									for (const quad of quads) {
										if (quad.length < 8) continue;
										const xs = [quad[0], quad[2], quad[4], quad[6]];
										const ys = [quad[1], quad[3], quad[5], quad[7]];
										const minX = Math.min(...xs);
										const maxX = Math.max(...xs);
										const minY = Math.min(...ys);
										const maxY = Math.max(...ys);

										if (maxX < 0 || maxY < 0 || minX > viewportSize.width || minY > viewportSize.height) {
											continue;
										}

										const visibleMinX = Math.max(0, minX);
										const visibleMaxX = Math.min(viewportSize.width, maxX);
										const visibleMinY = Math.max(0, minY);
										const visibleMaxY = Math.min(viewportSize.height, maxY);
										const visibleArea = (visibleMaxX - visibleMinX) * (visibleMaxY - visibleMinY);

										if (visibleArea > bestArea) {
											bestArea = visibleArea;
											bestQuad = quad;
										}
									}
								}
							} catch {
								// Ignore re-fetch errors
							}

							// If STILL no visible quad after scroll, fall back to JS click
							if (!bestQuad) {
								console.debug('⚠️ [click] Still no visible quad after scroll, falling back to JS click');
								await this.fallbackJSClick(page, node, pageId);
								this.eventBus.respondToEvent(event._eventId, { success: true, method: 'js_click_no_visible_quad' });
								return;
							}
						}

						// Calculate center point of the best quad (like Python lines 251-253)
						let centerX = (bestQuad[0] + bestQuad[2] + bestQuad[4] + bestQuad[6]) / 4;
						let centerY = (bestQuad[1] + bestQuad[3] + bestQuad[5] + bestQuad[7]) / 4;

						// Safety clamp to viewport bounds
						centerX = Math.max(0, Math.min(viewportSize.width - 1, centerX));
						centerY = Math.max(0, Math.min(viewportSize.height - 1, centerY));

						clickCoords = { x: centerX, y: centerY };
						console.log(`🖱️ [click] Calculated center: (${centerX.toFixed(1)}, ${centerY.toFixed(1)})`);
					}

					// If element was already visible, still scroll to ensure it's fully in view
					if (clickCoords) {
						try {
							await cdp.send('DOM.scrollIntoViewIfNeeded', {
								backendNodeId: backendNodeId,
							});
							await new Promise((r) => setTimeout(r, 50)); // 50ms delay like Python (asyncio.sleep(0.05))

							// Re-fetch coordinates after scroll for accuracy
							try {
								const postScrollQuads = await cdp.send('DOM.getContentQuads', {
									backendNodeId: backendNodeId,
								});
								if ((postScrollQuads as any)?.quads?.length > 0) {
									const quad = (postScrollQuads as any).quads[0];
									if (quad.length >= 8) {
										const newCenterX = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
										const newCenterY = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
										// Only update if the new coordinates are within viewport
										if (newCenterX >= 0 && newCenterX <= viewportSize.width &&
											newCenterY >= 0 && newCenterY <= viewportSize.height) {
											clickCoords = { x: newCenterX, y: newCenterY };
											console.debug(`📍 [click] Updated coordinates after scroll: (${newCenterX.toFixed(1)}, ${newCenterY.toFixed(1)})`);
										} else {
											console.debug(`⚠️ [click] Post-scroll coords out of viewport, keeping pre-scroll coords`);
										}
									}
								}
							} catch {
								console.debug('⚠️ [click] Re-fetch failed, keeping pre-scroll coords');
							}
						} catch {
							// Ignore scroll errors
						}
					}

					// If we have coordinates, check for occlusion (like Python lines 440-466)
					if (clickCoords) {
						// Check for occlusion before attempting CDP click (like Python _check_element_occlusion)
						const isOccluded = await this.checkElementOcclusionCDP(
							cdp,
							backendNodeId,
							clickCoords.x,
							clickCoords.y
						);

						if (isOccluded) {
							console.debug('🚫 Element is occluded, falling back to JavaScript click');
							await this.fallbackJSClick(page, node, pageId);
							this.eventBus.respondToEvent(event._eventId, { success: true, method: 'js_click_occlusion' });
							return;
						}

						// Step 1: mouseMoved (like Python - mimics human mouse movement)
						await cdp.send('Input.dispatchMouseEvent', {
							type: 'mouseMoved',
							x: clickCoords.x,
							y: clickCoords.y,
						});
						await new Promise((r) => setTimeout(r, 50)); // 50ms delay like Python

						// Step 2: mousePressed with timeout (Python uses 3s timeout for dialog handling)
						let mousePressedSuccess = false;
						let pressTimer: ReturnType<typeof setTimeout> | undefined;
						try {
							await Promise.race([
								cdp.send('Input.dispatchMouseEvent', {
									type: 'mousePressed',
									x: clickCoords.x,
									y: clickCoords.y,
									button: button,
									clickCount: 1,
								}),
								new Promise((_, reject) => { pressTimer = setTimeout(() => reject(new Error('mousePressed timeout')), 3000); })
							]);
							mousePressedSuccess = true;
						} catch (pressError: any) {
							// Timeout is OK - click may have triggered a dialog
							console.debug('mousePressed timed out (possibly dialog):', pressError.message);
						} finally {
							if (pressTimer) clearTimeout(pressTimer);
						}

						// Python: Only sleep 80ms if mousePressed succeeded (lines 498-501)
						if (mousePressedSuccess) {
							await new Promise((r) => setTimeout(r, 80));
						}

						// Step 3: mouseReleased with timeout (Python uses 5s timeout)
						let releaseTimer: ReturnType<typeof setTimeout> | undefined;
						try {
							await Promise.race([
								cdp.send('Input.dispatchMouseEvent', {
									type: 'mouseReleased',
									x: clickCoords.x,
									y: clickCoords.y,
									button: button,
									clickCount: 1,
								}),
								new Promise((_, reject) => { releaseTimer = setTimeout(() => reject(new Error('mouseReleased timeout')), 5000); })
							]);
						} catch (releaseError: any) {
							// Timeout is OK
							console.debug('mouseReleased timed out:', releaseError.message);
						} finally {
							if (releaseTimer) clearTimeout(releaseTimer);
						}

						this.eventBus.respondToEvent(event._eventId, {
							success: true,
							method: 'cdp_click',
							backendNodeId: backendNodeId,
							coordinates: clickCoords,
						});
						return;
					}
				} catch (cdpError: any) {
					// Python: On CDP click error, try JS click immediately (lines 525-545)
					console.debug('CDP click failed, falling back to JavaScript click:', cdpError.message);
					try {
						await this.fallbackJSClick(page, node, pageId);
						this.eventBus.respondToEvent(event._eventId, { success: true, method: 'js_click_cdp_error' });
						return;
					} catch (jsError: any) {
						console.debug('JS click also failed:', jsError.message);
						// Fall through to coordinate-based click
					}
				} finally {
					// Python lines 549-552: Always re-focus back to original session context
					// in case click opened a new tab/popup/window/dialog
					try {
						// Use page-specific CDP session for multi-agent support
						const cdpSession = pageId ? await this.getCdpSessionForPage(pageId) : await this.getCdpSession();
						await cdpSession.send('Runtime.runIfWaitingForDebugger', {});
					} catch {
						// Ignore cleanup errors
					}
				}
			}

			// Fallback: Use coordinates from node.absolutePosition
			// (Only reached if both CDP click AND JS click failed)

			if (!node.absolutePosition) {
				// No coordinates available, final JS click attempt
				console.debug('No coordinates available, attempting final JS click fallback');
				await this.fallbackJSClick(page, node, pageId);
				this.eventBus.respondToEvent(event._eventId, { success: true, method: 'js_click' });
				return;
			}

			const { x, y, width, height } = node.absolutePosition;

			// Calculate center point
			let centerX = x + (width || 0) / 2;
			let centerY = y + (height || 0) / 2;

			// Check if element is within viewport
			const isOutOfViewport =
				centerX < 0 || centerY < 0 || centerX > viewportSize.width || centerY > viewportSize.height;

			if (isOutOfViewport) {
				// Scroll element into view
				console.debug('Element out of viewport, scrolling into view');
				try {
					const scrollY = Math.max(0, y - viewportSize.height / 2);
					await page.evaluate((scrollY) => window.scrollTo(0, scrollY), scrollY);
					await new Promise((r) => setTimeout(r, 100));

					const scrollPos = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
					centerY = y - scrollPos.y + (height || 0) / 2;
					centerX = x - scrollPos.x + (width || 0) / 2;
				} catch (scrollError) {
					console.debug('Failed to scroll element into view:', scrollError);
				}
			}

			// Clamp coordinates to viewport bounds
			centerX = Math.max(1, Math.min(viewportSize.width - 1, centerX));
			centerY = Math.max(1, Math.min(viewportSize.height - 1, centerY));

			// Check for occlusion using CDP (like Python) - use backendNodeId if available
			let isOccluded = false;
			if (backendNodeId && backendNodeId > 0) {
				isOccluded = await this.checkElementOcclusionCDP(cdp, backendNodeId, centerX, centerY);
			}

			if (isOccluded) {
				console.debug('Element is occluded, falling back to JavaScript click');
				await this.fallbackJSClick(page, node, pageId);
				this.eventBus.respondToEvent(event._eventId, { success: true, method: 'js_click' });
				return;
			}

			// Move mouse to element first (like human behavior)
			await page.mouse.move(centerX, centerY);
			await new Promise((r) => setTimeout(r, 50));

			// Perform the click
			await page.mouse.click(centerX, centerY, { button });

			this.eventBus.respondToEvent(event._eventId, {
				success: true,
				method: 'mouse_click',
				coordinates: { x: centerX, y: centerY },
			});
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	/**
	 * Check if element is occluded by another element at the given coordinates
	 */
	private async checkElementOcclusion(
		page: Page,
		node: EnhancedDOMTreeNode,
		x: number,
		y: number
	): Promise<boolean> {
		try {
			const result = await page.evaluate(
				({ x, y, nodeId, nodeName }) => {
					const elementAtPoint = document.elementFromPoint(x, y);
					if (!elementAtPoint) return true; // No element found, consider occluded

					// Check if the element at point is the target or contains/is contained by target
					// Since we don't have direct access to the target element, use nodeName matching
					const targetTagName = nodeName?.toUpperCase() || '';

					// Simple heuristic: if element at point has same tag, likely the same element
					// This is a simplification - proper implementation would use backend node ID
					if (elementAtPoint.tagName === targetTagName) {
						return false; // Likely the same element
					}

					// Check if target might be a parent or child
					if (
						elementAtPoint.closest(targetTagName) ||
						elementAtPoint.querySelector(targetTagName)
					) {
						return false;
					}

					return true; // Different element, likely occluded
				},
				{ x, y, nodeId: node.nodeId, nodeName: node.nodeName }
			);
			return result;
		} catch {
			// If check fails, assume not occluded
			return false;
		}
	}

	/**
	 * Check element occlusion using CDP (matches Python _check_element_occlusion)
	 * Uses Runtime.callFunctionOn to run JS in the page context via CDP
	 */
	private async checkElementOcclusionCDP(
		cdp: CDPSession,
		backendNodeId: number,
		x: number,
		y: number
	): Promise<boolean> {
		try {
			// Resolve node to get objectId
			const resolved = await cdp.send('DOM.resolveNode', {
				backendNodeId: backendNodeId,
			});
			const objectId = (resolved as any)?.object?.objectId;

			if (!objectId) {
				console.debug('Could not resolve target element, assuming occluded');
				return true;
			}

			// Call function on the element to check occlusion (matches Python exactly)
			const result = await cdp.send('Runtime.callFunctionOn', {
				objectId: objectId,
				functionDeclaration: `
					function(x, y) {
						const getElementInfo = (el) => {
							return {
								tagName: el.tagName,
								id: el.id || '',
								className: el.className || '',
								textContent: (el.textContent || '').substring(0, 100)
							};
						};

						const elementAtPoint = document.elementFromPoint(x, y);
						if (!elementAtPoint) {
							return { targetInfo: getElementInfo(this), isClickable: false };
						}

						// Simple containment-based clickability logic (matches Python)
						const isClickable = this === elementAtPoint ||
							this.contains(elementAtPoint) ||
							elementAtPoint.contains(this);

						return {
							targetInfo: getElementInfo(this),
							elementAtPointInfo: getElementInfo(elementAtPoint),
							isClickable: isClickable
						};
					}
				`,
				arguments: [{ value: x }, { value: y }],
				returnByValue: true,
			});

			const data = (result as any)?.result?.value;
			if (!data) {
				console.debug('Could not get target element info, assuming occluded');
				return true;
			}

			const isClickable = data.isClickable;

			if (isClickable) {
				console.debug('Element is clickable (target, contained, or semantically related)');
				return false;
			} else {
				const targetInfo = data.targetInfo || {};
				const elementAtPointInfo = data.elementAtPointInfo || {};
				console.debug(
					`Element is occluded. Target: ${targetInfo.tagName || 'unknown'} ` +
					`(id=${targetInfo.id || 'none'}), ` +
					`ElementAtPoint: ${elementAtPointInfo.tagName || 'unknown'} ` +
					`(id=${elementAtPointInfo.id || 'none'})`
				);
				return true;
			}
		} catch (error: any) {
			console.debug(`Occlusion check failed: ${error.message}, assuming not occluded`);
			return false;
		}
	}

	/**
	 * Fallback to JavaScript click when mouse click fails
	 * Uses CDP to resolve node by backendNodeId and call this.click() (matches Python exactly)
	 */
	private async fallbackJSClick(page: Page, node: EnhancedDOMTreeNode, pageId?: string): Promise<void> {
		const backendNodeId = node.backendNodeId;

		// Method 1: Use CDP with backendNodeId (like Python - most reliable)
		if (backendNodeId && backendNodeId > 0) {
			try {
				// Use page-specific CDP session for multi-agent support
				const cdp = pageId ? await this.getCdpSessionForPage(pageId) : await this.getCdpSession();

				// Resolve node to get objectId (like Python)
				const result = await cdp.send('DOM.resolveNode', {
					backendNodeId: backendNodeId,
				});

				const objectId = (result as any)?.object?.objectId;
				if (objectId) {
					// Call this.click() on the element (like Python)
					await cdp.send('Runtime.callFunctionOn', {
						functionDeclaration: 'function() { this.click(); }',
						objectId: objectId,
					});
					await new Promise((r) => setTimeout(r, 50)); // Short delay like Python
					console.debug('JS click via CDP successful');
					return;
				}
			} catch (cdpError: any) {
				console.debug('CDP JS click failed:', cdpError.message);
			}
		}

		// Method 2: Try to find element by selectors (fallback)
		const selectors = [];
		if (node.attributes?.id) {
			selectors.push(`#${node.attributes.id}`);
		}
		if (node.attributes?.name) {
			selectors.push(`[name="${node.attributes.name}"]`);
		}

		for (const selector of selectors) {
			try {
				const element = await page.$(selector);
				if (element) {
					await element.click({ force: true });
					await new Promise((r) => setTimeout(r, 50)); // 50ms delay like Python
					return;
				}
			} catch {
				continue;
			}
		}

		// Method 3: Last resort - click at coordinates with force
		if (node.absolutePosition) {
			const { x, y, width, height } = node.absolutePosition;
			await page.mouse.click(x + (width || 0) / 2, y + (height || 0) / 2, { force: true } as any);
			await new Promise((r) => setTimeout(r, 50)); // 50ms delay like Python
		} else {
			throw new Error('Cannot click element: no coordinates and no valid selectors');
		}
	}

	private async handleTypeText(event: TypeTextEvent & { _eventId: string; pageId?: string }) {
		try {
			// Use page-specific page if provided (multi-agent support), otherwise fallback to current
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();
			const node = event.node;
			// Get CDP session - use page-specific session for multi-agent support
			const cdp = pageId ? await this.getCdpSessionForPage(pageId) : await this.getCdpSession();

			// Check if we should type to a specific element or the page (current focus)
			const backendNodeId = node?.backendNodeId;
			const hasTargetElement = backendNodeId && backendNodeId > 0;

			if (hasTargetElement) {
				// Type to a specific element using CDP (like Python)

				// Step 1: Scroll element into view using CDP (like Python)
				try {
					await cdp.send('DOM.scrollIntoViewIfNeeded', {
						backendNodeId: backendNodeId,
					});
					await new Promise((r) => setTimeout(r, 50));
				} catch (scrollError) {
					console.debug('Failed to scroll element into view:', scrollError);
				}

				// Step 2: Focus element using CDP DOM.focus (like Python tries first)
				// If DOM.focus fails, fall back to click
				let focusSucceeded = false;
				try {
					await cdp.send('DOM.focus', {
						backendNodeId: backendNodeId,
					});
					focusSucceeded = true;
					await new Promise((r) => setTimeout(r, 50));
				} catch (focusError) {
					console.debug('DOM.focus failed, falling back to click:', focusError);
				}

				// If DOM.focus failed, use click to focus (like Python)
				if (!focusSucceeded && node.absolutePosition) {
					const { x, y, width, height } = node.absolutePosition;
					const centerX = x + (width || 0) / 2;
					const centerY = y + (height || 0) / 2;
					await page.mouse.click(centerX, centerY);
					await new Promise((r) => setTimeout(r, 50));
				}

				// Step 3: Clear existing text if requested (like Python with multiple strategies)
				if (event.clear !== false) {
					await this.clearTextField(page, node, pageId);
				}

				// Step 4: Type character by character with CDP key events (18ms like Python)
				await this.typeCharacterByCharacter(page, event.text, 18, pageId);

				// Step 5: Trigger framework events (input, change, blur) for React/Vue/Angular compatibility
				await this.triggerFrameworkEvents(page, node);

				// Step 6: Read back the field value so the agent can spot reformatting / autocomplete,
				// and auto-retry once when a requested clear left the old text in place (Python 0.13).
				let actualValue = await this.readInputValue(cdp, backendNodeId);
				if (
					event.clear !== false &&
					!event.isSensitive &&
					typeof actualValue === 'string' &&
					actualValue !== event.text &&
					actualValue.length > event.text.length &&
					(actualValue.endsWith(event.text) || actualValue.startsWith(event.text))
				) {
					console.info(`🔄 Concatenation detected: got "${actualValue}", expected "${event.text}" — auto-retrying`);
					await this.clearTextField(page, node, pageId);
					await this.typeCharacterByCharacter(page, event.text, 18, pageId);
					await this.triggerFrameworkEvents(page, node);
					actualValue = await this.readInputValue(cdp, backendNodeId);
				}
				this.eventBus.respondToEvent(event._eventId, { success: true, actualValue });
				return;
			} else {
				// Type to the page (whatever has current focus)
				// Clear existing text if requested and text is empty (common pattern for clearing)
				if (event.clear !== false && !event.text) {
					await this.clearTextField(page, undefined, pageId);
				}

				// Type character by character with 18ms delay (human-like typing like Python)
				await this.typeCharacterByCharacter(page, event.text, 18, pageId);
			}

			this.eventBus.respondToEvent(event._eventId, { success: true });
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	/**
	 * Read the current value of an input/textarea/contenteditable element via CDP.
	 * Returns null when the node cannot be resolved or has no value.
	 */
	private async readInputValue(cdp: CDPSession, backendNodeId: number): Promise<string | null> {
		try {
			const resolved = (await cdp.send('DOM.resolveNode', { backendNodeId })) as any;
			const objectId = resolved?.object?.objectId;
			if (!objectId) {
				return null;
			}
			const result = (await cdp.send('Runtime.callFunctionOn', {
				objectId,
				functionDeclaration: `function() {
					if (this.value !== undefined && this.value !== null) return String(this.value);
					if (this.isContentEditable) return this.textContent || '';
					return null;
				}`,
				returnByValue: true,
			})) as any;
			const value = result?.result?.value;
			return typeof value === 'string' ? value : null;
		} catch (error: any) {
			console.debug(`Failed to read back input value: ${error?.message ?? error}`);
			return null;
		}
	}

	/**
	 * Clear a text field using multiple strategies (like Python)
	 * Python has 3 strategies: JS value setting → triple-click+delete → keyboard
	 * FIXED: Added verification and triple-click strategy
	 */
	private async clearTextField(page: Page, node?: EnhancedDOMTreeNode, pageId?: string): Promise<void> {
		// Helper to check if field is cleared
		const isFieldCleared = async (cdp: any, objectId: string): Promise<boolean> => {
			try {
				const result = await cdp.send('Runtime.callFunctionOn', {
					objectId: objectId,
					functionDeclaration: `function() { return this.value === '' || this.value === undefined; }`,
					returnByValue: true,
				});
				return (result as any)?.result?.value === true;
			} catch {
				return false;
			}
		};

		let cdp: any = null;
		let objectId: string | null = null;

		// Get CDP session and object ID for verification
		if (node?.backendNodeId) {
			try {
				cdp = pageId ? await this.getCdpSessionForPage(pageId) : await this.getCdpSession();
				const resolved = await cdp.send('DOM.resolveNode', {
					backendNodeId: node.backendNodeId,
				});
				objectId = (resolved as any)?.object?.objectId || null;
			} catch {
				// Continue without verification
			}
		}

		// Strategy 1: Try JavaScript value clearing first (most reliable, like Python lines 775-821)
		if (cdp && objectId) {
			try {
				await cdp.send('Runtime.callFunctionOn', {
					objectId: objectId,
					functionDeclaration: `function() {
						if (this.select) this.select(); // Select all text first
						if (this.value !== undefined) {
							this.value = '';
							this.dispatchEvent(new Event('input', { bubbles: true }));
							this.dispatchEvent(new Event('change', { bubbles: true }));
						}
					}`,
				});
				await new Promise((r) => setTimeout(r, 10));

				// CRITICAL: Verify clearing worked (like Python lines 816-821)
				if (await isFieldCleared(cdp, objectId)) {
					console.debug('Strategy 1 (JS value): cleared successfully');
					return;
				}
				console.debug('Strategy 1 (JS value): field not empty after clear, trying next strategy');
			} catch (jsError: any) {
				console.debug('Strategy 1 (JS value) failed:', jsError.message);
			}
		}

		// Strategy 2: Triple-click + Delete (like Python lines 823-886)
		// Triple-click selects all text in most browsers
		if (node?.absolutePosition) {
			try {
				const { x, y, width, height } = node.absolutePosition;
				const centerX = x + (width || 0) / 2;
				const centerY = y + (height || 0) / 2;

				// Triple-click to select all (clickCount: 3)
				await page.mouse.click(centerX, centerY, { clickCount: 3 });
				await new Promise((r) => setTimeout(r, 50));

				// Delete selected text
				await page.keyboard.press('Delete');
				await new Promise((r) => setTimeout(r, 10));

				// Verify if cleared
				if (cdp && objectId && await isFieldCleared(cdp, objectId)) {
					console.debug('Strategy 2 (triple-click): cleared successfully');
					return;
				}
				console.debug('Strategy 2 (triple-click): trying next strategy');
			} catch (clickError: any) {
				console.debug('Strategy 2 (triple-click) failed:', clickError.message);
			}
		}

		// Strategy 3: Platform-aware keyboard shortcut (like Python lines 888-941)
		// Python: Meta=4 (Cmd) on macOS, Ctrl=2 on other platforms
		try {
			const isMac = process.platform === 'darwin';
			const selectAllKey = isMac ? 'Meta+a' : 'Control+a';

			await page.keyboard.press(selectAllKey);
			await new Promise((r) => setTimeout(r, 10));

			// Delete selected text
			await page.keyboard.press('Backspace');
			await new Promise((r) => setTimeout(r, 10));

			console.debug('Strategy 3 (keyboard shortcut): applied');
		} catch (keyError: any) {
			console.debug('Strategy 3 (keyboard) failed:', keyError.message);
		}
	}

	/**
	 * Type text character by character with proper CDP key events
	 * Matches Python's exact behavior: keyDown → 5ms → char → keyUp → 18ms delay between chars
	 */
	private async typeCharacterByCharacter(page: Page, text: string, delayMs: number = 18, pageId?: string): Promise<void> {
		// Use page-specific CDP session for multi-agent support
		const cdp = pageId ? await this.getCdpSessionForPage(pageId) : await this.getCdpSession();

		for (const char of text) {
			if (char === '\n') {
				// Handle newline as Enter key (like Python)
				// keyDown
				await cdp.send('Input.dispatchKeyEvent', {
					type: 'keyDown',
					key: 'Enter',
					code: 'Enter',
					windowsVirtualKeyCode: 13,
				});
				await new Promise((r) => setTimeout(r, 5)); // 5ms delay like Python

				// char event with carriage return (like Python)
				await cdp.send('Input.dispatchKeyEvent', {
					type: 'char',
					text: '\r',
				});

				// keyUp
				await cdp.send('Input.dispatchKeyEvent', {
					type: 'keyUp',
					key: 'Enter',
					code: 'Enter',
					windowsVirtualKeyCode: 13,
				});
			} else {
				// Get key code and modifiers for special characters (like Python)
				const { keyCode, modifiers } = this.getCharKeyInfo(char);

				// keyDown
				await cdp.send('Input.dispatchKeyEvent', {
					type: 'keyDown',
					key: char,
					code: keyCode,
					modifiers: modifiers,
				});
				await new Promise((r) => setTimeout(r, 5)); // 5ms delay like Python

				// char event
				await cdp.send('Input.dispatchKeyEvent', {
					type: 'char',
					text: char,
				});

				// keyUp
				await cdp.send('Input.dispatchKeyEvent', {
					type: 'keyUp',
					key: char,
					code: keyCode,
					modifiers: modifiers,
				});
			}

			// Add delay between keystrokes for human-like typing (18ms like Python)
			if (delayMs > 0) {
				await new Promise((r) => setTimeout(r, delayMs));
			}
		}
	}

	/**
	 * Get key code and modifier information for a character
	 * Handles special characters that need Shift modifier
	 */
	private getCharKeyInfo(char: string): { keyCode: string; modifiers: number } {
		// Shift modifier = 8
		const shiftChars: Record<string, string> = {
			'!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4',
			'%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8',
			'(': 'Digit9', ')': 'Digit0', '_': 'Minus', '+': 'Equal',
			'{': 'BracketLeft', '}': 'BracketRight', '|': 'Backslash',
			':': 'Semicolon', '"': 'Quote', '<': 'Comma', '>': 'Period',
			'?': 'Slash', '~': 'Backquote',
			'A': 'KeyA', 'B': 'KeyB', 'C': 'KeyC', 'D': 'KeyD', 'E': 'KeyE',
			'F': 'KeyF', 'G': 'KeyG', 'H': 'KeyH', 'I': 'KeyI', 'J': 'KeyJ',
			'K': 'KeyK', 'L': 'KeyL', 'M': 'KeyM', 'N': 'KeyN', 'O': 'KeyO',
			'P': 'KeyP', 'Q': 'KeyQ', 'R': 'KeyR', 'S': 'KeyS', 'T': 'KeyT',
			'U': 'KeyU', 'V': 'KeyV', 'W': 'KeyW', 'X': 'KeyX', 'Y': 'KeyY',
			'Z': 'KeyZ',
		};

		if (char in shiftChars) {
			return { keyCode: shiftChars[char], modifiers: 8 }; // 8 = Shift
		}

		// Default key codes for lowercase letters and numbers
		const keyCodeMap: Record<string, string> = {
			'a': 'KeyA', 'b': 'KeyB', 'c': 'KeyC', 'd': 'KeyD', 'e': 'KeyE',
			'f': 'KeyF', 'g': 'KeyG', 'h': 'KeyH', 'i': 'KeyI', 'j': 'KeyJ',
			'k': 'KeyK', 'l': 'KeyL', 'm': 'KeyM', 'n': 'KeyN', 'o': 'KeyO',
			'p': 'KeyP', 'q': 'KeyQ', 'r': 'KeyR', 's': 'KeyS', 't': 'KeyT',
			'u': 'KeyU', 'v': 'KeyV', 'w': 'KeyW', 'x': 'KeyX', 'y': 'KeyY',
			'z': 'KeyZ',
			'0': 'Digit0', '1': 'Digit1', '2': 'Digit2', '3': 'Digit3',
			'4': 'Digit4', '5': 'Digit5', '6': 'Digit6', '7': 'Digit7',
			'8': 'Digit8', '9': 'Digit9',
			' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft',
			']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon',
			"'": 'Quote', '`': 'Backquote', ',': 'Comma', '.': 'Period',
			'/': 'Slash',
		};

		return { keyCode: keyCodeMap[char] || '', modifiers: 0 };
	}

	/**
	 * Trigger framework-aware DOM events after typing completion
	 * This is critical for React, Vue, Angular, etc. to update their internal state
	 */
	private async triggerFrameworkEvents(page: Page, node: EnhancedDOMTreeNode): Promise<void> {
		try {
			// Build selector for the element
			let selector = '';
			if (node.attributes?.id) {
				selector = `#${node.attributes.id}`;
			} else if (node.attributes?.name) {
				selector = `[name="${node.attributes.name}"]`;
			} else if (node.nodeName) {
				selector = node.nodeName.toLowerCase();
			}

			if (!selector) return;

			await page.evaluate(
				(sel) => {
					const element = document.querySelector(sel) as HTMLElement;
					if (!element) return;

					// Dispatch input event
					try {
						const inputEvent = new InputEvent('input', {
							bubbles: true,
							cancelable: true,
							inputType: 'insertText',
						});
						element.dispatchEvent(inputEvent);
					} catch (e) {
						console.debug('Failed to dispatch input event:', e);
					}

					// Dispatch change event
					try {
						const changeEvent = new Event('change', {
							bubbles: true,
							cancelable: true,
						});
						element.dispatchEvent(changeEvent);
					} catch (e) {
						console.debug('Failed to dispatch change event:', e);
					}

					// Dispatch blur event
					try {
						const blurEvent = new FocusEvent('blur', {
							bubbles: true,
							cancelable: true,
						});
						element.dispatchEvent(blurEvent);
					} catch (e) {
						console.debug('Failed to dispatch blur event:', e);
					}
				},
				selector
			);
		} catch (error) {
			console.debug('Failed to trigger framework events:', error);
		}
	}

	private async handleScroll(event: ScrollEvent & { _eventId: string; pageId?: string }) {
		try {
			// Use page-specific page if provided (multi-agent support), otherwise fallback to current
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();
			const pixels = event.direction === 'down' ? event.amount : -event.amount;

			// If a node is provided, scroll that element's container (like Python)
			if (event.node && event.node.backendNodeId) {
				const success = await this.scrollElementContainer(event.node, pixels, pageId);
				if (success) {
					// Wait for layout to stabilize after scroll (fixes lazy-loaded content like Google Forms)
					await new Promise((resolve) => setTimeout(resolve, 150));
					this.eventBus.respondToEvent(event._eventId, null);
					return;
				}
				// Fall through to page scroll if element scroll fails
				console.debug('Element scroll failed, falling back to page scroll');
			}

			// Default: scroll the page
			const deltaY = event.direction === 'down' ? event.amount : -event.amount;
			const deltaX = event.direction === 'right' ? event.amount : event.direction === 'left' ? -event.amount : 0;

			await page.mouse.wheel(deltaX, deltaY);

			// Wait for layout to stabilize after scroll (fixes lazy-loaded content like Google Forms)
			await new Promise((resolve) => setTimeout(resolve, 150));

			this.eventBus.respondToEvent(event._eventId, null);
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	/**
	 * Scroll an element's container using CDP (matches Python's _scroll_element_container)
	 */
	private async scrollElementContainer(node: EnhancedDOMTreeNode, pixels: number, pageId?: string): Promise<boolean> {
		try {
			// Use page-specific CDP session for multi-agent support
			const cdp = pageId ? await this.getCdpSessionForPage(pageId) : await this.getCdpSession();
			if (!cdp) return false;

			const backendNodeId = node.backendNodeId;
			const tagName = node.nodeName?.toUpperCase() || '';

			// Check if this is an iframe - if so, scroll its content directly
			if (tagName === 'IFRAME') {
				// For iframes, scroll the content document, not the iframe element itself
				try {
					const result = await cdp.send('DOM.resolveNode', { backendNodeId });
					if (result.object?.objectId) {
						const scrollResult = await cdp.send('Runtime.callFunctionOn', {
							objectId: result.object.objectId,
							functionDeclaration: `function() {
								try {
									const doc = this.contentDocument || this.contentWindow?.document;
									if (doc) {
										const scrollElement = doc.documentElement || doc.body;
										if (scrollElement) {
											const oldScrollTop = scrollElement.scrollTop;
											scrollElement.scrollTop += ${pixels};
											const newScrollTop = scrollElement.scrollTop;
											return {
												success: true,
												oldScrollTop: oldScrollTop,
												newScrollTop: newScrollTop,
												scrolled: newScrollTop - oldScrollTop
											};
										}
									}
									return {success: false, error: 'Could not access iframe content'};
								} catch (e) {
									return {success: false, error: e.message};
								}
							}`,
							returnByValue: true,
						});

						if (scrollResult.result?.value?.success) {
							console.debug(`Scrolled iframe content by ${scrollResult.result.value.scrolled}px`);
							return true;
						}
					}
				} catch (e) {
					console.debug('Failed to scroll iframe content:', e);
				}
				return false;
			}

			// For regular elements, scroll using the element's scrollTop
			try {
				const result = await cdp.send('DOM.resolveNode', { backendNodeId });
				if (result.object?.objectId) {
					const scrollResult = await cdp.send('Runtime.callFunctionOn', {
						objectId: result.object.objectId,
						functionDeclaration: `function() {
							try {
								// Find the first scrollable parent
								let element = this;
								while (element && element !== document.body) {
									const style = window.getComputedStyle(element);
									const isScrollable = style.overflowY === 'auto' ||
										style.overflowY === 'scroll' ||
										(element.scrollHeight > element.clientHeight && style.overflowY !== 'hidden');
									if (isScrollable) {
										const oldScrollTop = element.scrollTop;
										element.scrollTop += ${pixels};
										const newScrollTop = element.scrollTop;
										if (newScrollTop !== oldScrollTop) {
											return {
												success: true,
												element: element.tagName,
												scrolled: newScrollTop - oldScrollTop
											};
										}
									}
									element = element.parentElement;
								}
								// Fallback: scroll the document
								const oldScrollTop = document.documentElement.scrollTop || document.body.scrollTop;
								window.scrollBy(0, ${pixels});
								const newScrollTop = document.documentElement.scrollTop || document.body.scrollTop;
								return {
									success: true,
									element: 'document',
									scrolled: newScrollTop - oldScrollTop
								};
							} catch (e) {
								return {success: false, error: e.message};
							}
						}`,
						returnByValue: true,
					});

					if (scrollResult.result?.value?.success) {
						console.debug(`Scrolled ${scrollResult.result.value.element} by ${scrollResult.result.value.scrolled}px`);
						return true;
					}
				}
			} catch (e) {
				console.debug('Failed to scroll element container:', e);
			}

			return false;
		} catch (e) {
			console.debug('scrollElementContainer error:', e);
			return false;
		}
	}

	private async handleScreenshot(event: ScreenshotEvent & { _eventId: string; pageId?: string }) {
		try {
			// Use page-specific page if provided (multi-agent support), otherwise fallback to current
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();

			// Remove interaction highlights first so they don't appear in the screenshot (Python 0.13)
			await this.removeHighlights().catch(() => {});
			const screenshot = await page.screenshot({
				fullPage: event.fullPage,
				clip: event.clip,
				type: 'png',
			});

			const base64 = screenshot.toString('base64');

			this.eventBus.respondToEvent(event._eventId, base64);
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	private async handleBrowserStateRequest(event: BrowserStateRequestEvent & { _eventId: string; pageId?: string }) {
		try {
			// Use page-specific page if provided (multi-agent support), otherwise fallback to current
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();

			// Get page scroll info for pageInfo
			const scrollInfo = await page.evaluate(() => {
				return {
					scrollX: window.scrollX,
					scrollY: window.scrollY,
					viewportWidth: window.innerWidth,
					viewportHeight: window.innerHeight,
					pageWidth: document.documentElement.scrollWidth,
					pageHeight: document.documentElement.scrollHeight,
				};
			});

			const pageInfo: PageInfo = {
				viewportWidth: scrollInfo.viewportWidth,
				viewportHeight: scrollInfo.viewportHeight,
				pageWidth: scrollInfo.pageWidth,
				pageHeight: scrollInfo.pageHeight,
				scrollX: scrollInfo.scrollX,
				scrollY: scrollInfo.scrollY,
				pixelsAbove: scrollInfo.scrollY,
				pixelsBelow: Math.max(0, scrollInfo.pageHeight - scrollInfo.viewportHeight - scrollInfo.scrollY),
				pixelsLeft: scrollInfo.scrollX,
				pixelsRight: Math.max(0, scrollInfo.pageWidth - scrollInfo.viewportWidth - scrollInfo.scrollX),
			};

			// Create empty domState first
			let domState: SerializedDOMState = {
				root: null,
				selectorMap: new Map(),
			};

			// DOM extraction using DOMService
			let lastPageState: PageState | null = null;
			if (event.includeDom !== false) {
				let domService: DOMService | null = null;
				try {
					domService = new DOMService(page, {
						paintOrderFiltering: true,
						crossOriginIframes: false,
						...((event as any).viewportThreshold !== undefined ? { viewportThreshold: (event as any).viewportThreshold } : {}),
					});
					const pageState = await domService.getPageState({
						includeScreenshot: false, // Will capture separately
						useCDPAccessibility: true,
					});
					lastPageState = pageState;

					// Update cached selector map
					this.updateCachedSelectorMap(pageState.selectorMap);

					// Create SimplifiedNode from domTree for llmRepresentation
					const domTree = pageState.domTree;
					const selectorMap = pageState.selectorMap;

					// Create a proper SerializedDOMState with llmRepresentation function
					// that uses DOMService.formatDOMForLLM
					domState = {
						root: this.createSimplifiedNode(domTree, selectorMap as any),
						selectorMap: selectorMap as any, // Type cast due to different EnhancedDOMTreeNode definitions
						llmRepresentation: (includeAttributes: string[] = []) => {
							// Pass filtered selectorMap to ensure LLM only sees valid element indices
							return domService!.formatDOMForLLM(domTree, 0, true, selectorMap);
						},
					};
				} catch (domError: any) {
					console.debug('DOM extraction failed:', domError.message);
				} finally {
					// Always detach the CDP session, even when extraction throws —
					// otherwise a failed step orphans the session at the Chromium level.
					if (domService) {
						try { await domService.close(); } catch {}
					}
				}
			}

			// Remember the real viewport for coordinate-click conversion
			this.originalViewportSize = [pageInfo.viewportWidth, pageInfo.viewportHeight];

			// Build the full BrowserStateSummary
			const state: BrowserStateSummary = {
				domState,
				url: page.url(),
				title: await page.title(),
				tabs: await this.getAllTabs(),
				pageInfo,
				pixelsAbove: pageInfo.pixelsAbove,
				pixelsBelow: pageInfo.pixelsBelow,
				browserErrors: [],
				isPdfViewer: page.url().endsWith('.pdf') || page.url().includes('chrome-extension://') && page.url().includes('pdf'),
				pendingNetworkRequests: [],
				paginationButtons: [],
				modalOverlays: lastPageState?.modalOverlays,
				closedPopupMessages: this.drainClosedPopupMessages(),
			};

			// Capture screenshot with element highlighting (like Python)
			if (event.includeScreenshot !== false) {
				// Remove interaction highlights first so they don't appear in the screenshot
				await this.removeHighlights().catch(() => {});
				const screenshot = await page.screenshot({ type: 'png' });
				let screenshotBase64 = screenshot.toString('base64');

				// Apply element highlighting if we have a selector map (like Python's create_highlighted_screenshot)
				if (domState.selectorMap && domState.selectorMap.size > 0) {
					try {
						// Get device pixel ratio for proper scaling
						const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio || 1);

						// Create highlighted screenshot with bounding boxes around interactive elements
						screenshotBase64 = await createHighlightedScreenshot(
							screenshotBase64,
							domState.selectorMap,
							devicePixelRatio,
							true // filterHighlightIds - only show index for elements without meaningful text
						);
					} catch (highlightError: any) {
						console.debug('Screenshot highlighting failed, using original:', highlightError.message);
						// Fall back to original screenshot if highlighting fails
					}
				}

				state.screenshot = screenshotBase64;
			}

			// Cache the state
			this.cachedBrowserStateSummary = state;

			this.eventBus.respondToEvent(event._eventId, state);
		} catch (error: any) {
			// Return a minimal, model-visible state instead of failing the whole step (Python 0.13
			// DOMWatchdog error state): the LLM sees <browser_state_error> and can wait/retry.
			const fallback = await this.buildFallbackBrowserState((event as any).pageId, error);
			if (fallback) {
				console.warn(`⚠️ Browser state request failed, returning minimal state: ${error?.message ?? error}`);
				this.eventBus.respondToEvent(event._eventId, fallback);
			} else {
				this.eventBus.rejectEvent(event._eventId, error);
			}
		}
	}

	/** Take (and clear) the dialog messages collected since the last browser state. */
	private drainClosedPopupMessages(): string[] {
		const messages = this.closedPopupMessages;
		this.closedPopupMessages = [];
		return messages;
	}

	/** Dialog messages collected since the last browser state (not cleared). */
	getClosedPopupMessages(): string[] {
		return [...this.closedPopupMessages];
	}

	/**
	 * Build a minimal browser state when DOM/screenshot capture fails, so the agent step
	 * can continue with an explicit `stateError` instead of a hard failure.
	 */
	private async buildFallbackBrowserState(pageId: string | undefined, error: unknown): Promise<BrowserStateSummary | null> {
		let url = '';
		let title = '';
		try {
			const page = pageId ? this.getPageOrCurrent(pageId) : this.getCurrentPage();
			url = page.url();
			try {
				title = await page.title();
			} catch {
				title = '';
			}
		} catch {
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			domState: { root: null, selectorMap: new Map(), llmRepresentation: () => '' },
			url,
			title,
			tabs: [],
			pageInfo: null,
			pixelsAbove: 0,
			pixelsBelow: 0,
			browserErrors: [message],
			isPdfViewer: false,
			pendingNetworkRequests: [],
			paginationButtons: [],
			closedPopupMessages: this.drainClosedPopupMessages(),
			stateError: `Browser state could not be captured: ${message}. The page may still be loading or unresponsive — consider waiting or refreshing.`,
		};
	}

	/**
	 * Create a SimplifiedNode from DOM tree for llmRepresentation compatibility
	 * Now properly builds the tree structure for accurate page statistics
	 */
	private createSimplifiedNode(
		domTree: any[],
		selectorMap: Map<number, any>
	): SimplifiedNode | null {
		if (!domTree || domTree.length === 0) {
			return null;
		}

		// Helper to recursively build SimplifiedNode tree from domTree
		const buildNode = (node: any): SimplifiedNode | null => {
			if (!node) return null;

			const backendNodeId = node.backendNodeId || 0;
			const isInteractive = selectorMap.has(backendNodeId);

			const simplified: SimplifiedNode = {
				isInteractive,
				isShadowHost: node.isShadowHost || false,
				isNew: false,
				shouldDisplay: true,
				ignoredByPaintOrder: false,
				excludedByParent: false,
				isCompoundComponent: false,
				children: [],
				originalNode: {
					nodeId: node.nodeId || 0,
					backendNodeId,
					sessionId: node.sessionId || '',
					frameId: node.frameId || '',
					targetId: node.targetId || '',
					nodeType: node.nodeType || NodeType.ELEMENT_NODE,
					nodeName: node.nodeName || '',
					nodeValue: node.nodeValue || '',
					attributes: node.attributes || {},
				},
			};

			// Recursively build children
			if (node.children && Array.isArray(node.children)) {
				for (const child of node.children) {
					const childNode = buildNode(child);
					if (childNode) {
						simplified.children.push(childNode);
					}
				}
			}

			// Also process shadow roots if present
			if (node.shadowRoots && Array.isArray(node.shadowRoots)) {
				for (const shadowRoot of node.shadowRoots) {
					const shadowNode = buildNode(shadowRoot);
					if (shadowNode) {
						simplified.children.push(shadowNode);
					}
				}
			}

			// Process content document for iframes
			if (node.contentDocument) {
				const contentNode = buildNode(node.contentDocument);
				if (contentNode) {
					simplified.children.push(contentNode);
				}
			}

			return simplified;
		};

		// Create root document node
		const root: SimplifiedNode = {
			isInteractive: false,
			isShadowHost: false,
			isNew: false,
			shouldDisplay: true,
			ignoredByPaintOrder: false,
			excludedByParent: false,
			isCompoundComponent: false,
			children: [],
			originalNode: {
				nodeId: 0,
				backendNodeId: 0,
				sessionId: '',
				frameId: '',
				targetId: '',
				nodeType: NodeType.DOCUMENT_NODE,
				nodeName: '#document',
				nodeValue: '',
				attributes: {},
			},
		};

		// Build children from domTree array
		for (const node of domTree) {
			const childNode = buildNode(node);
			if (childNode) {
				root.children.push(childNode);
			}
		}

		return root;
	}

	private async handleGoBack(event: GoBackEvent & { _eventId: string; pageId?: string }) {
		try {
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();
			await page.goBack();
			this.eventBus.respondToEvent(event._eventId, null);
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	private async handleGoForward(event: GoForwardEvent & { _eventId: string; pageId?: string }) {
		try {
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();
			await page.goForward();
			this.eventBus.respondToEvent(event._eventId, null);
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	private async handleRefresh(event: RefreshEvent & { _eventId: string; pageId?: string }) {
		try {
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();
			await page.reload();
			this.eventBus.respondToEvent(event._eventId, null);
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	private async handleWait(event: WaitEvent & { _eventId: string; pageId?: string }) {
		try {
			// Wait doesn't need page-specific handling, but accept pageId for consistency
			// FIXED: Removed arbitrary 10s cap - use maxSeconds from event or WAIT timeout (60s)
			// The event timeout (TIMEOUTS.WAIT = 60s) already enforces the upper limit
			const maxWait = event.maxSeconds || 60; // Match TIMEOUTS.WAIT from events/base.ts
			const seconds = Math.min(event.seconds, maxWait);
			console.debug(`Waiting for ${seconds}s (requested: ${event.seconds}s, max: ${maxWait}s)`);
			await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
			this.eventBus.respondToEvent(event._eventId, null);
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	/**
	 * Parse and normalize key names to match Playwright's expected format
	 * Handles aliases like 'ctrl' -> 'Control', 'cmd' -> 'Meta', etc.
	 */
	private normalizeKeyName(key: string): string {
		const keyAliases: Record<string, string> = {
			'ctrl': 'Control',
			'control': 'Control',
			'cmd': 'Meta',
			'command': 'Meta',
			'meta': 'Meta',
			'win': 'Meta',
			'windows': 'Meta',
			'alt': 'Alt',
			'option': 'Alt',
			'shift': 'Shift',
			'enter': 'Enter',
			'return': 'Enter',
			'esc': 'Escape',
			'escape': 'Escape',
			'tab': 'Tab',
			'space': 'Space',
			'backspace': 'Backspace',
			'delete': 'Delete',
			'del': 'Delete',
			'up': 'ArrowUp',
			'down': 'ArrowDown',
			'left': 'ArrowLeft',
			'right': 'ArrowRight',
			'arrowup': 'ArrowUp',
			'arrowdown': 'ArrowDown',
			'arrowleft': 'ArrowLeft',
			'arrowright': 'ArrowRight',
			'home': 'Home',
			'end': 'End',
			'pageup': 'PageUp',
			'pagedown': 'PageDown',
			'insert': 'Insert',
			'ins': 'Insert',
		};

		const lowerKey = key.toLowerCase().trim();
		return keyAliases[lowerKey] || key;
	}

	/**
	 * Parse key combination string like "Control+A" or "Ctrl+Shift+Delete"
	 * Returns array of keys to press in sequence
	 */
	private parseKeyCombination(keys: string): { modifiers: string[]; key: string } | null {
		// Handle key combinations with + separator
		if (keys.includes('+')) {
			const parts = keys.split('+').map(k => k.trim()).filter(k => k.length > 0);
			if (parts.length === 0) return null;

			const modifiers: string[] = [];
			let mainKey = '';

			for (let i = 0; i < parts.length; i++) {
				const normalizedKey = this.normalizeKeyName(parts[i]);
				// Check if it's a modifier key
				if (['Control', 'Alt', 'Shift', 'Meta'].includes(normalizedKey)) {
					modifiers.push(normalizedKey);
				} else {
					// Last non-modifier is the main key
					mainKey = normalizedKey;
				}
			}

			// If no main key found, use the last part
			if (!mainKey && parts.length > 0) {
				mainKey = this.normalizeKeyName(parts[parts.length - 1]);
				// Remove it from modifiers if it was added
				const idx = modifiers.indexOf(mainKey);
				if (idx !== -1) modifiers.splice(idx, 1);
			}

			return { modifiers, key: mainKey };
		}

		// Single key
		return { modifiers: [], key: this.normalizeKeyName(keys) };
	}

	private async handleSendKeys(event: SendKeysEvent & { _eventId: string; pageId?: string }) {
		try {
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();

			const keysInput = event.keys;

			// Parse the key combination
			const parsed = this.parseKeyCombination(keysInput);
			if (!parsed) {
				throw new Error(`Invalid key combination: ${keysInput}`);
			}

			const { modifiers, key } = parsed;

			if (modifiers.length > 0) {
				// Press modifiers in order, then the key, then release modifiers in reverse
				// This matches Python's behavior (lines 1609-1632 in default_action_watchdog.py)
				for (const mod of modifiers) {
					await page.keyboard.down(mod);
				}

				// Press the main key
				if (key) {
					await page.keyboard.press(key);
				}

				// Release modifiers in reverse order
				for (let i = modifiers.length - 1; i >= 0; i--) {
					await page.keyboard.up(modifiers[i]);
				}
			} else {
				// Simple single key press
				await page.keyboard.press(key);
			}

			// Add delay after Enter key for navigation (like Python line 1726-1727)
			if (key === 'Enter') {
				await new Promise(r => setTimeout(r, 100));
			}

			this.eventBus.respondToEvent(event._eventId, null);
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	private async handleUploadFile(event: UploadFileEvent & { _eventId: string; pageId?: string }) {
		try {
			// Use page-specific page if provided (multi-agent support), otherwise fallback to current
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();

			if (!event.node || !event.node.absolutePosition) {
				throw new Error('Element position not available for file upload');
			}

			// Click on the file input to focus it
			const { x, y } = event.node.absolutePosition;
			await page.mouse.click(x + 5, y + 5);

			// Helper to escape CSS selector values (handles special chars like quotes, brackets)
			const escapeCssSelectorValue = (value: string): string => {
				return value.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
			};

			// Use page.setInputFiles for file inputs
			// FIXED: Properly escape id and name attributes to handle special characters
			let selector: string;
			if (event.node.attributes?.id) {
				const escapedId = escapeCssSelectorValue(event.node.attributes.id);
				selector = `#${escapedId}`;
			} else if (event.node.attributes?.name) {
				const escapedName = escapeCssSelectorValue(event.node.attributes.name);
				selector = `input[name="${escapedName}"]`;
			} else {
				// Fallback - try to use backendNodeId through CDP if available
				selector = 'input[type="file"]';
			}

			const filePaths = Array.isArray(event.filePath) ? event.filePath : [event.filePath];
			await page.setInputFiles(selector, filePaths);

			this.eventBus.respondToEvent(event._eventId, { success: true });
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	private async handleGetDropdownOptions(event: GetDropdownOptionsEvent & { _eventId: string; pageId?: string }) {
		try {
			// Use page-specific page if provided (multi-agent support), otherwise fallback to current
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();

			if (!event.node || !event.node.absolutePosition) {
				throw new Error('Element position not available');
			}

			const nodeName = event.node.nodeName?.toLowerCase() || '';

			// Handle native <select> elements
			if (nodeName === 'select') {
				const selector = event.node.attributes?.id
					? `#${event.node.attributes.id}`
					: event.node.attributes?.name
						? `select[name="${event.node.attributes.name}"]`
						: 'select';

				const options = await page.evaluate((sel) => {
					const select = document.querySelector(sel) as HTMLSelectElement;
					if (!select) return [];
					return Array.from(select.options).map((opt) => ({
						value: opt.value,
						text: opt.text,
						selected: opt.selected,
					}));
				}, selector);

				this.eventBus.respondToEvent(event._eventId, {
					type: 'native_select',
					options: options,
				});
			} else {
				// Handle ARIA menus or custom dropdowns
				// Click to open the dropdown first
				const { x, y, width, height } = event.node.absolutePosition;
				await page.mouse.click(x + width / 2, y + height / 2);
				await page.waitForTimeout(300); // Wait for dropdown to open

				// Try to find dropdown options
				const options = await page.evaluate(() => {
					const menuItems = document.querySelectorAll(
						'[role="option"], [role="menuitem"], [role="listitem"], li[data-value], .dropdown-item, .select-option'
					);
					return Array.from(menuItems).map((item) => ({
						text: (item as HTMLElement).innerText?.trim() || '',
						value: item.getAttribute('data-value') || (item as HTMLElement).innerText?.trim() || '',
					}));
				});

				this.eventBus.respondToEvent(event._eventId, {
					type: 'custom_dropdown',
					options: options,
				});
			}
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	private async handleSelectDropdownOption(event: SelectDropdownOptionEvent & { _eventId: string; pageId?: string }) {
		try {
			// Use page-specific page if provided (multi-agent support), otherwise fallback to current
			const pageId = (event as any).pageId as string | undefined;
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();

			if (!event.node || !event.node.absolutePosition) {
				throw new Error('Element position not available');
			}

			const nodeName = event.node.nodeName?.toLowerCase() || '';

			// Handle native <select> elements
			if (nodeName === 'select') {
				const selector = event.node.attributes?.id
					? `#${event.node.attributes.id}`
					: event.node.attributes?.name
						? `select[name="${event.node.attributes.name}"]`
						: 'select';

				await page.selectOption(selector, { label: event.text });

				this.eventBus.respondToEvent(event._eventId, {
					success: true,
					selectedText: event.text,
				});
			} else {
				// Handle ARIA menus or custom dropdowns
				// Click to open the dropdown first
				const { x, y, width, height } = event.node.absolutePosition;
				await page.mouse.click(x + width / 2, y + height / 2);
				await page.waitForTimeout(300); // Wait for dropdown to open

				// FIXED: Case-insensitive matching, exact match preferred, expanded selectors
				// Matches Python watchdog behavior (lines 615, 639-640, 674, 706)
				const result = await page.evaluate((targetText) => {
					const targetLower = targetText.toLowerCase().trim();

					// Expanded selectors to match more dropdown patterns (like Python watchdog lines 527-536)
					const menuItems = document.querySelectorAll(
						'[role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
						'[role="listitem"], li[data-value], .dropdown-item, .select-option, .item, .option, ' +
						'.menu-item, [data-value], li, a'
					);

					let exactMatch: HTMLElement | null = null;
					let partialMatch: HTMLElement | null = null;
					const availableOptions: string[] = [];

					for (const item of Array.from(menuItems)) {
						const el = item as HTMLElement;
						const itemText = (el.innerText?.trim() || '').toLowerCase();
						const itemValue = (el.getAttribute('data-value') || '').toLowerCase();

						// Skip empty or very short items
						if (!itemText && !itemValue) continue;

						// Collect available options for error message
						if (itemText) availableOptions.push(el.innerText?.trim() || '');

						// Check for disabled state
						if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) {
							continue;
						}

						// Exact match on text or value (case-insensitive)
						if (itemText === targetLower || itemValue === targetLower) {
							exactMatch = el;
							break; // Prefer exact match
						}

						// Partial match only if no exact match yet
						if (!partialMatch && (itemText.includes(targetLower) || itemValue.includes(targetLower))) {
							partialMatch = el;
						}
					}

					const matchedEl = exactMatch || partialMatch;
					if (matchedEl) {
						matchedEl.click();
						// Dispatch events for framework compatibility
						matchedEl.dispatchEvent(new Event('input', { bubbles: true }));
						matchedEl.dispatchEvent(new Event('change', { bubbles: true }));
						return { found: true, selectedText: matchedEl.innerText?.trim() };
					}

					return { found: false, availableOptions: availableOptions.slice(0, 20) };
				}, event.text);

				if (!result.found) {
					// Include available options in error message (like Python watchdog lines 755-766)
					const availableOpts = result.availableOptions || [];
					const optionsInfo = availableOpts.length > 0
						? ` Available options: ${availableOpts.join(', ')}`
						: '';
					throw new Error(`Option "${event.text}" not found in dropdown.${optionsInfo}`);
				}

				this.eventBus.respondToEvent(event._eventId, {
					success: true,
					selectedText: event.text,
				});
			}
		} catch (error: any) {
			this.eventBus.rejectEvent(event._eventId, error);
		}
	}

	// ============================================================================
	// Helper Methods
	// ============================================================================

	private async getAllTabs(): Promise<TabInfo[]> {
		const tabs: TabInfo[] = [];

		for (const [pageId, page] of this.pages.entries()) {
			tabs.push({
				targetId: pageId,
				url: page.url(),
				title: await page.title(),
			});
		}

		return tabs;
	}

	/**
	 * Get browser state (matches Python's get_browser_state_summary)
	 * @param options.includeScreenshot - Whether to include screenshot (default: true)
	 * @param options.includeDom - Whether to include DOM state (default: true)
	 * @param options.includeRecentEvents - Whether to include recent events (default: false)
	 */
	async getState(options: {
		includeScreenshot?: boolean;
		includeDom?: boolean;
		includeRecentEvents?: boolean;
		/** Pixels beyond the viewport to still list (default 2000; a step-by-step
		 *  driver wants ~one screen so a results page fits its budget). */
		viewportThreshold?: number | null;
	} = {}): Promise<BrowserStateSummary> {
		return this.eventBus.dispatch<BrowserStateSummary>(
			BrowserEventNames.BROWSER_STATE_REQUEST,
			{
				includeScreenshot: options.includeScreenshot ?? true,
				includeDom: options.includeDom ?? true,
				includeRecentEvents: options.includeRecentEvents ?? false,
				...(options.viewportThreshold !== undefined ? { viewportThreshold: options.viewportThreshold } : {}),
			},
			TIMEOUTS.BROWSER_STATE_REQUEST
		);
	}

	/**
	 * Navigate to URL
	 */
	async navigate(url: string, options: Partial<NavigateToUrlEvent> = {}): Promise<void> {
		return this.eventBus.dispatch<void>(
			BrowserEventNames.NAVIGATE_TO_URL,
			{ url, ...options },
			TIMEOUTS.NAVIGATE_TO_URL
		);
	}

	/**
	 * Take screenshot
	 */
	async screenshot(options: Partial<ScreenshotEvent> = {}): Promise<string> {
		return this.eventBus.dispatch<string>(
			BrowserEventNames.SCREENSHOT,
			options,
			TIMEOUTS.SCREENSHOT
		);
	}

	/**
	 * Go back in history
	 */
	async goBack(): Promise<void> {
		return this.eventBus.dispatch<void>(BrowserEventNames.GO_BACK, {}, TIMEOUTS.GO_BACK);
	}

	/**
	 * Go forward in history
	 */
	async goForward(): Promise<void> {
		return this.eventBus.dispatch<void>(BrowserEventNames.GO_FORWARD, {}, TIMEOUTS.GO_FORWARD);
	}

	/**
	 * Refresh page
	 */
	async refresh(): Promise<void> {
		return this.eventBus.dispatch<void>(BrowserEventNames.REFRESH, {}, TIMEOUTS.REFRESH);
	}

	/**
	 * Get element by index from cached selector map
	 */
	async getElementByIndex(index: number): Promise<EnhancedDOMTreeNode | null> {
		// Check cached selector map
		if (this.cachedSelectorMap && this.cachedSelectorMap.has(index)) {
			return this.cachedSelectorMap.get(index)!;
		}
		return null;
	}

	/**
	 * Update the cached selector map with new DOM state
	 * This should be called after DOM extraction
	 */
	updateCachedSelectorMap(selectorMap: Map<number, EnhancedDOMTreeNode>): void {
		this.cachedSelectorMap = selectorMap;
	}

	/**
	 * Get the current selector map
	 */
	async getSelectorMap(): Promise<Map<number, EnhancedDOMTreeNode>> {
		return this.cachedSelectorMap;
	}

	/**
	 * Clear all cached state (selector maps, browser state summary)
	 * Called when page navigation is detected to prevent stale element references.
	 * Matches Python's cache clearing behavior on AgentFocusChangedEvent.
	 */
	clearCachedState(): void {
		console.debug('🔄 Clearing cached browser state (page navigation detected)');
		this.cachedSelectorMap.clear();
		this.cachedBrowserStateSummary = null;

		// Clear per-page selector maps as well
		for (const [pageId, selectorMap] of this.pageSelectorMaps) {
			selectorMap.clear();
		}

		// Clear pending requests tracking
		this.pendingRequests.clear();
	}

	/**
	 * Find element index by its id attribute
	 */
	async getIndexById(elementId: string): Promise<number | null> {
		for (const [idx, element] of this.cachedSelectorMap.entries()) {
			if (element.attributes && element.attributes['id'] === elementId) {
				return idx;
			}
		}
		return null;
	}

	/**
	 * Find element index by its class attribute
	 */
	async getIndexByClass(className: string): Promise<number | null> {
		for (const [idx, element] of this.cachedSelectorMap.entries()) {
			if (element.attributes) {
				const elementClass = element.attributes['class'] || '';
				if (elementClass.split(' ').includes(className)) {
					return idx;
				}
			}
		}
		return null;
	}

	/**
	 * Check if element is a file input
	 */
	isFileInput(element: EnhancedDOMTreeNode): boolean {
		return (
			element.nodeName?.toUpperCase() === 'INPUT' &&
			element.attributes?.['type']?.toLowerCase() === 'file'
		);
	}

	/**
	 * Click element at node
	 */
	async clickElement(node: EnhancedDOMTreeNode): Promise<any> {
		return this.eventBus.dispatch<any>(
			BrowserEventNames.CLICK_ELEMENT,
			{ node },
			TIMEOUTS.CLICK_ELEMENT
		);
	}

	/**
	 * Type text
	 */
	async typeText(text: string, node?: EnhancedDOMTreeNode): Promise<void> {
		return this.eventBus.dispatch<void>(
			BrowserEventNames.TYPE_TEXT,
			{ text, node },
			TIMEOUTS.TYPE_TEXT
		);
	}

	/**
	 * Scroll page
	 */
	async scroll(
		direction: 'up' | 'down' | 'left' | 'right',
		amount?: number,
		scrollableElement?: number
	): Promise<void> {
		return this.eventBus.dispatch<void>(
			BrowserEventNames.SCROLL,
			{ direction, amount: amount || 500 },
			TIMEOUTS.SCROLL
		);
	}

	/**
	 * Get target ID from tab ID (last 4 chars of target_id)
	 */
	async getTargetIdFromTabId(tabId: string): Promise<string> {
		const tabs = await this.getAllTabs();
		for (const tab of tabs) {
			if (tab.targetId.endsWith(tabId)) {
				return tab.targetId;
			}
		}
		throw new Error(`No tab found with ID ending in: ${tabId}`);
	}

	/**
	 * Switch to tab by tab ID (last 4 chars) or full target ID
	 */
	async switchTab(tabId: string): Promise<void> {
		// If it's a short ID (4 chars), look up the full target ID
		const targetId =
			tabId.length === 4 ? await this.getTargetIdFromTabId(tabId) : tabId;
		this.currentPageId = targetId;
	}

	/**
	 * Close tab by tab ID (last 4 chars) or full target ID
	 * Also handles current page switching if the closed tab was current
	 */
	async closeTab(tabId: string): Promise<boolean> {
		// If it's a short ID (4 chars), look up the full target ID
		const targetId =
			tabId.length === 4 ? await this.getTargetIdFromTabId(tabId) : tabId;
		const page = this.pages.get(targetId);
		if (page) {
			try {
				await page.close();
				this.pages.delete(targetId);

				// Clean up per-page selector map (multi-agent support)
				this.pageSelectorMaps.delete(targetId);

				// Clean up per-page CDP session (multi-agent support)
				const cdpSession = this.pageCdpSessions.get(targetId);
				if (cdpSession) {
					cdpSession.detach().catch(() => {}); // Ignore detach errors
					this.pageCdpSessions.delete(targetId);
				}

				// If we closed the current page, switch to another
				if (this.currentPageId === targetId) {
					const remainingPages = Array.from(this.pages.keys());
					this.currentPageId = remainingPages.length > 0 ? remainingPages[0] : undefined;
					console.log(`🔄 [BrowserSession] Switched to another tab after closing current`);
				}

				console.log(`🗑️ [BrowserSession] Closed tab ${tabId}. Remaining tabs: ${this.pages.size}`);
				return true;
			} catch (error: any) {
				console.error(`❌ [BrowserSession] Error closing tab ${tabId}: ${error.message}`);
				return false;
			}
		}
		return false;
	}

	/**
	 * Upload file to a file input element
	 */
	async uploadFile(index: number, filePaths: string[]): Promise<void> {
		const node = await this.getElementByIndex(index);
		if (!node) {
			throw new Error(`Element at index ${index} not found`);
		}

		if (!this.isFileInput(node)) {
			throw new Error(`Element at index ${index} is not a file input`);
		}

		return this.eventBus.dispatch<void>(
			BrowserEventNames.UPLOAD_FILE,
			{ node, filePath: filePaths },
			TIMEOUTS.UPLOAD_FILE || 30000
		);
	}

	/**
	 * Get dropdown options for an element
	 */
	async getDropdownOptions(index: number): Promise<{ type: string; options: any[] }> {
		const node = await this.getElementByIndex(index);
		if (!node) {
			throw new Error(`Element at index ${index} not found`);
		}

		return this.eventBus.dispatch<{ type: string; options: any[] }>(
			BrowserEventNames.GET_DROPDOWN_OPTIONS,
			{ node },
			TIMEOUTS.GET_DROPDOWN_OPTIONS || 15000
		);
	}

	/**
	 * Select a dropdown option by text
	 */
	async selectDropdownOption(index: number, text: string): Promise<{ success: boolean; selectedText: string }> {
		const node = await this.getElementByIndex(index);
		if (!node) {
			throw new Error(`Element at index ${index} not found`);
		}

		return this.eventBus.dispatch<{ success: boolean; selectedText: string }>(
			BrowserEventNames.SELECT_DROPDOWN_OPTION,
			{ node, text },
			TIMEOUTS.SELECT_DROPDOWN_OPTION || 8000
		);
	}

	/**
	 * Send keys
	 */
	async sendKeys(keys: string[]): Promise<void> {
		return this.eventBus.dispatch<void>(
			BrowserEventNames.SEND_KEYS,
			{ keys: keys.join('') },
			TIMEOUTS.SEND_KEYS
		);
	}

	/**
	 * Evaluate JavaScript code in the browser context
	 */
	async evaluate<T = any>(expression: string): Promise<T> {
		const page = await this.ensurePage();
		return page.evaluate(expression) as Promise<T>;
	}

	/**
	 * Get the current page for direct access when needed
	 */
	get page(): Page {
		return this.getCurrentPage();
	}

	// ============================================================================
	// Downloaded Files
	// ============================================================================

	/**
	 * Get list of downloaded files
	 */
	get downloadedFiles(): string[] {
		return [...this._downloadedFiles];
	}

	// ============================================================================
	// CDP Session Management
	// ============================================================================

	/**
	 * Get or create CDP session for current page
	 * Like Python's get_or_create_cdp_session, creates fresh session if stale
	 */
	async getCdpSession(): Promise<CDPSession> {
		const page = await this.ensurePage();

		// Validate existing session is still valid
		if (this.cdpSession) {
			try {
				// Try a simple command to validate the session
				await this.cdpSession.send('Runtime.evaluate', {
					expression: '1',
					returnByValue: true,
				});
				return this.cdpSession;
			} catch (error: any) {
				// Session is stale, clear it
				console.debug('CDP session stale, creating new one:', error.message);
				try {
					await this.cdpSession.detach();
				} catch {
					// Ignore detach errors
				}
				this.cdpSession = null;
			}
		}

		// Create new CDP session
		this.cdpSession = await page.context().newCDPSession(page);
		return this.cdpSession;
	}

	/**
	 * Get or create CDP session for a specific page (multi-agent support)
	 * Each page gets its own CDP session to avoid conflicts between parallel agents
	 */
	async getCdpSessionForPage(pageId: string): Promise<CDPSession> {
		const page = this.pages.get(pageId);
		if (!page) {
			throw new Error(`Page ${pageId} not found`);
		}

		// Check existing session for this page
		const existingSession = this.pageCdpSessions.get(pageId);
		if (existingSession) {
			try {
				// Validate the session is still valid
				await existingSession.send('Runtime.evaluate', {
					expression: '1',
					returnByValue: true,
				});
				return existingSession;
			} catch (error: any) {
				// Session is stale, remove it
				console.debug(`CDP session for page ${pageId} stale, creating new one:`, error.message);
				try {
					await existingSession.detach();
				} catch {
					// Ignore detach errors
				}
				this.pageCdpSessions.delete(pageId);
			}
		}

		// Create new CDP session for this page
		const newSession = await page.context().newCDPSession(page);
		this.pageCdpSessions.set(pageId, newSession);
		return newSession;
	}

	/**
	 * Close CDP session
	 */
	async closeCdpSession(): Promise<void> {
		if (this.cdpSession) {
			await this.cdpSession.detach();
			this.cdpSession = null;
		}
	}

	/**
	 * Close CDP session for a specific page
	 */
	async closeCdpSessionForPage(pageId: string): Promise<void> {
		const session = this.pageCdpSessions.get(pageId);
		if (session) {
			try {
				await session.detach();
			} catch {
				// Ignore detach errors
			}
			this.pageCdpSessions.delete(pageId);
		}
	}

	// ============================================================================
	// Cookies & Storage
	// ============================================================================

	/**
	 * Get all cookies, optionally filtered by URLs
	 * Port from browser_use/browser/session.py cookies (lines 994-1007)
	 */
	async cookies(urls?: string[]): Promise<any[]> {
		if (!this.context) {
			throw new Error('Browser context not initialized');
		}
		return this.context.cookies(urls);
	}

	/**
	 * Set cookies
	 */
	async setCookies(cookies: any[]): Promise<void> {
		if (!this.context) {
			throw new Error('Browser context not initialized');
		}
		await this.context.addCookies(cookies);
	}

	/**
	 * Clear all cookies
	 * Port from browser_use/browser/session.py clear_cookies (lines 1005-1007)
	 */
	async clearCookies(): Promise<void> {
		if (!this.context) {
			throw new Error('Browser context not initialized');
		}
		await this.context.clearCookies();
	}

	/**
	 * Export browser storage state (cookies, localStorage, sessionStorage)
	 * Port from browser_use/browser/session.py export_storage_state (lines 1009-1052)
	 */
	async exportStorageState(outputPath?: string): Promise<any> {
		if (!this.context) {
			throw new Error('Browser context not initialized');
		}

		if (outputPath) {
			return this.context.storageState({ path: outputPath });
		}
		return this.context.storageState();
	}

	/**
	 * Import storage state from file or object
	 */
	async importStorageState(storageState: string | any): Promise<void> {
		// Note: Playwright doesn't support importing storage state after context creation
		// This would need to be done during context creation
		console.warn('Storage state import is only supported during browser session initialization');
	}

	// ============================================================================
	// Frame Handling
	// ============================================================================

	/**
	 * Get all frames in the current page using CDP for complete frame hierarchy
	 * Port from browser_use/browser/session.py get_all_frames (lines 2766-2899)
	 * Includes cross-origin iframe support via CDP
	 */
	async getAllFrames(
		includeCrossOrigin: boolean = true
	): Promise<{ frames: Map<string, any>; targetSessions: Map<string, string> }> {
		const allFrames = new Map<string, any>();
		const targetSessions = new Map<string, string>();

		try {
			const page = await this.ensurePage();
			const cdp = await page.context().newCDPSession(page);

			// Get all targets including iframes
			const targetsResult = await cdp.send('Target.getTargets');
			const targets = (targetsResult as any).targetInfos || [];

			// Filter targets - include pages and optionally iframes
			const validTargets = targets.filter((t: any) => {
				if (t.type === 'page') return true;
				if (t.type === 'iframe' && includeCrossOrigin) return true;
				return false;
			});

			// Process each target to get its frame tree
			for (const target of validTargets) {
				const targetId = target.targetId;

				try {
					// Attach to target if needed
					let sessionId: string | undefined;
					try {
						const attachResult = await cdp.send('Target.attachToTarget', {
							targetId,
							flatten: true,
						});
						sessionId = (attachResult as any).sessionId;
					} catch (e) {
						// Already attached or can't attach
						console.debug(`Could not attach to target ${targetId}:`, e);
						continue;
					}

					if (sessionId) {
						targetSessions.set(targetId, sessionId);

						// Enable Page domain and get frame tree
						await cdp.send('Page.enable', undefined, sessionId);
						const frameTreeResult = await cdp.send('Page.getFrameTree', undefined, sessionId);
						const frameTree = (frameTreeResult as any).frameTree;

						if (frameTree) {
							// Process frame tree recursively
							const processFrameTree = (node: any, parentFrameId: string | null = null) => {
								const frame = node.frame || {};
								const currentFrameId = frame.id;

								if (currentFrameId) {
									const actualParentId = frame.parentId || parentFrameId;

									// Create frame info
									const frameInfo = {
										...frame,
										frameTargetId: targetId,
										parentFrameId: actualParentId,
										childFrameIds: [] as string[],
										isCrossOrigin: target.type === 'iframe',
									};

									// Check crossOriginIsolatedContextType
									const crossOriginType = frame.crossOriginIsolatedContextType;
									if (crossOriginType && crossOriginType !== 'NotIsolated') {
										frameInfo.isCrossOrigin = true;
									}

									// Add child frame IDs
									const childFrames = node.childFrames || [];
									for (const child of childFrames) {
										const childFrame = child.frame || {};
										if (childFrame.id) {
											frameInfo.childFrameIds.push(childFrame.id);
										}
									}

									// Store frame info
									if (allFrames.has(currentFrameId)) {
										// Update existing with iframe target info
										const existing = allFrames.get(currentFrameId);
										if (target.type === 'iframe') {
											existing.frameTargetId = targetId;
											existing.isCrossOrigin = true;
										}
									} else {
										allFrames.set(currentFrameId, frameInfo);
									}

									// Process children
									for (const child of childFrames) {
										processFrameTree(child, currentFrameId);
									}
								}
							};

							processFrameTree(frameTree);
						}
					}
				} catch (e) {
					console.debug(`Failed to get frame tree for target ${targetId}:`, e);
				}
			}
		} catch (error) {
			console.debug('Failed to get frames via CDP, falling back to Playwright:', error);

			// Fallback to Playwright frames
			const page = await this.ensurePage();
			const mainFrame = page.mainFrame();

			const processPlaywrightFrame = (frame: any, parentId: string | null) => {
				const frameId = frame.name() || `frame_${allFrames.size}`;
				allFrames.set(frameId, {
					id: frameId,
					url: frame.url(),
					name: frame.name(),
					parentFrameId: parentId,
					isCrossOrigin: false,
				});

				for (const childFrame of frame.childFrames()) {
					processPlaywrightFrame(childFrame, frameId);
				}
			};

			processPlaywrightFrame(mainFrame, null);
		}

		return { frames: allFrames, targetSessions };
	}

	/**
	 * Find a frame by ID
	 * Port from browser_use/browser/session.py find_frame_target (lines 2939-2952)
	 */
	async findFrameById(frameId: string): Promise<any | null> {
		const { frames } = await this.getAllFrames();
		return frames.get(frameId) || null;
	}

	/**
	 * Get frame by URL
	 */
	async getFrameByUrl(url: string): Promise<any | null> {
		const page = await this.ensurePage();
		const frames = page.frames();

		for (const frame of frames) {
			if (frame.url() === url || frame.url().includes(url)) {
				return frame;
			}
		}
		return null;
	}

	// ============================================================================
	// DOM Highlighting
	// ============================================================================

	/**
	 * Remove all highlights from the page
	 * Port from browser_use/browser/session.py remove_highlights (lines 1874-1918)
	 */
	async removeHighlights(): Promise<void> {
		if (!this.highlightsAdded) {
			return;
		}

		try {
			const page = await this.ensurePage();
			await page.evaluate(() => {
				// Remove the debug highlight container (matching Python's container ID)
				const debugContainer = document.getElementById('browser-use-debug-highlights');
				if (debugContainer) {
					debugContainer.remove();
				}

				// Also remove legacy highlight container (for backwards compatibility)
				const legacyContainer = document.getElementById('browser-use-highlights');
				if (legacyContainer) {
					legacyContainer.remove();
				}

				// Remove any stray highlight elements with data attribute
				const highlightedElements = document.querySelectorAll('[data-browser-use-highlight]');
				highlightedElements.forEach((el) => {
					el.remove();
				});

				// Remove interaction highlights
				const interactionHighlights = document.querySelectorAll('[data-browser-use-interaction-highlight]');
				interactionHighlights.forEach((el) => {
					el.remove();
				});
			});

			this.highlightsAdded = false;
		} catch (error: any) {
			console.debug(`Failed to remove highlights: ${error.message}`);
		}
	}

	/**
	 * Add highlights to elements in the selector map
	 * Port from browser_use/browser/session.py add_highlights (lines 2205-2421)
	 */
	async addHighlights(selectorMap: Map<number, EnhancedDOMTreeNode>): Promise<void> {
		try {
			const page = await this.ensurePage();

			// First remove existing highlights
			await this.removeHighlights();

			// Add a small delay to ensure removal completes (matching Python)
			await new Promise(resolve => setTimeout(resolve, 50));

			// Build highlight data with element name for color coding
			const highlights: Array<{
				index: number;
				x: number;
				y: number;
				width: number;
				height: number;
				elementName: string;
				backendNodeId: number;
			}> = [];

			for (const [index, node] of selectorMap.entries()) {
				if (node.absolutePosition) {
					const { x, y, width, height } = node.absolutePosition;
					// Only include elements with valid bounding boxes
					if (width > 0 && height > 0) {
						highlights.push({
							index,
							x,
							y,
							width,
							height,
							elementName: node.nodeName || 'div',
							backendNodeId: node.backendNodeId || index,
						});
					}
				}
			}

			if (highlights.length === 0) {
				console.debug('No valid elements to highlight');
				return;
			}

			// Inject highlight overlay with Apple Liquid Glass effect (matching Python)
			await page.evaluate((highlightData) => {
				// Double-check: Remove any existing highlight container first
				const existingContainer = document.getElementById('browser-use-debug-highlights');
				if (existingContainer) {
					existingContainer.remove();
				}

				// Also remove any stray highlight elements
				const strayHighlights = document.querySelectorAll('[data-browser-use-highlight]');
				strayHighlights.forEach(el => el.remove());

				// Use maximum z-index for visibility
				const HIGHLIGHT_Z_INDEX = 2147483647;

				// Create container for all highlights - use ABSOLUTE positioning (matching Python exactly)
				const container = document.createElement('div');
				container.id = 'browser-use-debug-highlights';
				container.setAttribute('data-browser-use-highlight', 'container');
				container.style.cssText = `
					position: absolute;
					top: 0;
					left: 0;
					width: 100vw;
					height: 100vh;
					pointer-events: none;
					z-index: ${HIGHLIGHT_Z_INDEX};
					overflow: visible;
					margin: 0;
					padding: 0;
					border: none;
					outline: none;
					box-shadow: none;
					background: none;
					font-family: inherit;
				`;

				// Professional liquid glass color scheme - sophisticated neutral palette (matching Python)
				const getElementColor = (elementName: string) => {
					const colors: Record<string, { main: string; glow: string; label: string }> = {
						'button': { main: '#8FA3B8', glow: 'rgba(143, 163, 184, 0.3)', label: '#8FA3B8' },
						'input': { main: '#A0B4C8', glow: 'rgba(160, 180, 200, 0.3)', label: '#A0B4C8' },
						'select': { main: '#B8C5D0', glow: 'rgba(184, 197, 208, 0.3)', label: '#B8C5D0' },
						'a': { main: '#7A92A8', glow: 'rgba(122, 146, 168, 0.3)', label: '#7A92A8' },
						'textarea': { main: '#C0CCD8', glow: 'rgba(192, 204, 216, 0.3)', label: '#C0CCD8' },
						'default': { main: '#9CADB8', glow: 'rgba(156, 173, 184, 0.3)', label: '#9CADB8' },
					};
					return colors[elementName.toLowerCase()] || colors.default;
				};

				// Add highlights for each element (matching Python positioning exactly)
				for (const hl of highlightData) {
					const colors = getElementColor(hl.elementName);

					const highlight = document.createElement('div');
					highlight.setAttribute('data-browser-use-highlight', 'element');
					highlight.setAttribute('data-element-id', String(hl.backendNodeId));
					highlight.style.cssText = `
						position: absolute;
						left: ${hl.x}px;
						top: ${hl.y}px;
						width: ${hl.width}px;
						height: ${hl.height}px;
						background: transparent;
						border: 2px solid ${colors.main};
						border-radius: 8px;
						pointer-events: none;
						box-sizing: border-box;
						margin: 0;
						padding: 0;
					`;

					// Label for element index (matching Python exactly)
					const label = document.createElement('div');
					label.textContent = String(hl.backendNodeId);
					label.style.cssText = `
						position: absolute;
						top: -28px;
						left: 50%;
						transform: translateX(-50%);
						background: linear-gradient(135deg, ${colors.label}EE 0%, ${colors.label}CC 100%);
						color: white;
						padding: 5px 14px;
						font-size: ${fontSizes.xs};
						font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
						font-weight: 600;
						letter-spacing: 0.4px;
						border-radius: 10px;
						white-space: nowrap;
						z-index: ${HIGHLIGHT_Z_INDEX + 1};
						margin: 0;
						line-height: 1.4;
					`;

					highlight.appendChild(label);
					container.appendChild(highlight);
				}

				document.body.appendChild(container);
			}, highlights);

			this.highlightsAdded = true;
		} catch (error: any) {
			console.debug(`Failed to add highlights: ${error.message}`);
		}
	}

	/**
	 * Highlight a specific interaction element
	 * Port from browser_use/browser/session.py highlight_interaction_element (lines 2033-2203)
	 */
	async highlightInteractionElement(node: EnhancedDOMTreeNode, pageId?: string): Promise<void> {
		try {
			// Get fresh coordinates using CDP (matching Python exactly)
			// Python: rect = await self.get_element_coordinates(node.backend_node_id, cdp_session)
			const rect = await this.getElementCoordinatesByBackendNodeId(node.backendNodeId, pageId);

			if (!rect) {
				console.debug(`No coordinates found for backend node ${node.backendNodeId}`);
				return;
			}

			// Use page-specific page for multi-agent support
			const page = pageId ? this.getPageOrCurrent(pageId) : await this.ensurePage();
			const { x, y, width, height } = rect;

			// Professional steel gray color (matching Python's default: rgb(156, 173, 184) = #9CADB8)
			const color = 'rgb(156, 173, 184)';
			const duration = 2000; // ms

			await page.evaluate(
				({ x, y, width, height, color, duration }) => {
					// Check for accessibility preference - respect reduced motion
					const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
					const shouldAnimate = !prefersReducedMotion;

					// Get current scroll position (matching Python exactly)
					const scrollX = window.pageXOffset || document.documentElement.scrollLeft || 0;
					const scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;

					// Remove existing interaction highlight
					const existing = document.querySelector('[data-browser-use-interaction-highlight]');
					if (existing) {
						existing.remove();
					}

					// Create frame-only overlay (transparent middle, border only)
					// Use ABSOLUTE positioning with scroll offset (matching Python exactly)
					const overlay = document.createElement('div');
					overlay.setAttribute('data-browser-use-interaction-highlight', 'true');
					overlay.style.cssText = `
						position: absolute;
						left: ${x + scrollX}px;
						top: ${y + scrollY}px;
						width: ${width}px;
						height: ${height}px;
						background: transparent;
						border: 3px solid ${color};
						border-radius: 12px;
						pointer-events: none;
						z-index: 2147483647;
						box-sizing: border-box;
						transform: ${shouldAnimate ? 'scale(0.95)' : 'scale(1)'};
						opacity: ${shouldAnimate ? '0' : '1'};
						transition: ${shouldAnimate ? 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none'};
					`;

					// Frame-only highlight - no glow ring or shimmer to keep middle transparent
					document.body.appendChild(overlay);

					// Animate in with spring effect (or instantly if reduced motion)
					if (shouldAnimate) {
						requestAnimationFrame(() => {
							setTimeout(() => {
								overlay.style.transform = 'scale(1)';
								overlay.style.opacity = '1';
							}, 10);
						});
					}

					// Elegant fade out with scale animation (or quick removal if reduced motion)
					setTimeout(() => {
						if (shouldAnimate) {
							overlay.style.transform = 'scale(1.05)';
							overlay.style.opacity = '0';
							overlay.style.transition = 'all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1)';
							setTimeout(() => overlay.remove(), 300);
						} else {
							overlay.remove();
						}
					}, duration);
				},
				{ x, y, width: width || 0, height: height || 0, color, duration }
			);
		} catch (error: any) {
			console.debug(`Failed to highlight interaction element: ${error.message}`);
		}
	}

	/**
	 * Get element coordinates/bounding box by CSS selector
	 * Port from browser_use/browser/session.py get_element_coordinates (lines 1920-2031)
	 */
	async getElementCoordinates(
		selector: string
	): Promise<{ x: number; y: number; width: number; height: number } | null> {
		try {
			const page = await this.ensurePage();
			const element = await page.$(selector);

			if (!element) {
				return null;
			}

			const box = await element.boundingBox();
			if (!box) {
				return null;
			}

			return {
				x: box.x,
				y: box.y,
				width: box.width,
				height: box.height,
			};
		} catch (error: any) {
			console.debug(`Failed to get element coordinates: ${error.message}`);
			return null;
		}
	}

	/**
	 * Get element coordinates by backendNodeId using CDP
	 * Matches Python's get_element_coordinates exactly (lines 1920-2031)
	 * Uses DOM.getContentQuads -> DOM.getBoxModel -> getBoundingClientRect fallback chain
	 */
	async getElementCoordinatesByBackendNodeId(
		backendNodeId: number,
		pageId?: string
	): Promise<{ x: number; y: number; width: number; height: number } | null> {
		try {
			// Use page-specific CDP session for multi-agent support
			const cdp = pageId ? await this.getCdpSessionForPage(pageId) : await this.getCdpSession();
			let quads: number[][] = [];

			// Method 1: Try DOM.getContentQuads first (best for inline elements and complex layouts)
			try {
				const contentQuadsResult = await cdp.send('DOM.getContentQuads', {
					backendNodeId,
				});
				if (contentQuadsResult.quads && contentQuadsResult.quads.length > 0) {
					quads = contentQuadsResult.quads;
					console.debug(`Got ${quads.length} quads from DOM.getContentQuads`);
				}
			} catch (error: any) {
				console.debug(`DOM.getContentQuads failed: ${error.message}`);
			}

			// Method 2: Fall back to DOM.getBoxModel
			if (quads.length === 0) {
				try {
					const boxModel = await cdp.send('DOM.getBoxModel', {
						backendNodeId,
					});
					if (boxModel.model && boxModel.model.content && boxModel.model.content.length >= 8) {
						const content = boxModel.model.content;
						// Convert box model format to quad format
						quads = [[
							content[0], content[1], // x1, y1
							content[2], content[3], // x2, y2
							content[4], content[5], // x3, y3
							content[6], content[7], // x4, y4
						]];
						console.debug('Got quad from DOM.getBoxModel');
					}
				} catch (error: any) {
					console.debug(`DOM.getBoxModel failed: ${error.message}`);
				}
			}

			// Method 3: Fall back to JavaScript getBoundingClientRect
			if (quads.length === 0) {
				try {
					const resolved = await cdp.send('DOM.resolveNode', {
						backendNodeId,
					});
					if (resolved.object && resolved.object.objectId) {
						const jsResult = await cdp.send('Runtime.callFunctionOn', {
							objectId: resolved.object.objectId,
							functionDeclaration: `
								function() {
									const rect = this.getBoundingClientRect();
									return {
										x: rect.x,
										y: rect.y,
										width: rect.width,
										height: rect.height
									};
								}
							`,
							returnByValue: true,
						});
						if (jsResult.result && jsResult.result.value) {
							const rectData = jsResult.result.value as { x: number; y: number; width: number; height: number };
							if (rectData.width > 0 && rectData.height > 0) {
								return rectData;
							}
						}
					}
				} catch (error: any) {
					console.debug(`JavaScript getBoundingClientRect failed: ${error.message}`);
				}
			}

			// Convert quads to bounding rectangle if we have them
			if (quads.length > 0) {
				const quad = quads[0];
				if (quad.length >= 8) {
					// Calculate bounding rect from quad points
					const xCoords = [quad[0], quad[2], quad[4], quad[6]];
					const yCoords = [quad[1], quad[3], quad[5], quad[7]];

					const minX = Math.min(...xCoords);
					const minY = Math.min(...yCoords);
					const maxX = Math.max(...xCoords);
					const maxY = Math.max(...yCoords);

					const width = maxX - minX;
					const height = maxY - minY;

					if (width > 0 && height > 0) {
						return { x: minX, y: minY, width, height };
					}
				}
			}

			return null;
		} catch (error: any) {
			console.debug(`Failed to get element coordinates by backendNodeId: ${error.message}`);
			return null;
		}
	}

	// ============================================================================
	// Page Management
	// ============================================================================

	/**
	 * Create a new page/tab
	 * Port from browser_use/browser/session.py new_page (lines 932-944)
	 */
	async newPage(url?: string): Promise<Page> {
		if (!this.context) {
			throw new Error('Browser context not initialized');
		}

		const page = await this.context.newPage();
		const pageId = this.generatePageId();
		this.pages.set(pageId, page);
		await this.injectStealthScripts(page);
		this.setupPageListeners(page, pageId);
		this.currentPageId = pageId;

		if (url) {
			await page.goto(url);
		}

		return page;
	}

	/**
	 * Get current page URL
	 * Port from browser_use/browser/session.py get_current_page_url (lines 1689-1693)
	 */
	async getCurrentPageUrl(): Promise<string> {
		const page = await this.ensurePage();
		return page.url();
	}

	/**
	 * Get current page title
	 * Port from browser_use/browser/session.py get_current_page_title (lines 1696-1700)
	 */
	async getCurrentPageTitle(): Promise<string> {
		const page = await this.ensurePage();
		return page.title();
	}

	/**
	 * Get all pages/tabs
	 * Port from browser_use/browser/session.py get_pages (lines 965-977)
	 */
	async getPages(): Promise<Page[]> {
		return Array.from(this.pages.values());
	}

	/**
	 * Close a specific page
	 * Port from browser_use/browser/session.py close_page (lines 979-992)
	 */
	async closePage(pageOrId: Page | string): Promise<void> {
		let pageId: string | undefined;
		let page: Page | undefined;

		if (typeof pageOrId === 'string') {
			pageId = pageOrId;
			page = this.pages.get(pageId);
		} else {
			// Find page ID for the given page
			for (const [id, p] of this.pages.entries()) {
				if (p === pageOrId) {
					pageId = id;
					page = p;
					break;
				}
			}
		}

		if (page && pageId) {
			await page.close();
			this.pages.delete(pageId);

			// Switch to another page if this was the current one
			if (this.currentPageId === pageId) {
				const remainingPages = Array.from(this.pages.keys());
				this.currentPageId = remainingPages[0];
			}
		}
	}

	// ============================================================================
	// Permissions & Geolocation
	// ============================================================================

	/**
	 * Grant browser permissions
	 * Port from browser_use/browser/session.py _cdp_grant_permissions (lines 2544-2551)
	 */
	async grantPermissions(permissions: string[], origin?: string): Promise<void> {
		if (!this.context) {
			throw new Error('Browser context not initialized');
		}

		await this.context.grantPermissions(permissions, { origin });
	}

	/**
	 * Set geolocation
	 * Port from browser_use/browser/session.py _cdp_set_geolocation (lines 2553-2557)
	 */
	async setGeolocation(latitude: number, longitude: number, accuracy: number = 100): Promise<void> {
		if (!this.context) {
			throw new Error('Browser context not initialized');
		}

		await this.context.setGeolocation({ latitude, longitude, accuracy });
	}

	/**
	 * Clear geolocation override
	 * Port from browser_use/browser/session.py _cdp_clear_geolocation (lines 2559-2561)
	 */
	async clearGeolocation(): Promise<void> {
		if (!this.context) {
			throw new Error('Browser context not initialized');
		}

		await this.context.clearPermissions();
	}

	// ============================================================================
	// Extra Headers & Init Scripts
	// ============================================================================

	/**
	 * Set extra HTTP headers
	 * Port from browser_use/browser/session.py _cdp_set_extra_headers (lines 2535-2542)
	 */
	async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
		if (!this.context) {
			throw new Error('Browser context not initialized');
		}

		await this.context.setExtraHTTPHeaders(headers);
	}

	/**
	 * Add initialization script
	 * Port from browser_use/browser/session.py _cdp_add_init_script (lines 2563-2571)
	 */
	async addInitScript(script: string | { path: string }): Promise<void> {
		if (!this.context) {
			throw new Error('Browser context not initialized');
		}

		await this.context.addInitScript(script);
	}

	// ============================================================================
	// Viewport
	// ============================================================================

	/**
	 * Set viewport size
	 * Port from browser_use/browser/session.py _cdp_set_viewport (lines 2580-2605)
	 */
	async setViewport(width: number, height: number): Promise<void> {
		const page = await this.ensurePage();
		await page.setViewportSize({ width, height });
	}

	/**
	 * Get current viewport size
	 */
	async getViewport(): Promise<{ width: number; height: number } | null> {
		const page = await this.ensurePage();
		return page.viewportSize();
	}

	// ============================================================================
	// Screenshot Utilities
	// ============================================================================

	/**
	 * Take a full-page screenshot
	 * Port from browser_use/browser/session.py take_screenshot (lines 3033-3089)
	 */
	async takeScreenshot(options?: {
		fullPage?: boolean;
		path?: string;
		type?: 'png' | 'jpeg';
		quality?: number;
		clip?: { x: number; y: number; width: number; height: number };
	}): Promise<Buffer> {
		const page = await this.ensurePage();
		return page.screenshot({
			fullPage: options?.fullPage ?? false,
			path: options?.path,
			type: options?.type ?? 'png',
			quality: options?.quality,
			clip: options?.clip,
		});
	}

	/**
	 * Take a screenshot of a specific element
	 * Port from browser_use/browser/session.py screenshot_element (lines 3091-3119)
	 */
	async screenshotElement(
		selector: string,
		options?: { path?: string; type?: 'png' | 'jpeg'; quality?: number }
	): Promise<Buffer | null> {
		try {
			const page = await this.ensurePage();
			const element = await page.$(selector);

			if (!element) {
				return null;
			}

			return element.screenshot({
				path: options?.path,
				type: options?.type ?? 'png',
				quality: options?.quality,
			});
		} catch (error: any) {
			console.debug(`Failed to screenshot element: ${error.message}`);
			return null;
		}
	}

	// ============================================================================
	// Browser State Text
	// ============================================================================

	/**
	 * Get browser state as formatted text
	 * Port from browser_use/browser/session.py get_state_as_text (lines 1174-1178)
	 */
	async getStateAsText(): Promise<string> {
		const state = await this.getState();
		const lines: string[] = [];

		lines.push(`URL: ${state.url}`);
		lines.push(`Title: ${state.title}`);
		lines.push(`Tabs: ${state.tabs.length}`);

		for (const tab of state.tabs) {
			lines.push(`  - [${tab.targetId.slice(-4)}] ${tab.title}: ${tab.url}`);
		}

		return lines.join('\n');
	}

	// ============================================================================
	// Reset
	// ============================================================================

	/**
	 * Reset browser session state
	 * Port from browser_use/browser/session.py reset (lines 393-425)
	 */
	async reset(): Promise<void> {
		// Clear caches
		this.cachedSelectorMap.clear();
		this.cachedBrowserStateSummary = null;
		this._downloadedFiles = [];

		// Remove highlights
		await this.removeHighlights();

		// Close all pages except one
		const pageIds = Array.from(this.pages.keys());
		for (let i = 1; i < pageIds.length; i++) {
			const page = this.pages.get(pageIds[i]);
			if (page) {
				await page.close();
				this.pages.delete(pageIds[i]);
			}
		}

		// Navigate remaining page to about:blank
		if (pageIds.length > 0) {
			const firstPage = this.pages.get(pageIds[0]);
			if (firstPage) {
				await firstPage.goto('about:blank');
			}
		}

		// Clear cookies
		await this.clearCookies();
	}
}

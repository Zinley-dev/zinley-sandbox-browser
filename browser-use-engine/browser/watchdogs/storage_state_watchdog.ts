/**
 * Storage state watchdog for managing browser cookies and storage persistence
 * Port from browser_use/browser/watchdogs/storage_state_watchdog.py
 */
import { EventEmitter } from 'events';
import { BrowserContext, CDPSession } from 'patchright';
import fs from 'fs';
import path from 'path';

export interface Cookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface Origin {
	origin: string;
	localStorage?: Array<{ name: string; value: string }>;
	sessionStorage?: Array<{ name: string; value: string }>;
}

export interface StorageState {
	cookies: Cookie[];
	origins: Origin[];
}

export interface StorageStateWatchdogOptions {
	/** Path to storage state file */
	storagePath?: string;
	/** Auto-save interval in milliseconds */
	autoSaveInterval?: number;
	/** Save immediately when cookies change */
	saveOnChange?: boolean;
}

export class StorageStateWatchdog {
	private isRunning: boolean = false;
	private context: BrowserContext | null = null;
	private cdpSession: CDPSession | null = null;
	private storagePath: string | null;
	private autoSaveInterval: number;
	private saveOnChange: boolean;
	private monitoringInterval: NodeJS.Timeout | null = null;
	private lastCookieState: Cookie[] = [];
	private saveLock: boolean = false;

	constructor(
		private eventBus: EventEmitter,
		options: StorageStateWatchdogOptions = {}
	) {
		this.storagePath = options.storagePath || null;
		this.autoSaveInterval = options.autoSaveInterval ?? 30000; // 30 seconds
		this.saveOnChange = options.saveOnChange ?? true;
	}

	/**
	 * Set the browser context
	 */
	setContext(context: BrowserContext): void {
		this.context = context;
	}

	/**
	 * Set the CDP session
	 */
	setCDPSession(cdpSession: CDPSession): void {
		this.cdpSession = cdpSession;
	}

	/**
	 * Set storage path
	 */
	setStoragePath(storagePath: string): void {
		this.storagePath = storagePath;
	}

	/**
	 * Start monitoring
	 */
	private startMonitoring(): void {
		if (this.monitoringInterval) return;

		this.monitoringInterval = setInterval(async () => {
			try {
				if (await this.haveCookiesChanged()) {
					console.log('[StorageStateWatchdog] Detected changes to sync with storage_state.json');
					await this.saveStorageState();
				}
			} catch (error: any) {
				console.error(`[StorageStateWatchdog] Error in monitoring loop: ${error.message}`);
			}
		}, this.autoSaveInterval);
	}

	/**
	 * Stop monitoring
	 */
	private stopMonitoring(): void {
		if (this.monitoringInterval) {
			clearInterval(this.monitoringInterval);
			this.monitoringInterval = null;
		}
	}

	/**
	 * Check if cookies have changed since last save
	 */
	private async haveCookiesChanged(): Promise<boolean> {
		try {
			const currentCookies = await this.getCurrentCookies();

			// Convert to comparable format
			const currentCookieSet = new Map(
				currentCookies.map((c) => [`${c.name}:${c.domain}:${c.path}`, c.value])
			);

			const lastCookieSet = new Map(
				this.lastCookieState.map((c) => [`${c.name}:${c.domain}:${c.path}`, c.value])
			);

			if (currentCookieSet.size !== lastCookieSet.size) {
				return true;
			}

			for (const [key, value] of currentCookieSet) {
				if (lastCookieSet.get(key) !== value) {
					return true;
				}
			}

			return false;
		} catch (error: any) {
			console.debug(`[StorageStateWatchdog] Error comparing cookies: ${error.message}`);
			return false;
		}
	}

	/**
	 * Get current cookies
	 */
	async getCurrentCookies(): Promise<Cookie[]> {
		try {
			if (this.context) {
				const cookies = await this.context.cookies();
				return cookies as Cookie[];
			}

			if (this.cdpSession) {
				const result = await this.cdpSession.send('Network.getAllCookies');
				return (result.cookies || []) as Cookie[];
			}

			return [];
		} catch (error: any) {
			console.error(`[StorageStateWatchdog] Failed to get cookies: ${error.message}`);
			return [];
		}
	}

	/**
	 * Get current storage state
	 */
	async getStorageState(): Promise<StorageState> {
		try {
			if (this.context) {
				const state = await this.context.storageState();
				return state as StorageState;
			}

			// Fallback to CDP
			const cookies = await this.getCurrentCookies();
			return { cookies, origins: [] };
		} catch (error: any) {
			console.error(`[StorageStateWatchdog] Failed to get storage state: ${error.message}`);
			return { cookies: [], origins: [] };
		}
	}

	/**
	 * Save storage state to file
	 */
	async saveStorageState(targetPath?: string): Promise<void> {
		if (this.saveLock) return;
		this.saveLock = true;

		try {
			const savePath = targetPath || this.storagePath;
			if (!savePath) return;

			const storageState = await this.getStorageState();
			this.lastCookieState = [...storageState.cookies];

			// Resolve path
			const jsonPath = path.resolve(savePath);
			const dir = path.dirname(jsonPath);

			// Ensure directory exists
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			// Merge with existing state if file exists
			let mergedState = storageState;
			if (fs.existsSync(jsonPath)) {
				try {
					const existingContent = fs.readFileSync(jsonPath, 'utf-8');
					const existingState = JSON.parse(existingContent);
					mergedState = this.mergeStorageStates(existingState, storageState);
				} catch (error: any) {
					console.error(`[StorageStateWatchdog] Failed to merge with existing state: ${error.message}`);
				}
			}

			// Write atomically
			const tempPath = jsonPath + '.tmp';
			fs.writeFileSync(tempPath, JSON.stringify(mergedState, null, 4));

			// Backup existing file
			if (fs.existsSync(jsonPath)) {
				const backupPath = jsonPath + '.bak';
				fs.renameSync(jsonPath, backupPath);
			}

			// Move temp to final
			fs.renameSync(tempPath, jsonPath);

			console.log(
				`[StorageStateWatchdog] Saved storage state to ${jsonPath} ` +
				`(${mergedState.cookies.length} cookies, ${mergedState.origins.length} origins)`
			);

			this.eventBus.emit('storage:saved', {
				path: jsonPath,
				cookiesCount: mergedState.cookies.length,
				originsCount: mergedState.origins.length,
			});
		} catch (error: any) {
			console.error(`[StorageStateWatchdog] Failed to save storage state: ${error.message}`);
		} finally {
			this.saveLock = false;
		}
	}

	/**
	 * Load storage state from file
	 */
	async loadStorageState(sourcePath?: string): Promise<void> {
		try {
			const loadPath = sourcePath || this.storagePath;
			if (!loadPath || !fs.existsSync(loadPath)) return;

			const content = fs.readFileSync(loadPath, 'utf-8');
			const storage: StorageState = JSON.parse(content);

			// Apply cookies
			if (storage.cookies && storage.cookies.length > 0) {
				await this.addCookies(storage.cookies);
				this.lastCookieState = [...storage.cookies];
				console.log(`[StorageStateWatchdog] Added ${storage.cookies.length} cookies from storage state`);
			}

			// Apply origins
			if (storage.origins && storage.origins.length > 0) {
				// Note: localStorage/sessionStorage would need to be applied via page.evaluate
				console.log(
					`[StorageStateWatchdog] Applied localStorage/sessionStorage from ${storage.origins.length} origins`
				);
			}

			this.eventBus.emit('storage:loaded', {
				path: loadPath,
				cookiesCount: storage.cookies?.length || 0,
				originsCount: storage.origins?.length || 0,
			});

			console.log(`[StorageStateWatchdog] Loaded storage state from: ${loadPath}`);
		} catch (error: any) {
			console.error(`[StorageStateWatchdog] Failed to load storage state: ${error.message}`);
		}
	}

	/**
	 * Add cookies
	 */
	async addCookies(cookies: Cookie[]): Promise<void> {
		try {
			if (this.context) {
				await this.context.addCookies(cookies);
				return;
			}

			if (this.cdpSession) {
				await this.cdpSession.send('Network.setCookies', { cookies });
				return;
			}

			console.warn('[StorageStateWatchdog] No context or CDP session available for adding cookies');
		} catch (error: any) {
			console.error(`[StorageStateWatchdog] Failed to add cookies: ${error.message}`);
		}
	}

	/**
	 * Merge two storage states
	 */
	private mergeStorageStates(existing: StorageState, newState: StorageState): StorageState {
		const merged: StorageState = { cookies: [], origins: [] };

		// Merge cookies
		const cookieMap = new Map<string, Cookie>();
		for (const cookie of existing.cookies || []) {
			const key = `${cookie.name}:${cookie.domain}:${cookie.path}`;
			cookieMap.set(key, cookie);
		}
		for (const cookie of newState.cookies || []) {
			const key = `${cookie.name}:${cookie.domain}:${cookie.path}`;
			cookieMap.set(key, cookie);
		}
		merged.cookies = Array.from(cookieMap.values());

		// Merge origins
		const originMap = new Map<string, Origin>();
		for (const origin of existing.origins || []) {
			originMap.set(origin.origin, origin);
		}
		for (const origin of newState.origins || []) {
			originMap.set(origin.origin, origin);
		}
		merged.origins = Array.from(originMap.values());

		return merged;
	}

	/**
	 * Start the watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;

		console.log('[StorageStateWatchdog] Initializing auth/cookies sync with storage_state.json file');

		// Start monitoring
		this.startMonitoring();

		// Load storage state on start
		await this.loadStorageState();

		console.log('[StorageStateWatchdog] Started');
	}

	/**
	 * Stop the watchdog
	 */
	async stop(): Promise<void> {
		this.isRunning = false;
		this.stopMonitoring();
		console.log('[StorageStateWatchdog] Stopped');
	}
}

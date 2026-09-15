/**
 * Local browser watchdog for managing browser subprocess lifecycle
 * Port from browser_use/browser/watchdogs/local_browser_watchdog.py
 */
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import os from 'os';

export interface BrowserLaunchResult {
	cdpUrl: string;
	pid?: number;
}

export interface LocalBrowserWatchdogOptions {
	/** Path to browser executable */
	executablePath?: string;
	/** User data directory */
	userDataDir?: string;
	/** Additional launch arguments */
	args?: string[];
	/** Enable headless mode */
	headless?: boolean;
	/** Debug port for CDP */
	debugPort?: number;
}

export class LocalBrowserWatchdog {
	private isRunning: boolean = false;
	private subprocess: ChildProcess | null = null;
	private ownsBrowserResources: boolean = true;
	private tempDirsToCleanup: string[] = [];
	private originalUserDataDir: string | null = null;
	private executablePath: string | null;
	private userDataDir: string | null;
	private args: string[];
	private headless: boolean;
	private debugPort: number;

	constructor(
		private eventBus: EventEmitter,
		options: LocalBrowserWatchdogOptions = {}
	) {
		this.executablePath = options.executablePath || null;
		this.userDataDir = options.userDataDir || null;
		this.args = options.args || [];
		this.headless = options.headless ?? false;
		this.debugPort = options.debugPort ?? 0;
	}

	/**
	 * Launch a local browser process
	 */
	async launchBrowser(maxRetries: number = 3): Promise<BrowserLaunchResult> {
		this.originalUserDataDir = this.userDataDir;
		this.tempDirsToCleanup = [];

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				console.log(`[LocalBrowserWatchdog] Launch attempt ${attempt + 1}/${maxRetries}`);

				// Build launch args
				const launchArgs = this.buildLaunchArgs();

				// Find browser executable if not provided
				const browserPath = this.executablePath || this.findInstalledBrowserPath();
				if (!browserPath) {
					throw new Error('No local Chrome/Chromium install found');
				}

				console.log(`[LocalBrowserWatchdog] Browser path: ${browserPath}`);
				console.log(`[LocalBrowserWatchdog] Launch args: ${launchArgs.slice(0, 10).join(' ')}...`);

				// Launch browser subprocess
				this.subprocess = spawn(browserPath, launchArgs, {
					stdio: ['ignore', 'pipe', 'pipe'],
					detached: false,
				});

				const pid = this.subprocess.pid;
				console.log(`[LocalBrowserWatchdog] Chrome process started with PID=${pid}`);

				// Wait for CDP to be ready
				const cdpUrl = await this.waitForCDPUrl(this.debugPort);
				console.log(`[LocalBrowserWatchdog] Got CDP URL: ${cdpUrl}`);

				return { cdpUrl, pid };

			} catch (error: any) {
				const errorStr = error.message.toLowerCase();

				// Check if this is a user_data_dir related error
				if (
					errorStr.includes('singletonlock') ||
					errorStr.includes('user data directory') ||
					errorStr.includes('cannot create') ||
					errorStr.includes('already in use')
				) {
					console.warn(`[LocalBrowserWatchdog] Browser launch failed (attempt ${attempt + 1}/${maxRetries}): ${error.message}`);

					if (attempt < maxRetries - 1) {
						// Create a temporary directory for next attempt
						const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browseruse-tmp-'));
						this.tempDirsToCleanup.push(tmpDir);
						this.userDataDir = tmpDir;
						console.log(`[LocalBrowserWatchdog] Retrying with temporary user_data_dir: ${tmpDir}`);
						continue;
					}
				}

				// Restore original user_data_dir before throwing
				if (this.originalUserDataDir !== null) {
					this.userDataDir = this.originalUserDataDir;
				}

				// Clean up any temp dirs we created
				for (const tmpDir of this.tempDirsToCleanup) {
					this.cleanupTempDir(tmpDir);
				}

				throw error;
			}
		}

		throw new Error(`Failed to launch browser after ${maxRetries} attempts`);
	}

	/**
	 * Build launch arguments for the browser
	 */
	private buildLaunchArgs(): string[] {
		const args: string[] = [...this.args];

		// Add user data dir
		if (this.userDataDir) {
			args.push(`--user-data-dir=${this.userDataDir}`);
		} else {
			// Create temp dir if no user data dir specified
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browseruse-tmp-'));
			this.tempDirsToCleanup.push(tmpDir);
			this.userDataDir = tmpDir;
			args.push(`--user-data-dir=${tmpDir}`);
		}

		// Add debug port
		if (this.debugPort === 0) {
			this.debugPort = this.findFreePort();
		}
		args.push(`--remote-debugging-port=${this.debugPort}`);
		args.push('--remote-allow-origins=*');

		// Add headless mode
		if (this.headless) {
			args.push('--headless=new');
		}

		// Add common args
		args.push(
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-background-networking',
			'--disable-sync',
			'--disable-translate',
			'--metrics-recording-only',
			'--safebrowsing-disable-auto-update',
			'--password-store=basic',
		);

		return args;
	}

	/**
	 * Find installed browser path
	 */
	private findInstalledBrowserPath(): string | null {
		const platform = process.platform;
		let patterns: string[] = [];

		// Get playwright browsers path from environment variable if set
		const playwrightPath = process.env.PLAYWRIGHT_BROWSERS_PATH ||
			(platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright') :
				platform === 'linux' ? path.join(os.homedir(), '.cache/ms-playwright') :
					path.join(os.homedir(), 'AppData/Local/ms-playwright'));

		if (platform === 'darwin') {
			patterns = [
				'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
				'/Applications/Chromium.app/Contents/MacOS/Chromium',
				'/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
				'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
			];
		} else if (platform === 'linux') {
			patterns = [
				'/usr/bin/google-chrome-stable',
				'/usr/bin/google-chrome',
				'/usr/local/bin/google-chrome',
				'/usr/bin/chromium',
				'/usr/bin/chromium-browser',
				'/usr/local/bin/chromium',
				'/snap/bin/chromium',
				'/usr/bin/brave-browser',
			];
		} else if (platform === 'win32') {
			patterns = [
				'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
				'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
				path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
				'C:\\Program Files\\Chromium\\Application\\chrome.exe',
				'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
				'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
			];
		}

		for (const pattern of patterns) {
			if (fs.existsSync(pattern)) {
				return pattern;
			}
		}

		// Try to find in playwright cache
		if (fs.existsSync(playwrightPath)) {
			const chromiumDirs = fs.readdirSync(playwrightPath)
				.filter((d) => d.startsWith('chromium-'))
				.sort()
				.reverse();

			for (const dir of chromiumDirs) {
				let chromePath: string;
				if (platform === 'darwin') {
					chromePath = path.join(playwrightPath, dir, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium');
				} else if (platform === 'linux') {
					chromePath = path.join(playwrightPath, dir, 'chrome-linux/chrome');
				} else {
					chromePath = path.join(playwrightPath, dir, 'chrome-win/chrome.exe');
				}

				if (fs.existsSync(chromePath)) {
					return chromePath;
				}
			}
		}

		return null;
	}

	/**
	 * Find a free port
	 */
	private findFreePort(): number {
		return Math.floor(9000 + Math.random() * 1000);
	}

	/**
	 * Wait for CDP URL to be ready
	 */
	private async waitForCDPUrl(port: number, timeout: number = 30000): Promise<string> {
		const startTime = Date.now();
		const url = `http://localhost:${port}/json/version`;

		while (Date.now() - startTime < timeout) {
			try {
				const response = await this.fetchJSON(url);
				if (response) {
					return `http://localhost:${port}/`;
				}
			} catch {
				// Connection error - Chrome might not be ready yet
			}
			await this.sleep(100);
		}

		throw new Error(`Browser did not start within ${timeout / 1000} seconds`);
	}

	/**
	 * Simple fetch for JSON
	 */
	private async fetchJSON(url: string): Promise<any> {
		return new Promise((resolve, reject) => {
			const http = require('http');
			const urlObj = new URL(url);

			const req = http.get({
				hostname: urlObj.hostname,
				port: urlObj.port,
				path: urlObj.pathname,
			}, (res: any) => {
				let data = '';
				res.on('data', (chunk: string) => data += chunk);
				res.on('end', () => {
					if (res.statusCode === 200) {
						try {
							resolve(JSON.parse(data));
						} catch {
							resolve(data);
						}
					} else {
						reject(new Error(`HTTP ${res.statusCode}`));
					}
				});
			});

			req.on('error', reject);
			req.setTimeout(1000, () => {
				req.destroy();
				reject(new Error('Timeout'));
			});
		});
	}

	/**
	 * Sleep helper
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Kill the browser subprocess
	 */
	async killBrowser(): Promise<void> {
		console.log('[LocalBrowserWatchdog] Killing local browser process');

		if (this.subprocess) {
			try {
				// Try graceful shutdown first
				this.subprocess.kill('SIGTERM');

				// Wait for process to exit
				await new Promise<void>((resolve) => {
					const timeout = setTimeout(() => {
						// Force kill if still running
						if (this.subprocess && !this.subprocess.killed) {
							this.subprocess.kill('SIGKILL');
						}
						resolve();
					}, 5000);

					if (this.subprocess) {
						this.subprocess.on('exit', () => {
							clearTimeout(timeout);
							resolve();
						});
					}
				});
			} catch {
				// Ignore errors during cleanup
			}

			this.subprocess = null;
		}

		// Clean up temp directories
		for (const tmpDir of this.tempDirsToCleanup) {
			this.cleanupTempDir(tmpDir);
		}
		this.tempDirsToCleanup = [];

		// Restore original user_data_dir
		if (this.originalUserDataDir !== null) {
			this.userDataDir = this.originalUserDataDir;
			this.originalUserDataDir = null;
		}

		console.log('[LocalBrowserWatchdog] Browser cleanup completed');
	}

	/**
	 * Clean up temporary directory
	 */
	private cleanupTempDir(tmpDir: string): void {
		if (!tmpDir) return;

		try {
			// Only remove if it's actually a temp directory we created
			if (tmpDir.includes('browseruse-tmp-')) {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		} catch (error: any) {
			console.debug(`[LocalBrowserWatchdog] Failed to cleanup temp dir ${tmpDir}: ${error.message}`);
		}
	}

	/**
	 * Get browser process ID
	 */
	get browserPid(): number | null {
		return this.subprocess?.pid || null;
	}

	/**
	 * Start the watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;
		console.log('[LocalBrowserWatchdog] Started');
	}

	/**
	 * Stop the watchdog
	 */
	async stop(): Promise<void> {
		this.isRunning = false;
		await this.killBrowser();
		console.log('[LocalBrowserWatchdog] Stopped');
	}
}

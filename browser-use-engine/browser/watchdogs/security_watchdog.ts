/**
 * Security watchdog for enforcing URL access policies
 * Port from browser_use/browser/watchdogs/security_watchdog.py
 */
import { EventEmitter } from 'events';
import { Page } from 'patchright';

export interface SecurityWatchdogOptions {
	/** List of allowed domains (whitelist) */
	allowedDomains?: string[] | Set<string>;
	/** List of prohibited domains (blacklist) */
	prohibitedDomains?: string[] | Set<string>;
	/** Block IP addresses */
	blockIpAddresses?: boolean;
}

// Track if we've shown the glob warning
let GLOB_WARNING_SHOWN = false;

export class SecurityWatchdog {
	private isRunning: boolean = false;
	private page: Page | null = null;
	private allowedDomains: string[] | Set<string>;
	private prohibitedDomains: string[] | Set<string>;
	private blockIpAddresses: boolean;

	constructor(
		private eventBus: EventEmitter,
		options: SecurityWatchdogOptions = {}
	) {
		this.allowedDomains = options.allowedDomains || [];
		this.prohibitedDomains = options.prohibitedDomains || [];
		this.blockIpAddresses = options.blockIpAddresses ?? false;
	}

	/**
	 * Set the page to monitor
	 */
	setPage(page: Page): void {
		this.page = page;
		this.setupNavigationListeners();
	}

	/**
	 * Update allowed domains
	 */
	setAllowedDomains(domains: string[] | Set<string>): void {
		this.allowedDomains = domains;
	}

	/**
	 * Update prohibited domains
	 */
	setProhibitedDomains(domains: string[] | Set<string>): void {
		this.prohibitedDomains = domains;
	}

	/**
	 * Set up navigation listeners
	 */
	private setupNavigationListeners(): void {
		if (!this.page) return;

		// Listen for frame navigation
		this.page.on('framenavigated', async (frame) => {
			if (frame === this.page?.mainFrame()) {
				const url = frame.url();
				await this.checkNavigationComplete(url);
			}
		});
	}

	/**
	 * Check if navigation URL is allowed before navigation
	 */
	async checkNavigationRequest(url: string): Promise<boolean> {
		if (!this.isUrlAllowed(url)) {
			console.warn(`[SecurityWatchdog] Blocking navigation to disallowed URL: ${url}`);

			this.eventBus.emit('browser:error', {
				errorType: 'NavigationBlocked',
				message: `Navigation blocked to disallowed URL: ${url}`,
				details: { url, reason: 'not_in_allowed_domains' },
			});

			return false;
		}
		return true;
	}

	/**
	 * Check URL after navigation completes (catches redirects)
	 */
	private async checkNavigationComplete(url: string): Promise<void> {
		if (!this.isRunning) return;

		if (!this.isUrlAllowed(url)) {
			console.warn(`[SecurityWatchdog] Navigation to non-allowed URL detected: ${url}`);

			this.eventBus.emit('browser:error', {
				errorType: 'NavigationBlocked',
				message: `Navigation blocked to non-allowed URL: ${url} - redirecting to about:blank`,
				details: { url },
			});

			// Navigate to about:blank to keep session alive
			try {
				if (this.page) {
					await this.page.goto('about:blank');
					console.log(`[SecurityWatchdog] Navigated to about:blank after blocked URL: ${url}`);
				}
			} catch (error: any) {
				console.error(`[SecurityWatchdog] Failed to navigate to about:blank: ${error.message}`);
			}
		}
	}

	/**
	 * Check if a URL is allowed based on configuration
	 */
	isUrlAllowed(url: string): boolean {
		// Always allow internal browser targets
		if (['about:blank', 'chrome://new-tab-page/', 'chrome://new-tab-page', 'chrome://newtab/'].includes(url)) {
			return true;
		}

		// Parse the URL
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			// Invalid URL
			return false;
		}

		// Allow data: and blob: URLs
		if (['data:', 'blob:'].includes(parsed.protocol)) {
			return true;
		}

		// Get the host
		const host = parsed.hostname;
		if (!host) {
			return false;
		}

		// Check if IP addresses should be blocked
		if (this.blockIpAddresses && this.isIpAddress(host)) {
			return false;
		}

		// If no allowed_domains or prohibited_domains specified, allow all URLs
		const hasAllowed = this.allowedDomains instanceof Set
			? this.allowedDomains.size > 0
			: this.allowedDomains.length > 0;
		const hasProhibited = this.prohibitedDomains instanceof Set
			? this.prohibitedDomains.size > 0
			: this.prohibitedDomains.length > 0;

		if (!hasAllowed && !hasProhibited) {
			return true;
		}

		// Check allowed domains
		if (hasAllowed) {
			if (this.allowedDomains instanceof Set) {
				// Fast path: O(1) exact hostname match
				const [hostVariant, hostAlt] = this.getDomainVariants(host);
				return this.allowedDomains.has(hostVariant) || this.allowedDomains.has(hostAlt);
			} else {
				// Slow path: O(n) pattern matching for lists
				for (const pattern of this.allowedDomains) {
					if (this.isUrlMatch(url, host, parsed.protocol.slice(0, -1), pattern)) {
						return true;
					}
				}
				return false;
			}
		}

		// Check prohibited domains
		if (hasProhibited) {
			if (this.prohibitedDomains instanceof Set) {
				// Fast path: O(1) exact hostname match
				const [hostVariant, hostAlt] = this.getDomainVariants(host);
				return !this.prohibitedDomains.has(hostVariant) && !this.prohibitedDomains.has(hostAlt);
			} else {
				// Slow path: O(n) pattern matching for lists
				for (const pattern of this.prohibitedDomains) {
					if (this.isUrlMatch(url, host, parsed.protocol.slice(0, -1), pattern)) {
						return false;
					}
				}
				return true;
			}
		}

		return true;
	}

	/**
	 * Check if URL matches a pattern
	 */
	private isUrlMatch(url: string, host: string, scheme: string, pattern: string): boolean {
		// Handle glob patterns
		if (pattern.includes('*')) {
			this.logGlobWarning();

			if (pattern.startsWith('*.')) {
				// Pattern like *.example.com should match subdomains and main domain
				const domainPart = pattern.substring(2);
				if (host === domainPart || host.endsWith('.' + domainPart)) {
					if (['http', 'https'].includes(scheme)) {
						return true;
					}
				}
			} else if (pattern.endsWith('/*')) {
				// Pattern like brave://* should match any brave:// URL
				const prefix = pattern.slice(0, -1);
				if (url.startsWith(prefix)) {
					return true;
				}
			} else {
				// Use fnmatch-like matching for other patterns
				const fullUrlPattern = `${scheme}://${host}`;
				const targetToMatch = pattern.includes('://') ? fullUrlPattern : host;
				if (this.fnmatch(targetToMatch, pattern)) {
					return true;
				}
			}
		} else {
			// Exact match
			if (pattern.includes('://')) {
				// Full URL pattern
				if (url.startsWith(pattern)) {
					return true;
				}
			} else {
				// Domain-only pattern
				if (host.toLowerCase() === pattern.toLowerCase()) {
					return true;
				}
				// If pattern is a root domain, also check www subdomain
				if (this.isRootDomain(pattern) && host.toLowerCase() === `www.${pattern.toLowerCase()}`) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Simple fnmatch-like pattern matching
	 */
	private fnmatch(str: string, pattern: string): boolean {
		// Convert glob pattern to regex
		const regexPattern = pattern
			.replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
			.replace(/\*/g, '.*') // * matches anything
			.replace(/\?/g, '.'); // ? matches single char

		const regex = new RegExp(`^${regexPattern}$`, 'i');
		return regex.test(str);
	}

	/**
	 * Get both variants of a domain (with and without www prefix)
	 */
	private getDomainVariants(host: string): [string, string] {
		if (host.startsWith('www.')) {
			return [host, host.substring(4)];
		} else {
			return [host, `www.${host}`];
		}
	}

	/**
	 * Check if a domain is a root domain (no subdomain present)
	 */
	private isRootDomain(domain: string): boolean {
		if (domain.includes('*') || domain.includes('://')) {
			return false;
		}
		return domain.split('.').length === 2;
	}

	/**
	 * Check if a hostname is an IP address
	 */
	private isIpAddress(host: string): boolean {
		// IPv4 pattern
		const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
		if (ipv4Pattern.test(host)) {
			const parts = host.split('.').map(Number);
			return parts.every((p) => p >= 0 && p <= 255);
		}

		// IPv6 pattern (simplified check)
		if (host.includes(':') && /^[a-fA-F0-9:]+$/.test(host)) {
			return true;
		}

		return false;
	}

	/**
	 * Log a warning about glob patterns
	 */
	private logGlobWarning(): void {
		if (!GLOB_WARNING_SHOWN) {
			GLOB_WARNING_SHOWN = true;
			console.warn(
				'[SecurityWatchdog] Using glob patterns in allowed_domains. ' +
				'Note: Patterns like "*.example.com" will match both subdomains AND the main domain.'
			);
		}
	}

	/**
	 * Start the watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;
		console.log('[SecurityWatchdog] Started monitoring');
	}

	/**
	 * Stop the watchdog
	 */
	async stop(): Promise<void> {
		this.isRunning = false;
		console.log('[SecurityWatchdog] Stopped monitoring');
	}
}

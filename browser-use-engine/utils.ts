/**
 * Core utility functions
 */

import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { minimatch } from 'minimatch';

// Pre-compiled regex for URL detection - used in URL shortening
export const URL_PATTERN =
	/https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[^\s<>"']+\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi;

// ============================================================================
// Signal Handler (Node.js version - simplified)
// ============================================================================

/**
 * Signal handling for graceful shutdown in Node.js
 *
 * Note: Node.js signal handling differs from Python:
 * - SIGINT (Ctrl+C) is handled via process.on('SIGINT')
 * - SIGTERM is handled via process.on('SIGTERM')
 * - No event loop attribute manipulation needed
 */
export class SignalHandler {
	private pauseCallback?: () => void;
	private resumeCallback?: () => void;
	private customExitCallback?: () => void;
	private exitOnSecondInt: boolean;
	private interruptibleTaskPatterns: string[];
	private isWindows: boolean;
	private ctrlCPressed: boolean = false;
	private waitingForInput: boolean = false;
	private exiting: boolean = false;

	private sigintHandler?: NodeJS.SignalsListener;
	private sigtermHandler?: NodeJS.SignalsListener;

	constructor(options?: {
		pauseCallback?: () => void;
		resumeCallback?: () => void;
		customExitCallback?: () => void;
		exitOnSecondInt?: boolean;
		interruptibleTaskPatterns?: string[];
	}) {
		this.pauseCallback = options?.pauseCallback;
		this.resumeCallback = options?.resumeCallback;
		this.customExitCallback = options?.customExitCallback;
		this.exitOnSecondInt = options?.exitOnSecondInt ?? true;
		this.interruptibleTaskPatterns = options?.interruptibleTaskPatterns || [
			'step',
			'multi_act',
			'get_next_action',
		];
		this.isWindows = os.platform() === 'win32';
	}

	register(): void {
		try {
			if (this.isWindows) {
				// On Windows, use simple signal handling with immediate exit on Ctrl+C
				this.sigintHandler = () => {
					console.error('\n\n🛑 Got Ctrl+C. Exiting immediately on Windows...\n');
					if (this.customExitCallback) {
						this.customExitCallback();
					}
					process.exit(0);
				};
				process.on('SIGINT', this.sigintHandler);
			} else {
				// On Unix-like systems
				this.sigintHandler = () => this.handleSigint();
				this.sigtermHandler = () => this.handleSigterm();

				process.on('SIGINT', this.sigintHandler);
				process.on('SIGTERM', this.sigtermHandler);
			}
		} catch (error) {
			// Signal handlers may not be supported in some environments
			// (e.g., worker threads, some testing frameworks)
		}
	}

	unregister(): void {
		try {
			if (this.sigintHandler) {
				process.off('SIGINT', this.sigintHandler);
			}
			if (this.sigtermHandler) {
				process.off('SIGTERM', this.sigtermHandler);
			}
		} catch (error) {
			console.warn('Error while unregistering signal handlers:', error);
		}
	}

	private handleSecondCtrlC(): void {
		if (!this.exiting) {
			this.exiting = true;

			// Call custom exit callback if provided
			if (this.customExitCallback) {
				try {
					this.customExitCallback();
				} catch (error) {
					console.error('Error in exit callback:', error);
				}
			}
		}

		// Force immediate exit
		console.error('\n\n🛑  Got second Ctrl+C. Exiting immediately...\n');

		// Reset terminal to a clean state
		process.stderr.write('\x1b[?25h'); // Show cursor
		process.stdout.write('\x1b[?25h'); // Show cursor
		process.stderr.write('\x1b[0m'); // Reset text attributes
		process.stdout.write('\x1b[0m'); // Reset text attributes
		process.stderr.write('\x1b[?1l'); // Reset cursor keys
		process.stdout.write('\x1b[?1l'); // Reset cursor keys
		process.stderr.write('\x1b[?2004l'); // Disable bracketed paste
		process.stdout.write('\x1b[?2004l'); // Disable bracketed paste
		process.stderr.write('\r');
		process.stdout.write('\r');

		console.error('(tip: press [Enter] once to fix escape codes appearing after chrome exit)');

		process.exit(0);
	}

	private handleSigint(): void {
		if (this.exiting) {
			process.exit(0);
		}

		if (this.ctrlCPressed) {
			// If we're waiting for input, let the wait method handle it
			if (this.waitingForInput) {
				return;
			}

			// Second Ctrl+C - exit immediately if configured
			if (this.exitOnSecondInt) {
				this.handleSecondCtrlC();
			}
		}

		// Mark that Ctrl+C was pressed
		this.ctrlCPressed = true;

		// Call pause callback if provided
		if (this.pauseCallback) {
			try {
				this.pauseCallback();
			} catch (error) {
				console.error('Error in pause callback:', error);
			}
		}

		// Log pause message
		console.error('----------------------------------------------------------------------');
	}

	private handleSigterm(): void {
		if (!this.exiting) {
			this.exiting = true;
			console.error('\n\n🛑 SIGTERM received. Exiting immediately...\n\n');

			if (this.customExitCallback) {
				this.customExitCallback();
			}
		}
		process.exit(0);
	}

	waitForResume(): Promise<void> {
		return new Promise((resolve) => {
			this.waitingForInput = true;

			const green = '\x1b[32;1m';
			const red = '\x1b[31m';
			const blink = '\x1b[33;5m';
			const unblink = '\x1b[0m';
			const reset = '\x1b[0m';

			process.stderr.write(
				`➡️  Press ${green}[Enter]${reset} to resume or ${red}[Ctrl+C]${reset} again to exit${blink}...${unblink} `
			);

			const stdin = process.stdin;
			const originalRawMode = stdin.isRaw;

			// Set up stdin to read input
			stdin.setRawMode(false);
			stdin.resume();
			stdin.setEncoding('utf8');

			const onData = (key: string) => {
				// Check for Ctrl+C
				if (key === '\u0003') {
					cleanup();
					this.handleSecondCtrlC();
				}
				// Check for Enter
				else if (key === '\r' || key === '\n') {
					cleanup();
					if (this.resumeCallback) {
						this.resumeCallback();
					}
					resolve();
				}
			};

			const cleanup = () => {
				stdin.off('data', onData);
				stdin.pause();
				if (originalRawMode !== undefined) {
					stdin.setRawMode(originalRawMode);
				}
				this.waitingForInput = false;
			};

			stdin.on('data', onData);
		});
	}

	reset(): void {
		this.ctrlCPressed = false;
		this.waitingForInput = false;
	}
}

// ============================================================================
// Timing Decorators
// ============================================================================

/**
 * Decorator to time synchronous function execution
 */
export function timeExecutionSync(additionalText: string = '') {
	return function <T extends (...args: any[]) => any>(
		_target: any,
		_propertyKey: string,
		descriptor: PropertyDescriptor
	) {
		const originalMethod = descriptor.value;

		descriptor.value = function (this: any, ...args: any[]) {
			const startTime = Date.now();
			const result = originalMethod.apply(this, args);
			const executionTime = (Date.now() - startTime) / 1000;

			// Only log if execution takes more than 0.25 seconds
			if (executionTime > 0.25) {
				const logger = this.logger || console;
				const methodName = additionalText.replace(/-/g, '') || _propertyKey;
				logger.debug?.(`⏳ ${methodName}() took ${executionTime.toFixed(2)}s`);
			}

			return result;
		};

		return descriptor;
	};
}

/**
 * Decorator to time async function execution
 */
export function timeExecutionAsync(additionalText: string = '') {
	return function <T extends (...args: any[]) => Promise<any>>(
		_target: any,
		_propertyKey: string,
		descriptor: PropertyDescriptor
	) {
		const originalMethod = descriptor.value;

		descriptor.value = async function (this: any, ...args: any[]) {
			const startTime = Date.now();
			const result = await originalMethod.apply(this, args);
			const executionTime = (Date.now() - startTime) / 1000;

			// Only log if execution takes more than 0.25 seconds
			if (executionTime > 0.25) {
				const logger = this.logger || console;
				const methodName = additionalText.replace(/-/g, '') || _propertyKey;
				logger.debug?.(`⏳ ${methodName}() took ${executionTime.toFixed(2)}s`);
			}

			return result;
		};

		return descriptor;
	};
}

// ============================================================================
// Singleton Pattern
// ============================================================================

/**
 * Singleton decorator for classes
 */
export function singleton<T extends { new (...args: any[]): any }>(constructor: T): T {
	let instance: any = null;

	return class extends constructor {
		constructor(...args: any[]) {
			if (instance) {
				return instance;
			}
			super(...args);
			instance = this;
		}
	} as T;
}

// ============================================================================
// Environment Variables
// ============================================================================

/**
 * Check if environment variables are set
 */
export function checkEnvVariables(keys: string[], anyOrAll: 'any' | 'all' = 'all'): boolean {
	const values = keys.map((key) => (process.env[key] || '').trim());
	return anyOrAll === 'all' ? values.every(Boolean) : values.some(Boolean);
}

// ============================================================================
// URL Pattern Matching
// ============================================================================

/**
 * Check if a domain pattern has complex wildcards that could match too many domains
 */
export function isUnsafePattern(pattern: string): boolean {
	// Extract domain part if there's a scheme
	if (pattern.includes('://')) {
		[, pattern] = pattern.split('://', 2);
	}

	// Remove safe patterns (*.domain and domain.*)
	const bareDomain = pattern.replace(/\.\*/g, '').replace(/\*\./g, '');

	// If there are still wildcards, it's potentially unsafe
	return bareDomain.includes('*');
}

/**
 * Check if a URL is a new tab page
 */
export function isNewTabPage(url: string): boolean {
	return [
		'about:blank',
		'chrome://new-tab-page/',
		'chrome://new-tab-page',
		'chrome://newtab/',
		'chrome://newtab',
	].includes(url);
}

/**
 * Check if a URL matches a domain pattern. SECURITY CRITICAL.
 *
 * Supports optional glob patterns and schemes:
 * - *.example.com will match sub.example.com and example.com
 * - *google.com will match google.com, agoogle.com, and www.google.com
 * - http*://example.com will match http://example.com, https://example.com
 * - chrome-extension://* will match chrome-extension://aaaaaaaaaaaa and chrome-extension://bbbbbbbbbbbbb
 *
 * When no scheme is specified, https is used by default for security.
 * For example, 'example.com' will match 'https://example.com' but not 'http://example.com'.
 */
export function matchUrlWithDomainPattern(
	url: string,
	domainPattern: string,
	logWarnings: boolean = false
): boolean {
	try {
		// New tab pages should be handled at the callsite, not here
		if (isNewTabPage(url)) {
			return false;
		}

		const parsedUrl = new URL(url);

		// Extract only the hostname and scheme components
		const scheme = parsedUrl.protocol.replace(':', '').toLowerCase();
		const domain = parsedUrl.hostname.toLowerCase();

		if (!scheme || !domain) {
			return false;
		}

		// Normalize the domain pattern
		domainPattern = domainPattern.toLowerCase();

		// Handle pattern with scheme
		let patternScheme: string;
		let patternDomain: string;

		if (domainPattern.includes('://')) {
			[patternScheme, patternDomain] = domainPattern.split('://', 2);
		} else {
			patternScheme = 'https'; // Default to matching only https for security
			patternDomain = domainPattern;
		}

		// Handle port in pattern (we strip ports from patterns since we already
		// extracted only the hostname from the URL)
		if (patternDomain.includes(':') && !patternDomain.startsWith(':')) {
			[patternDomain] = patternDomain.split(':', 2);
		}

		// If scheme doesn't match, return false
		if (!minimatch(scheme, patternScheme)) {
			return false;
		}

		// Check for exact match
		if (patternDomain === '*' || domain === patternDomain) {
			return true;
		}

		// Handle glob patterns
		if (patternDomain.includes('*')) {
			// Check for unsafe glob patterns
			// First, check for patterns like *.*.domain which are unsafe
			const wildcardDotCount = (patternDomain.match(/\*\./g) || []).length;
			const dotWildcardCount = (patternDomain.match(/\.\*/g) || []).length;

			if (wildcardDotCount > 1 || dotWildcardCount > 1) {
				if (logWarnings) {
					console.error(`⛔️ Multiple wildcards in pattern=[${domainPattern}] are not supported`);
				}
				return false;
			}

			// Check for wildcards in TLD part (example.*)
			if (patternDomain.endsWith('.*')) {
				if (logWarnings) {
					console.error(
						`⛔️ Wildcard TLDs like in pattern=[${domainPattern}] are not supported for security`
					);
				}
				return false;
			}

			// Then check for embedded wildcards
			const bareDomain = patternDomain.replace(/\*\./g, '');
			if (bareDomain.includes('*')) {
				if (logWarnings) {
					console.error(
						`⛔️ Only *.domain style patterns are supported, ignoring pattern=[${domainPattern}]`
					);
				}
				return false;
			}

			// Special handling so that *.google.com also matches bare google.com
			if (patternDomain.startsWith('*.')) {
				const parentDomain = patternDomain.substring(2);
				if (domain === parentDomain || minimatch(domain, parentDomain)) {
					return true;
				}
			}

			// Normal case: match domain against pattern
			if (minimatch(domain, patternDomain)) {
				return true;
			}
		}

		return false;
	} catch (error: any) {
		console.error(
			`⛔️ Error matching URL ${url} with pattern ${domainPattern}: ${error?.name}: ${error?.message}`
		);
		return false;
	}
}

// ============================================================================
// Dictionary Merging
// ============================================================================

/**
 * Recursively merge two dictionaries
 */
export function mergeDicts(a: Record<string, any>, b: Record<string, any>, path: string[] = []): Record<string, any> {
	for (const key in b) {
		if (key in a) {
			if (typeof a[key] === 'object' && !Array.isArray(a[key]) && typeof b[key] === 'object' && !Array.isArray(b[key])) {
				mergeDicts(a[key], b[key], [...path, key]);
			} else if (Array.isArray(a[key]) && Array.isArray(b[key])) {
				a[key] = [...a[key], ...b[key]];
			} else if (a[key] !== b[key]) {
				throw new Error(`Conflict at ${[...path, key].join('.')}`);
			}
		} else {
			a[key] = b[key];
		}
	}
	return a;
}

// ============================================================================
// Version Detection
// ============================================================================

let cachedVersion: string | null = null;

/**
 * Get the browser-use package version
 */
export async function getBrowserUseVersion(): Promise<string> {
	if (cachedVersion) {
		return cachedVersion;
	}

	try {
		// Get package root (assuming we're in dist/utils.js or src/utils.ts)
		const currentFileUrl = import.meta.url;
		const currentFilePath = fileURLToPath(currentFileUrl);
		const currentDir = path.dirname(currentFilePath);

		// Navigate up to find package.json
		let packageRoot = currentDir;
		while (packageRoot !== path.dirname(packageRoot)) {
			const packageJsonPath = path.join(packageRoot, 'package.json');
			if (existsSync(packageJsonPath)) {
				const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
				const version = packageJson.version || 'unknown';
				cachedVersion = version;
				process.env.LIBRARY_VERSION = version;
				return version;
			}
			packageRoot = path.dirname(packageRoot);
		}

		cachedVersion = 'unknown';
		return 'unknown';
	} catch (error: any) {
		console.debug(`Error detecting browser-use version: ${error?.name}: ${error?.message}`);
		cachedVersion = 'unknown';
		return 'unknown';
	}
}

/**
 * Check the latest version of browser-use from npm registry
 */
export async function checkLatestBrowserUseVersion(): Promise<string | null> {
	try {
		const response = await fetch('https://registry.npmjs.org/browser-use', {
			signal: AbortSignal.timeout(3000),
		});

		if (response.ok) {
			const data = await response.json();
			return data['dist-tags']?.latest || null;
		}
	} catch {
		// Silently fail - don't break startup due to network issues
	}
	return null;
}

/**
 * Parse a browser-use version into a sortable key: (numeric parts, pre-release rank, pre-release number).
 * Returns null for unparseable versions.
 */
export function browserUseVersionKey(version: string): [number[], number, number] | null {
	const match = /^v?(\d+(?:\.\d+)*)(?:[-.]?(a|b|rc|alpha|beta|dev)\.?(\d*))?/i.exec(version.trim());
	if (!match) {
		return null;
	}
	const numeric = match[1].split('.').map((n) => parseInt(n, 10));
	const preTag = (match[2] ?? '').toLowerCase();
	const preRank = preTag === '' ? 3 : preTag === 'rc' ? 2 : preTag.startsWith('b') ? 1 : 0;
	const preNumber = match[3] ? parseInt(match[3], 10) : 0;
	return [numeric, preRank, preNumber];
}

/** True when `latestVersion` is strictly newer than `currentVersion` (pre-releases rank below finals). */
export function isNewerBrowserUseVersion(latestVersion: string, currentVersion: string): boolean {
	const latest = browserUseVersionKey(latestVersion);
	const current = browserUseVersionKey(currentVersion);
	if (!latest || !current) {
		return false;
	}
	const len = Math.max(latest[0].length, current[0].length);
	for (let i = 0; i < len; i++) {
		const a = latest[0][i] ?? 0;
		const b = current[0][i] ?? 0;
		if (a !== b) return a > b;
	}
	if (latest[1] !== current[1]) return latest[1] > current[1];
	return latest[2] > current[2];
}

// ============================================================================
// Git Information
// ============================================================================

let cachedGitInfo: Record<string, string> | null | undefined = undefined;

/**
 * Get git information if installed from git repository
 */
export async function getGitInfo(): Promise<Record<string, string> | null> {
	if (cachedGitInfo !== undefined) {
		return cachedGitInfo;
	}

	try {
		// Get package root
		const currentFileUrl = import.meta.url;
		const currentFilePath = fileURLToPath(currentFileUrl);
		const currentDir = path.dirname(currentFilePath);

		let packageRoot = currentDir;
		while (packageRoot !== path.dirname(packageRoot)) {
			const gitDir = path.join(packageRoot, '.git');
			if (existsSync(gitDir)) {
				// Found .git directory
				const gitCommands = {
					commitHash: 'git rev-parse HEAD',
					branch: 'git rev-parse --abbrev-ref HEAD',
					remoteUrl: 'git config --get remote.origin.url',
					commitTimestamp: 'git show -s --format=%ci HEAD',
				};

				const result: Record<string, string> = {};

				for (const [key, command] of Object.entries(gitCommands)) {
					try {
						const output = execSync(command, {
							cwd: packageRoot,
							encoding: 'utf-8',
							stdio: ['pipe', 'pipe', 'pipe'],
						}).trim();
						result[key] = output;
					} catch {
						// Skip if command fails
					}
				}

				cachedGitInfo = Object.keys(result).length > 0 ? result : null;
				return cachedGitInfo;
			}
			packageRoot = path.dirname(packageRoot);
		}

		cachedGitInfo = null;
		return null;
	} catch (error: any) {
		console.debug(`Error getting git info: ${error?.name}: ${error?.message}`);
		cachedGitInfo = null;
		return null;
	}
}

// ============================================================================
// Pretty Logging Helpers
// ============================================================================

/**
 * Pretty-print a path, shorten home dir to ~ and cwd to .
 */
export function logPrettyPath(pathInput: string | null | undefined): string {
	if (!pathInput || !pathInput.trim()) {
		return ''; // always falsy in -> falsy out
	}

	// Replace home dir and cwd with ~ and .
	const homeDir = os.homedir();
	const cwd = process.cwd();
	let prettyPath = pathInput.replace(homeDir, '~').replace(cwd, '.');

	// Wrap in quotes if it contains spaces
	if (prettyPath.trim() && prettyPath.includes(' ')) {
		prettyPath = `"${prettyPath}"`;
	}

	return prettyPath;
}

/**
 * Truncate/pretty-print a URL with a maximum length, removing the protocol and www. prefix
 */
export function logPrettyUrl(url: string, maxLen: number | null = 22): string {
	let s = url.replace('https://', '').replace('http://', '').replace('www.', '');
	if (maxLen !== null && s.length > maxLen) {
		return s.substring(0, maxLen) + '…';
	}
	return s;
}

// ============================================================================
// Sensitive data helpers (Python browser-use 0.13.10 utils.py)
// ============================================================================

/**
 * Flatten legacy `{key: value}` and domain-scoped `{domain: {key: value}}`
 * sensitive data into placeholder -> value mappings (empty values dropped).
 */
export function collectSensitiveDataValues(
	sensitiveData: Record<string, string | Record<string, string>> | null | undefined
): Record<string, string> {
	if (!sensitiveData) {
		return {};
	}
	const values: Record<string, string> = {};
	for (const [keyOrDomain, content] of Object.entries(sensitiveData)) {
		if (content && typeof content === 'object') {
			for (const [key, val] of Object.entries(content)) {
				if (val) {
					values[key] = val;
				}
			}
		} else if (content) {
			values[keyOrDomain] = content;
		}
	}
	return values;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace sensitive values with `<secret>key</secret>` placeholders in a single
 * pass, longest secrets first so partial overlaps never leak.
 */
export function redactSensitiveString(value: string, sensitiveValues: Record<string, string>): string {
	const entries = Object.entries(sensitiveValues).filter(([, secret]) => Boolean(secret));
	if (entries.length === 0 || !value) {
		return value;
	}
	entries.sort((a, b) => b[1].length - a[1].length);
	const secretToKey = new Map<string, string>();
	for (const [key, secret] of entries) {
		if (!secretToKey.has(secret)) {
			secretToKey.set(secret, key);
		}
	}
	const pattern = new RegExp(Array.from(secretToKey.keys()).map(escapeRegExp).join('|'), 'g');
	return value.replace(pattern, (match) => `<secret>${secretToKey.get(match)}</secret>`);
}

// ============================================================================
// URL helpers for task auto-navigation (Python browser-use 0.13.10 utils.py)
// ============================================================================

/** Prose that explicitly negates navigation to a nearby URL ("never go to ..."). */
export const URL_NEGATION_PATTERN = /\b(?:never|not|don['’]?t)\b/i;

export function hasUrlNegation(context: string): boolean {
	return URL_NEGATION_PATTERN.test(context);
}

/** True for mock placeholder hostnames like https://XXX.XX or www.xxx.xxx. */
export function isPlaceholderUrl(url: string): boolean {
	let hostname = '';
	try {
		hostname = new URL(url.includes('://') ? url : `https://${url}`).hostname;
	} catch {
		return false;
	}
	hostname = hostname.replace(/^\.+|\.+$/g, '').toLowerCase();
	if (!hostname) {
		return false;
	}
	let labels = hostname.split('.').filter(Boolean);
	if (labels.length > 0 && labels[0] === 'www') {
		labels = labels.slice(1);
	}
	return labels.length >= 2 && labels.every((label) => /^x+$/.test(label));
}

const TRAILING_PROSE_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '(', '[']);
const CLOSING_TO_OPENING_BRACKET: Record<string, string> = { ')': '(', ']': '[' };

/**
 * Normalize a URL candidate captured from prose before auto-navigation:
 * cut at escaped newlines/tabs and strip trailing prose punctuation while keeping
 * closing brackets the URL itself opened (e.g. /wiki/Python_(programming_language)).
 */
export function sanitizeUrlCandidate(url: string): string {
	let candidate = url.trim();
	candidate = candidate.split(/\\[nrt]/, 1)[0];

	const bracketCounts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0 };
	for (const ch of candidate) {
		if (ch in bracketCounts) bracketCounts[ch]++;
	}

	let end = candidate.length;
	while (end > 0) {
		const lastChar = candidate[end - 1];
		if (TRAILING_PROSE_PUNCTUATION.has(lastChar)) {
			if (lastChar in bracketCounts) bracketCounts[lastChar]--;
			end--;
			continue;
		}
		const opening = CLOSING_TO_OPENING_BRACKET[lastChar];
		if (opening !== undefined && bracketCounts[lastChar] > bracketCounts[opening]) {
			bracketCounts[lastChar]--;
			end--;
			continue;
		}
		break;
	}
	return candidate.slice(0, end);
}

/** Remove lone UTF-16 surrogates that cannot be encoded as UTF-8. */
export function sanitizeSurrogates(text: string): string {
	if (!text || !/[\uD800-\uDFFF]/.test(text)) {
		return text;
	}
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += text[i] + text[i + 1];
				i++;
			}
		} else if (code < 0xdc00 || code > 0xdfff) {
			out += text[i];
		}
	}
	return out;
}

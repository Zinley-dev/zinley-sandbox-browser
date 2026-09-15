/**
 * Profile Import Utility - Atlas-like browser profile import
 *
 * Allows users to import their browser credentials/cookies from their
 * existing Chrome installation into a sandboxed automation browser.
 *
 * Flow:
 * 1. User starts Chrome with: chrome --remote-debugging-port=9222
 * 2. User logs into their accounts
 * 3. This utility connects via CDP and extracts all cookies/storage
 * 4. Saved to persistent file for future autonomous use
 */

import { chromium, BrowserContext } from 'patchright';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ImportedProfile {
	cookies: any[];
	origins: any[];
	importedAt: string;
	sourceType: 'running-chrome' | 'cdp-url' | 'profile-clone';
	cookieCount: number;
	originCount: number;
}

export interface ProfileImportOptions {
	/** CDP URL to connect to (default: http://localhost:9222) */
	cdpUrl?: string;
	/** Path to save the imported profile */
	savePath?: string;
	/** Whether to merge with existing profile */
	merge?: boolean;
}

// Default storage location
const DEFAULT_STORAGE_DIR = path.join(os.homedir(), '.orion');
const DEFAULT_STORAGE_FILE = 'browser-profile.json';

/**
 * Get the default profile storage path
 */
export function getDefaultProfilePath(): string {
	return path.join(DEFAULT_STORAGE_DIR, DEFAULT_STORAGE_FILE);
}

/**
 * Get user's Chrome profile path based on OS
 */
export function getDefaultChromeProfilePath(): string {
	switch (process.platform) {
		case 'darwin':
			return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
		case 'win32':
			return path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data');
		case 'linux':
			return path.join(os.homedir(), '.config/google-chrome');
		default:
			throw new Error(`Unsupported platform: ${process.platform}`);
	}
}

/**
 * Get the command to start Chrome with remote debugging
 */
export function getChromeDebugCommand(): string {
	switch (process.platform) {
		case 'darwin':
			return '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222';
		case 'win32':
			return '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222';
		case 'linux':
			return 'google-chrome --remote-debugging-port=9222';
		default:
			return 'chrome --remote-debugging-port=9222';
	}
}

/**
 * Check if Chrome is running with remote debugging enabled
 */
export async function isChromeCDPAvailable(cdpUrl: string = 'http://localhost:9222'): Promise<boolean> {
	try {
		const response = await fetch(`${cdpUrl}/json/version`);
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Import profile from a running Chrome instance via CDP
 *
 * @param options Import options
 * @returns Imported profile data
 */
export async function importFromRunningChrome(
	options: ProfileImportOptions = {}
): Promise<ImportedProfile> {
	const cdpUrl = options.cdpUrl || 'http://localhost:9222';
	const savePath = options.savePath || getDefaultProfilePath();
	const merge = options.merge ?? true;

	// Check if Chrome is available
	const isAvailable = await isChromeCDPAvailable(cdpUrl);
	if (!isAvailable) {
		throw new Error(
			`Cannot connect to Chrome at ${cdpUrl}.\n\n` +
			`Please start Chrome with remote debugging:\n` +
			`  ${getChromeDebugCommand()}\n\n` +
			`Then log into your accounts and run this import again.`
		);
	}

	console.log(`[ProfileImport] Connecting to Chrome at ${cdpUrl}...`);

	let browser;
	try {
		browser = await chromium.connectOverCDP(cdpUrl);
		const contexts = browser.contexts();

		if (contexts.length === 0) {
			throw new Error('No browser contexts found. Please open at least one tab in Chrome.');
		}

		// Get storage state from the first context (usually the main one)
		const context = contexts[0];
		const storageState = await context.storageState();

		console.log(`[ProfileImport] Extracted ${storageState.cookies.length} cookies and ${storageState.origins.length} origins`);

		const importedProfile: ImportedProfile = {
			cookies: storageState.cookies,
			origins: storageState.origins,
			importedAt: new Date().toISOString(),
			sourceType: 'running-chrome',
			cookieCount: storageState.cookies.length,
			originCount: storageState.origins.length,
		};

		// Save the profile
		await saveImportedProfile(importedProfile, savePath, merge);

		return importedProfile;
	} finally {
		// Don't close the browser - it's the user's Chrome!
		// Just disconnect
		if (browser) {
			browser.close().catch(() => {});
		}
	}
}

/**
 * Import profile from a specific CDP URL (cloud browser, etc.)
 */
export async function importFromCDPUrl(
	cdpUrl: string,
	options: Omit<ProfileImportOptions, 'cdpUrl'> = {}
): Promise<ImportedProfile> {
	return importFromRunningChrome({ ...options, cdpUrl });
}

/**
 * Save imported profile to file
 */
export async function saveImportedProfile(
	profile: ImportedProfile,
	savePath: string = getDefaultProfilePath(),
	merge: boolean = true
): Promise<void> {
	// Ensure directory exists
	const dir = path.dirname(savePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	let finalProfile = profile;

	// Merge with existing if requested
	if (merge && fs.existsSync(savePath)) {
		try {
			const existing = JSON.parse(fs.readFileSync(savePath, 'utf-8'));
			finalProfile = mergeProfiles(existing, profile);
			console.log(`[ProfileImport] Merged with existing profile`);
		} catch (error: any) {
			console.warn(`[ProfileImport] Could not merge with existing profile: ${error.message}`);
		}
	}

	// Atomic write
	const tempPath = savePath + '.tmp';
	fs.writeFileSync(tempPath, JSON.stringify(finalProfile, null, 2));

	// Backup existing
	if (fs.existsSync(savePath)) {
		const backupPath = savePath + '.bak';
		fs.renameSync(savePath, backupPath);
	}

	fs.renameSync(tempPath, savePath);

	console.log(`[ProfileImport] Saved profile to ${savePath}`);
	console.log(`[ProfileImport] Total: ${finalProfile.cookieCount} cookies, ${finalProfile.originCount} origins`);
}

/**
 * Load previously imported profile
 */
export function loadImportedProfile(
	loadPath: string = getDefaultProfilePath()
): ImportedProfile | null {
	if (!fs.existsSync(loadPath)) {
		return null;
	}

	try {
		const data = JSON.parse(fs.readFileSync(loadPath, 'utf-8'));
		return data as ImportedProfile;
	} catch (error: any) {
		console.error(`[ProfileImport] Failed to load profile: ${error.message}`);
		return null;
	}
}

/**
 * Check if a saved profile exists
 */
export function hasImportedProfile(loadPath: string = getDefaultProfilePath()): boolean {
	return fs.existsSync(loadPath);
}

/**
 * Get storage state format for Playwright from imported profile
 */
export function getStorageStateFromProfile(
	profile: ImportedProfile | null
): { cookies: any[]; origins: any[] } | null {
	if (!profile) return null;

	return {
		cookies: profile.cookies,
		origins: profile.origins,
	};
}

/**
 * Load storage state directly (convenience function)
 */
export function loadStorageState(
	loadPath: string = getDefaultProfilePath()
): { cookies: any[]; origins: any[] } | null {
	const profile = loadImportedProfile(loadPath);
	return getStorageStateFromProfile(profile);
}

/**
 * Merge two profiles, preferring newer cookies
 */
function mergeProfiles(existing: ImportedProfile, incoming: ImportedProfile): ImportedProfile {
	// Create cookie map keyed by domain+name+path
	const cookieKey = (c: any) => `${c.domain}:${c.name}:${c.path}`;

	const cookieMap = new Map<string, any>();

	// Add existing cookies
	for (const cookie of existing.cookies || []) {
		cookieMap.set(cookieKey(cookie), cookie);
	}

	// Override with incoming cookies (newer)
	for (const cookie of incoming.cookies || []) {
		cookieMap.set(cookieKey(cookie), cookie);
	}

	// Merge origins (localStorage/sessionStorage)
	const originMap = new Map<string, any>();

	for (const origin of existing.origins || []) {
		originMap.set(origin.origin, origin);
	}

	for (const origin of incoming.origins || []) {
		const existingOrigin = originMap.get(origin.origin);
		if (existingOrigin) {
			// Merge localStorage items
			const localStorageMap = new Map<string, string>();
			for (const item of existingOrigin.localStorage || []) {
				localStorageMap.set(item.name, item.value);
			}
			for (const item of origin.localStorage || []) {
				localStorageMap.set(item.name, item.value);
			}
			origin.localStorage = Array.from(localStorageMap.entries()).map(([name, value]) => ({ name, value }));
		}
		originMap.set(origin.origin, origin);
	}

	const mergedCookies = Array.from(cookieMap.values());
	const mergedOrigins = Array.from(originMap.values());

	return {
		cookies: mergedCookies,
		origins: mergedOrigins,
		importedAt: incoming.importedAt,
		sourceType: incoming.sourceType,
		cookieCount: mergedCookies.length,
		originCount: mergedOrigins.length,
	};
}

/**
 * Delete imported profile
 */
export function deleteImportedProfile(profilePath: string = getDefaultProfilePath()): boolean {
	try {
		if (fs.existsSync(profilePath)) {
			fs.unlinkSync(profilePath);
			console.log(`[ProfileImport] Deleted profile at ${profilePath}`);
			return true;
		}
		return false;
	} catch (error: any) {
		console.error(`[ProfileImport] Failed to delete profile: ${error.message}`);
		return false;
	}
}

/**
 * Get profile info without loading full data
 */
export function getProfileInfo(profilePath: string = getDefaultProfilePath()): {
	exists: boolean;
	cookieCount: number;
	originCount: number;
	importedAt: string | null;
	path: string;
} {
	const exists = fs.existsSync(profilePath);

	if (!exists) {
		return {
			exists: false,
			cookieCount: 0,
			originCount: 0,
			importedAt: null,
			path: profilePath,
		};
	}

	try {
		const profile = loadImportedProfile(profilePath);
		return {
			exists: true,
			cookieCount: profile?.cookieCount || 0,
			originCount: profile?.originCount || 0,
			importedAt: profile?.importedAt || null,
			path: profilePath,
		};
	} catch {
		return {
			exists: true,
			cookieCount: 0,
			originCount: 0,
			importedAt: null,
			path: profilePath,
		};
	}
}

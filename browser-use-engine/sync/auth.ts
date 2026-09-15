/**
 * OAuth2 Device Authorization Grant flow client for browser-use.
 * Port from browser_use/sync/auth.py
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getConfig } from '../config.js';

// Temporary user ID for pre-auth events (matches cloud backend)
export const TEMP_USER_ID = '99999999-9999-9999-9999-999999999999';

/**
 * Get or create a persistent device ID for this installation.
 */
export function getOrCreateDeviceId(): string {
	const config = getConfig();
	const deviceIdPath = path.join(config.BROWSER_USE_CONFIG_DIR, 'device_id');

	// Try to read existing device ID
	try {
		if (fs.existsSync(deviceIdPath)) {
			const deviceId = fs.readFileSync(deviceIdPath, 'utf-8').trim();
			if (deviceId) {
				return deviceId;
			}
		}
	} catch {
		// If we can't read it, we'll create a new one
	}

	// Create new device ID
	const deviceId = uuidv4();

	// Ensure config directory exists
	fs.mkdirSync(config.BROWSER_USE_CONFIG_DIR, { recursive: true });

	// Write device ID to file
	fs.writeFileSync(deviceIdPath, deviceId);

	return deviceId;
}

/**
 * Configuration for cloud authentication
 */
export interface CloudAuthConfig {
	apiToken: string | null;
	userId: string | null;
	authorizedAt: Date | null;
}

/**
 * Load auth config from local file
 */
export function loadCloudAuthConfig(): CloudAuthConfig {
	const config = getConfig();
	const configPath = path.join(config.BROWSER_USE_CONFIG_DIR, 'cloud_auth.json');

	if (fs.existsSync(configPath)) {
		try {
			const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
			return {
				apiToken: data.apiToken || null,
				userId: data.userId || null,
				authorizedAt: data.authorizedAt ? new Date(data.authorizedAt) : null,
			};
		} catch {
			// Return empty config if file is corrupted
		}
	}

	return {
		apiToken: null,
		userId: null,
		authorizedAt: null,
	};
}

/**
 * Save auth config to local file
 */
export function saveCloudAuthConfig(authConfig: CloudAuthConfig): void {
	const config = getConfig();
	fs.mkdirSync(config.BROWSER_USE_CONFIG_DIR, { recursive: true });

	const configPath = path.join(config.BROWSER_USE_CONFIG_DIR, 'cloud_auth.json');
	fs.writeFileSync(
		configPath,
		JSON.stringify(
			{
				apiToken: authConfig.apiToken,
				userId: authConfig.userId,
				authorizedAt: authConfig.authorizedAt?.toISOString(),
			},
			null,
			2
		)
	);

	// Set restrictive permissions (owner read/write only) for security
	try {
		fs.chmodSync(configPath, 0o600);
	} catch {
		// Some systems may not support chmod, continue anyway
	}
}

/**
 * Clear stored authentication
 */
export function clearCloudAuth(): void {
	const config = getConfig();
	const configPath = path.join(config.BROWSER_USE_CONFIG_DIR, 'cloud_auth.json');

	try {
		fs.unlinkSync(configPath);
	} catch {
		// File may not exist
	}
}

/**
 * Client for OAuth2 device authorization flow
 */
export class DeviceAuthClient {
	private baseUrl: string;
	private clientId: string = 'library';
	private scope: string = 'read write';
	private deviceId: string;
	private authConfig: CloudAuthConfig;

	constructor(baseUrl?: string) {
		const config = getConfig();
		this.baseUrl = baseUrl || config.BROWSER_USE_CLOUD_API_URL;
		this.deviceId = getOrCreateDeviceId();
		this.authConfig = loadCloudAuthConfig();
	}

	/**
	 * Check if we have valid authentication
	 */
	get isAuthenticated(): boolean {
		return Boolean(this.authConfig.apiToken && this.authConfig.userId);
	}

	/**
	 * Get the current API token
	 */
	get apiToken(): string | null {
		return this.authConfig.apiToken;
	}

	/**
	 * Get the current user ID (temporary or real)
	 */
	get userId(): string {
		return this.authConfig.userId || TEMP_USER_ID;
	}

	/**
	 * Start the device authorization flow.
	 * Returns device authorization details including user code and verification URL.
	 */
	async startDeviceAuthorization(agentSessionId?: string): Promise<Record<string, any>> {
		const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/v1/oauth/device/authorize`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				client_id: this.clientId,
				scope: this.scope,
				agent_session_id: agentSessionId || '',
				device_id: this.deviceId,
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		}

		return response.json();
	}

	/**
	 * Poll for the access token.
	 * Returns token info when authorized, null if timeout.
	 */
	async pollForToken(
		deviceCode: string,
		interval: number = 3.0,
		timeout: number = 1800.0
	): Promise<Record<string, any> | null> {
		const startTime = Date.now();

		while ((Date.now() - startTime) / 1000 < timeout) {
			try {
				const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/v1/oauth/device/token`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams({
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
						device_code: deviceCode,
						client_id: this.clientId,
					}),
				});

				const data = await response.json();

				if (response.status === 200) {
					// Check for pending authorization
					if (data.error === 'authorization_pending') {
						await this.sleep(interval * 1000);
						continue;
					}

					// Check for slow down
					if (data.error === 'slow_down') {
						interval = data.interval || interval * 2;
						await this.sleep(interval * 1000);
						continue;
					}

					// Check for other errors
					if (data.error) {
						console.log(`Error: ${data.error_description || data.error}`);
						return null;
					}

					// Success! We have a token
					if (data.access_token) {
						return data;
					}
				} else if (response.status === 400) {
					// Error response
					if (!['authorization_pending', 'slow_down'].includes(data.error)) {
						console.log(`Error: ${data.error_description || 'Unknown error'}`);
						return null;
					}
				} else {
					console.log(`Unexpected status code: ${response.status}`);
					return null;
				}
			} catch (e: any) {
				console.log(`Error polling for token: ${e.message}`);
			}

			await this.sleep(interval * 1000);
		}

		return null;
	}

	/**
	 * Run the full authentication flow.
	 * Returns true if authentication successful.
	 */
	async authenticate(agentSessionId?: string, showInstructions: boolean = true): Promise<boolean> {
		const config = getConfig();

		try {
			// Start device authorization
			const deviceAuth = await this.startDeviceAuthorization(agentSessionId);

			// Use frontend URL for user-facing links
			const frontendUrl = config.BROWSER_USE_CLOUD_UI_URL || this.baseUrl.replace('//api.', '//cloud.');

			// Replace backend URL with frontend URL in verification URIs
			const verificationUri = deviceAuth.verification_uri.replace(this.baseUrl, frontendUrl);
			const verificationUriComplete = deviceAuth.verification_uri_complete.replace(
				this.baseUrl,
				frontendUrl
			);

			if (showInstructions && config.BROWSER_USE_CLOUD_SYNC) {
				console.log('─'.repeat(40));
				console.log('View the details of this run in Browser Use Cloud:');
				console.log(`    ${verificationUriComplete}`);
				console.log('─'.repeat(40) + '\n');
			}

			// Poll for token
			const tokenData = await this.pollForToken(deviceAuth.device_code, deviceAuth.interval || 5);

			if (tokenData?.access_token) {
				// Save authentication
				this.authConfig = {
					apiToken: tokenData.access_token,
					userId: tokenData.user_id || TEMP_USER_ID,
					authorizedAt: new Date(),
				};
				saveCloudAuthConfig(this.authConfig);

				if (showInstructions) {
					console.log('Authentication successful! Cloud sync is now enabled.');
				}

				return true;
			}
		} catch (e: any) {
			if (e.message?.includes('404')) {
				console.warn(
					'Cloud sync authentication endpoint not found (404). Check your BROWSER_USE_CLOUD_API_URL setting.'
				);
			} else if (e.message?.includes('ECONNREFUSED') || e.message?.includes('fetch failed')) {
				// Connection error - silently fail
			} else {
				console.warn(`Unexpected error during cloud sync authentication: ${e.message}`);
			}
		}

		if (showInstructions) {
			console.log('Sync authentication failed or timed out.');
		}

		return false;
	}

	/**
	 * Get headers for API requests
	 */
	getHeaders(): Record<string, string> {
		if (this.apiToken) {
			return { Authorization: `Bearer ${this.apiToken}` };
		}
		return {};
	}

	/**
	 * Clear stored authentication
	 */
	clearAuth(): void {
		this.authConfig = { apiToken: null, userId: null, authorizedAt: null };
		clearCloudAuth();
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

// Legacy export for compatibility
export class SyncAuth {
	private client: DeviceAuthClient;

	constructor() {
		this.client = new DeviceAuthClient();
	}

	async login(credentials?: any): Promise<string> {
		const success = await this.client.authenticate();
		if (success && this.client.apiToken) {
			return this.client.apiToken;
		}
		throw new Error('Authentication failed');
	}

	get isAuthenticated(): boolean {
		return this.client.isAuthenticated;
	}

	get apiToken(): string | null {
		return this.client.apiToken;
	}
}

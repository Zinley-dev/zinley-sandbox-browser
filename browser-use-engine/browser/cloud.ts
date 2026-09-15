/**
 * Cloud browser service integration for browser-use.
 * Port from browser_use/browser/cloud.py
 *
 * This module provides integration with the browser-use cloud browser service.
 * When cloud_browser=True, it automatically creates a cloud browser instance
 * and returns the CDP URL for connection.
 */

import { loadCloudAuthConfig } from '../sync/auth.js';

/**
 * Response from cloud browser API.
 */
export interface CloudBrowserResponse {
	id: string;
	status: string;
	liveUrl: string;
	cdpUrl: string;
	timeoutAt: string;
	startedAt: string;
	finishedAt: string | null;
}

/**
 * Cloud browser options
 */
export interface CloudBrowserOptions {
	provider?: string;
	region?: string;
	apiBaseUrl?: string;
}

/**
 * Exception raised when cloud browser operations fail.
 */
export class CloudBrowserError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CloudBrowserError';
	}
}

/**
 * Exception raised when cloud browser authentication fails.
 */
export class CloudBrowserAuthError extends CloudBrowserError {
	constructor(message: string) {
		super(message);
		this.name = 'CloudBrowserAuthError';
	}
}

/**
 * Client for browser-use cloud browser service.
 */
export class CloudBrowserClient {
	private apiBaseUrl: string;
	private currentSessionId: string | null = null;

	constructor(apiBaseUrl: string = 'https://api.browser-use.com') {
		this.apiBaseUrl = apiBaseUrl;
	}

	/**
	 * Create a new cloud browser instance.
	 *
	 * @returns CloudBrowserResponse containing CDP URL and other browser info
	 * @throws CloudBrowserAuthError if authentication fails
	 * @throws CloudBrowserError if browser creation fails
	 */
	async createBrowser(): Promise<CloudBrowserResponse> {
		const url = `${this.apiBaseUrl}/api/v2/browsers`;

		// Try to get API key from environment variable first, then auth config
		let apiToken = process.env.BROWSER_USE_API_KEY;

		if (!apiToken) {
			// Fallback to auth config file
			try {
				const authConfig = loadCloudAuthConfig();
				apiToken = authConfig.apiToken || undefined;
			} catch {
				// Ignore errors loading auth config
			}
		}

		if (!apiToken) {
			throw new CloudBrowserAuthError(
				'No authentication token found. Please set BROWSER_USE_API_KEY environment variable to authenticate with the cloud service. You can also create an API key at https://cloud.browser-use.com/new-api-key'
			);
		}

		const headers: Record<string, string> = {
			'X-Browser-Use-API-Key': apiToken,
			'Content-Type': 'application/json',
		};

		try {
			console.log('Creating cloud browser instance...');

			const response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify({}),
				signal: AbortSignal.timeout(30000),
			});

			if (response.status === 401) {
				throw new CloudBrowserAuthError(
					'Authentication failed. Please make sure you have set BROWSER_USE_API_KEY environment variable to authenticate with the cloud service. You can also create an API key at https://cloud.browser-use.com/new-api-key'
				);
			} else if (response.status === 403) {
				throw new CloudBrowserAuthError(
					'Access forbidden. Please check your browser-use cloud subscription status.'
				);
			} else if (!response.ok) {
				let errorMsg = `Failed to create cloud browser: HTTP ${response.status}`;
				try {
					const errorData = await response.json();
					if (errorData.detail) {
						errorMsg += ` - ${errorData.detail}`;
					}
				} catch {
					// Ignore JSON parse errors
				}
				throw new CloudBrowserError(errorMsg);
			}

			const browserData = await response.json();
			const browserResponse: CloudBrowserResponse = {
				id: browserData.id,
				status: browserData.status,
				liveUrl: browserData.liveUrl,
				cdpUrl: browserData.cdpUrl,
				timeoutAt: browserData.timeoutAt,
				startedAt: browserData.startedAt,
				finishedAt: browserData.finishedAt || null,
			};

			// Store session ID for cleanup
			this.currentSessionId = browserResponse.id;

			console.log(`Cloud browser created successfully: ${browserResponse.id}`);
			console.log(`Live URL: ${browserResponse.liveUrl}`);

			return browserResponse;
		} catch (e: any) {
			if (e instanceof CloudBrowserError || e instanceof CloudBrowserAuthError) {
				throw e;
			}
			if (e.name === 'TimeoutError') {
				throw new CloudBrowserError('Timeout while creating cloud browser. Please try again.');
			}
			if (e.message?.includes('ECONNREFUSED') || e.message?.includes('fetch failed')) {
				throw new CloudBrowserError(
					'Failed to connect to cloud browser service. Please check your internet connection.'
				);
			}
			throw new CloudBrowserError(`Unexpected error creating cloud browser: ${e.message}`);
		}
	}

	/**
	 * Stop a cloud browser session.
	 *
	 * @param sessionId Session ID to stop. If undefined, uses current session.
	 * @returns Updated browser info with stopped status
	 * @throws CloudBrowserAuthError if authentication fails
	 * @throws CloudBrowserError if stopping fails
	 */
	async stopBrowser(sessionId?: string): Promise<CloudBrowserResponse> {
		const targetSessionId = sessionId || this.currentSessionId;

		if (!targetSessionId) {
			throw new CloudBrowserError('No session ID provided and no current session available');
		}

		const url = `${this.apiBaseUrl}/api/v2/browsers/${targetSessionId}`;

		// Try to get API key from environment variable first, then auth config
		let apiToken = process.env.BROWSER_USE_API_KEY;

		if (!apiToken) {
			// Fallback to auth config file
			try {
				const authConfig = loadCloudAuthConfig();
				apiToken = authConfig.apiToken || undefined;
			} catch {
				// Ignore errors loading auth config
			}
		}

		if (!apiToken) {
			throw new CloudBrowserAuthError(
				'No authentication token found. Please set BROWSER_USE_API_KEY environment variable to authenticate with the cloud service. You can also create an API key at https://cloud.browser-use.com/new-api-key'
			);
		}

		const headers: Record<string, string> = {
			'X-Browser-Use-API-Key': apiToken,
			'Content-Type': 'application/json',
		};

		try {
			console.log(`Stopping cloud browser session: ${targetSessionId}`);

			const response = await fetch(url, {
				method: 'PATCH',
				headers,
				body: JSON.stringify({ action: 'stop' }),
				signal: AbortSignal.timeout(30000),
			});

			if (response.status === 401) {
				throw new CloudBrowserAuthError(
					'Authentication failed. Please make sure you have set the BROWSER_USE_API_KEY environment variable to authenticate with the cloud service.'
				);
			} else if (response.status === 404) {
				// Session already stopped or doesn't exist
				console.log(`Cloud browser session ${targetSessionId} not found (already stopped)`);
				if (targetSessionId === this.currentSessionId) {
					this.currentSessionId = null;
				}
				throw new CloudBrowserError(`Cloud browser session ${targetSessionId} not found`);
			} else if (!response.ok) {
				let errorMsg = `Failed to stop cloud browser: HTTP ${response.status}`;
				try {
					const errorData = await response.json();
					if (errorData.detail) {
						errorMsg += ` - ${errorData.detail}`;
					}
				} catch {
					// Ignore JSON parse errors
				}
				throw new CloudBrowserError(errorMsg);
			}

			const browserData = await response.json();
			const browserResponse: CloudBrowserResponse = {
				id: browserData.id,
				status: browserData.status,
				liveUrl: browserData.liveUrl,
				cdpUrl: browserData.cdpUrl,
				timeoutAt: browserData.timeoutAt,
				startedAt: browserData.startedAt,
				finishedAt: browserData.finishedAt || null,
			};

			// Clear current session if it was this one
			if (targetSessionId === this.currentSessionId) {
				this.currentSessionId = null;
			}

			console.log(`Cloud browser session stopped: ${browserResponse.id}`);

			return browserResponse;
		} catch (e: any) {
			if (e instanceof CloudBrowserError || e instanceof CloudBrowserAuthError) {
				throw e;
			}
			if (e.name === 'TimeoutError') {
				throw new CloudBrowserError('Timeout while stopping cloud browser. Please try again.');
			}
			if (e.message?.includes('ECONNREFUSED') || e.message?.includes('fetch failed')) {
				throw new CloudBrowserError(
					'Failed to connect to cloud browser service. Please check your internet connection.'
				);
			}
			throw new CloudBrowserError(`Unexpected error stopping cloud browser: ${e.message}`);
		}
	}

	/**
	 * Close the client and cleanup any active sessions.
	 */
	async close(): Promise<void> {
		// Try to stop current session if active
		if (this.currentSessionId) {
			try {
				await this.stopBrowser();
			} catch (e: any) {
				console.debug(`Failed to stop cloud browser session during cleanup: ${e.message}`);
			}
		}
	}

	/**
	 * Get current session ID
	 */
	get sessionId(): string | null {
		return this.currentSessionId;
	}
}

// Global client instance
let _cloudClient: CloudBrowserClient | null = null;

/**
 * Get a CDP URL for a new cloud browser instance.
 *
 * @returns CDP URL for connecting to the cloud browser
 * @throws CloudBrowserAuthError if authentication fails
 * @throws CloudBrowserError if browser creation fails
 */
export async function getCloudBrowserCdpUrl(): Promise<string> {
	if (!_cloudClient) {
		_cloudClient = new CloudBrowserClient();
	}

	try {
		const browserResponse = await _cloudClient.createBrowser();
		return browserResponse.cdpUrl;
	} catch (e) {
		// Clean up client on error
		if (_cloudClient) {
			await _cloudClient.close();
			_cloudClient = null;
		}
		throw e;
	}
}

/**
 * Stop a cloud browser session.
 *
 * @param sessionId Session ID to stop. If undefined, uses current session from global client.
 * @returns Updated browser info with stopped status
 * @throws CloudBrowserAuthError if authentication fails
 * @throws CloudBrowserError if stopping fails
 */
export async function stopCloudBrowserSession(sessionId?: string): Promise<CloudBrowserResponse> {
	if (!_cloudClient) {
		_cloudClient = new CloudBrowserClient();
	}

	return _cloudClient.stopBrowser(sessionId);
}

/**
 * Clean up the global cloud client.
 */
export async function cleanupCloudClient(): Promise<void> {
	if (_cloudClient) {
		await _cloudClient.close();
		_cloudClient = null;
	}
}

// Legacy export for compatibility
export class CloudBrowser {
	private client: CloudBrowserClient;
	private options: CloudBrowserOptions;

	constructor(options: CloudBrowserOptions = {}) {
		this.options = options;
		this.client = new CloudBrowserClient(options.apiBaseUrl);
	}

	async launch(): Promise<CloudBrowserResponse> {
		return this.client.createBrowser();
	}

	async stop(): Promise<CloudBrowserResponse | void> {
		try {
			return await this.client.stopBrowser();
		} catch {
			// Session may already be stopped
		}
	}

	async close(): Promise<void> {
		await this.client.close();
	}
}

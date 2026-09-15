/**
 * Cloud browser service integration for browser-use.
 * Port from browser_use/browser/cloud.py
 *
 * When cloud_browser=true, it automatically creates a cloud browser instance
 * and returns the CDP URL for connection.
 */

import axios, { AxiosInstance } from 'axios';

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
	private client: AxiosInstance;
	private currentSessionId: string | null = null;

	constructor(apiBaseUrl: string = 'https://api.browser-use.com') {
		this.apiBaseUrl = apiBaseUrl;
		this.client = axios.create({
			timeout: 30000,
		});
	}

	/**
	 * Create a new cloud browser instance.
	 *
	 * @returns Contains CDP URL and other browser info
	 * @throws CloudBrowserAuthError If authentication fails
	 * @throws CloudBrowserError If browser creation fails
	 */
	async createBrowser(): Promise<CloudBrowserResponse> {
		const url = `${this.apiBaseUrl}/api/v2/browsers`;

		// Try to get API key from environment variable
		const apiToken = process.env.BROWSER_USE_API_KEY;

		if (!apiToken) {
			throw new CloudBrowserAuthError(
				'No authentication token found. Please set BROWSER_USE_API_KEY environment variable to authenticate with the cloud service. You can also create an API key at https://cloud.browser-use.com/new-api-key'
			);
		}

		const headers = {
			'X-Browser-Use-API-Key': apiToken,
			'Content-Type': 'application/json',
		};

		// Empty request body as per API specification
		const requestBody = {};

		try {
			console.debug('Creating cloud browser instance...');

			const response = await this.client.post(url, requestBody, { headers });

			const browserData = response.data;
			const browserResponse = browserData as CloudBrowserResponse;

			// Store session ID for cleanup
			this.currentSessionId = browserResponse.id;

			console.debug(`Cloud browser created successfully: ${browserResponse.id}`);
			console.debug(`CDP URL: ${browserResponse.cdpUrl}`);
			console.log(`\x1b[36mLive URL: ${browserResponse.liveUrl}\x1b[0m`);

			return browserResponse;
		} catch (error: any) {
			if (axios.isAxiosError(error)) {
				if (error.response?.status === 401) {
					throw new CloudBrowserAuthError(
						'Authentication failed. Please make sure you have set BROWSER_USE_API_KEY environment variable to authenticate with the cloud service. You can also create an API key at https://cloud.browser-use.com/new-api-key'
					);
				} else if (error.response?.status === 403) {
					throw new CloudBrowserAuthError(
						'Access forbidden. Please check your browser-use cloud subscription status.'
					);
				} else if (error.response) {
					let errorMsg = `Failed to create cloud browser: HTTP ${error.response.status}`;
					if (error.response.data?.detail) {
						errorMsg += ` - ${error.response.data.detail}`;
					}
					throw new CloudBrowserError(errorMsg);
				} else if (error.code === 'ECONNABORTED') {
					throw new CloudBrowserError('Timeout while creating cloud browser. Please try again.');
				} else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
					throw new CloudBrowserError(
						'Failed to connect to cloud browser service. Please check your internet connection.'
					);
				}
			}
			throw new CloudBrowserError(`Unexpected error creating cloud browser: ${error.message}`);
		}
	}

	/**
	 * Stop a cloud browser session.
	 *
	 * @param sessionId Session ID to stop. If null, uses current session.
	 * @returns Updated browser info with stopped status
	 * @throws CloudBrowserAuthError If authentication fails
	 * @throws CloudBrowserError If stopping fails
	 */
	async stopBrowser(sessionId?: string | null): Promise<CloudBrowserResponse> {
		const targetSessionId = sessionId ?? this.currentSessionId;

		if (!targetSessionId) {
			throw new CloudBrowserError('No session ID provided and no current session available');
		}

		const url = `${this.apiBaseUrl}/api/v2/browsers/${targetSessionId}`;

		// Try to get API key from environment variable
		const apiToken = process.env.BROWSER_USE_API_KEY;

		if (!apiToken) {
			throw new CloudBrowserAuthError(
				'No authentication token found. Please set BROWSER_USE_API_KEY environment variable to authenticate with the cloud service. You can also create an API key at https://cloud.browser-use.com/new-api-key'
			);
		}

		const headers = {
			'X-Browser-Use-API-Key': apiToken,
			'Content-Type': 'application/json',
		};

		const requestBody = { action: 'stop' };

		try {
			console.debug(`Stopping cloud browser session: ${targetSessionId}`);

			const response = await this.client.patch(url, requestBody, { headers });

			const browserData = response.data;
			const browserResponse = browserData as CloudBrowserResponse;

			// Clear current session if it was this one
			if (targetSessionId === this.currentSessionId) {
				this.currentSessionId = null;
			}

			console.debug(`Cloud browser session stopped: ${browserResponse.id}`);
			console.debug(`Status: ${browserResponse.status}`);

			return browserResponse;
		} catch (error: any) {
			if (axios.isAxiosError(error)) {
				if (error.response?.status === 401) {
					throw new CloudBrowserAuthError(
						'Authentication failed. Please make sure you have set the BROWSER_USE_API_KEY environment variable to authenticate with the cloud service.'
					);
				} else if (error.response?.status === 404) {
					// Session already stopped or doesn't exist
					console.debug(`Cloud browser session ${targetSessionId} not found (already stopped)`);
					if (targetSessionId === this.currentSessionId) {
						this.currentSessionId = null;
					}
					throw new CloudBrowserError(`Cloud browser session ${targetSessionId} not found`);
				} else if (error.response) {
					let errorMsg = `Failed to stop cloud browser: HTTP ${error.response.status}`;
					if (error.response.data?.detail) {
						errorMsg += ` - ${error.response.data.detail}`;
					}
					throw new CloudBrowserError(errorMsg);
				} else if (error.code === 'ECONNABORTED') {
					throw new CloudBrowserError('Timeout while stopping cloud browser. Please try again.');
				} else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
					throw new CloudBrowserError(
						'Failed to connect to cloud browser service. Please check your internet connection.'
					);
				}
			}
			throw new CloudBrowserError(`Unexpected error stopping cloud browser: ${error.message}`);
		}
	}

	/**
	 * Close the HTTP client and cleanup any active sessions.
	 */
	async close(): Promise<void> {
		// Try to stop current session if active
		if (this.currentSessionId) {
			try {
				await this.stopBrowser();
			} catch (error) {
				console.debug(`Failed to stop cloud browser session during cleanup: ${error}`);
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
 * @throws CloudBrowserAuthError If authentication fails
 * @throws CloudBrowserError If browser creation fails
 */
export async function getCloudBrowserCdpUrl(): Promise<string> {
	if (_cloudClient === null) {
		_cloudClient = new CloudBrowserClient();
	}

	try {
		const browserResponse = await _cloudClient.createBrowser();
		return browserResponse.cdpUrl;
	} catch (error) {
		// Clean up client on error
		if (_cloudClient) {
			await _cloudClient.close();
			_cloudClient = null;
		}
		throw error;
	}
}

/**
 * Stop a cloud browser session.
 *
 * @param sessionId Session ID to stop. If null, uses current session from global client.
 * @returns Updated browser info with stopped status
 * @throws CloudBrowserAuthError If authentication fails
 * @throws CloudBrowserError If stopping fails
 */
export async function stopCloudBrowserSession(sessionId?: string | null): Promise<CloudBrowserResponse> {
	if (_cloudClient === null) {
		_cloudClient = new CloudBrowserClient();
	}

	return await _cloudClient.stopBrowser(sessionId);
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

/**
 * Get the global cloud client instance.
 */
export function getCloudClient(): CloudBrowserClient | null {
	return _cloudClient;
}

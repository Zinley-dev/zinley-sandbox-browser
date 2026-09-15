/**
 * Cloud sync service for sending events to the Browser Use cloud.
 * Port from browser_use/sync/service.py
 */

import { getConfig } from '../config.js';
import { DeviceAuthClient, TEMP_USER_ID } from './auth.js';

/**
 * Base event interface for cloud sync
 */
export interface BaseEvent {
	eventType: string;
	userId?: string;
	deviceId?: string;
	[key: string]: any;
}

/**
 * Service for syncing events to the Browser Use cloud
 */
export class CloudSync {
	private baseUrl: string;
	private authClient: DeviceAuthClient;
	private sessionId: string | null = null;
	private allowSessionEventsForAuth: boolean;
	private authFlowActive: boolean = false;
	private enabled: boolean;

	constructor(baseUrl?: string, allowSessionEventsForAuth: boolean = false) {
		const config = getConfig();
		this.baseUrl = baseUrl || config.BROWSER_USE_CLOUD_API_URL;
		this.authClient = new DeviceAuthClient(this.baseUrl);
		this.allowSessionEventsForAuth = allowSessionEventsForAuth;
		this.enabled = config.BROWSER_USE_CLOUD_SYNC;
	}

	/**
	 * Handle an event by sending it to the cloud
	 */
	async handleEvent(event: BaseEvent): Promise<void> {
		try {
			// If cloud sync is disabled, don't handle any events
			if (!this.enabled) {
				return;
			}

			// Extract session ID from CreateAgentSessionEvent
			if (event.eventType === 'CreateAgentSessionEvent' && event.id) {
				this.sessionId = String(event.id);
			}

			// Send events based on authentication status and context
			if (this.authClient.isAuthenticated) {
				// User is authenticated - send all events
				await this._sendEvent(event);
			} else if (this.allowSessionEventsForAuth) {
				// Special case: allow ALL events during auth flow
				await this._sendEvent(event);
				// Mark auth flow as active when we see a session event
				if (event.eventType === 'CreateAgentSessionEvent') {
					this.authFlowActive = true;
				}
			} else {
				// User is not authenticated and no auth in progress - don't send anything
				console.debug(`Skipping event ${event.eventType} - user not authenticated`);
			}
		} catch (e: any) {
			console.error(`Failed to handle ${event.eventType} event: ${e.message}`);
		}
	}

	/**
	 * Send event to cloud API
	 */
	private async _sendEvent(event: BaseEvent): Promise<void> {
		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};

			// Override user_id only if it's not already set to a specific value
			if (this.authClient.isAuthenticated) {
				const currentUserId = event.userId;
				if (currentUserId !== TEMP_USER_ID) {
					event.userId = this.authClient.userId;
				}
			} else {
				// Set temp user_id if not already set
				if (!event.userId) {
					event.userId = TEMP_USER_ID;
				}
			}

			// Add auth headers if available
			const authHeaders = this.authClient.getHeaders();
			Object.assign(headers, authHeaders);

			// Add device_id to all events
			event.deviceId = (this.authClient as any).deviceId;

			// Send event (batch format with direct event serialization)
			const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/v1/events`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ events: [event] }),
				signal: AbortSignal.timeout(10000),
			});

			if (response.status >= 400) {
				console.debug(`Failed to send sync event: POST ${response.url} ${response.status}`);
			}
		} catch (e: any) {
			if (e.name === 'TimeoutError') {
				console.debug(`Event send timed out after 10 seconds`);
			} else if (e.message?.includes('ECONNREFUSED') || e.message?.includes('fetch failed')) {
				// Connection error - silently fail
			} else {
				console.debug(`Error sending event: ${e.message}`);
			}
		}
	}

	/**
	 * Mark auth flow as active to allow all events
	 */
	setAuthFlowActive(): void {
		this.authFlowActive = true;
	}

	/**
	 * Authenticate with the cloud service
	 */
	async authenticate(showInstructions: boolean = true): Promise<boolean> {
		// If cloud sync is disabled, don't authenticate
		if (!this.enabled) {
			return false;
		}

		// Check if already authenticated first
		if (this.authClient.isAuthenticated) {
			if (showInstructions) {
				console.log('Already authenticated! Skipping OAuth flow.');
			}
			return true;
		}

		// Not authenticated - run OAuth flow
		return await this.authClient.authenticate(this.sessionId || undefined, showInstructions);
	}

	/**
	 * Check if authenticated
	 */
	get isAuthenticated(): boolean {
		return this.authClient.isAuthenticated;
	}
}

// Legacy export for compatibility
export class SyncService {
	private cloudSync: CloudSync;

	constructor() {
		this.cloudSync = new CloudSync();
	}

	async sync(state: any): Promise<void> {
		await this.cloudSync.handleEvent({
			eventType: 'SyncStateEvent',
			state,
		});
	}

	async authenticate(): Promise<boolean> {
		return this.cloudSync.authenticate();
	}
}

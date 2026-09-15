/**
 * Cloud events for distributed browser-use
 * Port from browser_use/cloud/events.py
 */

/**
 * Cloud event interface
 */
export interface CloudEvent {
	type: string;
	data: any;
	timestamp: number;
	id?: string;
	userId?: string;
	deviceId?: string | null;
}

/**
 * Cloud event publisher for sending events to the browser-use cloud service
 */
export class CloudEventPublisher {
	private apiBaseUrl: string;
	private apiToken: string | null = null;
	private eventQueue: CloudEvent[] = [];

	constructor(apiBaseUrl: string = 'https://api.browser-use.com') {
		this.apiBaseUrl = apiBaseUrl;
		this.apiToken = process.env.BROWSER_USE_API_KEY || null;
	}

	/**
	 * Set API token
	 */
	setApiToken(token: string): void {
		this.apiToken = token;
	}

	/**
	 * Publish an event to the cloud
	 */
	async publish(event: CloudEvent): Promise<void> {
		if (!this.apiToken) {
			// Queue event if no API token
			this.eventQueue.push(event);
			return;
		}

		try {
			const url = `${this.apiBaseUrl}/api/v2/events`;
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'X-Browser-Use-API-Key': this.apiToken,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(event),
			});

			if (!response.ok) {
				console.debug(`Failed to publish cloud event: ${response.status}`);
			}
		} catch (error) {
			console.debug(`Error publishing cloud event: ${error}`);
		}
	}

	/**
	 * Publish multiple events
	 */
	async publishBatch(events: CloudEvent[]): Promise<void> {
		for (const event of events) {
			await this.publish(event);
		}
	}

	/**
	 * Flush queued events (call after API token is set)
	 */
	async flush(): Promise<void> {
		if (!this.apiToken || this.eventQueue.length === 0) return;

		const queue = [...this.eventQueue];
		this.eventQueue = [];

		for (const event of queue) {
			await this.publish(event);
		}
	}

	/**
	 * Create a cloud event
	 */
	static createEvent(type: string, data: any): CloudEvent {
		return {
			type,
			data,
			timestamp: Date.now(),
		};
	}
}

// Global event publisher instance
let _cloudEventPublisher: CloudEventPublisher | null = null;

/**
 * Get the global cloud event publisher
 */
export function getCloudEventPublisher(): CloudEventPublisher {
	if (!_cloudEventPublisher) {
		_cloudEventPublisher = new CloudEventPublisher();
	}
	return _cloudEventPublisher;
}

/**
 * Reset the global cloud event publisher
 */
export function resetCloudEventPublisher(): void {
	_cloudEventPublisher = null;
}

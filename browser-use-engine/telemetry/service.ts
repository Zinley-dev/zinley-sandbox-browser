/**
 * Telemetry service for usage tracking
 * Port from browser_use/telemetry/service.py (synced with 0.13.10)
 *
 * Captures anonymized telemetry data using PostHog.
 * Disable by setting ANONYMIZED_TELEMETRY=false environment variable.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getConfig } from '../config.js';
import { BaseTelemetryEvent } from './views.js';

const POSTHOG_EVENT_SETTINGS = {
	process_person_profile: true,
};

export const POSTHOG_PROJECT_API_KEY = 'phc_F8JMNjW1i2KbGUTaW1unnDdLSPCoyc52SGRU0JecaUh';
export const POSTHOG_HOST = 'https://eu.i.posthog.com';

let _deviceId: string | null = null;

function deviceIdPath(): string {
	return path.join(getConfig().BROWSER_USE_CONFIG_DIR, 'device_id');
}

/**
 * Return the anonymous device id shared by telemetry.
 *
 * Resolution order (port of `get_or_create_device_id`):
 * BROWSER_USE_DEVICE_ID env -> persisted file -> hashed machine fingerprint -> fresh uuid.
 */
export function getOrCreateDeviceId(): string {
	if (_deviceId) {
		return _deviceId;
	}
	_deviceId = process.env.BROWSER_USE_DEVICE_ID || persistedDeviceId() || machineFingerprint() || uuidv4();
	return _deviceId;
}

function persistedDeviceId(): string | null {
	try {
		const filePath = deviceIdPath();
		if (fs.existsSync(filePath)) {
			return fs.readFileSync(filePath, 'utf-8').trim() || null;
		}
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const newDeviceId = uuidv4();
		// Write atomically so concurrent processes never observe a partial id
		const tmpPath = `${filePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmpPath, newDeviceId);
		fs.renameSync(tmpPath, filePath);
		return newDeviceId;
	} catch {
		return null;
	}
}

/**
 * Hashed hardware-derived id (port of `_machine_fingerprint`): sha256 of the
 * first real MAC address plus the hostname, prefixed with `bu_`.
 */
function machineFingerprint(): string | null {
	try {
		const interfaces = os.networkInterfaces();
		let mac: string | null = null;
		for (const entries of Object.values(interfaces)) {
			for (const entry of entries ?? []) {
				if (entry.internal || !entry.mac || entry.mac === '00:00:00:00:00:00') {
					continue;
				}
				mac = entry.mac;
				break;
			}
			if (mac) {
				break;
			}
		}
		if (!mac) {
			return null;
		}
		// Multicast bit set means this is not a real hardware address
		const firstOctet = parseInt(mac.split(':')[0], 16);
		if (Number.isNaN(firstOctet) || (firstOctet & 0x01) === 1) {
			return null;
		}
		const node = parseInt(mac.replace(/:/g, ''), 16);
		const digest = crypto.createHash('sha256').update(`browser-use:${node}:${os.hostname()}`).digest('hex');
		return 'bu_' + digest.slice(0, 32);
	} catch {
		return null;
	}
}

/** Test hook: forget the cached device id. */
export function _resetDeviceIdCache(): void {
	_deviceId = null;
}

// Singleton instance
let _instance: ProductTelemetry | null = null;

/**
 * Service for capturing anonymized telemetry data.
 *
 * If the environment variable `ANONYMIZED_TELEMETRY=False`, anonymized telemetry will be disabled.
 */
export class ProductTelemetry {
	static readonly PROJECT_API_KEY = POSTHOG_PROJECT_API_KEY;
	static readonly HOST = POSTHOG_HOST;

	private posthogClient: any = null;
	private debugLogging: boolean = false;
	private _currUserId: string | null = null;

	constructor() {
		const config = getConfig();
		this.debugLogging = config.BROWSER_USE_LOGGING_LEVEL === 'debug';

		const telemetryDisabled = !config.ANONYMIZED_TELEMETRY;

		if (telemetryDisabled) {
			this.posthogClient = null;
			console.debug('Telemetry disabled');
		} else {
			// Try to load PostHog client dynamically
			try {
				const PostHog = require('posthog-node').PostHog;
				console.log(
					'Using anonymized telemetry, see https://docs.browser-use.com/development/monitoring/telemetry.'
				);
				this.posthogClient = new PostHog(ProductTelemetry.PROJECT_API_KEY, {
					host: ProductTelemetry.HOST,
				});
			} catch {
				// PostHog not available - telemetry will be disabled
				console.debug('PostHog not installed, telemetry disabled');
				this.posthogClient = null;
			}
		}
	}

	/**
	 * Get singleton instance
	 */
	static getInstance(): ProductTelemetry {
		if (!_instance) {
			_instance = new ProductTelemetry();
		}
		return _instance;
	}

	/**
	 * Capture a telemetry event
	 */
	capture(event: BaseTelemetryEvent): void {
		if (!this.posthogClient) {
			return;
		}

		this._directCapture(event);
	}

	/**
	 * Direct capture implementation
	 */
	private _directCapture(event: BaseTelemetryEvent): void {
		if (!this.posthogClient) {
			return;
		}

		try {
			this.posthogClient.capture({
				distinctId: this.userId,
				event: event.name,
				properties: { ...event.properties, ...POSTHOG_EVENT_SETTINGS },
			});
		} catch (e: any) {
			console.error(`Failed to send telemetry event ${event.name}: ${e.message}`);
		}
	}

	/**
	 * Flush the telemetry queue
	 */
	async flush(): Promise<void> {
		if (this.posthogClient) {
			try {
				await this.posthogClient.flush();
				if (this.debugLogging) {
					console.debug('PostHog client telemetry queue flushed.');
				}
			} catch (e: any) {
				console.error(`Failed to flush PostHog client: ${e.message}`);
			}
		} else if (this.debugLogging) {
			console.debug('PostHog client not available, skipping flush.');
		}
	}

	/**
	 * Shutdown the telemetry client
	 */
	async shutdown(): Promise<void> {
		if (this.posthogClient) {
			try {
				await this.posthogClient.shutdown();
			} catch {
				// Ignore shutdown errors
			}
		}
	}

	/**
	 * Anonymous user id (shared device id)
	 */
	get userId(): string {
		if (this._currUserId) {
			return this._currUserId;
		}
		this._currUserId = getOrCreateDeviceId();
		return this._currUserId;
	}
}

// Export singleton getter
export function getProductTelemetry(): ProductTelemetry {
	return ProductTelemetry.getInstance();
}

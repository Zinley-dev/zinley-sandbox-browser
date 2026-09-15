/**
 * Permissions watchdog for granting browser permissions on connection
 * Port from browser_use/browser/watchdogs/permissions_watchdog.py
 */
import { EventEmitter } from 'events';
import { BrowserContext, CDPSession } from 'patchright';

export type PermissionType =
	| 'geolocation'
	| 'midi'
	| 'midi-sysex'
	| 'notifications'
	| 'camera'
	| 'microphone'
	| 'background-sync'
	| 'ambient-light-sensor'
	| 'accelerometer'
	| 'gyroscope'
	| 'magnetometer'
	| 'accessibility-events'
	| 'clipboard-read'
	| 'clipboard-write'
	| 'payment-handler'
	| 'idle-detection'
	| 'storage-access';

export interface PermissionsWatchdogOptions {
	/** Permissions to grant */
	permissions?: PermissionType[];
}

export class PermissionsWatchdog {
	private isRunning: boolean = false;
	private context: BrowserContext | null = null;
	private cdpSession: CDPSession | null = null;
	private permissions: PermissionType[];

	constructor(
		private eventBus: EventEmitter,
		options: PermissionsWatchdogOptions = {}
	) {
		this.permissions = options.permissions || [];
	}

	/**
	 * Set the browser context
	 */
	setContext(context: BrowserContext): void {
		this.context = context;
	}

	/**
	 * Set the CDP session for granting permissions
	 */
	setCDPSession(cdpSession: CDPSession): void {
		this.cdpSession = cdpSession;
	}

	/**
	 * Update permissions list
	 */
	setPermissions(permissions: PermissionType[]): void {
		this.permissions = permissions;
	}

	/**
	 * Grant permissions when browser connects
	 */
	async grantPermissions(): Promise<void> {
		if (!this.permissions || this.permissions.length === 0) {
			console.log('[PermissionsWatchdog] No permissions to grant');
			return;
		}

		console.log(`[PermissionsWatchdog] Granting browser permissions: ${this.permissions.join(', ')}`);

		try {
			// Try using Playwright's context API first
			if (this.context) {
				await this.context.grantPermissions(this.permissions);
				console.log(`[PermissionsWatchdog] Successfully granted permissions via context: ${this.permissions.join(', ')}`);
				return;
			}

			// Fall back to CDP if no context available
			if (this.cdpSession) {
				await this.grantPermissionsViaCDP();
				return;
			}

			console.warn('[PermissionsWatchdog] No context or CDP session available to grant permissions');

		} catch (error: any) {
			console.error(`[PermissionsWatchdog] Failed to grant permissions: ${error.message}`);
			// Don't raise - permissions are not critical to browser operation
		}
	}

	/**
	 * Grant permissions via CDP Browser.grantPermissions
	 */
	private async grantPermissionsViaCDP(): Promise<void> {
		if (!this.cdpSession) return;

		try {
			// Map permission types to CDP permission descriptors
			const cdpPermissions = this.permissions.map((p) => this.mapToCDPPermission(p));

			await this.cdpSession.send('Browser.grantPermissions', {
				permissions: cdpPermissions as any,
			});

			console.log(`[PermissionsWatchdog] Successfully granted permissions via CDP: ${this.permissions.join(', ')}`);

		} catch (error: any) {
			console.error(`[PermissionsWatchdog] Failed to grant permissions via CDP: ${error.message}`);
		}
	}

	/**
	 * Map Playwright permission type to CDP permission type
	 */
	private mapToCDPPermission(permission: PermissionType): string {
		const mapping: Record<PermissionType, string> = {
			'geolocation': 'geolocation',
			'midi': 'midi',
			'midi-sysex': 'midiSysex',
			'notifications': 'notifications',
			'camera': 'videoCapture',
			'microphone': 'audioCapture',
			'background-sync': 'backgroundSync',
			'ambient-light-sensor': 'sensors',
			'accelerometer': 'sensors',
			'gyroscope': 'sensors',
			'magnetometer': 'sensors',
			'accessibility-events': 'accessibilityEvents',
			'clipboard-read': 'clipboardReadWrite',
			'clipboard-write': 'clipboardReadWrite',
			'payment-handler': 'paymentHandler',
			'idle-detection': 'idleDetection',
			'storage-access': 'storageAccess',
		};

		return mapping[permission] || permission;
	}

	/**
	 * Start the watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;

		// Grant permissions on start
		await this.grantPermissions();

		console.log('[PermissionsWatchdog] Started');
	}

	/**
	 * Stop the watchdog
	 */
	async stop(): Promise<void> {
		this.isRunning = false;
		console.log('[PermissionsWatchdog] Stopped');
	}
}

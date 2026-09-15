/**
 * Screenshot watchdog for handling screenshot requests using CDP
 * Port from browser_use/browser/watchdogs/screenshot_watchdog.py
 */
import { EventEmitter } from 'events';
import { CDPSession } from 'patchright';
import { getLogger } from '../../logging_config.js';
import { BrowserEventNames, ScreenshotEvent } from '../events.js';

const logger = getLogger('browser-use.screenshot_watchdog');

export interface ScreenshotWatchdogOptions {
	/** Default screenshot format */
	format?: 'jpeg' | 'png' | 'webp';
	/** Default quality (1-100, for jpeg/webp) */
	quality?: number;
	/** Whether to capture beyond viewport */
	captureBeyondViewport?: boolean;
}

export class ScreenshotWatchdog {
	private isRunning: boolean = false;
	private cdpSession: CDPSession | null = null;
	private format: 'jpeg' | 'png' | 'webp';
	private quality: number;
	private captureBeyondViewport: boolean;

	constructor(
		private eventBus: EventEmitter,
		options: ScreenshotWatchdogOptions = {}
	) {
		this.format = options.format ?? 'jpeg';
		this.quality = options.quality ?? 60;
		this.captureBeyondViewport = options.captureBeyondViewport ?? false;
	}

	/**
	 * Set the CDP session to use for screenshots
	 */
	setCDPSession(cdpSession: CDPSession): void {
		this.cdpSession = cdpSession;
	}

	/**
	 * Handle screenshot request event
	 */
	async handleScreenshotEvent(event: ScreenshotEvent & { _eventId?: string }): Promise<string | null> {
		logger.debug('[ScreenshotWatchdog] Handler START - handleScreenshotEvent called');

		if (!this.cdpSession) {
			logger.error('[ScreenshotWatchdog] No CDP session available');
			throw new Error('No CDP session available for screenshot');
		}

		try {
			// Prepare screenshot parameters
			const params: Record<string, any> = {
				format: this.format,
				quality: this.format === 'png' ? undefined : this.quality,
				captureBeyondViewport: event.fullPage ?? this.captureBeyondViewport,
			};

			// Add clip if specified
			if (event.clip) {
				params.clip = {
					x: event.clip.x,
					y: event.clip.y,
					width: event.clip.width,
					height: event.clip.height,
					scale: 1,
				};
			}

			// Take screenshot using CDP
			logger.debug(`[ScreenshotWatchdog] Taking screenshot with params: ${JSON.stringify(params)}`);
			const result = await this.cdpSession.send('Page.captureScreenshot', params);

			// Return base64-encoded screenshot data
			if (result && result.data) {
				logger.debug('[ScreenshotWatchdog] Screenshot captured successfully');
				return result.data;
			}

			throw new Error('[ScreenshotWatchdog] Screenshot result missing data');
		} catch (error: any) {
			logger.error(`[ScreenshotWatchdog] Screenshot failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Start the watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;

		// Register event handler
		this.eventBus.on(BrowserEventNames.SCREENSHOT, async (event: ScreenshotEvent & { _eventId?: string }) => {
			try {
				const result = await this.handleScreenshotEvent(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		logger.debug('[ScreenshotWatchdog] Started monitoring');
	}

	/**
	 * Stop the watchdog
	 */
	async stop(): Promise<void> {
		this.isRunning = false;
		this.cdpSession = null;
		logger.debug('[ScreenshotWatchdog] Stopped monitoring');
	}
}

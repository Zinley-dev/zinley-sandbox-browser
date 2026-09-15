/**
 * About:blank watchdog for managing about:blank tabs with bouncing text animation.
 * Port from browser_use/browser/watchdogs/aboutblank_watchdog.py (239 lines)
 */
import { EventEmitter } from 'events';
import { CDPSession } from 'patchright';
import { getLogger } from '../../logging_config.js';
import { fontSizes } from '../../typography.js';
import {
	BrowserEventNames,
	TabCreatedEvent,
	TabClosedEvent,
	NavigateToUrlEvent,
	CloseTabEvent,
} from '../events.js';

const logger = getLogger('browser-use.about_blank_watchdog');

export interface AboutBlankAnimationShownEvent {
	targetId: string;
}

export interface AboutBlankWatchdogOptions {
	/** Label to show in the animation */
	browserSessionLabel?: string;
}

export class AboutBlankWatchdog {
	private isRunning: boolean = false;
	private stopping: boolean = false;
	private browserSessionLabel: string;
	private cdpSession: CDPSession | null = null;

	// Callbacks to access browser session methods
	private getAllPages: (() => Promise<Array<{ targetId: string; url: string }>>) | null = null;
	private getOrCreateCdpSession: ((targetId: string, focus?: boolean) => Promise<CDPSession>) | null = null;

	constructor(
		private eventBus: EventEmitter,
		options: AboutBlankWatchdogOptions = {}
	) {
		this.browserSessionLabel = options.browserSessionLabel ?? 'browser';
	}

	/**
	 * Set browser session methods for accessing pages and CDP sessions
	 */
	setBrowserMethods(
		getAllPages: () => Promise<Array<{ targetId: string; url: string }>>,
		getOrCreateCdpSession: (targetId: string, focus?: boolean) => Promise<CDPSession>
	): void {
		this.getAllPages = getAllPages;
		this.getOrCreateCdpSession = getOrCreateCdpSession;
	}

	/**
	 * Set the CDP session
	 */
	setCDPSession(cdpSession: CDPSession): void {
		this.cdpSession = cdpSession;
	}

	/**
	 * Start the about blank watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;
		this.stopping = false;

		// Listen for browser stop events
		this.eventBus.on(BrowserEventNames.BROWSER_STOP, this.handleBrowserStop.bind(this));
		this.eventBus.on(BrowserEventNames.BROWSER_STOPPED, this.handleBrowserStopped.bind(this));

		// Listen for tab events
		this.eventBus.on(BrowserEventNames.TAB_CREATED, this.handleTabCreated.bind(this));
		this.eventBus.on(BrowserEventNames.TAB_CLOSED, this.handleTabClosed.bind(this));

		logger.debug('[AboutBlankWatchdog] Started');
	}

	/**
	 * Stop the about blank watchdog
	 */
	async stop(): Promise<void> {
		if (!this.isRunning) return;
		this.isRunning = false;
		this.stopping = true;

		// Remove event listeners
		this.eventBus.removeAllListeners(BrowserEventNames.BROWSER_STOP);
		this.eventBus.removeAllListeners(BrowserEventNames.BROWSER_STOPPED);
		this.eventBus.removeAllListeners(BrowserEventNames.TAB_CREATED);
		this.eventBus.removeAllListeners(BrowserEventNames.TAB_CLOSED);

		logger.debug('[AboutBlankWatchdog] Stopped');
	}

	/**
	 * Handle browser stop request
	 */
	private async handleBrowserStop(): Promise<void> {
		logger.debug('[AboutBlankWatchdog] Browser stop requested, stopping tab creation');
		this.stopping = true;
	}

	/**
	 * Handle browser stopped event
	 */
	private async handleBrowserStopped(): Promise<void> {
		logger.debug('[AboutBlankWatchdog] Browser stopped');
		this.stopping = true;
	}

	/**
	 * Handle tab created event
	 */
	private async handleTabCreated(event: TabCreatedEvent): Promise<void> {
		logger.debug(`[AboutBlankWatchdog] New tab created: ${event.url}`);

		// If an about:blank tab was created, show text animation on all about:blank tabs
		if (event.url === 'about:blank') {
			await this.showTextAnimationOnAboutBlankTabs();
		}
	}

	/**
	 * Handle tab closed event
	 */
	private async handleTabClosed(event: TabClosedEvent): Promise<void> {
		logger.debug('[AboutBlankWatchdog] Tab closing, checking if we need to create about:blank tab');

		// Don't create new tabs if browser is shutting down
		if (this.stopping) {
			logger.debug('[AboutBlankWatchdog] Browser is stopping, not creating new tabs');
			return;
		}

		if (!this.getAllPages) {
			logger.debug('[AboutBlankWatchdog] No getAllPages method available');
			return;
		}

		try {
			// Check if we're about to close the last tab
			const pageTargets = await this.getAllPages();
			if (pageTargets.length <= 1) {
				logger.debug('[AboutBlankWatchdog] Last tab closing, creating new about:blank tab');

				// Create new about:blank tab
				this.eventBus.emit(BrowserEventNames.NAVIGATE_TO_URL, {
					url: 'about:blank',
					newTab: true,
				} as NavigateToUrlEvent);

				// Show text animation on the new tab
				await this.showTextAnimationOnAboutBlankTabs();
			} else {
				// Multiple tabs exist, check after close
				await this.checkAndEnsureAboutBlankTab();
			}
		} catch (error) {
			logger.error(`[AboutBlankWatchdog] Error handling tab closed: ${error}`);
		}
	}

	/**
	 * Check current tabs and ensure exactly one about:blank tab with animation exists
	 */
	private async checkAndEnsureAboutBlankTab(): Promise<void> {
		if (!this.getAllPages) return;

		try {
			const pageTargets = await this.getAllPages();

			// If no tabs exist at all, create one to keep browser alive
			if (pageTargets.length === 0) {
				logger.debug('[AboutBlankWatchdog] No tabs exist, creating new about:blank tab');

				this.eventBus.emit(BrowserEventNames.NAVIGATE_TO_URL, {
					url: 'about:blank',
					newTab: true,
				} as NavigateToUrlEvent);

				// Show text animation on the new tab
				await this.showTextAnimationOnAboutBlankTabs();
			}
			// Otherwise there are tabs, don't create new ones to avoid interfering

		} catch (error) {
			logger.error(`[AboutBlankWatchdog] Error ensuring about:blank tab: ${error}`);
		}
	}

	/**
	 * Show text animation on all about:blank pages only
	 */
	private async showTextAnimationOnAboutBlankTabs(): Promise<void> {
		if (!this.getAllPages || !this.getOrCreateCdpSession) return;

		try {
			const pageTargets = await this.getAllPages();
			const label = this.browserSessionLabel.slice(-4);

			for (const pageTarget of pageTargets) {
				// Only target about:blank pages specifically
				if (pageTarget.url === 'about:blank') {
					await this.showTextAnimationCDP(pageTarget.targetId, label);
				}
			}
		} catch (error) {
			logger.error(`[AboutBlankWatchdog] Error showing text animation: ${error}`);
		}
	}

	/**
	 * Inject a bouncing text animation overlay into the target using CDP
	 */
	private async showTextAnimationCDP(targetId: string, browserSessionLabel: string): Promise<void> {
		if (!this.getOrCreateCdpSession) return;

		try {
			// Create temporary session for this target without switching focus
			const tempSession = await this.getOrCreateCdpSession(targetId, false);

			// Inject the text animation script
			const script = `
				(function(browser_session_label) {
					// Idempotency check
					if (window.__bounceAnimationRunning) {
						return; // Already running, don't add another
					}
					window.__bounceAnimationRunning = true;

					// Ensure document.body exists before proceeding
					if (!document.body) {
						// Try again after DOM is ready
						window.__bounceAnimationRunning = false; // Reset flag to retry
						if (document.readyState === 'loading') {
							document.addEventListener('DOMContentLoaded', () => arguments.callee(browser_session_label));
						}
						return;
					}

					const animated_title = 'Browser-Use is waking up...';
					if (document.title === animated_title) {
						return; // already run on this tab, don't run again
					}
					document.title = animated_title;

					// Create clean minimal overlay
					const loadingOverlay = document.createElement('div');
					loadingOverlay.id = 'pretty-loading-animation';
					loadingOverlay.style.position = 'fixed';
					loadingOverlay.style.top = '0';
					loadingOverlay.style.left = '0';
					loadingOverlay.style.width = '100vw';
					loadingOverlay.style.height = '100vh';
					loadingOverlay.style.background = '#000000';
					loadingOverlay.style.zIndex = '99999';
					loadingOverlay.style.overflow = 'hidden';
					loadingOverlay.style.display = 'flex';
					loadingOverlay.style.alignItems = 'center';
					loadingOverlay.style.justifyContent = 'center';

					// Create minimal glass container
					const glassContainer = document.createElement('div');
					glassContainer.style.padding = '32px 64px';
					glassContainer.style.background = 'rgba(255, 255, 255, 0.04)';
					glassContainer.style.backdropFilter = 'blur(20px)';
					glassContainer.style.webkitBackdropFilter = 'blur(20px)';
					glassContainer.style.borderRadius = '20px';
					glassContainer.style.border = '0.5px solid rgba(255, 255, 255, 0.08)';
					glassContainer.style.boxShadow = '0 4px 24px rgba(0, 0, 0, 0.2)';

					// Create the text element
					const textElement = document.createElement('div');
					textElement.textContent = 'Browser-Use';
					textElement.style.fontSize = '${fontSizes['6xl']}';
					textElement.style.fontWeight = '600';
					textElement.style.fontFamily = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
					textElement.style.color = '#ffffff';
					textElement.style.letterSpacing = '-0.02em';
					textElement.style.userSelect = 'none';
					textElement.style.pointerEvents = 'none';
					textElement.style.opacity = '0.92';

					glassContainer.appendChild(textElement);
					loadingOverlay.appendChild(glassContainer);
					document.body.appendChild(loadingOverlay);

					// Subtle breathing animation
					let opacity = 0.92;
					let increasing = false;
					function breathe() {
						if (increasing) {
							opacity += 0.002;
							if (opacity >= 1) increasing = false;
						} else {
							opacity -= 0.002;
							if (opacity <= 0.7) increasing = true;
						}
						textElement.style.opacity = opacity.toFixed(3);
						requestAnimationFrame(breathe);
					}
					breathe();

					// Minimal CSS for smoothness
					const style = document.createElement('style');
					style.textContent = \`
						@supports (backdrop-filter: blur(20px)) or (-webkit-backdrop-filter: blur(20px)) {
							#pretty-loading-animation {
								-webkit-font-smoothing: antialiased;
								-moz-osx-font-smoothing: grayscale;
							}
						}
					\`;
					document.head.appendChild(style);
				})('${browserSessionLabel}');
			`;

			await tempSession.send('Runtime.evaluate', { expression: script });

			// Emit event
			this.eventBus.emit('about_blank_animation_shown', {
				targetId,
			} as AboutBlankAnimationShownEvent);

		} catch (error) {
			logger.error(`[AboutBlankWatchdog] Error injecting text animation: ${error}`);
		}
	}

	/**
	 * Attach to a target (AboutBlankWatchdog doesn't monitor individual targets)
	 */
	async attachToTarget(targetId: string): Promise<void> {
		// AboutBlankWatchdog doesn't monitor individual targets
	}
}

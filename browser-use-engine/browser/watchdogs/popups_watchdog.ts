/**
 * Popups watchdog for handling JavaScript dialogs (alert, confirm, prompt)
 * Port from browser_use/browser/watchdogs/popups_watchdog.py
 */
import { EventEmitter } from 'events';
import { Page, Dialog, CDPSession } from 'patchright';

export interface PopupsWatchdogOptions {
	/** Auto-accept dialogs */
	autoAccept?: boolean;
	/** Default text for prompt dialogs */
	defaultPromptText?: string;
}

export class PopupsWatchdog {
	private isRunning: boolean = false;
	private page: Page | null = null;
	private autoAccept: boolean;
	private defaultPromptText: string;
	private dialogListenersRegistered: Set<string> = new Set();

	constructor(
		private eventBus: EventEmitter,
		options: PopupsWatchdogOptions = {}
	) {
		this.autoAccept = options.autoAccept ?? true;
		this.defaultPromptText = options.defaultPromptText ?? '';
	}

	/**
	 * Set the page to monitor
	 */
	setPage(page: Page): void {
		this.page = page;
		this.setupDialogListeners();
	}

	/**
	 * Set up dialog event listeners using Playwright API
	 */
	private setupDialogListeners(): void {
		if (!this.page) return;

		// Listen for dialogs using Playwright's built-in API
		this.page.on('dialog', async (dialog: Dialog) => {
			await this.handleDialog(dialog);
		});
	}

	/**
	 * Set up dialog handling via CDP session (for more control)
	 */
	async setupCDPDialogHandling(cdpSession: CDPSession, targetId?: string): Promise<void> {
		try {
			const id = targetId || 'default';
			if (this.dialogListenersRegistered.has(id)) {
				return;
			}

			// Enable page events
			await cdpSession.send('Page.enable').catch(() => {});

			// Listen for JavaScript dialogs via CDP
			cdpSession.on('Page.javascriptDialogOpening', async (event: any) => {
				await this.handleCDPDialog(cdpSession, event);
			});

			this.dialogListenersRegistered.add(id);
			console.log(`[PopupsWatchdog] Set up dialog handling for target ${id}`);

		} catch (error: any) {
			console.warn(`[PopupsWatchdog] Failed to set up CDP dialog handling: ${error.message}`);
		}
	}

	/**
	 * Handle dialog using Playwright API
	 */
	private async handleDialog(dialog: Dialog): Promise<void> {
		const dialogType = dialog.type();
		const message = dialog.message();

		console.log(`[PopupsWatchdog] JavaScript ${dialogType} dialog: "${message.substring(0, 100)}"`);

		this.eventBus.emit('dialog:opened', {
			type: dialogType,
			message,
		});

		if (this.autoAccept) {
			try {
				if (dialogType === 'prompt') {
					await dialog.accept(this.defaultPromptText);
				} else {
					await dialog.accept();
				}
				console.log(`[PopupsWatchdog] Accepted ${dialogType} dialog`);

				this.eventBus.emit('dialog:accepted', {
					type: dialogType,
					message,
				});
			} catch (error: any) {
				console.error(`[PopupsWatchdog] Failed to accept dialog: ${error.message}`);
			}
		}
	}

	/**
	 * Handle dialog via CDP
	 */
	private async handleCDPDialog(cdpSession: CDPSession, event: any): Promise<void> {
		const dialogType = event.type || 'alert';
		const message = event.message || '';

		console.log(`[PopupsWatchdog] CDP JavaScript ${dialogType} dialog: "${message.substring(0, 100)}"`);

		this.eventBus.emit('dialog:opened', {
			type: dialogType,
			message,
			url: event.url,
			hasBrowserHandler: event.hasBrowserHandler,
		});

		if (this.autoAccept) {
			try {
				await cdpSession.send('Page.handleJavaScriptDialog', {
					accept: true,
					promptText: dialogType === 'prompt' ? this.defaultPromptText : undefined,
				});

				console.log(`[PopupsWatchdog] CDP accepted ${dialogType} dialog`);

				this.eventBus.emit('dialog:accepted', {
					type: dialogType,
					message,
				});
			} catch (error: any) {
				console.error(`[PopupsWatchdog] Failed to handle CDP dialog: ${error.message}`);
			}
		}
	}

	/**
	 * Start the watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;
		console.log('[PopupsWatchdog] Started monitoring');
	}

	/**
	 * Stop the watchdog
	 */
	async stop(): Promise<void> {
		this.isRunning = false;
		this.dialogListenersRegistered.clear();
		console.log('[PopupsWatchdog] Stopped monitoring');
	}
}

/**
 * Downloads watchdog for handling file downloads
 * Port from browser_use/browser/watchdogs/downloads_watchdog.py
 */
import { EventEmitter } from 'events';
import { Page, Download } from 'patchright';
import path from 'path';
import fs from 'fs';

export interface DownloadInfo {
	id: string;
	url: string;
	suggestedFilename: string;
	savedPath?: string;
	status: 'pending' | 'completed' | 'failed' | 'cancelled';
	error?: string;
	startTime: Date;
	endTime?: Date;
	totalBytes?: number;
}

export interface DownloadsWatchdogOptions {
	/** Directory to save downloads */
	downloadsPath?: string;
	/** Auto-accept downloads */
	autoAccept?: boolean;
	/** Maximum concurrent downloads */
	maxConcurrent?: number;
	/** Download timeout in ms */
	timeout?: number;
}

export class DownloadsWatchdog {
	private downloads: Map<string, DownloadInfo> = new Map();
	private pendingDownloads: Set<string> = new Set();
	private downloadsPath: string;
	private autoAccept: boolean;
	private maxConcurrent: number;
	private timeout: number;
	private page: Page | null = null;
	private isRunning: boolean = false;

	constructor(
		private eventBus: EventEmitter,
		options: DownloadsWatchdogOptions = {}
	) {
		this.downloadsPath = options.downloadsPath || './downloads';
		this.autoAccept = options.autoAccept ?? true;
		this.maxConcurrent = options.maxConcurrent ?? 5;
		this.timeout = options.timeout ?? 60000;
	}

	/**
	 * Set the page to monitor
	 */
	setPage(page: Page): void {
		this.page = page;
		this.setupDownloadListeners();
	}

	/**
	 * Set up download event listeners
	 */
	private setupDownloadListeners(): void {
		if (!this.page) return;

		this.page.on('download', async (download: Download) => {
			const downloadId = `download_${Date.now()}_${Math.random().toString(36).substring(7)}`;

			const info: DownloadInfo = {
				id: downloadId,
				url: download.url(),
				suggestedFilename: download.suggestedFilename(),
				status: 'pending',
				startTime: new Date(),
			};

			this.downloads.set(downloadId, info);
			this.pendingDownloads.add(downloadId);

			// Emit download started event
			this.eventBus.emit('download:started', info);

			if (this.autoAccept) {
				try {
					// Ensure downloads directory exists
					if (!fs.existsSync(this.downloadsPath)) {
						fs.mkdirSync(this.downloadsPath, { recursive: true });
					}

					// Save the download
					const savePath = path.join(this.downloadsPath, download.suggestedFilename());
					await download.saveAs(savePath);

					info.savedPath = savePath;
					info.status = 'completed';
					info.endTime = new Date();

					// Emit download completed event
					this.eventBus.emit('download:completed', info);
				} catch (error: any) {
					info.status = 'failed';
					info.error = error.message;
					info.endTime = new Date();

					// Emit download failed event
					this.eventBus.emit('download:failed', info);
				}
			}

			this.pendingDownloads.delete(downloadId);
		});
	}

	/**
	 * Start the watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;

		// Ensure downloads directory exists
		if (!fs.existsSync(this.downloadsPath)) {
			fs.mkdirSync(this.downloadsPath, { recursive: true });
		}
	}

	/**
	 * Stop the watchdog
	 */
	async stop(): Promise<void> {
		this.isRunning = false;
	}

	/**
	 * Get all downloads
	 */
	getDownloads(): DownloadInfo[] {
		return Array.from(this.downloads.values());
	}

	/**
	 * Get pending downloads
	 */
	getPendingDownloads(): DownloadInfo[] {
		return Array.from(this.downloads.values()).filter((d) => d.status === 'pending');
	}

	/**
	 * Get completed downloads
	 */
	getCompletedDownloads(): DownloadInfo[] {
		return Array.from(this.downloads.values()).filter((d) => d.status === 'completed');
	}

	/**
	 * Check if there are pending downloads
	 */
	hasPendingDownloads(): boolean {
		return this.pendingDownloads.size > 0;
	}

	/**
	 * Wait for all pending downloads to complete
	 */
	async waitForDownloads(timeout?: number): Promise<boolean> {
		const maxWait = timeout ?? this.timeout;
		const startTime = Date.now();

		while (this.hasPendingDownloads()) {
			if (Date.now() - startTime > maxWait) {
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		return true;
	}

	/**
	 * Clear download history
	 */
	clearHistory(): void {
		this.downloads.clear();
		this.pendingDownloads.clear();
	}
}

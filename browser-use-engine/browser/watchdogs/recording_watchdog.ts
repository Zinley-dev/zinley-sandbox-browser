/**
 * Recording Watchdog for Browser Use Sessions
 * Port from browser_use/browser/watchdogs/recording_watchdog.py
 */
import { EventEmitter } from 'events';
import { Page, CDPSession } from 'patchright';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

export interface ViewportSize {
	width: number;
	height: number;
}

export interface RecordingWatchdogOptions {
	/** Directory to save recordings */
	recordVideoDir?: string;
	/** Video size (width x height) */
	recordVideoSize?: ViewportSize;
	/** Video framerate */
	recordVideoFramerate?: number;
	/** Video format (mp4, webm) */
	recordVideoFormat?: string;
}

export class RecordingWatchdog {
	private isRunning: boolean = false;
	private page: Page | null = null;
	private cdpSession: CDPSession | null = null;
	private recorder: VideoRecorderService | null = null;
	// Stored so the CDP 'Page.screencastFrame' listener can be detached on stop
	// (leaving it attached leaks the closure + buffered frames across start/stop cycles).
	private _screencastFrameHandler: ((event: any) => void) | null = null;
	private recordVideoDir: string | null;
	private recordVideoSize: ViewportSize | null;
	private recordVideoFramerate: number;
	private recordVideoFormat: string;

	constructor(
		private eventBus: EventEmitter,
		options: RecordingWatchdogOptions = {}
	) {
		this.recordVideoDir = options.recordVideoDir || null;
		this.recordVideoSize = options.recordVideoSize || null;
		this.recordVideoFramerate = options.recordVideoFramerate ?? 10;
		this.recordVideoFormat = options.recordVideoFormat ?? 'mp4';
	}

	/**
	 * Set the page to record
	 */
	setPage(page: Page): void {
		this.page = page;
	}

	/**
	 * Set the CDP session for screencast
	 */
	setCDPSession(cdpSession: CDPSession): void {
		this.cdpSession = cdpSession;
	}

	/**
	 * Get current viewport size from page
	 */
	private async getCurrentViewportSize(): Promise<ViewportSize | null> {
		if (!this.page) return null;

		try {
			const viewport = this.page.viewportSize();
			if (viewport) {
				console.log(`[RecordingWatchdog] Detected viewport size: ${viewport.width}x${viewport.height}`);
				return { width: viewport.width, height: viewport.height };
			}
		} catch (error: any) {
			console.warn(`[RecordingWatchdog] Failed to get viewport size: ${error.message}`);
		}

		return null;
	}

	/**
	 * Start recording
	 */
	async startRecording(): Promise<void> {
		if (!this.recordVideoDir) {
			return;
		}

		// Dynamically determine video size
		let size = this.recordVideoSize;
		if (!size) {
			console.log('[RecordingWatchdog] record_video_size not specified, detecting viewport size...');
			size = await this.getCurrentViewportSize();
		}

		if (!size) {
			console.warn('[RecordingWatchdog] Cannot start video recording: viewport size could not be determined.');
			return;
		}

		// Create output path
		const videoId = uuidv4();
		const outputPath = path.join(this.recordVideoDir, `${videoId}.${this.recordVideoFormat}`);

		console.log(`[RecordingWatchdog] Initializing video recorder for format: ${this.recordVideoFormat}`);

		this.recorder = new VideoRecorderService({
			outputPath,
			size,
			framerate: this.recordVideoFramerate,
		});

		this.recorder.start();

		if (!this.recorder.isActive) {
			this.recorder = null;
			return;
		}

		// Set up CDP screencast
		if (this.cdpSession) {
			try {
				// Listen for screencast frames (store handler so we can detach on stop)
				this._screencastFrameHandler = (event: any) => {
					this.onScreencastFrame(event);
				};
				this.cdpSession.on('Page.screencastFrame', this._screencastFrameHandler);

				// Start screencast
				await this.cdpSession.send('Page.startScreencast', {
					format: 'png',
					quality: 90,
					maxWidth: size.width,
					maxHeight: size.height,
					everyNthFrame: 1,
				});

				console.log(`[RecordingWatchdog] Started video recording to ${outputPath}`);
			} catch (error: any) {
				console.error(`[RecordingWatchdog] Failed to start screencast via CDP: ${error.message}`);
				if (this.recorder) {
					this.recorder.stopAndSave();
					this.recorder = null;
				}
			}
		}
	}

	/**
	 * Handle screencast frame
	 */
	private onScreencastFrame(event: any): void {
		if (!this.recorder) return;

		this.recorder.addFrame(event.data);

		// Acknowledge the frame
		this.ackScreencastFrame(event.sessionId);
	}

	/**
	 * Acknowledge screencast frame
	 */
	private async ackScreencastFrame(sessionId: number): Promise<void> {
		if (!this.cdpSession) return;

		try {
			await this.cdpSession.send('Page.screencastFrameAck', {
				sessionId,
			});
		} catch (error: any) {
			console.debug(`[RecordingWatchdog] Failed to acknowledge screencast frame: ${error.message}`);
		}
	}

	/**
	 * Stop recording
	 */
	async stopRecording(): Promise<void> {
		if (this.recorder) {
			const recorder = this.recorder;
			this.recorder = null;

			console.log('[RecordingWatchdog] Stopping video recording and saving file...');

			// Stop screencast and detach the frame listener (prevents leak)
			if (this.cdpSession) {
				try {
					if (this._screencastFrameHandler) {
						this.cdpSession.off('Page.screencastFrame', this._screencastFrameHandler);
						this._screencastFrameHandler = null;
					}
					await this.cdpSession.send('Page.stopScreencast');
				} catch (error: any) {
					// Ignore errors
				}
			}

			// Stop and save recording
			recorder.stopAndSave();
		}
	}

	/**
	 * Start the watchdog
	 */
	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;

		await this.startRecording();

		console.log('[RecordingWatchdog] Started');
	}

	/**
	 * Stop the watchdog
	 */
	async stop(): Promise<void> {
		this.isRunning = false;

		await this.stopRecording();

		console.log('[RecordingWatchdog] Stopped');
	}
}

/**
 * Simple video recorder service using collected frames
 */
export interface VideoRecorderOptions {
	outputPath: string;
	size: ViewportSize;
	framerate: number;
}

export class VideoRecorderService {
	private outputPath: string;
	private size: ViewportSize;
	private framerate: number;
	private frames: string[] = [];
	private _isActive: boolean = false;

	constructor(options: VideoRecorderOptions) {
		this.outputPath = options.outputPath;
		this.size = options.size;
		this.framerate = options.framerate;
	}

	get isActive(): boolean {
		return this._isActive;
	}

	/**
	 * Start the recorder
	 */
	start(): void {
		try {
			// Ensure output directory exists
			const dir = path.dirname(this.outputPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			this._isActive = true;
			console.log(`[VideoRecorderService] Started. Output will be saved to ${this.outputPath}`);
		} catch (error: any) {
			console.error(`[VideoRecorderService] Failed to initialize: ${error.message}`);
			this._isActive = false;
		}
	}

	/**
	 * Add a frame (base64 encoded PNG)
	 */
	addFrame(frameDataB64: string): void {
		if (!this._isActive) return;
		this.frames.push(frameDataB64);
	}

	/**
	 * Stop and save the recording
	 */
	stopAndSave(): void {
		if (!this._isActive) return;

		try {
			// For now, save frames as individual PNGs
			// A full implementation would use ffmpeg to combine into video
			const framesDir = this.outputPath.replace(/\.[^.]+$/, '_frames');
			fs.mkdirSync(framesDir, { recursive: true });

			for (let i = 0; i < this.frames.length; i++) {
				const frameBuffer = Buffer.from(this.frames[i], 'base64');
				const framePath = path.join(framesDir, `frame_${String(i).padStart(6, '0')}.png`);
				fs.writeFileSync(framePath, frameBuffer);
			}

			console.log(`[VideoRecorderService] Saved ${this.frames.length} frames to ${framesDir}`);

			// Create a simple HTML viewer
			const viewerPath = path.join(framesDir, 'viewer.html');
			const viewerHtml = `
<!DOCTYPE html>
<html>
<head>
	<title>Recording Playback</title>
	<style>
		body { margin: 0; background: #000; display: flex; justify-content: center; align-items: center; height: 100vh; }
		img { max-width: 100%; max-height: 100%; }
	</style>
</head>
<body>
	<img id="frame" src="frame_000000.png">
	<script>
		const frameCount = ${this.frames.length};
		const framerate = ${this.framerate};
		let currentFrame = 0;
		const img = document.getElementById('frame');

		setInterval(() => {
			currentFrame = (currentFrame + 1) % frameCount;
			img.src = 'frame_' + String(currentFrame).padStart(6, '0') + '.png';
		}, 1000 / framerate);
	</script>
</body>
</html>
`;
			fs.writeFileSync(viewerPath, viewerHtml);
			console.log(`[VideoRecorderService] Created viewer at ${viewerPath}`);

		} catch (error: any) {
			console.error(`[VideoRecorderService] Failed to save: ${error.message}`);
		} finally {
			this._isActive = false;
			this.frames = [];
		}
	}
}

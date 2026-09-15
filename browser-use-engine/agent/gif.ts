/**
 * Agent GIF generation
 * Port from browser_use/agent/gif.py (425 lines)
 *
 * Creates a GIF from the agent's history with overlaid task and goal text.
 *
 * Note: For native GIF generation, install optional dependencies:
 *   npm install sharp gif-encoder-2
 */

import { AgentHistory } from '../types/agent.js';
import { AgentHistoryList } from './views.js';
import { PLACEHOLDER_4PX_SCREENSHOT, getScreenshot } from '../browser/views.js';
import { fontSizes, gifFontSizes } from '../typography.js';
import * as fs from 'fs';
import * as path from 'path';

// Re-export for backward compatibility
export { AgentHistoryList };

// Dynamic import helper to avoid TypeScript compilation errors for optional dependencies
async function dynamicImport(moduleName: string): Promise<any> {
	try {
		return await import(/* webpackIgnore: true */ moduleName);
	} catch {
		throw new Error(`Module '${moduleName}' not available. Install with: npm install ${moduleName}`);
	}
}

// Utility function to check if a URL is a new tab page
function isNewTabPage(url: string): boolean {
	if (!url) return false;
	const newTabPatterns = [
		'about:blank',
		'chrome://newtab',
		'chrome://new-tab-page',
		'edge://newtab',
		'about:newtab',
		'about:home',
	];
	return newTabPatterns.some((pattern) => url.toLowerCase().startsWith(pattern.toLowerCase()));
}

/**
 * Handle decoding any unicode escape sequences embedded in a string
 * (needed to render non-ASCII languages like Chinese or Arabic in the GIF overlay text)
 */
function decodeUnicodeEscapesToUtf8(text: string): string {
	if (!text.includes('\\u')) {
		return text;
	}

	try {
		// Try to decode Unicode escape sequences
		return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
			return String.fromCharCode(parseInt(hex, 16));
		});
	} catch {
		return text;
	}
}

/**
 * Create history GIF options
 */
export interface CreateHistoryGifOptions {
	task: string;
	history: AgentHistoryList;
	outputPath?: string;
	duration?: number; // Frame duration in milliseconds
	showGoals?: boolean;
	showTask?: boolean;
	showLogo?: boolean;
	fontSize?: number;
	titleFontSize?: number;
	goalFontSize?: number;
	margin?: number;
	lineSpacing?: number;
}

/**
 * Get screenshots from history
 * Handles both screenshotPath (from browser/views) and screenshot (from types/agent)
 */
async function getScreenshots(
	history: AgentHistoryList,
	returnNoneIfNotScreenshot: boolean = false
): Promise<(string | null)[]> {
	const screenshots: (string | null)[] = [];

	for (const item of history.history) {
		const state = item.state as any; // Handle both state structures
		const screenshotPath = state.screenshotPath;
		const screenshotBase64 = state.screenshot;

		if (screenshotPath) {
			// Load from file path
			const screenshot = await getScreenshot(screenshotPath);
			screenshots.push(screenshot);
		} else if (screenshotBase64) {
			// Already base64 encoded
			screenshots.push(screenshotBase64);
		} else if (returnNoneIfNotScreenshot) {
			screenshots.push(null);
		}
	}

	return screenshots;
}

/**
 * Create a GIF from the agent's history with overlaid task and goal text.
 *
 * This is a simplified implementation that creates an HTML file with all screenshots
 * as an alternative to generating an actual GIF. For full GIF support, install
 * additional dependencies like 'gif-encoder-2' and 'sharp'.
 */
export async function createHistoryGif(options: CreateHistoryGifOptions): Promise<void> {
	const {
		task,
		history,
		outputPath = 'agent_history.gif',
		duration = 3000,
		showGoals = true,
		showTask = true,
		showLogo = false,
		fontSize = gifFontSizes.text,
		titleFontSize = gifFontSizes.title,
		goalFontSize = gifFontSizes.goal,
		margin = 40,
		lineSpacing = 1.5,
	} = options;

	if (!history.history || history.history.length === 0) {
		console.warn('[GIF] No history to create GIF from');
		return;
	}

	// Get all screenshots from history (including null placeholders)
	const screenshots = await getScreenshots(history, true);

	if (!screenshots || screenshots.length === 0) {
		console.warn('[GIF] No screenshots found in history');
		return;
	}

	// Find the first non-placeholder screenshot
	let firstRealScreenshot: string | null = null;
	for (const screenshot of screenshots) {
		if (screenshot && screenshot !== PLACEHOLDER_4PX_SCREENSHOT) {
			firstRealScreenshot = screenshot;
			break;
		}
	}

	if (!firstRealScreenshot) {
		console.warn('[GIF] No valid screenshots found (all are placeholders or from new tab pages)');
		return;
	}

	// Try to use native GIF generation if available
	try {
		await createNativeGif({
			task,
			history,
			screenshots,
			firstRealScreenshot,
			outputPath,
			duration,
			showGoals,
			showTask,
			showLogo,
			fontSize,
			titleFontSize,
			goalFontSize,
			margin,
			lineSpacing,
		});
		console.info(`[GIF] Created GIF at ${outputPath}`);
	} catch (error: any) {
		// Fall back to HTML viewer if native GIF generation fails
		console.warn(`[GIF] Native GIF generation failed: ${error.message}`);
		console.info('[GIF] Falling back to HTML viewer');

		await createHtmlViewer({
			task,
			history,
			screenshots,
			outputPath: outputPath.replace('.gif', '.html'),
			duration,
			showGoals,
			showTask,
		});
	}
}

/**
 * Native GIF generation options
 */
interface NativeGifOptions {
	task: string;
	history: AgentHistoryList;
	screenshots: (string | null)[];
	firstRealScreenshot: string;
	outputPath: string;
	duration: number;
	showGoals: boolean;
	showTask: boolean;
	showLogo: boolean;
	fontSize: number;
	titleFontSize: number;
	goalFontSize: number;
	margin: number;
	lineSpacing: number;
}

/**
 * Create native GIF using sharp and gif-encoder-2
 */
async function createNativeGif(options: NativeGifOptions): Promise<void> {
	const {
		task,
		history,
		screenshots,
		firstRealScreenshot,
		outputPath,
		duration,
		showGoals,
		showTask,
		fontSize,
		titleFontSize,
		margin,
		lineSpacing,
	} = options;

	// Dynamic import of sharp
	let sharp: any;
	try {
		const sharpModule = await dynamicImport('sharp');
		sharp = sharpModule.default || sharpModule;
	} catch (e: any) {
		throw new Error(`sharp library not available: ${e.message}`);
	}

	// Dynamic import of gif-encoder-2
	let GIFEncoder: any;
	try {
		const gifModule = await dynamicImport('gif-encoder-2');
		GIFEncoder = gifModule.default || gifModule;
	} catch (e: any) {
		throw new Error(`gif-encoder-2 library not available: ${e.message}`);
	}

	// Get image dimensions from first real screenshot
	const firstImageBuffer = Buffer.from(firstRealScreenshot, 'base64');
	const metadata = await sharp(firstImageBuffer).metadata();
	const width = metadata.width || 1920;
	const height = metadata.height || 1080;

	// Create GIF encoder
	const encoder = new GIFEncoder(width, height, 'neuquant', true);
	encoder.setDelay(duration);
	encoder.setRepeat(0); // Infinite loop
	encoder.setQuality(10);
	encoder.start();

	const frames: Buffer[] = [];

	// Create task frame if requested
	if (showTask && task) {
		const taskFrame = await createTaskFrame(sharp, task, firstRealScreenshot, width, height, fontSize, margin);
		frames.push(taskFrame);
	}

	// Process each history item with its corresponding screenshot
	let stepNumber = 0;
	for (let i = 0; i < history.history.length; i++) {
		const item = history.history[i];
		const screenshot = screenshots[i];

		if (!screenshot) {
			continue;
		}

		// Skip placeholder screenshots from about:blank pages
		if (screenshot === PLACEHOLDER_4PX_SCREENSHOT) {
			console.debug(`[GIF] Skipping placeholder screenshot from about:blank page at step ${i + 1}`);
			continue;
		}

		// Skip screenshots from new tab pages
		if (isNewTabPage(item.state.url)) {
			console.debug(`[GIF] Skipping screenshot from new tab page (${item.state.url}) at step ${i + 1}`);
			continue;
		}

		stepNumber++;

		// Convert base64 screenshot to buffer
		const imageBuffer = Buffer.from(screenshot, 'base64');

		if (showGoals && item.modelOutput) {
			const goalText = (item.modelOutput as any).currentState?.nextGoal || item.modelOutput.nextGoal || '';
			const frameBuffer = await addOverlayToImage(
				sharp,
				imageBuffer,
				stepNumber,
				goalText,
				width,
				height,
				fontSize,
				titleFontSize,
				margin
			);
			frames.push(frameBuffer);
		} else {
			// Ensure image is in correct format for GIF
			const frameBuffer = await sharp(imageBuffer).resize(width, height, { fit: 'fill' }).raw().toBuffer();
			frames.push(frameBuffer);
		}
	}

	if (frames.length === 0) {
		console.warn('[GIF] No valid frames to create GIF');
		return;
	}

	// Add frames to encoder
	for (const frame of frames) {
		encoder.addFrame(frame);
	}

	encoder.finish();

	// Write GIF to file
	const gifBuffer = encoder.out.getData();
	fs.writeFileSync(outputPath, gifBuffer);
}

/**
 * Create task frame with centered text
 */
async function createTaskFrame(
	sharp: any,
	task: string,
	firstScreenshot: string,
	width: number,
	height: number,
	fontSize: number,
	margin: number
): Promise<Buffer> {
	// Create black background
	const background = await sharp({
		create: {
			width,
			height,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 1 },
		},
	})
		.raw()
		.toBuffer();

	// For now, return the black background
	// Full text rendering would require additional libraries like canvas or svg
	return background;
}

/**
 * Add overlay to image with step number and goal text
 */
async function addOverlayToImage(
	sharp: any,
	imageBuffer: Buffer,
	stepNumber: number,
	goalText: string,
	width: number,
	height: number,
	fontSize: number,
	titleFontSize: number,
	margin: number
): Promise<Buffer> {
	// Decode unicode escapes in goal text
	const decodedGoal = decodeUnicodeEscapesToUtf8(goalText);

	// Create SVG overlay with step number and goal
	const svgOverlay = `
		<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
			<defs>
				<filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
					<feDropShadow dx="2" dy="2" stdDeviation="2" flood-opacity="0.5"/>
				</filter>
			</defs>
			<!-- Step number background -->
			<rect x="${margin}" y="${height - margin - 60}" width="60" height="50" rx="10" fill="rgba(0,0,0,0.8)"/>
			<!-- Step number text -->
			<text x="${margin + 30}" y="${height - margin - 30}"
				font-family="Arial, sans-serif" font-size="${titleFontSize}" font-weight="bold"
				fill="white" text-anchor="middle" dominant-baseline="middle"
				filter="url(#shadow)">
				${stepNumber}
			</text>
			<!-- Goal text background -->
			<rect x="${margin}" y="${height - margin - 130}" width="${width - 2 * margin}" height="60" rx="10" fill="rgba(0,0,0,0.8)"/>
			<!-- Goal text -->
			<text x="${width / 2}" y="${height - margin - 100}"
				font-family="Arial, sans-serif" font-size="${fontSize}"
				fill="white" text-anchor="middle" dominant-baseline="middle"
				filter="url(#shadow)">
				${escapeXml(truncateText(decodedGoal, 80))}
			</text>
		</svg>
	`;

	// Composite the overlay onto the image
	const result = await sharp(imageBuffer)
		.resize(width, height, { fit: 'fill' })
		.composite([
			{
				input: Buffer.from(svgOverlay),
				top: 0,
				left: 0,
			},
		])
		.raw()
		.toBuffer();

	return result;
}

/**
 * Escape XML special characters
 */
function escapeXml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * Truncate text to a maximum length
 */
function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return text.substring(0, maxLength - 3) + '...';
}

/**
 * HTML viewer options
 */
interface HtmlViewerOptions {
	task: string;
	history: AgentHistoryList;
	screenshots: (string | null)[];
	outputPath: string;
	duration: number;
	showGoals: boolean;
	showTask: boolean;
}

/**
 * Create HTML viewer as fallback when native GIF generation is not available
 */
async function createHtmlViewer(options: HtmlViewerOptions): Promise<void> {
	const { task, history, screenshots, outputPath, duration, showGoals, showTask } = options;

	// Build frames data for the HTML viewer
	const frames: { screenshot: string; stepNumber: number; goal: string; url: string }[] = [];

	let stepNumber = 0;
	for (let i = 0; i < history.history.length; i++) {
		const item = history.history[i];
		const screenshot = screenshots[i];

		if (!screenshot) continue;
		if (screenshot === PLACEHOLDER_4PX_SCREENSHOT) continue;
		if (isNewTabPage(item.state.url)) continue;

		stepNumber++;

		const goal =
			showGoals && item.modelOutput
				? (item.modelOutput as any).currentState?.nextGoal || item.modelOutput.nextGoal || ''
				: '';

		frames.push({
			screenshot,
			stepNumber,
			goal: decodeUnicodeEscapesToUtf8(goal),
			url: item.state.url,
		});
	}

	// Generate HTML
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Agent History - ${escapeXml(task)}</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			background: #1a1a1a;
			color: white;
			min-height: 100vh;
			display: flex;
			flex-direction: column;
			align-items: center;
		}
		.header {
			padding: 20px;
			text-align: center;
			background: #2a2a2a;
			width: 100%;
			border-bottom: 1px solid #444;
		}
		.header h1 {
			font-size: ${fontSizes['2xl']};
			margin-bottom: 10px;
		}
		.task {
			font-size: ${fontSizes.md};
			color: #aaa;
			max-width: 800px;
			margin: 0 auto;
		}
		.container {
			display: flex;
			flex-direction: column;
			align-items: center;
			padding: 20px;
			width: 100%;
			max-width: 1400px;
		}
		.player {
			position: relative;
			width: 100%;
			background: #000;
			border-radius: 8px;
			overflow: hidden;
			margin-bottom: 20px;
		}
		.frame {
			display: none;
			width: 100%;
		}
		.frame.active {
			display: block;
		}
		.frame img {
			width: 100%;
			height: auto;
			display: block;
		}
		.overlay {
			position: absolute;
			bottom: 0;
			left: 0;
			right: 0;
			padding: 20px;
			background: linear-gradient(transparent, rgba(0,0,0,0.9));
		}
		.step-badge {
			display: inline-block;
			background: rgba(0,0,0,0.8);
			padding: 8px 16px;
			border-radius: 20px;
			font-weight: bold;
			font-size: ${fontSizes.lg};
			margin-bottom: 10px;
		}
		.goal {
			font-size: ${fontSizes.md};
			line-height: 1.5;
			background: rgba(0,0,0,0.7);
			padding: 12px 16px;
			border-radius: 8px;
			margin-bottom: 8px;
		}
		.url {
			font-size: ${fontSizes.sm};
			color: #888;
			word-break: break-all;
		}
		.controls {
			display: flex;
			gap: 10px;
			align-items: center;
			margin-bottom: 20px;
		}
		.controls button {
			background: #444;
			border: none;
			color: white;
			padding: 10px 20px;
			border-radius: 5px;
			cursor: pointer;
			font-size: ${fontSizes.label};
		}
		.controls button:hover {
			background: #555;
		}
		.controls button.active {
			background: #0066cc;
		}
		.progress {
			flex: 1;
			height: 6px;
			background: #333;
			border-radius: 3px;
			overflow: hidden;
			cursor: pointer;
		}
		.progress-bar {
			height: 100%;
			background: #0066cc;
			transition: width 0.1s;
		}
		.frame-counter {
			font-size: ${fontSizes.label};
			color: #888;
			min-width: 80px;
			text-align: right;
		}
		.thumbnails {
			display: flex;
			gap: 10px;
			flex-wrap: wrap;
			justify-content: center;
			width: 100%;
			padding: 10px;
			background: #222;
			border-radius: 8px;
		}
		.thumbnail {
			width: 120px;
			height: 80px;
			border-radius: 4px;
			overflow: hidden;
			cursor: pointer;
			border: 2px solid transparent;
			transition: border-color 0.2s;
		}
		.thumbnail:hover, .thumbnail.active {
			border-color: #0066cc;
		}
		.thumbnail img {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}
	</style>
</head>
<body>
	<div class="header">
		<h1>Agent History Viewer</h1>
		<p class="task">${escapeXml(task)}</p>
	</div>

	<div class="container">
		<div class="player">
			${frames
				.map(
					(frame, i) => `
				<div class="frame ${i === 0 ? 'active' : ''}" data-index="${i}">
					<img src="data:image/png;base64,${frame.screenshot}" alt="Step ${frame.stepNumber}">
					<div class="overlay">
						<div class="step-badge">Step ${frame.stepNumber}</div>
						${frame.goal ? `<div class="goal">${escapeXml(frame.goal)}</div>` : ''}
						<div class="url">${escapeXml(frame.url)}</div>
					</div>
				</div>
			`
				)
				.join('')}
		</div>

		<div class="controls">
			<button id="prevBtn">&lt; Prev</button>
			<button id="playBtn">Play</button>
			<button id="nextBtn">Next &gt;</button>
			<div class="progress" id="progress">
				<div class="progress-bar" id="progressBar"></div>
			</div>
			<span class="frame-counter" id="counter">1 / ${frames.length}</span>
		</div>

		<div class="thumbnails">
			${frames
				.map(
					(frame, i) => `
				<div class="thumbnail ${i === 0 ? 'active' : ''}" data-index="${i}">
					<img src="data:image/png;base64,${frame.screenshot}" alt="Step ${frame.stepNumber}">
				</div>
			`
				)
				.join('')}
		</div>
	</div>

	<script>
		const frames = document.querySelectorAll('.frame');
		const thumbnails = document.querySelectorAll('.thumbnail');
		const playBtn = document.getElementById('playBtn');
		const prevBtn = document.getElementById('prevBtn');
		const nextBtn = document.getElementById('nextBtn');
		const progress = document.getElementById('progress');
		const progressBar = document.getElementById('progressBar');
		const counter = document.getElementById('counter');

		let currentFrame = 0;
		let isPlaying = false;
		let intervalId = null;
		const duration = ${duration};
		const totalFrames = ${frames.length};

		function showFrame(index) {
			if (index < 0) index = totalFrames - 1;
			if (index >= totalFrames) index = 0;

			currentFrame = index;

			frames.forEach((f, i) => f.classList.toggle('active', i === index));
			thumbnails.forEach((t, i) => t.classList.toggle('active', i === index));

			progressBar.style.width = ((index + 1) / totalFrames * 100) + '%';
			counter.textContent = (index + 1) + ' / ' + totalFrames;
		}

		function play() {
			if (isPlaying) {
				clearInterval(intervalId);
				playBtn.textContent = 'Play';
				playBtn.classList.remove('active');
			} else {
				intervalId = setInterval(() => showFrame(currentFrame + 1), duration);
				playBtn.textContent = 'Pause';
				playBtn.classList.add('active');
			}
			isPlaying = !isPlaying;
		}

		playBtn.addEventListener('click', play);
		prevBtn.addEventListener('click', () => showFrame(currentFrame - 1));
		nextBtn.addEventListener('click', () => showFrame(currentFrame + 1));

		thumbnails.forEach((thumb, i) => {
			thumb.addEventListener('click', () => showFrame(i));
		});

		progress.addEventListener('click', (e) => {
			const rect = progress.getBoundingClientRect();
			const percent = (e.clientX - rect.left) / rect.width;
			showFrame(Math.floor(percent * totalFrames));
		});

		// Keyboard shortcuts
		document.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowLeft') showFrame(currentFrame - 1);
			if (e.key === 'ArrowRight') showFrame(currentFrame + 1);
			if (e.key === ' ') { e.preventDefault(); play(); }
		});
	</script>
</body>
</html>`;

	fs.writeFileSync(outputPath, html);
	console.info(`[GIF] Created HTML viewer at ${outputPath}`);
}

/**
 * Legacy AgentGifGenerator class for backward compatibility
 */
export class AgentGifGenerator {
	async generate(frames: Buffer[]): Promise<Buffer> {
		// Try to use gif-encoder-2
		try {
			const gifModule = await dynamicImport('gif-encoder-2');
			const GIFEncoder = gifModule.default || gifModule;
			const sharpModule = await dynamicImport('sharp');
			const sharp = sharpModule.default || sharpModule;

			if (frames.length === 0) {
				throw new Error('No frames to encode');
			}

			// Get dimensions from first frame
			const firstFrameMeta = await sharp(frames[0]).metadata();
			const width = firstFrameMeta.width || 800;
			const height = firstFrameMeta.height || 600;

			const encoder = new GIFEncoder(width, height);
			encoder.setDelay(500);
			encoder.setRepeat(0);
			encoder.start();

			for (const frame of frames) {
				const rawData = await sharp(frame).resize(width, height).raw().toBuffer();
				encoder.addFrame(rawData);
			}

			encoder.finish();
			return encoder.out.getData();
		} catch (error: any) {
			throw new Error(`GIF generation failed: ${error.message}. Install sharp and gif-encoder-2 for native GIF support.`);
		}
	}
}

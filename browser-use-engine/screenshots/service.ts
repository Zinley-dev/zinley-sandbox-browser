/**
 * Screenshot storage service for browser-use agents.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export class ScreenshotService {
	private agentDirectory: string;
	private screenshotsDir: string;

	constructor(agentDirectory: string) {
		this.agentDirectory = agentDirectory;
		this.screenshotsDir = path.join(this.agentDirectory, 'screenshots');
	}

	/**
	 * Initialize screenshot directory
	 */
	async initialize(): Promise<void> {
		await fs.mkdir(this.screenshotsDir, { recursive: true });
	}

	/**
	 * Store screenshot to disk and return the full path as string
	 */
	async storeScreenshot(screenshotB64: string, stepNumber: number): Promise<string> {
		const screenshotFilename = `step_${stepNumber}.png`;
		const screenshotPath = path.join(this.screenshotsDir, screenshotFilename);

		// Decode base64 and save to disk
		const screenshotData = Buffer.from(screenshotB64, 'base64');
		await fs.writeFile(screenshotPath, screenshotData);

		return screenshotPath;
	}

	/**
	 * Load screenshot from disk path and return as base64
	 */
	async getScreenshot(screenshotPath: string | null): Promise<string | null> {
		if (!screenshotPath) {
			return null;
		}

		try {
			// Check if file exists
			await fs.access(screenshotPath);

			// Load from disk and encode to base64
			const screenshotData = await fs.readFile(screenshotPath);
			return screenshotData.toString('base64');
		} catch (error) {
			return null;
		}
	}
}

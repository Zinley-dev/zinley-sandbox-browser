/**
 * GIF generation for browser recordings
 * Port from browser_use/gif/generator.py
 *
 * Note: For native GIF generation, install optional dependencies:
 *   npm install sharp gif-encoder-2
 */

export { createHistoryGif, AgentGifGenerator, AgentHistoryList, CreateHistoryGifOptions } from '../agent/gif.js';

// Dynamic import helper to avoid TypeScript compilation errors for optional dependencies
async function dynamicImport(moduleName: string): Promise<any> {
	try {
		return await import(/* webpackIgnore: true */ moduleName);
	} catch {
		throw new Error(`Module '${moduleName}' not available. Install with: npm install ${moduleName}`);
	}
}

/**
 * GIF Generator class for creating GIFs from image frames
 *
 * This is a wrapper that delegates to the more comprehensive implementation
 * in agent/gif.ts
 */
export class GifGenerator {
	/**
	 * Generate a GIF from a list of image frames
	 *
	 * @param frames - Array of image buffers (PNG/JPEG)
	 * @param options - Generation options
	 * @returns GIF buffer
	 */
	async generateFromFrames(
		frames: Buffer[],
		options: {
			delay?: number; // Frame delay in milliseconds
			repeat?: number; // Number of loops (0 = infinite)
			quality?: number; // Quality 1-30, lower is better quality
		} = {}
	): Promise<Buffer> {
		const { delay = 500, repeat = 0, quality = 10 } = options;

		// Try to use gif-encoder-2 and sharp
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

			// Create encoder
			const encoder = new GIFEncoder(width, height, 'neuquant', true);
			encoder.setDelay(delay);
			encoder.setRepeat(repeat);
			encoder.setQuality(quality);
			encoder.start();

			// Add each frame
			for (const frame of frames) {
				const rawData = await sharp(frame).resize(width, height, { fit: 'fill' }).raw().toBuffer();

				encoder.addFrame(rawData);
			}

			encoder.finish();
			return encoder.out.getData();
		} catch (error: any) {
			throw new Error(
				`GIF generation requires sharp and gif-encoder-2 libraries. ` +
					`Install with: npm install sharp gif-encoder-2\n` +
					`Original error: ${error.message}`
			);
		}
	}

	/**
	 * Generate a GIF from base64-encoded images
	 *
	 * @param base64Images - Array of base64-encoded images
	 * @param options - Generation options
	 * @returns GIF buffer
	 */
	async generateFromBase64(
		base64Images: string[],
		options: {
			delay?: number;
			repeat?: number;
			quality?: number;
		} = {}
	): Promise<Buffer> {
		const frames = base64Images.map((b64) => Buffer.from(b64, 'base64'));
		return this.generateFromFrames(frames, options);
	}
}

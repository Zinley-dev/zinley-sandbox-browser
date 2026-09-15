/**
 * Visual highlighting system for drawing bounding boxes on screenshots.
 * Port from browser_use/browser/python_highlights.py
 *
 * This module draws premium glassmorphism bounding boxes around interactive elements.
 * Requires: sharp (npm install sharp)
 *
 * Features:
 * - Multi-layer glassmorphism with glow effects
 * - Cross-platform font support
 * - Smart element index positioning
 * - Device pixel ratio scaling
 */

import { EnhancedDOMTreeNode } from '../events/browser-events.js';
import { fontSizesNumeric } from '../typography.js';

/**
 * Professional liquid glass color scheme - sophisticated neutral palette
 */
export const ELEMENT_COLORS: Record<string, string> = {
	button: '#8FA3B8', // Steel blue-gray for buttons
	input: '#A0B4C8', // Soft steel blue for inputs
	select: '#B8C5D0', // Light steel for dropdowns
	a: '#7A92A8', // Deep steel blue for links
	textarea: '#C0CCD8', // Pale steel for text areas
	default: '#9CADB8', // Medium steel for other elements
};

/**
 * Secondary glow colors for glassmorphism effect
 */
export const ELEMENT_GLOW_COLORS: Record<string, string> = {
	button: '#B5C5D8', // Light steel blue
	input: '#C0D0E0', // Soft light steel
	select: '#D8E0E8', // Very light steel
	a: '#A0B8C8', // Medium light steel
	textarea: '#E0E8F0', // Pale light steel
	default: '#B8C8D8', // Balanced light steel
};

/**
 * Cross-platform font paths for text rendering
 */
export const FONT_PATHS = [
	'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', // Linux (Debian/Ubuntu)
	'/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', // Linux (Arch/Fedora)
	'/System/Library/Fonts/Arial.ttf', // macOS
	'C:\\Windows\\Fonts\\arial.ttf', // Windows
	'arial.ttf', // Windows (system path)
	'/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', // Linux alternative
];

/**
 * Get color for element based on tag name and type
 */
export function getElementColor(tagName: string, elementType?: string): string {
	// Check input type first
	if (tagName.toLowerCase() === 'input' && elementType) {
		if (elementType === 'button' || elementType === 'submit') {
			return ELEMENT_COLORS.button;
		}
	}
	return ELEMENT_COLORS[tagName.toLowerCase()] || ELEMENT_COLORS.default;
}

/**
 * Get glow color for glassmorphism effect
 */
export function getElementGlowColor(tagName: string, elementType?: string): string {
	if (tagName.toLowerCase() === 'input' && elementType) {
		if (elementType === 'button' || elementType === 'submit') {
			return ELEMENT_GLOW_COLORS.button;
		}
	}
	return ELEMENT_GLOW_COLORS[tagName.toLowerCase()] || ELEMENT_GLOW_COLORS.default;
}

/**
 * Parse hex color to RGB
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	if (result) {
		return {
			r: parseInt(result[1], 16),
			g: parseInt(result[2], 16),
			b: parseInt(result[3], 16),
		};
	}
	return { r: 159, g: 173, b: 184 }; // Default steel color
}

/**
 * Create a lighter version of a hex color for highlight effect
 */
export function lightenColor(hex: string, factor: number = 0.6): string {
	const rgb = hexToRgb(hex);
	const lighter = {
		r: Math.min(255, Math.round(rgb.r * (1 - factor) + 255 * factor)),
		g: Math.min(255, Math.round(rgb.g * (1 - factor) + 255 * factor)),
		b: Math.min(255, Math.round(rgb.b * (1 - factor) + 255 * factor)),
	};
	return `#${lighter.r.toString(16).padStart(2, '0')}${lighter.g.toString(16).padStart(2, '0')}${lighter.b.toString(16).padStart(2, '0')}`;
}

/**
 * Bounding box coordinates
 */
export interface BoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Element highlight info
 */
export interface ElementHighlight {
	index: number;
	bbox: BoundingBox;
	tagName: string;
	elementType?: string;
	text?: string;
	backendNodeId?: number;
}

/**
 * Viewport info for scaling (used for highlighting)
 */
export interface HighlightViewportInfo {
	devicePixelRatio: number;
	scrollX: number;
	scrollY: number;
}

/**
 * Calculate smart index position based on element size
 * Port from Python's draw_enhanced_bounding_box_with_text positioning logic
 *
 * UPDATED: Always position labels OUTSIDE elements to avoid covering content.
 * Priority: above > below > left > right
 */
function calculateIndexPosition(
	bbox: BoundingBox,
	textWidth: number,
	textHeight: number,
	padding: number,
	imgWidth: number,
	imgHeight: number
): { x: number; y: number } {
	const elementWidth = bbox.width;
	const containerWidth = textWidth + padding * 2;
	const containerHeight = textHeight + padding * 2;

	// Center horizontally within the element (use floor for integer division like Python)
	let bgX = bbox.x + Math.floor((elementWidth - containerWidth) / 2);
	let bgY: number;

	// ALWAYS place labels OUTSIDE the element to avoid covering content
	// Priority: above the element
	const spaceAbove = bbox.y;
	const spaceBelow = imgHeight - (bbox.y + bbox.height);

	if (spaceAbove >= containerHeight + 2) {
		// Place above the element (preferred)
		bgY = bbox.y - containerHeight - 2;
	} else if (spaceBelow >= containerHeight + 2) {
		// Place below the element
		bgY = bbox.y + bbox.height + 2;
	} else {
		// Fallback: place at the top-left corner just outside the element
		// Position slightly above and to the left
		bgY = Math.max(0, bbox.y - containerHeight - 2);
		bgX = Math.max(0, bbox.x - containerWidth - 2);
	}

	// Ensure stays within image bounds
	if (bgX < 0) bgX = 0;
	if (bgY < 0) bgY = 0;
	if (bgX + containerWidth > imgWidth) bgX = imgWidth - containerWidth;
	if (bgY + containerHeight > imgHeight) bgY = imgHeight - containerHeight;

	// Round to integers for crisp rendering
	return { x: Math.round(bgX), y: Math.round(bgY) };
}

/**
 * Create highlighted screenshot using Sharp with multi-layer glassmorphism
 *
 * @param screenshotBase64 Base64 encoded screenshot
 * @param selectorMap Map of index to DOM node
 * @param devicePixelRatio Device pixel ratio for scaling
 * @param filterHighlightIds Filter element IDs based on meaningful text
 * @returns Base64 encoded highlighted screenshot
 */
export async function createHighlightedScreenshot(
	screenshotBase64: string,
	selectorMap: Map<number, EnhancedDOMTreeNode>,
	devicePixelRatio: number = 1.0,
	filterHighlightIds: boolean = true
): Promise<string> {
	// Try to use sharp if available
	try {
		// @ts-ignore - sharp may not be installed
		const sharp = await import('sharp').catch(() => null);
		if (!sharp) {
			console.debug('Sharp library not available, returning original screenshot');
			return screenshotBase64;
		}

		// Decode the screenshot
		const screenshotBuffer = Buffer.from(screenshotBase64, 'base64');

		// Get image metadata
		const metadata = await sharp.default(screenshotBuffer).metadata();
		const imgWidth = metadata.width || 1280;
		const imgHeight = metadata.height || 720;

		// Collect highlights
		const highlights: ElementHighlight[] = [];

		for (const [index, node] of selectorMap.entries()) {
			if (node.absolutePosition) {
				const bounds = node.absolutePosition;

				// Scale coordinates from CSS pixels to device pixels (matching Python exactly)
				// Python uses int() which truncates, so use Math.floor
				// Python calculates x2 = int((bounds.x + bounds.width) * dpr), not int(bounds.x * dpr) + int(bounds.width * dpr)
				const x1 = Math.floor(bounds.x * devicePixelRatio);
				const y1 = Math.floor(bounds.y * devicePixelRatio);
				const x2 = Math.floor((bounds.x + (bounds.width || 0)) * devicePixelRatio);
				const y2 = Math.floor((bounds.y + (bounds.height || 0)) * devicePixelRatio);

				// Ensure coordinates are within image bounds (matching Python)
				const clampedX1 = Math.max(0, Math.min(x1, imgWidth));
				const clampedY1 = Math.max(0, Math.min(y1, imgHeight));
				const clampedX2 = Math.max(clampedX1, Math.min(x2, imgWidth));
				const clampedY2 = Math.max(clampedY1, Math.min(y2, imgHeight));

				// Convert back to bbox format for the highlight
				const scaledBbox: BoundingBox = {
					x: clampedX1,
					y: clampedY1,
					width: clampedX2 - clampedX1,
					height: clampedY2 - clampedY1,
				};

				// Skip if bounding box is too small (matching Python: x2 - x1 < 2 or y2 - y1 < 2)
				if (scaledBbox.width < 2 || scaledBbox.height < 2) continue;

				// Get meaningful text for filtering (matching Python's get_meaningful_text_for_llm)
				// Priority: value, aria-label, title, placeholder, alt, then text content
				let meaningfulText = '';
				if (node.attributes) {
					const priorityAttrs = ['value', 'aria-label', 'title', 'placeholder', 'alt'];
					for (const attr of priorityAttrs) {
						if (node.attributes[attr]) {
							meaningfulText = node.attributes[attr];
							break;
						}
					}
				}
				// Fallback to text content
				if (!meaningfulText) {
					meaningfulText = node.text || '';
				}
				meaningfulText = meaningfulText.trim();

				// Show ID only if meaningful text is less than 3 characters (matching Python)
				const showIndex = filterHighlightIds ? meaningfulText.length < 3 : true;

				highlights.push({
					index,
					bbox: scaledBbox,
					tagName: node.nodeName || 'div',
					elementType: node.attributes?.type,
					text: showIndex ? String(index) : undefined,
					backendNodeId: index,
				});
			}
		}

		// If no highlights, return original
		if (highlights.length === 0) {
			return screenshotBase64;
		}

		// Create SVG overlay with premium glassmorphism
		const svgOverlay = createPremiumSvgOverlay(highlights, imgWidth, imgHeight, devicePixelRatio);

		// Composite SVG over screenshot
		const highlightedBuffer = await sharp
			.default(screenshotBuffer)
			.composite([
				{
					input: Buffer.from(svgOverlay),
					top: 0,
					left: 0,
				},
			])
			.png()
			.toBuffer();

		return highlightedBuffer.toString('base64');
	} catch (error) {
		// Sharp not available or error - return original screenshot
		console.debug('Image highlighting not available (sharp library may not be installed):', error);
		return screenshotBase64;
	}
}

/**
 * Create premium SVG overlay with multi-layer glassmorphism effects
 */
function createPremiumSvgOverlay(highlights: ElementHighlight[], width: number, height: number, _devicePixelRatio: number): string {
	// Calculate base font size based on image width in device pixels (matches Python)
	// Python: css_width = img_width (NOT divided by device_pixel_ratio)
	// This ensures font size scales with the actual image size
	const imgWidth = width; // Use device pixels like Python
	const baseFontSize = Math.max(fontSizesNumeric['2xs'], Math.min(fontSizesNumeric.xl, Math.round(imgWidth * 0.01)));
	const padding = Math.max(4, Math.min(10, Math.round(imgWidth * 0.005)));

	let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;

	// No filters needed for simple frame-only highlights

	// Dashed line parameters for frame-only highlights
	const dashLength = 6;
	const gapLength = 4;
	const lineWidth = 2;

	// Helper to generate dashed line segments for an edge (frame only, no fill)
	function generateDashedEdge(
		x1: number, y1: number, x2: number, y2: number,
		color: string, _glowColor: string | undefined, lineWidth: number
	): string {
		let segments = '';
		if (x1 === x2) {
			// Vertical line
			let y = Math.min(y1, y2);
			const endY = Math.max(y1, y2);
			while (y < endY) {
				const dashEnd = Math.min(y + dashLength, endY);
				// Main line only - no glow, keeping middle transparent
				segments += `<line x1="${x1}" y1="${y}" x2="${x1}" y2="${dashEnd}" stroke="${color}" stroke-width="${lineWidth}"/>`;
				y += dashLength + gapLength;
			}
		} else {
			// Horizontal line
			let x = Math.min(x1, x2);
			const endX = Math.max(x1, x2);
			while (x < endX) {
				const dashEnd = Math.min(x + dashLength, endX);
				// Main line only - no glow, keeping middle transparent
				segments += `<line x1="${x}" y1="${y1}" x2="${dashEnd}" y2="${y1}" stroke="${color}" stroke-width="${lineWidth}"/>`;
				x += dashLength + gapLength;
			}
		}
		return segments;
	}

	for (const highlight of highlights) {
		const { bbox, tagName, elementType, text } = highlight;
		const color = getElementColor(tagName, elementType);

		// Use integer coordinates like Python (int() truncates, so use Math.floor)
		const x1 = Math.max(0, Math.floor(bbox.x));
		const y1 = Math.max(0, Math.floor(bbox.y));
		const x2 = Math.min(Math.floor(bbox.x + bbox.width), width);
		const y2 = Math.min(Math.floor(bbox.y + bbox.height), height);

		// Skip invalid boxes
		if (x2 - x1 <= 0 || y2 - y1 <= 0) continue;

		// Draw dashed rectangle frame (no fill, transparent middle)
		// Top edge
		svgContent += generateDashedEdge(x1, y1, x2, y1, color, undefined, lineWidth);
		// Right edge
		svgContent += generateDashedEdge(x2, y1, x2, y2, color, undefined, lineWidth);
		// Bottom edge
		svgContent += generateDashedEdge(x2, y2, x1, y2, color, undefined, lineWidth);
		// Left edge
		svgContent += generateDashedEdge(x1, y2, x1, y1, color, undefined, lineWidth);

		// For positioning the label, use corrected integer coordinates
		const w = x2 - x1;
		const h = y2 - y1;

		// Draw simple index label if text is provided
		if (text) {
			const textWidth = text.length * (baseFontSize * 0.6);
			const textHeight = baseFontSize;
			const containerWidth = textWidth + padding * 2;
			const containerHeight = textHeight + padding * 2;

			// Calculate smart position using corrected bbox
			const correctedBbox: BoundingBox = { x: x1, y: y1, width: w, height: h };
			const pos = calculateIndexPosition(correctedBbox, textWidth, textHeight, padding, width, height);
			const labelX = pos.x;
			const labelY = pos.y;

			// Simple label background
			svgContent += `
				<rect x="${labelX}" y="${labelY}" width="${containerWidth}" height="${containerHeight}"
					fill="${color}" rx="3"/>
			`;

			// Draw text with shadow - center horizontally and vertically (matching Python)
			// Python: text_x = bg_x1 + (container_width - text_width) // 2
			// Python: text_y = bg_y1 + (container_height - text_height) // 2 - bbox_text[1]
			// In SVG, y is the baseline, so we need to add ~80% of text height for visual centering
			const textX = labelX + Math.floor((containerWidth - textWidth) / 2);
			const textY = labelY + Math.floor((containerHeight + textHeight * 0.7) / 2);

			// Shadow text
			svgContent += `
				<text x="${textX + 1}" y="${textY + 1}"
					fill="rgba(0,0,0,0.4)" font-family="Arial, sans-serif" font-size="${baseFontSize}" font-weight="bold">
					${text}
				</text>
			`;

			// Main text (crisp white)
			svgContent += `
				<text x="${textX}" y="${textY}"
					fill="white" font-family="Arial, sans-serif" font-size="${baseFontSize}" font-weight="bold">
					${text}
				</text>
			`;
		}
	}

	svgContent += '</svg>';
	return svgContent;
}

/**
 * Create simple text-only representation of highlights (fallback)
 */
export function createHighlightDescription(selectorMap: Map<number, EnhancedDOMTreeNode>): string[] {
	const descriptions: string[] = [];

	for (const [index, node] of selectorMap.entries()) {
		if (node.absolutePosition) {
			const bbox = node.absolutePosition;
			const tagName = node.nodeName || 'element';
			const text = node.text?.substring(0, 30) || '';

			descriptions.push(`[${index}] ${tagName} at (${Math.round(bbox.x)}, ${Math.round(bbox.y)}) - ${text}`);
		}
	}

	return descriptions;
}

/**
 * Get viewport info from a page (helper for device pixel ratio)
 */
export async function getHighlightViewportInfo(page: any): Promise<HighlightViewportInfo> {
	try {
		const metrics = await page.evaluate(() => {
			return {
				devicePixelRatio: window.devicePixelRatio || 1,
				scrollX: window.scrollX || 0,
				scrollY: window.scrollY || 0,
			};
		});
		return metrics;
	} catch {
		return { devicePixelRatio: 1, scrollX: 0, scrollY: 0 };
	}
}

/**
 * Create highlighted screenshot with automatic viewport detection
 */
export async function createHighlightedScreenshotAsync(
	screenshotBase64: string,
	selectorMap: Map<number, EnhancedDOMTreeNode>,
	page?: any,
	filterHighlightIds: boolean = true
): Promise<string> {
	let devicePixelRatio = 1.0;

	// Get viewport info if page is available
	if (page) {
		try {
			const viewportInfo = await getHighlightViewportInfo(page);
			devicePixelRatio = viewportInfo.devicePixelRatio;
		} catch {
			// Use default if unable to get viewport info
		}
	}

	return createHighlightedScreenshot(screenshotBase64, selectorMap, devicePixelRatio, filterHighlightIds);
}

/**
 * Cleanup any cached resources (for long-running applications)
 */
export function cleanupHighlightCache(): void {
	// In the future, this can be used to clean up font caches or other resources
	// Currently a no-op since we generate SVG on each call
}

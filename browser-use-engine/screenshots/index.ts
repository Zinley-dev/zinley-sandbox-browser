export { ScreenshotService } from './service.js';

// Visual highlighting
export {
	ELEMENT_COLORS,
	ELEMENT_GLOW_COLORS,
	FONT_PATHS,
	getElementColor,
	getElementGlowColor,
	hexToRgb,
	lightenColor,
	createHighlightedScreenshot,
	createHighlightedScreenshotAsync,
	createHighlightDescription,
	getHighlightViewportInfo,
	cleanupHighlightCache,
} from './highlights.js';
export type { BoundingBox, ElementHighlight, HighlightViewportInfo } from './highlights.js';

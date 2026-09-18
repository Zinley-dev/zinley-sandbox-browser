/**
 * Browser state views and data models
 */

import { z } from 'zod';
import { DOMInteractedElement, SerializedDOMState } from '../dom/views.js';

// Known placeholder image data for about:blank pages - a 4x4 white PNG
export const PLACEHOLDER_4PX_SCREENSHOT =
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8//8/AwwwMSAB3BwAlm4DBfIlvvkAAAAASUVORK5CYII=';

// ============================================================================
// Tab Info
// ============================================================================

export interface TabInfo {
	url: string;
	title: string;
	targetId: string; // Also known as tab_id
	parentTargetId?: string | null; // Parent page that contains this popup or cross-origin iframe
}

export const TabInfoSchema = z.object({
	url: z.string(),
	title: z.string(),
	targetId: z.string(),
	parentTargetId: z.string().nullable().optional(),
});

// ============================================================================
// Page Info
// ============================================================================

export interface PageInfo {
	// Current viewport dimensions
	viewportWidth: number;
	viewportHeight: number;

	// Total page dimensions
	pageWidth: number;
	pageHeight: number;

	// Current scroll position
	scrollX: number;
	scrollY: number;

	// Calculated scroll information
	pixelsAbove: number;
	pixelsBelow: number;
	pixelsLeft: number;
	pixelsRight: number;
}

export const PageInfoSchema = z.object({
	viewportWidth: z.number(),
	viewportHeight: z.number(),
	pageWidth: z.number(),
	pageHeight: z.number(),
	scrollX: z.number(),
	scrollY: z.number(),
	pixelsAbove: z.number(),
	pixelsBelow: z.number(),
	pixelsLeft: z.number(),
	pixelsRight: z.number(),
});

// ============================================================================
// Network Request
// ============================================================================

export interface NetworkRequest {
	url: string;
	method: string; // 'GET', 'POST', etc.
	loadingDurationMs: number; // How long this request has been loading
	resourceType?: string | null; // 'Document', 'Stylesheet', 'Image', 'Script', 'XHR', 'Fetch'
}

export const NetworkRequestSchema = z.object({
	url: z.string(),
	method: z.string().default('GET'),
	loadingDurationMs: z.number().default(0),
	resourceType: z.string().nullable().optional(),
});

// ============================================================================
// Pagination Button
// ============================================================================

export interface PaginationButton {
	buttonType: string; // 'next', 'prev', 'first', 'last', 'page_number'
	backendNodeId: number;
	/** Model-visible selector index */
	selectorIndex?: number | null; // Backend node ID for clicking
	text: string; // Button text/label
	selector: string; // XPath or other selector
	isDisabled: boolean; // Whether the button appears disabled
}

export const PaginationButtonSchema = z.object({
	buttonType: z.string(),
	backendNodeId: z.number(),
	selectorIndex: z.number().nullable().optional(),
	text: z.string(),
	selector: z.string(),
	isDisabled: z.boolean().default(false),
});

// ============================================================================
// Browser State Summary
// ============================================================================

export interface BrowserStateSummary {
	// DOM state
	domState: SerializedDOMState;

	// Page info
	url: string;
	title: string;
	tabs: TabInfo[];
	screenshot?: string | null;
	pageInfo?: PageInfo | null;

	// Legacy fields for backward compatibility
	pixelsAbove: number;
	pixelsBelow: number;
	browserErrors: string[];
	isPdfViewer: boolean; // Whether the current page is a PDF viewer
	recentEvents?: string | null; // Text summary of recent browser events
	pendingNetworkRequests: NetworkRequest[]; // Currently loading network requests
	paginationButtons: PaginationButton[]; // Detected pagination buttons
	/** Messages from auto-closed JavaScript dialogs since the last state */
	closedPopupMessages?: string[];
	/** Dialog / cookie banner / overlay candidates covering the page (from the DOM service). */
	modalOverlays?: Array<{ backendNodeId: number; nodeName: string; reason: string }>;
	/** Safe, model-visible explanation when the current state could not be captured */
	stateError?: string | null;
}

export const BrowserStateSummarySchema = z.object({
	domState: z.any(), // SerializedDOMStateSchema
	url: z.string(),
	title: z.string(),
	tabs: z.array(TabInfoSchema),
	screenshot: z.string().nullable().optional(),
	pageInfo: PageInfoSchema.nullable().optional(),
	pixelsAbove: z.number().default(0),
	pixelsBelow: z.number().default(0),
	browserErrors: z.array(z.string()).default([]),
	isPdfViewer: z.boolean().default(false),
	recentEvents: z.string().nullable().optional(),
	pendingNetworkRequests: z.array(NetworkRequestSchema).default([]),
	paginationButtons: z.array(PaginationButtonSchema).default([]),
	closedPopupMessages: z.array(z.string()).default([]),
	stateError: z.string().nullable().optional(),
});

// ============================================================================
// Browser State History
// ============================================================================

export interface BrowserStateHistory {
	url: string;
	title: string;
	tabs: TabInfo[];
	interactedElement: (DOMInteractedElement | null)[];
	screenshotPath?: string | null;
}

export const BrowserStateHistorySchema = z.object({
	url: z.string(),
	title: z.string(),
	tabs: z.array(TabInfoSchema),
	interactedElement: z.array(z.any().nullable()), // DOMInteractedElementSchema
	screenshotPath: z.string().nullable().optional(),
});

/**
 * Load screenshot from disk and return as base64 string
 */
export async function getScreenshot(screenshotPath?: string | null): Promise<string | null> {
	if (!screenshotPath) {
		return null;
	}

	try {
		const fs = await import('fs/promises');
		const path = await import('path');

		const exists = await fs
			.access(screenshotPath)
			.then(() => true)
			.catch(() => false);

		if (!exists) {
			return null;
		}

		const data = await fs.readFile(screenshotPath);
		return data.toString('base64');
	} catch {
		return null;
	}
}

// ============================================================================
// Browser Errors
// ============================================================================

export interface BrowserErrorOptions {
	shortTermMemory?: string | null;
	longTermMemory?: string | null;
	details?: Record<string, any> | null;
	event?: any | null;
}

export class BrowserError extends Error {
	shortTermMemory?: string | null;
	longTermMemory?: string | null;
	details?: Record<string, any> | null;
	whileHandlingEvent?: any | null;

	constructor(message: string, options?: BrowserErrorOptions) {
		super(message);
		this.name = 'BrowserError';
		this.shortTermMemory = options?.shortTermMemory;
		this.longTermMemory = options?.longTermMemory;
		this.details = options?.details;
		this.whileHandlingEvent = options?.event;
	}

	toString(): string {
		const parts = [this.message];
		if (this.details) {
			parts.push(`(${JSON.stringify(this.details)})`);
		}
		if (this.whileHandlingEvent) {
			parts.push(`during: ${this.whileHandlingEvent}`);
		}
		return parts.join(' ');
	}
}

export class URLNotAllowedError extends BrowserError {
	constructor(message: string, options?: BrowserErrorOptions) {
		super(message, options);
		this.name = 'URLNotAllowedError';
	}
}

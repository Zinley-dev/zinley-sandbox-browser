/**
 * Built-in browser actions (live agent path).
 * Behaviour follows browser_use/tools/service.py (Python browser-use 0.13.10),
 * implemented on top of the fork's patchright + event-bus BrowserSession.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { ActionRegistry, ActionContext } from './registry.js';
import { ActionResult } from '../types/agent.js';
import { BrowserEventNames } from '../events/browser-events.js';
import { TIMEOUTS } from '../events/base.js';
import type { EnhancedDOMTreeNode as DomTreeNode } from '../dom/views.js';
import type { EnhancedDOMTreeNode } from '../events/browser-events.js';
import { chunkMarkdownByStructure } from '../dom/markdown_chunking.js';
import { FileSystem } from '../filesystem/file_system.js';
import { createSystemMessage, createUserMessage } from '../llm/messages.js';
import {
	ACTION_DESCRIPTIONS,
	ClickElementActionIndexOnlySchema,
	ClickElementActionSchema,
	CloseTabActionSchema,
	DoneActionSchema,
	EvaluateActionSchema,
	ExtractActionSchema,
	FindElementsActionSchema,
	FindTextActionSchema,
	GetDropdownOptionsActionSchema,
	InputTextActionSchema,
	NavigateActionSchema,
	NoParamsActionSchema,
	ReadFileActionSchema,
	ReplaceFileActionSchema,
	SaveAsPdfActionSchema,
	ScreenshotActionSchema,
	ScrollActionSchema,
	SearchActionSchema,
	SearchPageActionSchema,
	SelectDropdownOptionActionSchema,
	SendKeysActionSchema,
	SwitchTabActionSchema,
	UploadFileActionSchema,
	WaitActionSchema,
	WriteFileActionSchema,
} from '../tools/views.js';
import {
	DEFAULT_PDF_FOOTER_TEMPLATE,
	DEFAULT_PDF_HEADER_TEMPLATE,
	EVALUATE_MAX_MEMORY_LENGTH,
	EVALUATE_MAX_RESULT_CHARS,
	EXTRACT_FREE_TEXT_SYSTEM_PROMPT,
	EXTRACT_LLM_TIMEOUT_MS,
	EXTRACT_MAX_CHAR_LIMIT,
	EXTRACT_MAX_MEMORY_LENGTH,
	EXTRACT_STRUCTURED_SYSTEM_PROMPT,
	NAVIGATION_NETWORK_ERRORS,
	buildAlreadyCollectedSection,
	detectSensitiveKeyName,
	ensureExtension,
	extractDataImages,
	formatFindResults,
	formatSearchResults,
	getClickDescription,
	isAutocompleteField,
	isPathInsideDir,
	needsAutocompleteDelay,
	pdfFileNameFromTitle,
	resolvePaperSize,
	sanitizeSurrogates,
	shouldExtractImages,
	summarizeForMemory,
	uniqueFileName,
	validateAndFixJavaScript,
} from '../tools/utils.js';
import { schemaDictToZod } from '../tools/extraction/schema_utils.js';
import { createExtractionResult } from '../tools/extraction/views.js';

export { validateAndFixJavaScript } from '../tools/utils.js';

// ============================================================================
// Constants
// ============================================================================

/** Actions whose successful execution ends the current multi-action sequence. */
export const TERMINATING_ACTIONS = ['search', 'navigate', 'go_back', 'switch', 'evaluate'] as const;

const NEW_TAB_DETECTION_DELAY_MS = 50;
const AUTOCOMPLETE_DELAY_MS = 400;
const SCROLL_STEP_DELAY_MS = 150;
const EMPTY_DOM_RECHECK_DELAY_MS = 3000;
const EMPTY_DOM_RELOAD_WAIT_MS = 5000;
const PDF_PRINT_TIMEOUT_MS = 30000;

// ============================================================================
// Helper Functions
// ============================================================================

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Get element by index, using page-specific selector map for multi-agent support
 * Falls back to session-wide method if pageId not specified
 */
async function getElementForContext(context: ActionContext, index: number): Promise<EnhancedDOMTreeNode | null> {
	if (context.pageId) {
		return context.browserSession.getElementByIndexForPage(context.pageId, index);
	}
	return context.browserSession.getElementByIndex(index);
}

/**
 * Get selector map, using page-specific map for multi-agent support
 */
async function getSelectorMapForContext(context: ActionContext): Promise<Map<number, EnhancedDOMTreeNode>> {
	if (context.pageId) {
		return context.browserSession.getSelectorMapForPage(context.pageId);
	}
	return await context.browserSession.getSelectorMap();
}

/** Page for this action (agent's own tab in multi-agent mode). */
function getPageForContext(context: ActionContext) {
	return context.browserSession.getPageOrCurrent(context.pageId);
}

/** CDP session for this action's page. */
async function getCdpForContext(context: ActionContext) {
	return context.pageId
		? context.browserSession.getCdpSessionForPage(context.pageId)
		: context.browserSession.getCdpSession();
}

function elementNotAvailable(index: number): ActionResult {
	const msg = `Element index ${index} not available - page may have changed. Try refreshing browser state.`;
	console.warn(`⚠️ ${msg}`);
	return { extractedContent: msg };
}

function noFileSystem(): ActionResult {
	return { error: 'No file system available. FileSystem must be configured in agent settings.' };
}

/**
 * Convert coordinates from the LLM screenshot size to the real viewport size.
 * Only applies when the session exposes a resized `llmScreenshotSize`.
 */
export function convertLlmCoordinatesToViewport(
	llmX: number,
	llmY: number,
	session: { llmScreenshotSize?: [number, number] | null; originalViewportSize?: [number, number] | null }
): [number, number] {
	const llmSize = session.llmScreenshotSize;
	const original = session.originalViewportSize;
	if (llmSize && original && llmSize[0] > 0 && llmSize[1] > 0) {
		const actualX = Math.trunc((llmX / llmSize[0]) * original[0]);
		const actualY = Math.trunc((llmY / llmSize[1]) * original[1]);
		console.info(
			`🔄 Converting coordinates: LLM (${llmX}, ${llmY}) @ ${llmSize[0]}x${llmSize[1]} → Viewport (${actualX}, ${actualY}) @ ${original[0]}x${original[1]}`
		);
		return [actualX, actualY];
	}
	return [llmX, llmY];
}

/**
 * Detect if a click opened a new tab. In single-agent mode the session focus
 * switches to it automatically; in multi-agent mode the agent is only told.
 */
async function detectNewTabOpened(context: ActionContext, tabsBefore: Set<string>): Promise<string> {
	try {
		// Brief delay so the browser can register the new target
		await sleep(NEW_TAB_DETECTION_DELAY_MS);
		const newTabs = context.browserSession.getAllTabIds().filter((id) => !tabsBefore.has(id));
		if (newTabs.length === 0) {
			return '';
		}
		const newTabId = newTabs[0];
		const shortId = newTabId.slice(-4);
		if (!context.pageId && context.browserSession.switchToPage(newTabId)) {
			return `. Automatically switched to new tab (tab_id: ${shortId}).`;
		}
		return `. Note: This opened a new tab (tab_id: ${shortId}) - switch to it if you need to interact with the new page.`;
	} catch {
		return '';
	}
}

/**
 * True when an http(s) page rendered no usable content (blank body, no interactive elements).
 * Mirrors Python's `_page_appears_empty`, evaluated in-page to avoid a full DOM extraction.
 */
async function pageAppearsEmpty(context: ActionContext): Promise<boolean> {
	try {
		const page = getPageForContext(context);
		const url = page.url().toLowerCase();
		if (!url.startsWith('http://') && !url.startsWith('https://')) {
			return false;
		}
		return await page.evaluate(() => {
			const body = document.body;
			if (!body) return true;
			const text = (body.innerText || '').trim();
			if (text.length > 0) return false;
			return body.querySelector('input, button, a, select, textarea, img, iframe, canvas, video, [role]') === null;
		});
	} catch {
		return false;
	}
}

/** Resolve a 4-char tab id to the full target id. */
async function findTabByShortId(context: ActionContext, tabId: string): Promise<string | null> {
	const ids = context.browserSession.getAllTabIds();
	const match = ids.find((id) => id.endsWith(tabId));
	if (match) return match;
	try {
		const state = await context.browserSession.getState({ includeScreenshot: false, includeDom: false });
		const tab = state.tabs.find((t) => t.targetId.endsWith(tabId));
		return tab?.targetId ?? null;
	} catch {
		return null;
	}
}

// ============================================================================
// Navigation actions
// ============================================================================

async function search(params: z.infer<typeof SearchActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		const engine = params.engine || 'duckduckgo';
		const encodedQuery = encodeURIComponent(params.query);

		const searchEngines: Record<string, string> = {
			google: `https://www.google.com/search?q=${encodedQuery}&udm=14`,
			bing: `https://www.bing.com/search?q=${encodedQuery}`,
			duckduckgo: `https://duckduckgo.com/?q=${encodedQuery}`,
		};

		const searchUrl = searchEngines[engine];
		if (!searchUrl) {
			return { error: `Unsupported search engine: ${engine}. Options: duckduckgo, google, bing` };
		}

		await context.browserSession.eventBus.dispatch(
			BrowserEventNames.NAVIGATE_TO_URL,
			{ url: searchUrl, newTab: false, pageId: context.pageId },
			TIMEOUTS.NAVIGATE_TO_URL
		);

		const memory = `Searched ${engine.charAt(0).toUpperCase() + engine.slice(1)} for '${params.query}'`;
		console.info(`🔍 ${memory}`);
		return { extractedContent: memory, longTermMemory: memory };
	} catch (error: any) {
		return { error: `Failed to search: ${error.message}` };
	}
}

async function navigate(params: z.infer<typeof NavigateActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		await context.browserSession.eventBus.dispatch(
			BrowserEventNames.NAVIGATE_TO_URL,
			{ url: params.url, newTab: params.new_tab ?? false, pageId: context.pageId },
			TIMEOUTS.NAVIGATE_TO_URL
		);

		// Health check: detect an empty DOM for http/https pages and retry once.
		if (!params.new_tab && (await pageAppearsEmpty(context))) {
			console.warn(`⚠️ Empty DOM detected after navigation to ${params.url}, waiting 3s and rechecking...`);
			await sleep(EMPTY_DOM_RECHECK_DELAY_MS);
			if (await pageAppearsEmpty(context)) {
				console.warn(`⚠️ Still empty after 3s, attempting page reload for ${params.url}...`);
				try {
					await context.browserSession.eventBus.dispatch(
						BrowserEventNames.NAVIGATE_TO_URL,
						{ url: params.url, newTab: false, pageId: context.pageId },
						TIMEOUTS.NAVIGATE_TO_URL
					);
				} catch {
					// The final check below reports the failure
				}
				await sleep(EMPTY_DOM_RELOAD_WAIT_MS);
				if (await pageAppearsEmpty(context)) {
					return {
						error:
							`Page loaded but returned empty content for ${params.url}. ` +
							'The page may require JavaScript that failed to render, use anti-bot measures, ' +
							'or have a connection issue (e.g. tunnel/proxy error). Try a different URL or approach.',
					};
				}
			}
		}

		const memory = params.new_tab ? `Opened new tab with URL ${params.url}` : `Navigated to ${params.url}`;
		console.info(`🔗 ${memory}`);
		return { extractedContent: memory, longTermMemory: memory };
	} catch (error: any) {
		const errorMsg = error.message || String(error);

		if (errorMsg.includes('CDP client not initialized')) {
			return { error: `Browser connection error: ${errorMsg}` };
		}

		if (NAVIGATION_NETWORK_ERRORS.some((err) => errorMsg.includes(err))) {
			return { error: `Navigation failed - site unavailable: ${params.url}` };
		}

		return { error: `Navigation failed: ${errorMsg}` };
	}
}

async function goBack(_params: any, context: ActionContext): Promise<ActionResult> {
	try {
		await context.browserSession.eventBus.dispatch(BrowserEventNames.GO_BACK, { pageId: context.pageId }, TIMEOUTS.GO_BACK);
		const memory = 'Navigated back';
		return { extractedContent: memory, longTermMemory: memory };
	} catch (error: any) {
		return { error: `Failed to go back: ${error.message}` };
	}
}

async function goForward(_params: any, context: ActionContext): Promise<ActionResult> {
	try {
		await context.browserSession.eventBus.dispatch(
			BrowserEventNames.GO_FORWARD,
			{ pageId: context.pageId },
			TIMEOUTS.GO_FORWARD
		);
		const memory = 'Navigated forward';
		return { extractedContent: memory, longTermMemory: memory };
	} catch (error: any) {
		return { error: `Failed to go forward: ${error.message}` };
	}
}

async function refresh(_params: any, context: ActionContext): Promise<ActionResult> {
	try {
		await context.browserSession.eventBus.dispatch(BrowserEventNames.REFRESH, { pageId: context.pageId }, TIMEOUTS.REFRESH);
		const memory = 'Refreshed page';
		return { extractedContent: memory, longTermMemory: memory };
	} catch (error: any) {
		return { error: `Failed to refresh: ${error.message}` };
	}
}

/** Python: wait `seconds - 1` (the LLM round trip already took time), capped at 30s. */
export function effectiveWaitSeconds(seconds: number): number {
	return Math.min(Math.max(seconds - 1, 0), 30);
}

async function wait(params: z.infer<typeof WaitActionSchema>, context: ActionContext): Promise<ActionResult> {
	const seconds = params.seconds ?? 3;
	const actualSeconds = effectiveWaitSeconds(seconds);
	const memory = `Waited for ${seconds} seconds`;
	console.info(`🕒 waited for ${seconds} second${seconds === 1 ? '' : 's'}`);
	try {
		if (actualSeconds > 0) {
			await context.browserSession.eventBus.dispatch(
				BrowserEventNames.WAIT,
				{ seconds: actualSeconds, pageId: context.pageId },
				TIMEOUTS.WAIT
			);
		}
		return { extractedContent: memory, longTermMemory: memory };
	} catch (error: any) {
		return { error: `Failed to wait: ${error.message}` };
	}
}

// ============================================================================
// Element interaction
// ============================================================================

async function clickByIndex(
	params: { index: number; button?: 'left' | 'right' | 'middle' },
	context: ActionContext
): Promise<ActionResult> {
	try {
		if (params.index === 0) {
			return {
				error: 'Cannot click on element with index 0. If there are no interactive elements use wait(), refresh(), etc. to troubleshoot',
			};
		}

		const element = await getElementForContext(context, params.index);
		if (!element) {
			const selectorMap = await getSelectorMapForContext(context);
			console.debug(
				`🔍 [click] Available indices in selectorMap: ${selectorMap ? Array.from(selectorMap.keys()).slice(0, 20).join(', ') : 'empty'}`
			);
			return elementNotAvailable(params.index);
		}

		const elementDesc = getClickDescription(element as unknown as DomTreeNode);
		const tabsBefore = new Set(context.browserSession.getAllTabIds());

		// Highlight the element being clicked (non-blocking)
		context.browserSession.highlightInteractionElement(element, context.pageId).catch(() => {});

		let clickMetadata: any;
		try {
			clickMetadata = await context.browserSession.eventBus.dispatch(
				BrowserEventNames.CLICK_ELEMENT,
				{ node: element, button: params.button, pageId: context.pageId },
				TIMEOUTS.CLICK_ELEMENT
			);
		} catch (error: any) {
			const errorMsg = error.message || String(error);
			// Clicking a <select>: return the dropdown options as a helpful shortcut
			if (errorMsg.includes('Cannot click on <select>')) {
				try {
					return await dropdownOptions({ index: params.index }, context);
				} catch (dropdownError: any) {
					console.debug(
						`Failed to get dropdown options as shortcut during click on dropdown: ${dropdownError?.name}: ${dropdownError?.message}`
					);
				}
				return { error: errorMsg };
			}
			if (errorMsg.includes('Cannot click on file input')) {
				return { error: errorMsg };
			}
			throw error;
		}

		let memory = `Clicked ${elementDesc}`;
		memory += await detectNewTabOpened(context, tabsBefore);
		console.info(`🖱️ ${memory}`);

		return {
			extractedContent: memory,
			longTermMemory: memory,
			metadata: clickMetadata && typeof clickMetadata === 'object' ? clickMetadata : null,
		};
	} catch (error: any) {
		return { error: `Failed to click element ${params.index}: ${error.message || String(error)}` };
	}
}

async function clickByCoordinate(
	params: z.infer<typeof ClickElementActionSchema>,
	context: ActionContext
): Promise<ActionResult> {
	if (params.coordinate_x == null || params.coordinate_y == null) {
		return { error: 'Both coordinate_x and coordinate_y must be provided' };
	}
	try {
		const [actualX, actualY] = convertLlmCoordinatesToViewport(
			params.coordinate_x,
			params.coordinate_y,
			context.browserSession as any
		);
		const tabsBefore = new Set(context.browserSession.getAllTabIds());

		const page = getPageForContext(context);
		await page.mouse.click(actualX, actualY, { button: params.button ?? 'left' });

		let memory = `Clicked on coordinate ${params.coordinate_x}, ${params.coordinate_y}`;
		memory += await detectNewTabOpened(context, tabsBefore);
		console.info(`🖱️ ${memory}`);

		return {
			extractedContent: memory,
			longTermMemory: memory,
			metadata: { click_x: actualX, click_y: actualY },
		};
	} catch (error: any) {
		return {
			error: `Failed to click at coordinates (${params.coordinate_x}, ${params.coordinate_y}): ${error.message || String(error)}`,
		};
	}
}

async function clickIndexOnly(
	params: z.infer<typeof ClickElementActionIndexOnlySchema>,
	context: ActionContext
): Promise<ActionResult> {
	return clickByIndex(params, context);
}

async function clickWithCoordinates(
	params: z.infer<typeof ClickElementActionSchema>,
	context: ActionContext
): Promise<ActionResult> {
	if (params.index == null && (params.coordinate_x == null || params.coordinate_y == null)) {
		return { error: 'Must provide either index or both coordinate_x and coordinate_y' };
	}
	if (params.index != null) {
		return clickByIndex({ index: params.index, button: params.button }, context);
	}
	return clickByCoordinate(params, context);
}

async function typeText(params: z.infer<typeof InputTextActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		const element = await getElementForContext(context, params.index);
		if (!element) {
			return elementNotAvailable(params.index);
		}

		context.browserSession.highlightInteractionElement(element, context.pageId).catch(() => {});

		const hasSensitiveData = context.hasSensitiveData || false;
		let sensitiveKeyName: string | null = null;
		if (hasSensitiveData && context.sensitiveData) {
			sensitiveKeyName = detectSensitiveKeyName(params.text, context.sensitiveData);
		}

		const inputMetadata = await context.browserSession.eventBus.dispatch<any>(
			BrowserEventNames.TYPE_TEXT,
			{
				node: element,
				text: params.text,
				clear: params.clear,
				isSensitive: hasSensitiveData,
				sensitiveKeyName: sensitiveKeyName ?? undefined,
				pageId: context.pageId,
			},
			TIMEOUTS.TYPE_TEXT
		);

		let msg: string;
		let logMsg: string;
		if (hasSensitiveData) {
			msg = sensitiveKeyName ? `Typed ${sensitiveKeyName}` : 'Typed sensitive data';
			logMsg = sensitiveKeyName ? `Typed <${sensitiveKeyName}>` : 'Typed <sensitive>';
		} else {
			msg = `Typed '${params.text}'`;
			logMsg = msg;
		}
		console.debug(logMsg);

		// Value mismatch check (non-sensitive only) when the handler reports the actual value
		let metadata: Record<string, any> | null = null;
		if (inputMetadata && typeof inputMetadata === 'object') {
			const { actualValue, actual_value, ...rest } = inputMetadata as Record<string, any>;
			const actual = actualValue ?? actual_value;
			if (!hasSensitiveData && typeof actual === 'string' && actual !== params.text) {
				msg += `\n⚠️ Note: the field's actual value '${actual}' differs from typed text '${params.text}'. The page may have reformatted or autocompleted your input.`;
			}
			metadata = Object.keys(rest).length > 0 ? rest : null;
		}

		// Autocomplete/combobox: hint + mechanical delay so the dropdown can populate
		if (isAutocompleteField(element as unknown as DomTreeNode)) {
			msg += '\n💡 This is an autocomplete field. Wait for suggestions to appear, then click the correct suggestion instead of pressing Enter.';
			if (needsAutocompleteDelay(element as unknown as DomTreeNode)) {
				await sleep(AUTOCOMPLETE_DELAY_MS);
			}
		}

		return { extractedContent: msg, longTermMemory: msg, metadata };
	} catch (error: any) {
		console.error(`Failed to dispatch TypeTextEvent: ${error?.name}: ${error?.message}`);
		return { error: `Failed to type text into element ${params.index}: ${error.message || String(error)}` };
	}
}

async function scroll(params: z.infer<typeof ScrollActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		const pages = params.pages ?? 1.0;
		const down = params.down ?? true;
		const direction = down ? 'down' : 'up';

		let node: EnhancedDOMTreeNode | null = null;
		if (params.index != null && params.index !== 0) {
			node = await getElementForContext(context, params.index);
			if (!node) {
				return { error: `Element index ${params.index} not found in browser state` };
			}
		}
		const targetDesc = node ? `element ${params.index}` : 'the page';

		// Viewport height for accurate scrolling (fallback 1000px)
		let viewportHeight = 1000;
		try {
			const cdpSession = await getCdpForContext(context);
			const metrics = (await cdpSession.send('Page.getLayoutMetrics')) as any;
			const cssViewport = metrics?.cssVisualViewport || metrics?.cssLayoutViewport;
			if (cssViewport?.clientHeight) {
				viewportHeight = Math.floor(cssViewport.clientHeight);
			}
		} catch {
			// keep fallback
		}

		const dispatchScroll = async (pixels: number) => {
			await context.browserSession.eventBus.dispatch(
				BrowserEventNames.SCROLL,
				{ direction, amount: pixels, node, pageId: context.pageId },
				TIMEOUTS.SCROLL
			);
		};

		if (pages >= 1.0) {
			const numFullPages = Math.floor(pages);
			const remainingFraction = pages - numFullPages;
			let completedScrolls = 0;

			for (let i = 0; i < numFullPages; i++) {
				try {
					await dispatchScroll(viewportHeight);
					completedScrolls++;
					await sleep(SCROLL_STEP_DELAY_MS);
				} catch (e: any) {
					console.warn(`Scroll ${i + 1}/${numFullPages} failed: ${e?.message}`);
				}
			}

			if (remainingFraction > 0) {
				try {
					await dispatchScroll(Math.floor(remainingFraction * viewportHeight));
					completedScrolls += remainingFraction;
				} catch (e: any) {
					console.warn(`Fractional scroll failed: ${e?.message}`);
				}
			}

			const memory =
				pages === 1.0
					? `Scrolled ${direction} ${targetDesc} by one page (${viewportHeight}px)`
					: `Scrolled ${direction} ${targetDesc} by ${completedScrolls.toFixed(1)} pages (${Math.floor(completedScrolls * viewportHeight)}px total)`;
			console.info(`🔍 ${memory}`);
			return { extractedContent: memory, longTermMemory: memory };
		}

		const pixels = Math.floor(pages * viewportHeight);
		await dispatchScroll(pixels);
		const memory = `Scrolled ${direction} ${targetDesc} by ${pages} pages (${pixels}px)`;
		console.info(`🔍 ${memory}`);
		return { extractedContent: memory, longTermMemory: memory };
	} catch (error: any) {
		return { error: `Failed to scroll: ${error.message}` };
	}
}

async function sendKeys(params: z.infer<typeof SendKeysActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		await context.browserSession.eventBus.dispatch(
			BrowserEventNames.SEND_KEYS,
			{ ...params, pageId: context.pageId },
			TIMEOUTS.SEND_KEYS
		);
		const memory = `Sent keys: ${params.keys}`;
		return { extractedContent: memory, longTermMemory: memory };
	} catch (error: any) {
		return { error: `Failed to send keys: ${error.message}` };
	}
}

async function findText(params: z.infer<typeof FindTextActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		await context.browserSession.eventBus.dispatch(
			BrowserEventNames.SCROLL_TO_TEXT,
			{ text: params.text, pageId: context.pageId },
			TIMEOUTS.SCROLL_TO_TEXT
		);
		const memory = `Scrolled to text: ${params.text}`;
		return { extractedContent: memory, longTermMemory: memory };
	} catch {
		const msg = `Text '${params.text}' not found or not visible on page`;
		return {
			extractedContent: msg,
			longTermMemory: `Tried scrolling to text '${params.text}' but it was not found`,
		};
	}
}

// ============================================================================
// Tabs
// ============================================================================

async function switchTab(params: z.infer<typeof SwitchTabActionSchema>, context: ActionContext): Promise<ActionResult> {
	const targetId = await findTabByShortId(context, params.tab_id);
	if (!targetId) {
		const memory = `Failed to switch to tab #${params.tab_id}: no tab with that id`;
		console.warn(memory);
		return { error: memory };
	}
	try {
		await context.browserSession.eventBus.dispatch(
			BrowserEventNames.SWITCH_TAB,
			{ targetId },
			TIMEOUTS.SWITCH_TAB
		);
	} catch (error: any) {
		// Preserve the concrete cause so the agent gets actionable failure info
		const memory = `Failed to switch to tab #${params.tab_id}: ${error.message || String(error)}`;
		console.warn(memory);
		return { error: memory };
	}
	const memory = `Switched to tab #${targetId.slice(-4)}`;
	console.info(`🔄 ${memory}`);
	return { extractedContent: memory, longTermMemory: memory };
}

async function closeTab(params: z.infer<typeof CloseTabActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		const targetId = await findTabByShortId(context, params.tab_id);
		if (!targetId) {
			return {
				extractedContent: `Tab #${params.tab_id} closed (was already closed or invalid)`,
				longTermMemory: `Tab #${params.tab_id} closed`,
			};
		}
		await context.browserSession.eventBus.dispatch(BrowserEventNames.CLOSE_TAB, { targetId }, TIMEOUTS.CLOSE_TAB);
		const memory = `Closed tab #${params.tab_id}`;
		console.info(`🗑️ ${memory}`);
		return { extractedContent: memory, longTermMemory: memory };
	} catch (error: any) {
		return { error: `Failed to close tab: ${error.message}` };
	}
}

// ============================================================================
// Dropdowns
// ============================================================================

async function dropdownOptions(
	params: z.infer<typeof GetDropdownOptionsActionSchema>,
	context: ActionContext
): Promise<ActionResult> {
	try {
		const element = await getElementForContext(context, params.index);
		if (!element) {
			return { error: `Element with index ${params.index} not found` };
		}

		const result = await context.browserSession.eventBus.dispatch<any>(
			BrowserEventNames.GET_DROPDOWN_OPTIONS,
			{ node: element, pageId: context.pageId },
			TIMEOUTS.GET_DROPDOWN_OPTIONS
		);

		if (!result) {
			return { error: 'Failed to get dropdown options - no data returned' };
		}

		return {
			extractedContent: result.shortTermMemory || JSON.stringify(result),
			longTermMemory: result.longTermMemory || `Got dropdown options for element ${params.index}`,
			includeExtractedContentOnlyOnce: true,
		};
	} catch (error: any) {
		return { error: `Failed to get dropdown options: ${error.message}` };
	}
}

async function selectDropdown(
	params: z.infer<typeof SelectDropdownOptionActionSchema>,
	context: ActionContext
): Promise<ActionResult> {
	try {
		const element = await getElementForContext(context, params.index);
		if (!element) {
			return elementNotAvailable(params.index);
		}

		const result = await context.browserSession.eventBus.dispatch<any>(
			BrowserEventNames.SELECT_DROPDOWN_OPTION,
			{ node: element, text: params.text, pageId: context.pageId },
			TIMEOUTS.SELECT_DROPDOWN_OPTION
		);

		if (!result) {
			return { error: 'Failed to select dropdown option - no data returned' };
		}

		if (result.success === 'true' || result.success === true) {
			const msg = result.message || `Selected option: ${params.text}`;
			return {
				extractedContent: msg,
				longTermMemory: `Selected dropdown option '${params.text}' at index ${params.index}`,
			};
		}
		return { error: result.error || `Failed to select option: ${params.text}` };
	} catch (error: any) {
		return { error: `Failed to select dropdown option: ${error.message}` };
	}
}

// ============================================================================
// Files: upload, screenshot, PDF, filesystem
// ============================================================================

const FILE_PATH_NOT_AVAILABLE = (p: string) =>
	`File path ${p} is not available. To fix: The user must add this file path to the available_file_paths parameter when creating the Agent. Example: Agent(task="...", llm=llm, browser=browser, available_file_paths=["${p}"])`;

/**
 * Resolve the path the agent asked to upload.
 * Order: available_file_paths → session downloads → FileSystem-managed files (basename-based,
 * with traversal defence, GHSA-j9hj-92j8-jv9h). Returns an error result when not permitted.
 */
export function resolveUploadPath(
	requestedPath: string,
	options: {
		availableFilePaths?: string[] | null;
		downloadedFiles?: string[] | null;
		fileSystem?: Pick<FileSystem, 'getFile' | 'getDir'> | null;
	}
): { path: string } | { error: string } {
	const available = options.availableFilePaths ?? [];
	if (available.includes(requestedPath)) {
		return { path: requestedPath };
	}
	const downloads = options.downloadedFiles ?? [];
	if (downloads.includes(requestedPath)) {
		return { path: requestedPath };
	}
	const fileSystem = options.fileSystem;
	if (fileSystem && fileSystem.getDir()) {
		const fileObj = fileSystem.getFile(requestedPath);
		if (fileObj) {
			// Build the path from the FileSystem-owned basename, never from the agent-controlled input
			const fileSystemPath = path.join(fileSystem.getDir(), fileObj.fullName);
			if (!isPathInsideDir(fileSystemPath, fileSystem.getDir())) {
				return { error: `Upload of ${JSON.stringify(requestedPath)} escapes FileSystem directory; refusing.` };
			}
			return { path: fileSystemPath };
		}
	}
	return { error: FILE_PATH_NOT_AVAILABLE(requestedPath) };
}

/** Structural view of a DOM node with tree links (selector-map nodes carry these at runtime). */
type TreeNodeLike = EnhancedDOMTreeNode & {
	childrenNodes?: TreeNodeLike[] | null;
	parentNode?: TreeNodeLike | null;
};

/** Find a file input near the selected element (itself, descendants, ancestors and their descendants). */
export function findFileInputNearElement(
	node: TreeNodeLike,
	isFileInput: (n: TreeNodeLike) => boolean,
	maxHeight = 3,
	maxDescendantDepth = 3
): TreeNodeLike | null {
	const findInDescendants = (n: TreeNodeLike, depth: number): TreeNodeLike | null => {
		if (depth < 0) return null;
		if (isFileInput(n)) return n;
		for (const child of n.childrenNodes ?? []) {
			const found = findInDescendants(child, depth - 1);
			if (found) return found;
		}
		return null;
	};

	let current: TreeNodeLike | null | undefined = node;
	for (let i = 0; i <= maxHeight && current; i++) {
		if (isFileInput(current)) return current;
		const inDescendants = findInDescendants(current, maxDescendantDepth);
		if (inDescendants) return inDescendants;
		if (current.parentNode) {
			for (const sibling of current.parentNode.childrenNodes ?? []) {
				if (sibling === current) continue;
				if (isFileInput(sibling)) return sibling;
				const found = findInDescendants(sibling, maxDescendantDepth);
				if (found) return found;
			}
		}
		current = current.parentNode;
	}
	return null;
}

async function uploadFile(params: z.infer<typeof UploadFileActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		const resolved = resolveUploadPath(params.path, {
			availableFilePaths: context.availableFilePaths,
			downloadedFiles: context.browserSession.downloadedFiles,
			fileSystem: context.fileSystem,
		});
		if ('error' in resolved) {
			console.error(`❌ ${resolved.error}`);
			return { error: resolved.error };
		}
		const filePath = resolved.path;

		// Local browser: the file must exist and have content
		if (!fs.existsSync(filePath)) {
			return { error: `File ${filePath} does not exist` };
		}
		if (fs.statSync(filePath).size === 0) {
			return { error: `File ${filePath} is empty (0 bytes). The file may not have been saved correctly.` };
		}

		const element = await getElementForContext(context, params.index);
		if (!element) {
			return { error: `Element with index ${params.index} not found` };
		}
		const selectorMap = await getSelectorMapForContext(context);
		const isFileInput = (n: EnhancedDOMTreeNode) => context.browserSession.isFileInput(n);

		// Try to find a file input element near the selected element
		let fileInputNode: EnhancedDOMTreeNode | null = findFileInputNearElement(element as TreeNodeLike, isFileInput);

		// Fallback: the file input closest to the current scroll position
		if (!fileInputNode && selectorMap) {
			let scrollY = 0;
			try {
				scrollY = await getPageForContext(context).evaluate(() => window.scrollY || 0);
			} catch {
				// keep 0
			}
			let closest: EnhancedDOMTreeNode | null = null;
			let minDistance = Infinity;
			for (const candidate of selectorMap.values()) {
				if (!isFileInput(candidate)) continue;
				const distance = Math.abs((candidate.absolutePosition?.y ?? 0) - scrollY);
				if (distance < minDistance) {
					minDistance = distance;
					closest = candidate;
				}
			}
			if (closest) {
				fileInputNode = closest;
				console.info(`Found file input closest to scroll position (distance: ${minDistance}px)`);
			}
		}

		if (!fileInputNode) {
			const msg = 'No file upload element found on the page';
			console.error(msg);
			return { error: msg };
		}

		context.browserSession.highlightInteractionElement(fileInputNode, context.pageId).catch(() => {});

		await context.browserSession.eventBus.dispatch(
			BrowserEventNames.UPLOAD_FILE,
			{ node: fileInputNode, filePath, pageId: context.pageId },
			TIMEOUTS.UPLOAD_FILE
		);

		const msg = `Successfully uploaded file to index ${params.index}`;
		console.info(`📁 ${msg}`);
		return { extractedContent: msg, longTermMemory: `Uploaded file ${filePath} to element ${params.index}` };
	} catch (error: any) {
		return { error: `Failed to upload file: ${error.message}` };
	}
}

async function screenshot(params: z.infer<typeof ScreenshotActionSchema>, context: ActionContext): Promise<ActionResult> {
	if (params.file_name) {
		if (!context.fileSystem) {
			return noFileSystem();
		}
		try {
			const fileName = FileSystem.sanitizeFilename(ensureExtension(params.file_name, '.png'));
			const buffer = await getPageForContext(context).screenshot({ fullPage: false, type: 'png' });
			const filePath = path.join(context.fileSystem.getDir(), fileName);
			fs.writeFileSync(filePath, buffer);

			const result = `Screenshot saved to ${fileName}`;
			console.info(`📸 ${result}. Full path: ${filePath}`);
			return {
				extractedContent: result,
				longTermMemory: `${result}. Full path: ${filePath}`,
				attachments: [filePath],
			};
		} catch (error: any) {
			return { error: `Failed to take screenshot: ${error.message}` };
		}
	}

	// Flag for next observation
	const memory = 'Requested screenshot for next observation';
	console.info(`📸 ${memory}`);
	return { extractedContent: memory, metadata: { includeScreenshot: true } };
}

async function saveAsPdf(params: z.infer<typeof SaveAsPdfActionSchema>, context: ActionContext): Promise<ActionResult> {
	if (!context.fileSystem) {
		return noFileSystem();
	}
	try {
		const [paperWidth, paperHeight] = resolvePaperSize(params.paper_format);
		const pdfParams: Record<string, any> = {
			printBackground: params.print_background ?? true,
			landscape: params.landscape ?? false,
			scale: params.scale ?? 1.0,
			paperWidth,
			paperHeight,
			preferCSSPageSize: true,
		};

		if (params.display_header_footer ?? true) {
			// Chrome clips the header/footer unless the page leaves vertical room for them
			Object.assign(pdfParams, {
				displayHeaderFooter: true,
				headerTemplate: params.header_template ?? DEFAULT_PDF_HEADER_TEMPLATE,
				footerTemplate: params.footer_template ?? DEFAULT_PDF_FOOTER_TEMPLATE,
				marginTop: 0.5,
				marginBottom: 0.5,
				marginLeft: 0.4,
				marginRight: 0.4,
			});
		}

		const cdpSession = await getCdpForContext(context);
		let printTimer: ReturnType<typeof setTimeout> | undefined;
		const result = (await Promise.race([
			cdpSession.send('Page.printToPDF', pdfParams),
			new Promise<never>((_, reject) => {
				printTimer = setTimeout(() => reject(new Error('Page.printToPDF timed out')), PDF_PRINT_TIMEOUT_MS);
			}),
		]).finally(() => printTimer && clearTimeout(printTimer))) as { data?: string };

		if (!result?.data) {
			throw new Error('CDP Page.printToPDF returned no data');
		}
		const pdfBytes = Buffer.from(result.data, 'base64');

		let fileName: string;
		if (params.file_name) {
			fileName = params.file_name;
		} else {
			let title = '';
			try {
				title = await getPageForContext(context).title();
			} catch {
				title = '';
			}
			fileName = pdfFileNameFromTitle(title);
		}
		fileName = FileSystem.sanitizeFilename(ensureExtension(fileName, '.pdf'));

		const dir = context.fileSystem.getDir();
		fileName = uniqueFileName(dir, fileName);
		const filePath = path.join(dir, fileName);
		fs.writeFileSync(filePath, pdfBytes);

		const msg = `Saved page as PDF: ${fileName} (${pdfBytes.length.toLocaleString('en-US')} bytes)`;
		console.info(`📄 ${msg}. Full path: ${filePath}`);
		return {
			extractedContent: msg,
			longTermMemory: `${msg}. Full path: ${filePath}`,
			attachments: [filePath],
		};
	} catch (error: any) {
		return { error: `Failed to save page as PDF: ${error.message}` };
	}
}

async function writeFile(params: z.infer<typeof WriteFileActionSchema>, context: ActionContext): Promise<ActionResult> {
	if (!context.fileSystem) {
		return noFileSystem();
	}
	try {
		let content = params.content;
		if (params.trailing_newline !== false) {
			content += '\n';
		}
		if (params.leading_newline === true) {
			content = '\n' + content;
		}

		const result = params.append
			? await context.fileSystem.appendFile(params.file_name, content)
			: await context.fileSystem.writeFile(params.file_name, content);

		console.info(`💾 ${result} File location: ${path.join(context.fileSystem.getDir(), FileSystem.sanitizeFilename(params.file_name))}`);
		return { extractedContent: result, longTermMemory: result };
	} catch (error: any) {
		return { error: `Failed to write file: ${error.message}` };
	}
}

async function replaceFile(params: z.infer<typeof ReplaceFileActionSchema>, context: ActionContext): Promise<ActionResult> {
	if (!context.fileSystem) {
		return noFileSystem();
	}
	try {
		const result = await context.fileSystem.replaceFileStr(params.file_name, params.old_str, params.new_str);
		console.info(`💾 ${result}`);
		return { extractedContent: result, longTermMemory: result };
	} catch (error: any) {
		return { error: `Failed to replace in file: ${error.message}` };
	}
}

async function readFile(params: z.infer<typeof ReadFileActionSchema>, context: ActionContext): Promise<ActionResult> {
	if (!context.fileSystem) {
		return noFileSystem();
	}
	try {
		const isExternal = context.availableFilePaths?.includes(params.file_name) ?? false;
		const structured = await context.fileSystem.readFileStructured(params.file_name, isExternal);
		const result = structured.message;
		const images = structured.images && structured.images.length > 0 ? structured.images : null;

		const memory = images && images.length > 0 ? `Read image file ${params.file_name}` : summarizeForMemory(result, 1000);
		console.info(`💾 ${memory}`);

		return {
			extractedContent: result,
			longTermMemory: memory,
			images,
			includeExtractedContentOnlyOnce: true,
		};
	} catch (error: any) {
		return { error: `Failed to read file: ${error.message}` };
	}
}

// ============================================================================
// JavaScript, extraction, page search
// ============================================================================

async function evaluate(params: z.infer<typeof EvaluateActionSchema>, context: ActionContext): Promise<ActionResult> {
	const validatedCode = validateAndFixJavaScript(params.code);
	try {
		const page = getPageForContext(context);
		const result = await page.evaluate(validatedCode);

		let resultText: string;
		if (result === undefined) {
			resultText = 'undefined';
		} else if (result === null) {
			resultText = 'null';
		} else if (typeof result === 'object') {
			try {
				resultText = JSON.stringify(result, null, 2);
			} catch {
				resultText = String(result);
			}
		} else {
			resultText = String(result);
		}

		// Inline base64 images become ContentPartImageParam via metadata.images
		const { text, images } = extractDataImages(resultText);
		resultText = text;
		const metadata = images.length > 0 ? { images } : null;

		if (resultText.length > EVALUATE_MAX_RESULT_CHARS) {
			resultText = resultText.substring(0, EVALUATE_MAX_RESULT_CHARS - 50) + '\n... [Truncated after 20000 characters]';
		}
		console.debug(`JavaScript executed successfully, result length: ${resultText.length}`);

		// Full result for the current step, summary in long-term memory when large
		let memory: string;
		let includeExtractedContentOnlyOnce: boolean;
		if (resultText.length < EVALUATE_MAX_MEMORY_LENGTH) {
			memory = resultText;
			includeExtractedContentOnlyOnce = false;
		} else {
			memory = `JavaScript executed successfully, result length: ${resultText.length} characters.`;
			includeExtractedContentOnlyOnce = true;
		}

		return { extractedContent: resultText, longTermMemory: memory, includeExtractedContentOnlyOnce, metadata };
	} catch (error: any) {
		const errorMsg = error.message || String(error);
		const enhancedMsg = `JavaScript Execution Failed:\n${errorMsg}\n\nValidated Code (after quote fixing):\n${validatedCode.substring(0, 500)}${validatedCode.length > 500 ? '...' : ''}`;
		return { error: enhancedMsg };
	}
}

interface PageMarkdownResult {
	content: string;
	originalHtmlChars: number;
	initialMarkdownChars: number;
	finalFilteredChars: number;
}

/** In-page markdown extraction (fork equivalent of `extract_clean_markdown`). */
async function extractPageMarkdown(
	context: ActionContext,
	options: { extractLinks: boolean; extractImages: boolean }
): Promise<PageMarkdownResult> {
	const page = getPageForContext(context);
	return page.evaluate(({ includeLinks, includeImages }: { includeLinks: boolean; includeImages: boolean }) => {
		const SKIPPED = ['script', 'style', 'noscript', 'svg', 'path', 'iframe', 'template'];

		function toMarkdown(el: HTMLElement, depth = 0): string {
			if (depth > 25) return '';
			const tagName = el.tagName?.toLowerCase();
			if (!tagName || SKIPPED.includes(tagName)) return '';

			try {
				const style = window.getComputedStyle(el);
				if (style.display === 'none' || style.visibility === 'hidden') return '';
			} catch {
				// getComputedStyle can fail on some elements
			}

			if (tagName === 'img') {
				if (!includeImages) return '';
				const src = (el as HTMLImageElement).currentSrc || el.getAttribute('src') || '';
				if (!src || src.startsWith('data:')) return '';
				const alt = (el.getAttribute('alt') || '').trim();
				return `![${alt}](${src})\n`;
			}

			if (/^h[1-6]$/.test(tagName)) {
				const level = parseInt(tagName[1], 10);
				const heading = el.innerText.trim();
				return heading ? `\n${'#'.repeat(level)} ${heading}\n` : '';
			}

			if (tagName === 'p') {
				const pText = el.innerText.trim();
				return pText ? `\n${pText}\n` : '';
			}

			if (tagName === 'a' && includeLinks) {
				const href = (el as HTMLAnchorElement).href || el.getAttribute('href') || '';
				const linkText = el.innerText.trim();
				if (href && linkText && !href.startsWith('javascript:')) {
					return `[${linkText}](${href})`;
				}
			}

			if (tagName === 'li') {
				const liText = el.innerText.trim();
				return liText ? `- ${liText}\n` : '';
			}

			if (tagName === 'table') {
				const rows = Array.from(el.querySelectorAll('tr'));
				const lines: string[] = [];
				rows.forEach((row, rowIndex) => {
					const cells = Array.from(row.querySelectorAll('th, td')).map((c) =>
						((c as HTMLElement).innerText || '').trim().replace(/\|/g, '\\|').replace(/\s+/g, ' ')
					);
					if (cells.length === 0) return;
					lines.push(`| ${cells.join(' | ')} |`);
					if (rowIndex === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
				});
				return lines.length ? `\n${lines.join('\n')}\n` : '';
			}

			let text = '';
			for (const child of Array.from(el.children)) {
				text += toMarkdown(child as HTMLElement, depth + 1);
			}
			if (text === '' && ['div', 'span', 'section', 'article', 'main', 'td', 'th', 'label', 'button'].includes(tagName)) {
				const directText = el.innerText?.trim() ?? '';
				if (directText.length > 2) {
					text = directText + '\n';
				}
			}
			return text;
		}

		const originalHtml = document.documentElement.outerHTML;
		const extracted = document.body ? toMarkdown(document.body) : '';
		const cleaned = extracted
			.replace(/\n{3,}/g, '\n\n')
			.replace(/[ \t]+/g, ' ')
			.trim();

		return {
			content: cleaned,
			originalHtmlChars: originalHtml.length,
			initialMarkdownChars: extracted.length,
			finalFilteredChars: cleaned.length,
		};
	}, { includeLinks: options.extractLinks, includeImages: options.extractImages });
}

async function extract(params: z.infer<typeof ExtractActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		const llm = context.pageExtractionLlm || context.llm;
		if (!llm) {
			return { error: 'No LLM available for extraction. Neither pageExtractionLlm nor main llm configured.' };
		}

		const query = sanitizeSurrogates(params.query);
		const extractLinks = params.extract_links ?? false;
		const extractImages = shouldExtractImages(query, params.extract_images ?? false);
		const startFromChar = params.start_from_char ?? 0;
		const alreadyCollected = params.already_collected ?? [];

		// Structured output: the agent-injected schema. Invalid schemas fall back to free text.
		let outputSchema: Record<string, any> | null = context.extractionSchema ?? null;
		let structuredModel: z.ZodTypeAny | null = null;
		if (outputSchema) {
			try {
				structuredModel = schemaDictToZod(outputSchema);
			} catch (exc: any) {
				console.warn(`Invalid output_schema, falling back to free-text extraction: ${exc?.message ?? exc}`);
				outputSchema = null;
			}
		}

		const page = getPageForContext(context);
		const currentUrl = page.url();

		let markdown: PageMarkdownResult;
		try {
			markdown = await extractPageMarkdown(context, { extractLinks, extractImages });
		} catch (error: any) {
			return { error: `Could not extract clean markdown: ${error?.name ?? 'Error'}` };
		}

		const contentStats: Record<string, unknown> = {
			original_html_chars: markdown.originalHtmlChars,
			initial_markdown_chars: markdown.initialMarkdownChars,
			filtered_chars_removed: markdown.initialMarkdownChars - markdown.finalFilteredChars,
			final_filtered_chars: markdown.finalFilteredChars,
		};

		// Structure-aware chunking replaces naive char-based truncation
		const chunks = chunkMarkdownByStructure(markdown.content, {
			maxChunkChars: EXTRACT_MAX_CHAR_LIMIT,
			startFromChar,
		});
		if (chunks.length === 0) {
			return {
				error: `start_from_char (${startFromChar}) exceeds content length ${markdown.finalFilteredChars} characters.`,
			};
		}
		const chunk = chunks[0];
		let content = chunk.content;
		const truncated = chunk.hasMore;
		if (chunk.overlapPrefix) {
			content = chunk.overlapPrefix + '\n' + content;
		}
		if (startFromChar > 0) {
			contentStats.started_from_char = startFromChar;
		}
		if (truncated) {
			contentStats.truncated_at_char = chunk.charOffsetEnd;
			contentStats.next_start_char = chunk.charOffsetEnd;
			contentStats.chunk_index = chunk.chunkIndex;
			contentStats.total_chunks = chunk.totalChunks;
		}

		const fmt = (n: number) => n.toLocaleString('en-US');
		let statsSummary = `Content processed: ${fmt(markdown.originalHtmlChars)} HTML chars → ${fmt(markdown.finalFilteredChars)} filtered markdown chars`;
		if (startFromChar > 0) {
			statsSummary += ` (started from char ${fmt(startFromChar)})`;
		}
		if (truncated) {
			statsSummary += ` → ${fmt(content.length)} final chars (chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}, use start_from_char=${chunk.charOffsetEnd} to continue)`;
		} else if (markdown.initialMarkdownChars - markdown.finalFilteredChars > 0) {
			statsSummary += ` (filtered ${fmt(markdown.initialMarkdownChars - markdown.finalFilteredChars)} chars of noise)`;
		}

		content = sanitizeSurrogates(content);
		const alreadyCollectedSection = buildAlreadyCollectedSection(alreadyCollected);

		const invokeWithTimeout = async <T>(run: () => Promise<T>): Promise<T> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					run(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error('LLM extraction timeout')), EXTRACT_LLM_TIMEOUT_MS);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		};

		const buildMemory = async (extractedContent: string): Promise<{ memory: string; onlyOnce: boolean }> => {
			if (extractedContent.length < EXTRACT_MAX_MEMORY_LENGTH) {
				return { memory: extractedContent, onlyOnce: false };
			}
			if (context.fileSystem) {
				try {
					const fileName = await context.fileSystem.saveExtractedContent(extractedContent);
					return { memory: `Query: ${query}\nContent in ${fileName} and once in <read_state>.`, onlyOnce: true };
				} catch {
					// fall through
				}
			}
			return { memory: `Query: ${query}\nExtracted ${extractedContent.length} chars (see <read_state>).`, onlyOnce: true };
		};

		// --- Structured extraction path ---
		if (structuredModel && outputSchema) {
			const prompt =
				`<query>\n${query}\n</query>\n\n` +
				`<output_schema>\n${JSON.stringify(outputSchema, null, 2)}\n</output_schema>\n\n` +
				`<content_stats>\n${statsSummary}\n</content_stats>\n\n` +
				`<webpage_content>\n${content}\n</webpage_content>` +
				alreadyCollectedSection;

			const response = await invokeWithTimeout(() =>
				llm.ainvoke<any>(
					[createSystemMessage(EXTRACT_STRUCTURED_SYSTEM_PROMPT), createUserMessage(prompt)],
					structuredModel as z.ZodType<any>
				)
			);
			const resultData: Record<string, unknown> =
				typeof response.completion === 'string' ? JSON.parse(response.completion) : (response.completion as Record<string, unknown>);
			const resultJson = JSON.stringify(resultData);
			const extractedContent = `<url>\n${currentUrl}\n</url>\n<query>\n${query}\n</query>\n<structured_result>\n${resultJson}\n</structured_result>`;

			const extractionMeta = createExtractionResult({
				data: resultData,
				schemaUsed: outputSchema,
				isPartial: truncated,
				sourceUrl: currentUrl,
				contentStats,
			});
			const { memory, onlyOnce } = await buildMemory(extractedContent);
			console.info(`📄 ${memory}`);
			return {
				extractedContent,
				includeExtractedContentOnlyOnce: onlyOnce,
				longTermMemory: memory,
				metadata: { structured_extraction: true, extraction_result: extractionMeta },
			};
		}

		// --- Free-text extraction path (default) ---
		const prompt =
			`<query>\n${query}\n</query>\n\n<content_stats>\n${statsSummary}\n</content_stats>\n\n<webpage_content>\n${content}\n</webpage_content>` +
			alreadyCollectedSection;

		const response = await invokeWithTimeout(() =>
			llm.ainvoke([createSystemMessage(EXTRACT_FREE_TEXT_SYSTEM_PROMPT), createUserMessage(prompt)])
		);
		const completion = typeof response.completion === 'string' ? response.completion : JSON.stringify(response.completion);
		const extractedContent = `<url>\n${currentUrl}\n</url>\n<query>\n${query}\n</query>\n<result>\n${completion}\n</result>`;

		const { memory, onlyOnce } = await buildMemory(extractedContent);
		console.info(`📄 ${memory}`);
		return { extractedContent, includeExtractedContentOnlyOnce: onlyOnce, longTermMemory: memory };
	} catch (error: any) {
		console.error(`❌ [Extract] Action failed:`, error?.message);
		return { error: `Extract action failed: ${error?.message ?? String(error)}` };
	}
}

async function searchPage(params: z.infer<typeof SearchPageActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		const page = getPageForContext(context);
		const pattern = params.pattern;
		const isRegex = params.regex ?? false;
		const caseSensitive = params.case_sensitive ?? false;
		const contextChars = params.context_chars ?? 150;
		const cssScope = params.css_scope ?? null;
		const maxResults = params.max_results ?? 25;

		const result = await page.evaluate(
			({ pattern, isRegex, caseSensitive, contextChars, cssScope, maxResults }) => {
				function getPath(el: Element | null): string {
					const parts: string[] = [];
					let current = el;
					while (current && current !== document.body && current !== document.documentElement) {
						let desc = current.tagName ? current.tagName.toLowerCase() : '';
						if (!desc) break;
						if (current.id) desc += '#' + current.id;
						else if (current.className && typeof current.className === 'string') {
							const classes = current.className.trim().split(/\s+/).slice(0, 2).join('.');
							if (classes) desc += '.' + classes;
						}
						parts.unshift(desc);
						current = current.parentElement;
					}
					return parts.join(' > ');
				}

				try {
					const scope = cssScope ? document.querySelector(cssScope) : document.body;
					if (!scope) {
						return { error: 'CSS scope selector not found: ' + cssScope, matches: [], total: 0 };
					}

					const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
					let fullText = '';
					const nodeOffsets: { offset: number; length: number; node: Node }[] = [];
					while (walker.nextNode()) {
						const node = walker.currentNode;
						const text = node.textContent;
						if (text && text.trim()) {
							nodeOffsets.push({ offset: fullText.length, length: text.length, node });
							fullText += text;
						}
					}

					let re: RegExp;
					try {
						const flags = caseSensitive ? 'g' : 'gi';
						re = isRegex ? new RegExp(pattern, flags) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
					} catch (e: any) {
						return { error: 'Invalid regex pattern: ' + e.message, matches: [], total: 0 };
					}

					const matches: { match_text: string; context: string; element_path: string; char_position: number }[] = [];
					let match: RegExpExecArray | null;
					let totalFound = 0;
					while ((match = re.exec(fullText)) !== null) {
						totalFound++;
						if (matches.length < maxResults) {
							const start = Math.max(0, match.index - contextChars);
							const end = Math.min(fullText.length, match.index + match[0].length + contextChars);
							let elementPath = '';
							for (const no of nodeOffsets) {
								if (no.offset <= match.index && no.offset + no.length > match.index) {
									elementPath = getPath(no.node.parentElement);
									break;
								}
							}
							matches.push({
								match_text: match[0],
								context: (start > 0 ? '...' : '') + fullText.slice(start, end) + (end < fullText.length ? '...' : ''),
								element_path: elementPath,
								char_position: match.index,
							});
						}
						if (match[0].length === 0) re.lastIndex++;
					}
					return { matches, total: totalFound, has_more: totalFound > maxResults };
				} catch (e: any) {
					return { error: 'search_page error: ' + e.message, matches: [], total: 0 };
				}
			},
			{ pattern, isRegex, caseSensitive, contextChars, cssScope, maxResults }
		);

		if (!result) {
			return { error: 'search_page returned no result' };
		}
		if (result.error) {
			return { error: `search_page: ${result.error}` };
		}

		const total = result.total ?? 0;
		const memory = `Searched page for "${pattern}": ${total} match${total !== 1 ? 'es' : ''} found.`;
		console.info(`🔎 ${memory}`);
		return { extractedContent: formatSearchResults(result, pattern), longTermMemory: memory };
	} catch (error: any) {
		return { error: `search_page failed: ${error.message}` };
	}
}

async function findElements(params: z.infer<typeof FindElementsActionSchema>, context: ActionContext): Promise<ActionResult> {
	try {
		const page = getPageForContext(context);
		const selector = params.selector;
		const attributes = params.attributes ?? null;
		const maxResults = params.max_results ?? 50;
		const includeText = params.include_text ?? true;

		const result = await page.evaluate(
			({ selector, attributes, maxResults, includeText }) => {
				try {
					let elements: NodeListOf<Element>;
					try {
						elements = document.querySelectorAll(selector);
					} catch (e: any) {
						return { error: 'Invalid CSS selector: ' + e.message, elements: [], total: 0 };
					}

					const total = elements.length;
					const limit = Math.min(total, maxResults);
					const results: { index: number; tag: string; text?: string; attrs?: Record<string, string>; children_count: number }[] = [];

					for (let i = 0; i < limit; i++) {
						const el = elements[i];
						const item: { index: number; tag: string; text?: string; attrs?: Record<string, string>; children_count: number } = {
							index: i,
							tag: el.tagName.toLowerCase(),
							children_count: el.children.length,
						};
						if (includeText) {
							const text = (el.textContent || '').trim();
							item.text = text.length > 300 ? text.slice(0, 300) + '...' : text;
						}
						if (attributes && attributes.length > 0) {
							item.attrs = {};
							for (const attrName of attributes) {
								let val: string | null;
								// Resolved DOM property for src/href gives absolute URLs
								const prop = (el as any)[attrName];
								if ((attrName === 'src' || attrName === 'href') && typeof prop === 'string' && prop !== '') {
									val = prop;
								} else {
									val = el.getAttribute(attrName);
								}
								if (val !== null) {
									item.attrs[attrName] = val.length > 500 ? val.slice(0, 500) + '...' : val;
								}
							}
						}
						results.push(item);
					}
					return { elements: results, total, showing: limit };
				} catch (e: any) {
					return { error: 'find_elements error: ' + e.message, elements: [], total: 0 };
				}
			},
			{ selector, attributes, maxResults, includeText }
		);

		if (!result) {
			return { error: 'find_elements returned no result' };
		}
		if (result.error) {
			return { error: `find_elements: ${result.error}` };
		}

		const total = result.total ?? 0;
		const memory = `Found ${total} element${total !== 1 ? 's' : ''} matching "${selector}".`;
		console.info(`🔍 ${memory}`);
		return { extractedContent: formatFindResults(result, selector), longTermMemory: memory };
	} catch (error: any) {
		return { error: `find_elements failed: ${error.message}` };
	}
}

// ============================================================================
// Done
// ============================================================================

/**
 * Attachments for `done`: explicitly requested files (resolved through the FileSystem)
 * plus browser downloads tracked by the session, de-duplicated.
 */
export function collectDoneAttachments(
	filesToDisplay: string[] | null | undefined,
	fileSystem: Pick<FileSystem, 'displayFile' | 'getDir'> | null | undefined,
	downloadedFiles: string[] | null | undefined
): string[] {
	const attachments: string[] = [];
	if (filesToDisplay && fileSystem) {
		for (const fileName of filesToDisplay) {
			if (fileSystem.displayFile(fileName)) {
				attachments.push(path.join(fileSystem.getDir(), fileName));
			}
		}
	}
	for (const filePath of downloadedFiles ?? []) {
		if (!attachments.includes(filePath)) {
			attachments.push(filePath);
		}
	}
	return attachments;
}

async function done(params: z.infer<typeof DoneActionSchema>, context: ActionContext): Promise<ActionResult> {
	let userMessage = params.text;
	const attachments = collectDoneAttachments(
		params.files_to_display,
		context.fileSystem,
		context.browserSession?.downloadedFiles
	);

	if (params.files_to_display && params.files_to_display.length > 0 && context.fileSystem) {
		const displayed: string[] = [];
		for (const fileName of params.files_to_display) {
			const fileContent = context.fileSystem.displayFile(fileName);
			if (fileContent) {
				displayed.push(`\n\n${fileName}:\n${fileContent}`);
			}
		}
		if (displayed.length > 0) {
			userMessage += `\n\nAttachments:${displayed.join('')}`;
		}
	}

	return {
		isDone: true,
		success: params.success ?? true,
		extractedContent: userMessage,
		longTermMemory: `Task completed: ${params.success ?? true} - ${params.text.slice(0, 100)}`,
		attachments,
	};
}

// ============================================================================
// Registration
// ============================================================================

export interface BuiltinActionOptions {
	/**
	 * Register `click` with coordinate support (index OR coordinate_x/coordinate_y).
	 * Off by default; enabled by the agent for models that click by coordinates.
	 */
	coordinateClicking?: boolean;
}

/**
 * (Re-)register the `click` action with or without coordinate support.
 */
export function setCoordinateClicking(registry: ActionRegistry, enabled: boolean): void {
	const current = registry.getAction('click');
	const currentlyEnabled = current?.paramSchema === ClickElementActionSchema;
	if (current && currentlyEnabled === enabled) {
		return;
	}
	registry.unregister('click');
	if (enabled) {
		registry.register({
			name: 'click',
			description: ACTION_DESCRIPTIONS.click_with_coordinates,
			function: clickWithCoordinates,
			paramSchema: ClickElementActionSchema,
		});
	} else {
		registry.register({
			name: 'click',
			description: ACTION_DESCRIPTIONS.click_index_only,
			function: clickIndexOnly,
			paramSchema: ClickElementActionIndexOnlySchema,
		});
	}
	console.debug(`Coordinate clicking ${enabled ? 'enabled' : 'disabled'}`);
}

export function registerBuiltinActions(registry: ActionRegistry, options: BuiltinActionOptions = {}): void {
	// Navigation
	registry.register({
		name: 'search',
		description: ACTION_DESCRIPTIONS.search,
		function: search,
		paramSchema: SearchActionSchema,
		terminatesSequence: true,
	});
	registry.register({
		name: 'navigate',
		description: ACTION_DESCRIPTIONS.navigate,
		function: navigate,
		paramSchema: NavigateActionSchema,
		terminatesSequence: true,
	});
	registry.register({
		name: 'go_back',
		description: ACTION_DESCRIPTIONS.go_back,
		function: goBack,
		paramSchema: NoParamsActionSchema,
		terminatesSequence: true,
	});
	registry.register({
		name: 'go_forward',
		description: ACTION_DESCRIPTIONS.go_forward,
		function: goForward,
		paramSchema: NoParamsActionSchema,
	});
	registry.register({
		name: 'refresh',
		description: ACTION_DESCRIPTIONS.refresh,
		function: refresh,
		paramSchema: NoParamsActionSchema,
	});
	registry.register({
		name: 'wait',
		description: ACTION_DESCRIPTIONS.wait,
		function: wait,
		paramSchema: WaitActionSchema,
	});

	// Element interaction
	setCoordinateClicking(registry, options.coordinateClicking ?? false);
	registry.register({
		name: 'input',
		description: ACTION_DESCRIPTIONS.input,
		function: typeText,
		paramSchema: InputTextActionSchema,
	});
	registry.register({
		name: 'upload_file',
		description: ACTION_DESCRIPTIONS.upload_file,
		function: uploadFile,
		paramSchema: UploadFileActionSchema,
	});

	// Tabs
	registry.register({
		name: 'switch',
		description: ACTION_DESCRIPTIONS.switch,
		function: switchTab,
		paramSchema: SwitchTabActionSchema,
		terminatesSequence: true,
	});
	registry.register({
		name: 'close',
		description: ACTION_DESCRIPTIONS.close,
		function: closeTab,
		paramSchema: CloseTabActionSchema,
	});

	// Content
	registry.register({
		name: 'extract',
		description: ACTION_DESCRIPTIONS.extract,
		function: extract,
		paramSchema: ExtractActionSchema,
	});
	registry.register({
		name: 'search_page',
		description: ACTION_DESCRIPTIONS.search_page,
		function: searchPage,
		paramSchema: SearchPageActionSchema,
	});
	registry.register({
		name: 'find_elements',
		description: ACTION_DESCRIPTIONS.find_elements,
		function: findElements,
		paramSchema: FindElementsActionSchema,
	});
	registry.register({
		name: 'scroll',
		description: ACTION_DESCRIPTIONS.scroll,
		function: scroll,
		paramSchema: ScrollActionSchema,
	});
	registry.register({
		name: 'send_keys',
		description: ACTION_DESCRIPTIONS.send_keys,
		function: sendKeys,
		paramSchema: SendKeysActionSchema,
	});
	registry.register({
		name: 'find_text',
		description: ACTION_DESCRIPTIONS.find_text,
		function: findText,
		paramSchema: FindTextActionSchema,
	});
	registry.register({
		name: 'screenshot',
		description: ACTION_DESCRIPTIONS.screenshot,
		function: screenshot,
		paramSchema: ScreenshotActionSchema,
	});
	registry.register({
		name: 'save_as_pdf',
		description: ACTION_DESCRIPTIONS.save_as_pdf,
		function: saveAsPdf,
		paramSchema: SaveAsPdfActionSchema,
	});

	// Dropdowns
	registry.register({
		name: 'dropdown_options',
		description: ACTION_DESCRIPTIONS.dropdown_options,
		function: dropdownOptions,
		paramSchema: GetDropdownOptionsActionSchema,
	});
	registry.register({
		name: 'select_dropdown',
		description: ACTION_DESCRIPTIONS.select_dropdown,
		function: selectDropdown,
		paramSchema: SelectDropdownOptionActionSchema,
	});

	// File system
	registry.register({
		name: 'write_file',
		description: ACTION_DESCRIPTIONS.write_file,
		function: writeFile,
		paramSchema: WriteFileActionSchema,
	});
	registry.register({
		name: 'replace_file',
		description: ACTION_DESCRIPTIONS.replace_file,
		function: replaceFile,
		paramSchema: ReplaceFileActionSchema,
	});
	registry.register({
		name: 'read_file',
		description: ACTION_DESCRIPTIONS.read_file,
		function: readFile,
		paramSchema: ReadFileActionSchema,
	});

	// JavaScript
	registry.register({
		name: 'evaluate',
		description: ACTION_DESCRIPTIONS.evaluate,
		function: evaluate,
		paramSchema: EvaluateActionSchema,
		terminatesSequence: true,
	});

	// Done
	registry.register({
		name: 'done',
		description: ACTION_DESCRIPTIONS.done,
		function: done,
		paramSchema: DoneActionSchema,
	});
}

/**
 * Utility functions shared by the browser tools.
 * Port of browser_use/tools/utils.py plus the module-level helpers of
 * browser_use/tools/service.py (Python browser-use 0.13.10).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnhancedDOMTreeNode } from '../dom/views.js';
import { getAllChildrenText, getChildren, getTagName } from '../dom/views.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Default header/footer templates for save_as_pdf, mirroring the metadata that
 * Chrome's own Print dialog renders by default: the date in the header and the
 * page URL + page numbers in the footer. Chrome injects values into elements
 * bearing the magic classes `date`, `title`, `url`, `pageNumber` and `totalPages`.
 * A font-size MUST be set explicitly — Chrome defaults header/footer text to 0px,
 * so omitting it renders an invisible (blank) header/footer.
 */
export const DEFAULT_PDF_HEADER_TEMPLATE =
	'<div style="font-size:9px; color:#666; width:100%; padding:0 0.4in; ' +
	'box-sizing:border-box; text-align:right;"><span class="date"></span></div>';

export const DEFAULT_PDF_FOOTER_TEMPLATE =
	'<div style="font-size:9px; color:#666; width:100%; padding:0 0.4in; ' +
	'box-sizing:border-box; display:flex; justify-content:space-between;">' +
	// A flex item defaults to min-width:auto and won't shrink below its content,
	// so a long/unbroken URL would overflow and push the page count off-page.
	// min-width:0 + ellipsis lets the URL truncate while page numbers stay put.
	'<span class="url" style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>' +
	'<span style="flex-shrink:0; padding-left:8px;"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>';

/** Paper format dimensions in inches (width, height). */
export const PDF_PAPER_SIZES: Record<string, [number, number]> = {
	letter: [8.5, 11],
	legal: [8.5, 14],
	a4: [8.27, 11.69],
	a3: [11.69, 16.54],
	tabloid: [11, 17],
};

/**
 * Global per-action timeout: last-resort guard against hung event handlers.
 * The default (180s) sits above the longest built-in inner timeout — the extract
 * action's LLM call at 120s — plus comfortable grace. Override via the
 * BROWSER_USE_ACTION_TIMEOUT_S env var or per call.
 */
export const ACTION_TIMEOUT_FALLBACK_S = 180.0;

/** Error substrings that mean "site unavailable" rather than a generic navigation failure. */
export const NAVIGATION_NETWORK_ERRORS = [
	'ERR_NAME_NOT_RESOLVED',
	'ERR_INTERNET_DISCONNECTED',
	'ERR_CONNECTION_REFUSED',
	'ERR_TIMED_OUT',
	'ERR_TUNNEL_CONNECTION_FAILED',
	'net::',
];

/** Query keywords that auto-enable image extraction in `extract`. */
export const IMAGE_QUERY_KEYWORDS = [
	'image',
	'photo',
	'picture',
	'thumbnail',
	'img url',
	'image url',
	'photo url',
	'product image',
];

export const EXTRACT_MAX_CHAR_LIMIT = 100000;
export const EXTRACT_MAX_MEMORY_LENGTH = 10000;
export const EXTRACT_LLM_TIMEOUT_MS = 120000;
export const EVALUATE_MAX_RESULT_CHARS = 20000;
export const EVALUATE_MAX_MEMORY_LENGTH = 10000;

export const EXTRACT_STRUCTURED_SYSTEM_PROMPT = `You are an expert at extracting structured data from the markdown of a webpage.

<input>
You will be given a query, a JSON Schema, and the markdown of a webpage that has been filtered to remove noise and advertising content.
</input>

<instructions>
- Extract ONLY information present in the webpage. Do not guess or fabricate values.
- Your response MUST conform to the provided JSON Schema exactly.
- If a required field's value cannot be found on the page, use null (if the schema allows it) or an empty string / empty array as appropriate.
- If the content was truncated, extract what is available from the visible portion.
- If <already_collected> items are provided, skip any items whose name/title/URL matches those listed — do not include duplicates.
</instructions>`;

export const EXTRACT_FREE_TEXT_SYSTEM_PROMPT = `You are an expert at extracting data from the markdown of a webpage.

<input>
You will be given a query and the markdown of a webpage that has been filtered to remove noise and advertising content.
</input>

<instructions>
- You are tasked to extract information from the webpage that is relevant to the query.
- You should ONLY use the information available in the webpage to answer the query. Do not make up information or provide guess from your own knowledge.
- If the information relevant to the query is not available in the page, your response should mention that.
- If the query asks for all items, products, etc., make sure to directly list all of them.
- If the content was truncated and you need more information, note that the user can use start_from_char parameter to continue from where truncation occurred.
- If <already_collected> items are provided, exclude any results whose name/title/URL matches those already collected — do not include duplicates.
</instructions>

<output>
- Your output should present ALL the information relevant to the query in a concise way.
- Do not answer in conversational format - directly output the relevant information or say that the information is unavailable.
</output>`;

// ============================================================================
// Types
// ============================================================================

export type SensitiveData = Record<string, string | Record<string, string>>;

export interface SearchPageMatch {
	match_text: string;
	context: string;
	element_path: string;
	char_position: number;
}

export interface SearchPageResult {
	matches?: SearchPageMatch[];
	total?: number;
	has_more?: boolean;
	error?: string;
}

export interface FoundElement {
	index: number;
	tag: string;
	text?: string;
	attrs?: Record<string, string>;
	children_count: number;
}

export interface FindElementsResult {
	elements?: FoundElement[];
	total?: number;
	showing?: number;
	error?: string;
}

// ============================================================================
// Action timeout helpers
// ============================================================================

/**
 * Parse BROWSER_USE_ACTION_TIMEOUT_S defensively.
 * Accepts only finite positive values; everything else falls back to the default
 * (nan would time out every action immediately, inf/<=0 would disable the guard).
 */
export function parseEnvActionTimeout(raw: string | null | undefined): number {
	if (raw === null || raw === undefined || raw === '') {
		return ACTION_TIMEOUT_FALLBACK_S;
	}
	const parsed = Number(raw.trim());
	if (raw.trim() === '' || Number.isNaN(parsed)) {
		console.warn(`Invalid BROWSER_USE_ACTION_TIMEOUT_S=${JSON.stringify(raw)}; falling back to ${ACTION_TIMEOUT_FALLBACK_S}s`);
		return ACTION_TIMEOUT_FALLBACK_S;
	}
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.warn(
			`BROWSER_USE_ACTION_TIMEOUT_S=${JSON.stringify(raw)} is not a finite positive number; falling back to ${ACTION_TIMEOUT_FALLBACK_S}s`
		);
		return ACTION_TIMEOUT_FALLBACK_S;
	}
	return parsed;
}

/** Env-derived default action timeout in seconds (read at call time so tests can override). */
export function getDefaultActionTimeoutS(): number {
	return parseEnvActionTimeout(process.env.BROWSER_USE_ACTION_TIMEOUT_S);
}

/**
 * Normalize a caller-supplied action timeout to a finite positive value,
 * mirroring the env-var guard for the public override path.
 */
export function coerceValidActionTimeout(value: number | null | undefined): number {
	const fallback = getDefaultActionTimeoutS();
	if (value === null || value === undefined) {
		return fallback;
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		console.warn(`action_timeout=${String(value)} is not a finite positive number; falling back to ${fallback}s`);
		return fallback;
	}
	return value;
}

export class ActionTimeoutError extends Error {
	constructor(
		public readonly actionName: string,
		public readonly timeoutS: number
	) {
		super(`Action '${actionName}' timed out after ${timeoutS}s`);
		this.name = 'ActionTimeoutError';
	}
}

/** Race a promise against a wall-clock cap; rejects with ActionTimeoutError. */
export async function withActionTimeout<T>(promise: Promise<T>, timeoutS: number, actionName: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new ActionTimeoutError(actionName, timeoutS)), timeoutS * 1000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// ============================================================================
// Sensitive data
// ============================================================================

/** Detect which sensitive key name corresponds to the given text value. */
export function detectSensitiveKeyName(text: string, sensitiveData?: SensitiveData | null): string | null {
	if (!sensitiveData || !text) {
		return null;
	}
	for (const [domainOrKey, content] of Object.entries(sensitiveData)) {
		if (content && typeof content === 'object') {
			for (const [key, value] of Object.entries(content)) {
				if (value && value === text) {
					return key;
				}
			}
		} else if (content && content === text) {
			return domainOrKey;
		}
	}
	return null;
}

// ============================================================================
// Click / input descriptions
// ============================================================================

function axChecked(node: EnhancedDOMTreeNode): boolean | null {
	const props = node.axNode?.properties;
	if (!props) return null;
	for (const prop of props) {
		if (prop.name === 'checked') {
			return prop.value === true || prop.value === 'true';
		}
	}
	return null;
}

function attrChecked(node: EnhancedDOMTreeNode): boolean {
	const raw = (node.attributes?.checked ?? 'false').toLowerCase();
	return raw === 'true' || raw === 'checked' || raw === '';
}

function checkboxState(node: EnhancedDOMTreeNode, fromAria = false): 'checked' | 'unchecked' {
	let isChecked: boolean;
	if (fromAria) {
		const ariaChecked = (node.attributes?.['aria-checked'] ?? 'false').toLowerCase();
		isChecked = ariaChecked === 'true' || ariaChecked === 'checked';
	} else {
		isChecked = attrChecked(node);
	}
	const ax = axChecked(node);
	if (ax !== null) isChecked = ax;
	return isChecked ? 'checked' : 'unchecked';
}

/** Get a brief description of the clicked element for memory. */
export function getClickDescription(node: EnhancedDOMTreeNode): string {
	const parts: string[] = [];
	const attrs = node.attributes ?? {};
	const tagName = getTagName(node);

	parts.push(tagName);

	if (tagName === 'input' && attrs.type) {
		const inputType = attrs.type;
		parts.push(`type=${inputType}`);
		if (inputType === 'checkbox') {
			parts.push(`checkbox-state=${checkboxState(node)}`);
		}
	}

	if (attrs.role) {
		parts.push(`role=${attrs.role}`);
		if (attrs.role === 'checkbox') {
			parts.push(`checkbox-state=${checkboxState(node, true)}`);
		}
	}

	// For labels/spans/divs, check if related to a hidden checkbox
	if (['label', 'span', 'div'].includes(tagName) && !parts.join(' ').includes('type=')) {
		for (const child of getChildren(node)) {
			if (getTagName(child) === 'input' && child.attributes?.type === 'checkbox') {
				let isHidden = false;
				const opacity = child.snapshotNode?.computedStyles?.opacity ?? '1';
				if (opacity === '0' || opacity === '0.0') {
					isHidden = true;
				}
				if (isHidden || !child.isVisible) {
					parts.push(`checkbox-state=${checkboxState(child)}`);
					break;
				}
			}
		}
	}

	const text = getAllChildrenText(node).trim();
	if (text) {
		const shortText = text.slice(0, 30) + (text.length > 30 ? '...' : '');
		parts.push(`"${shortText}"`);
	}

	for (const attr of ['id', 'name', 'aria-label']) {
		if (attrs[attr]) {
			parts.push(`${attr}=${attrs[attr].slice(0, 20)}`);
		}
	}

	return parts.join(' ');
}

/** Detect if a node is an autocomplete/combobox field from its attributes. */
export function isAutocompleteField(node: EnhancedDOMTreeNode): boolean {
	const attrs = node.attributes ?? {};
	if (attrs.role === 'combobox') return true;
	const ariaAc = attrs['aria-autocomplete'] ?? '';
	if (ariaAc && ariaAc !== 'none') return true;
	if (attrs.list) return true;
	const haspopup = attrs['aria-haspopup'] ?? '';
	if (haspopup && haspopup !== 'false' && (attrs['aria-controls'] || attrs['aria-owns'])) return true;
	return false;
}

/**
 * Only true JS-driven autocomplete (combobox / aria-autocomplete) needs a
 * mechanical delay so the dropdown can populate before the next action.
 */
export function needsAutocompleteDelay(node: EnhancedDOMTreeNode): boolean {
	const attrs = node.attributes ?? {};
	const ariaAc = attrs['aria-autocomplete'] ?? '';
	return attrs.role === 'combobox' || (ariaAc !== '' && ariaAc !== 'none');
}

// ============================================================================
// search_page / find_elements (JS templates + result formatting)
// ============================================================================

export const SEARCH_PAGE_JS_BODY = String.raw`try {
	var scope = CSS_SCOPE ? document.querySelector(CSS_SCOPE) : document.body;
	if (!scope) {
		return {error: 'CSS scope selector not found: ' + CSS_SCOPE, matches: [], total: 0};
	}
	var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
	var fullText = '';
	var nodeOffsets = [];
	while (walker.nextNode()) {
		var node = walker.currentNode;
		var text = node.textContent;
		if (text && text.trim()) {
			nodeOffsets.push({offset: fullText.length, length: text.length, node: node});
			fullText += text;
		}
	}
	var re;
	try {
		var flags = CASE_SENSITIVE ? 'g' : 'gi';
		if (IS_REGEX) {
			re = new RegExp(PATTERN, flags);
		} else {
			re = new RegExp(PATTERN.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&'), flags);
		}
	} catch (e) {
		return {error: 'Invalid regex pattern: ' + e.message, matches: [], total: 0};
	}
	var matches = [];
	var match;
	var totalFound = 0;
	while ((match = re.exec(fullText)) !== null) {
		totalFound++;
		if (matches.length < MAX_RESULTS) {
			var start = Math.max(0, match.index - CONTEXT_CHARS);
			var end = Math.min(fullText.length, match.index + match[0].length + CONTEXT_CHARS);
			var context = fullText.slice(start, end);
			var elementPath = '';
			for (var i = 0; i < nodeOffsets.length; i++) {
				var no = nodeOffsets[i];
				if (no.offset <= match.index && no.offset + no.length > match.index) {
					elementPath = _getPath(no.node.parentElement);
					break;
				}
			}
			matches.push({
				match_text: match[0],
				context: (start > 0 ? '...' : '') + context + (end < fullText.length ? '...' : ''),
				element_path: elementPath,
				char_position: match.index
			});
		}
		if (match[0].length === 0) re.lastIndex++;
	}
	return {matches: matches, total: totalFound, has_more: totalFound > MAX_RESULTS};
} catch (e) {
	return {error: 'search_page error: ' + e.message, matches: [], total: 0};
}
function _getPath(el) {
	var parts = [];
	var current = el;
	while (current && current !== document.body && current !== document) {
		var desc = current.tagName ? current.tagName.toLowerCase() : '';
		if (!desc) break;
		if (current.id) desc += '#' + current.id;
		else if (current.className && typeof current.className === 'string') {
			var classes = current.className.trim().split(/\s+/).slice(0, 2).join('.');
			if (classes) desc += '.' + classes;
		}
		parts.unshift(desc);
		current = current.parentElement;
	}
	return parts.join(' > ');
}
`;

export const FIND_ELEMENTS_JS_BODY = String.raw`try {
	var elements;
	try {
		elements = document.querySelectorAll(SELECTOR);
	} catch (e) {
		return {error: 'Invalid CSS selector: ' + e.message, elements: [], total: 0};
	}
	var total = elements.length;
	var limit = Math.min(total, MAX_RESULTS);
	var results = [];
	for (var i = 0; i < limit; i++) {
		var el = elements[i];
		var item = {index: i, tag: el.tagName.toLowerCase()};
		if (INCLUDE_TEXT) {
			var text = (el.textContent || '').trim();
			item.text = text.length > 300 ? text.slice(0, 300) + '...' : text;
		}
		if (ATTRIBUTES && ATTRIBUTES.length > 0) {
			item.attrs = {};
			for (var j = 0; j < ATTRIBUTES.length; j++) {
				var attrName = ATTRIBUTES[j];
				var val;
				// Use resolved DOM property for src/href to get absolute URLs
				if ((attrName === 'src' || attrName === 'href') && typeof el[attrName] === 'string' && el[attrName] !== '') {
					val = el[attrName];
				} else {
					val = el.getAttribute(attrName);
				}
				if (val !== null) {
					item.attrs[attrName] = val.length > 500 ? val.slice(0, 500) + '...' : val;
				}
			}
		}
		item.children_count = el.children.length;
		results.push(item);
	}
	return {elements: results, total: total, showing: limit};
} catch (e) {
	return {error: 'find_elements error: ' + e.message, elements: [], total: 0};
}
`;

/** Build JS IIFE for search_page with safe parameter injection. */
export function buildSearchPageJs(options: {
	pattern: string;
	regex: boolean;
	caseSensitive: boolean;
	contextChars: number;
	cssScope: string | null;
	maxResults: number;
}): string {
	const paramsJs =
		`var PATTERN = ${JSON.stringify(options.pattern)};\n` +
		`var IS_REGEX = ${JSON.stringify(options.regex)};\n` +
		`var CASE_SENSITIVE = ${JSON.stringify(options.caseSensitive)};\n` +
		`var CONTEXT_CHARS = ${JSON.stringify(options.contextChars)};\n` +
		`var CSS_SCOPE = ${JSON.stringify(options.cssScope)};\n` +
		`var MAX_RESULTS = ${JSON.stringify(options.maxResults)};\n`;
	return '(function() {\n' + paramsJs + SEARCH_PAGE_JS_BODY + '\n})()';
}

/** Build JS IIFE for find_elements with safe parameter injection. */
export function buildFindElementsJs(options: {
	selector: string;
	attributes: string[] | null;
	maxResults: number;
	includeText: boolean;
}): string {
	const paramsJs =
		`var SELECTOR = ${JSON.stringify(options.selector)};\n` +
		`var ATTRIBUTES = ${JSON.stringify(options.attributes)};\n` +
		`var MAX_RESULTS = ${JSON.stringify(options.maxResults)};\n` +
		`var INCLUDE_TEXT = ${JSON.stringify(options.includeText)};\n`;
	return '(function() {\n' + paramsJs + FIND_ELEMENTS_JS_BODY + '\n})()';
}

/** Format search_page result into human-readable text for the agent. */
export function formatSearchResults(data: unknown, pattern: string): string {
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		return `search_page returned unexpected result: ${String(data)}`;
	}
	const result = data as SearchPageResult;
	const matches = result.matches ?? [];
	const total = result.total ?? 0;
	const hasMore = result.has_more ?? false;

	if (total === 0) {
		return `No matches found for "${pattern}" on page.`;
	}

	const lines = [`Found ${total} match${total !== 1 ? 'es' : ''} for "${pattern}" on page:`, ''];
	matches.forEach((m, i) => {
		const loc = m.element_path ? ` (in ${m.element_path})` : '';
		lines.push(`[${i + 1}] ${m.context ?? ''}${loc}`);
	});
	if (hasMore) {
		lines.push(`\n... showing ${matches.length} of ${total} total matches. Increase max_results to see more.`);
	}
	return lines.join('\n');
}

/** Format find_elements result into human-readable text for the agent. */
export function formatFindResults(data: unknown, selector: string): string {
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		return `find_elements returned unexpected result: ${String(data)}`;
	}
	const result = data as FindElementsResult;
	const elements = result.elements ?? [];
	const total = result.total ?? 0;
	const showing = result.showing ?? 0;

	if (total === 0) {
		return `No elements found matching "${selector}".`;
	}

	const lines = [`Found ${total} element${total !== 1 ? 's' : ''} matching "${selector}":`, ''];
	for (const el of elements) {
		const parts = [`[${el.index ?? 0}] <${el.tag ?? '?'}>`];
		if (el.text) {
			let displayText = el.text.split(/\s+/).filter(Boolean).join(' ');
			if (displayText.length > 120) displayText = displayText.slice(0, 120) + '...';
			parts.push(`"${displayText}"`);
		}
		if (el.attrs && Object.keys(el.attrs).length > 0) {
			parts.push('{' + Object.entries(el.attrs).map(([k, v]) => `${k}="${v}"`).join(', ') + '}');
		}
		parts.push(`(${el.children_count ?? 0} children)`);
		lines.push(parts.join(' '));
	}
	if (showing < total) {
		lines.push(`\nShowing ${showing} of ${total} total elements. Increase max_results to see more.`);
	}
	return lines.join('\n');
}

// ============================================================================
// extract helpers
// ============================================================================

/** Auto-enable image extraction when the query mentions images. */
export function shouldExtractImages(query: string, explicit: boolean): boolean {
	if (explicit) return true;
	const lower = query.toLowerCase();
	return IMAGE_QUERY_KEYWORDS.some((kw) => lower.includes(kw));
}

/** `<already_collected>` prompt section (max 100 identifiers). */
export function buildAlreadyCollectedSection(alreadyCollected: string[] | null | undefined): string {
	if (!alreadyCollected || alreadyCollected.length === 0) return '';
	const items = alreadyCollected
		.slice(0, 100)
		.map((item) => `- ${item}`)
		.join('\n');
	return `\n\n<already_collected>\nSkip items whose name/title/URL matches any of these already-collected identifiers:\n${items}\n</already_collected>`;
}

export { sanitizeSurrogates } from '../utils.js';

// ============================================================================
// evaluate helpers
// ============================================================================

const DATA_IMAGE_PATTERN = /(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/g;

/** Pull inline base64 images out of a JS result, replacing them with `[Image]` placeholders. */
export function extractDataImages(resultText: string): { text: string; images: string[] } {
	const images = Array.from(resultText.matchAll(DATA_IMAGE_PATTERN), (m) => m[1]);
	if (images.length === 0) {
		return { text: resultText, images };
	}
	let text = resultText;
	for (const img of images) {
		text = text.split(img).join('[Image]');
	}
	return { text, images };
}

/**
 * Validate and fix common JavaScript issues before execution
 * (double-escaped quotes, over-escaped regexes, mixed quotes in selectors).
 * Port of Tools._validate_and_fix_javascript (0.13.10 patterns).
 */
export function validateAndFixJavaScript(code: string): string {
	let fixedCode = code;

	// Pattern 1: Fix double-escaped quotes (\\" → ")
	fixedCode = fixedCode.replace(/\\"/g, '"');

	// Pattern 2: Fix over-escaped regex patterns (\\d → \d)
	fixedCode = fixedCode.replace(/\\\\([dDsSwWbBnrtfv])/g, '\\$1');
	fixedCode = fixedCode.replace(/\\\\([.*+?^${}()|[\]])/g, '\\$1');

	// Pattern 3: XPath expressions in double quotes → template literals
	fixedCode = fixedCode.replace(/document\.evaluate\s*\(\s*"([^"]*)"\s*,/g, (_, xpath) => `document.evaluate(\`${xpath}\`,`);

	// Pattern 4: querySelector/querySelectorAll with double quotes → template literals
	fixedCode = fixedCode.replace(
		/(querySelector(?:All)?)\s*\(\s*"([^"]*)"\s*\)/g,
		(_, method, selector) => `${method}(\`${selector}\`)`
	);

	// Pattern 5: closest()
	fixedCode = fixedCode.replace(/\.closest\s*\(\s*"([^"]*)"\s*\)/g, (_, selector) => `.closest(\`${selector}\`)`);

	// Pattern 6: .matches()
	fixedCode = fixedCode.replace(/\.matches\s*\(\s*"([^"]*)"\s*\)/g, (_, selector) => `.matches(\`${selector}\`)`);

	return fixedCode;
}

// ============================================================================
// File helpers
// ============================================================================

/** Resolve a user-supplied paper format to inches; unknown formats fall back to Letter. */
export function resolvePaperSize(paperFormat: string | null | undefined): [number, number] {
	const key = (paperFormat ?? 'letter').toLowerCase();
	return PDF_PAPER_SIZES[key] ?? PDF_PAPER_SIZES.letter;
}

/** Page title → safe PDF base name (max 50 chars, `page` when empty). */
export function pdfFileNameFromTitle(title: string | null | undefined): string {
	const safeTitle = (title ?? '')
		.replace(/[^\w\s-]/g, '')
		.trim()
		.slice(0, 50);
	return safeTitle || 'page';
}

/** Ensure a file name carries the given extension (case-insensitive). */
export function ensureExtension(fileName: string, ext: string): string {
	return fileName.toLowerCase().endsWith(ext.toLowerCase()) ? fileName : `${fileName}${ext}`;
}

/** Return `name`, or `name (N)` with the first N that does not exist in `dir`. */
export function uniqueFileName(dir: string, fileName: string): string {
	if (!fs.existsSync(path.join(dir, fileName))) {
		return fileName;
	}
	const ext = path.extname(fileName);
	const base = fileName.slice(0, fileName.length - ext.length);
	let counter = 1;
	while (fs.existsSync(path.join(dir, `${base} (${counter})${ext}`))) {
		counter++;
	}
	return `${base} (${counter})${ext}`;
}

/** True when `candidate` resolves to `dir` itself or a path inside it. */
export function isPathInsideDir(candidate: string, dir: string): boolean {
	const realCandidate = path.resolve(candidate);
	const realDir = path.resolve(dir);
	return realCandidate === realDir || realCandidate.startsWith(realDir + path.sep);
}

/** Truncate long text to a line-based memory summary (Python read_file behaviour). */
export function summarizeForMemory(result: string, maxSize = 1000): string {
	if (result.length <= maxSize) {
		return result;
	}
	const lines = result.split('\n');
	let display = '';
	let linesCount = 0;
	for (const line of lines) {
		if (display.length + line.length < maxSize) {
			display += line + '\n';
			linesCount++;
		} else {
			break;
		}
	}
	const remainingLines = lines.length - linesCount;
	return remainingLines > 0 ? `${display}${remainingLines} more lines...` : display;
}

/**
 * DOM views - Complete type definitions for DOM tree nodes
 */

import crypto from 'crypto';
import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_INCLUDE_ATTRIBUTES = [
	'title',
	'type',
	'checked',
	'id',
	'name',
	'role',
	'value',
	'placeholder',
	'data-date-format',
	'alt',
	'aria-label',
	'aria-expanded',
	'data-state',
	'aria-checked',
	'aria-valuemin',
	'aria-valuemax',
	'aria-valuenow',
	'aria-placeholder',
	'pattern',
	'min',
	'max',
	'minlength',
	'maxlength',
	'step',
	'accept', // File input types (e.g., accept="image/*" or accept=".pdf")
	'multiple', // Whether multiple files/selections are allowed
	'inputmode', // Virtual keyboard hint (numeric, tel, email, url, etc.)
	'autocomplete', // Autocomplete behavior hint
	'aria-autocomplete', // ARIA autocomplete type (list, inline, both)
	'list', // Associated datalist element ID
	'data-mask', // Input mask format (e.g., phone numbers, credit cards)
	'data-inputmask', // Alternative input mask attribute
	'data-datepicker', // jQuery datepicker indicator
	'format', // Synthetic attribute for date/time input format (e.g., MM/dd/yyyy)
	'expected_format', // Synthetic attribute for explicit expected format (e.g., AngularJS datepickers)
	'contenteditable', // Rich text editor detection
	'pseudo',
	'selected',
	'expanded',
	'pressed',
	'disabled',
	'invalid',
	'valuemin',
	'valuemax',
	'valuenow',
	'keyshortcuts',
	'haspopup',
	'multiselectable',
	'required',
	'valuetext',
	'level',
	'busy',
	'live',
	'ax_name',
];

// ============================================================================
// Target Types (from cdp_use types)
// ============================================================================

export type TargetID = string;
export type SessionID = string;

export interface TargetInfo {
	targetId: TargetID;
	type: string;
	title: string;
	url: string;
	attached?: boolean;
	canAccessOpener?: boolean;
}

// ============================================================================
// Current Page Targets
// ============================================================================

export interface CurrentPageTargets {
	pageSession: TargetInfo;
	/**
	 * Iframe sessions are ALL the iframes sessions of all the pages (not just the current page)
	 */
	iframeSessions: TargetInfo[];
}

// ============================================================================
// Target All Trees (CDP snapshot data)
// ============================================================================

export interface TargetAllTrees {
	snapshot: any; // CaptureSnapshotReturns
	domTree: any; // GetDocumentReturns
	axTree: any; // GetFullAXTreeReturns
	devicePixelRatio: number;
	cdpTiming: Record<string, number>;
	/** Backend node IDs of elements with JS click/mouse event listeners (detected via CDP getEventListeners) */
	jsClickListenerBackendIds?: Set<number> | null;
}

// ============================================================================
// Propagating Bounds
// ============================================================================

export interface PropagatingBounds {
	/** The tag that started propagation ('a' or 'button') */
	tag: string;
	/** The bounding box */
	bounds: DOMRect;
	/** Node ID for debugging */
	nodeId: number;
	/** How deep in tree this started (for debugging) */
	depth: number;
}

// ============================================================================
// Static Attributes
// ============================================================================

export const STATIC_ATTRIBUTES = new Set([
	'class',
	'id',
	'name',
	'type',
	'placeholder',
	'aria-label',
	'title',
	'role',
	'data-testid',
	'data-test',
	'data-cy',
	'data-selenium',
	'for',
	'required',
	'disabled',
	'readonly',
	'checked',
	'selected',
	'multiple',
	'accept',
	'href',
	'target',
	'rel',
	'aria-describedby',
	'aria-labelledby',
	'aria-controls',
	'aria-owns',
	'aria-live',
	'aria-atomic',
	'aria-busy',
	'aria-disabled',
	'aria-hidden',
	'aria-pressed',
	'aria-autocomplete',
	'aria-checked',
	'aria-selected',
	'list',
	'tabindex',
	'alt',
	'src',
	'lang',
	'itemscope',
	'itemtype',
	'itemprop',
	'pseudo',
	'aria-valuemin',
	'aria-valuemax',
	'aria-valuenow',
	'aria-placeholder',
]);

/** Class patterns that indicate dynamic/transient UI state - excluded from the stable hash */
export const DYNAMIC_CLASS_PATTERNS: ReadonlySet<string> = new Set([
	'focus',
	'hover',
	'active',
	'selected',
	'disabled',
	'animation',
	'transition',
	'loading',
	'open',
	'closed',
	'expanded',
	'collapsed',
	'visible',
	'hidden',
	'pressed',
	'checked',
	'highlighted',
	'current',
	'entering',
	'leaving',
]);

/** Element matching strictness levels for history replay */
export enum MatchLevel {
	/** Full hash with all attributes (current behavior) */
	EXACT = 1,
	/** Hash with dynamic classes filtered out */
	STABLE = 2,
	/** XPath string comparison */
	XPATH = 3,
	/** Accessible name (ax_name) from accessibility tree */
	AX_NAME = 4,
	/** Unique attribute match (name, id, aria-label) */
	ATTRIBUTE = 5,
}

/**
 * Remove dynamic state classes, keep semantic/identifying ones.
 * Returns sorted classes for deterministic hashing.
 */
export function filterDynamicClasses(classStr: string | null | undefined): string {
	if (!classStr) {
		return '';
	}
	const stable = classStr
		.split(/\s+/)
		.filter((c) => c)
		.filter((c) => {
			const lower = c.toLowerCase();
			for (const pattern of DYNAMIC_CLASS_PATTERNS) {
				if (lower.includes(pattern)) {
					return false;
				}
			}
			return true;
		});
	return stable.sort().join(' ');
}

// ============================================================================
// Node Types
// ============================================================================

export enum NodeType {
	ELEMENT_NODE = 1,
	ATTRIBUTE_NODE = 2,
	TEXT_NODE = 3,
	CDATA_SECTION_NODE = 4,
	ENTITY_REFERENCE_NODE = 5,
	ENTITY_NODE = 6,
	PROCESSING_INSTRUCTION_NODE = 7,
	COMMENT_NODE = 8,
	DOCUMENT_NODE = 9,
	DOCUMENT_TYPE_NODE = 10,
	DOCUMENT_FRAGMENT_NODE = 11,
	NOTATION_NODE = 12,
}

// ============================================================================
// DOM Rect
// ============================================================================

export interface DOMRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export const DOMRectSchema = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});

// ============================================================================
// Enhanced AX Property
// ============================================================================

export interface EnhancedAXProperty {
	name: string; // AXPropertyName
	value: string | boolean | null;
}

// ============================================================================
// Enhanced AX Node
// ============================================================================

export interface EnhancedAXNode {
	axNodeId: string;
	ignored: boolean;
	role?: string | null;
	name?: string | null;
	description?: string | null;
	properties?: EnhancedAXProperty[] | null;
	childIds?: string[] | null;
}

// ============================================================================
// Enhanced Snapshot Node
// ============================================================================

export interface EnhancedSnapshotNode {
	isClickable?: boolean; // Python returns True/False, not True/None
	cursorStyle?: string | null;
	/**
	 * Document coordinates (origin = top-left of page, ignores scroll)
	 */
	bounds?: DOMRect | null;
	/**
	 * Viewport coordinates (origin = top-left of visible scrollport)
	 */
	clientRects?: DOMRect | null;
	/**
	 * Scrollable area of the element
	 */
	scrollRects?: DOMRect | null;
	/**
	 * Computed styles from layout tree
	 */
	computedStyles?: Record<string, string> | null;
	/**
	 * Paint order from layout tree
	 */
	paintOrder?: number | null;
	/**
	 * Stacking contexts from layout tree
	 */
	stackingContexts?: number | null;
	/**
	 * Live value of an <input> or <textarea> (DOMSnapshot inputValue/textValue), which the value
	 * attribute misses when JS, autofill, or a framework set it.
	 */
	inputValue?: string | null;
	/** Live checked state of a checkbox or radio input (DOMSnapshot inputChecked) */
	inputChecked?: boolean | null;
}

// ============================================================================
// Enhanced DOM Tree Node
// ============================================================================

export interface EnhancedDOMTreeNode {
	// DOM Node data
	nodeId: number;
	backendNodeId: number;
	nodeType: NodeType;
	nodeName: string;
	nodeValue: string;
	attributes: Record<string, string>;
	isScrollable?: boolean | null;
	isVisible?: boolean | null;
	absolutePosition?: DOMRect | null;

	// Frames
	targetId: string;
	frameId?: string | null;
	sessionId?: string | null;
	contentDocument?: EnhancedDOMTreeNode | null;

	// Shadow DOM
	shadowRootType?: string | null;
	shadowRoots?: EnhancedDOMTreeNode[] | null;

	// Navigation
	parentNode?: EnhancedDOMTreeNode | null;
	childrenNodes?: EnhancedDOMTreeNode[] | null;

	// AX Node data
	axNode?: EnhancedAXNode | null;

	// Snapshot Node data
	snapshotNode?: EnhancedSnapshotNode | null;

	// Compound control children
	compoundChildren?: any[];

	/**
	 * Whether this element has JS click/mouse event listeners attached (detected via CDP
	 * getEventListeners). Used to identify clicks that don't use native interactive HTML tags.
	 */
	hasJsClickListener?: boolean;

	/**
	 * Iframes: details of interactive elements hidden due to the viewport threshold.
	 * Each entry: tag, text, pages (scroll distance in viewport pages).
	 */
	hiddenElementsInfo?: { tag: string; text: string; pages: number }[];

	/** Iframes: there is hidden non-interactive content below the viewport threshold */
	hasHiddenContent?: boolean;

	// UUID
	uuid?: string;
}

// ============================================================================
// Simplified Node
// ============================================================================

export interface SimplifiedNode {
	originalNode: EnhancedDOMTreeNode;
	children: SimplifiedNode[];
	shouldDisplay: boolean;
	isInteractive: boolean;
	/** Model-visible index (backend node id unless it collided with another target's id) */
	selectorIndex?: number | null;
	isNew: boolean;
	ignoredByPaintOrder: boolean;
	excludedByParent: boolean;
	isShadowHost: boolean;
	isCompoundComponent: boolean;
}

// ============================================================================
// DOM Selector Map
// ============================================================================

export type DOMSelectorMap = Map<number, EnhancedDOMTreeNode>;

// ============================================================================
// Serialized DOM State
// ============================================================================

export interface SerializedDOMState {
	root?: SimplifiedNode | null;
	selectorMap: DOMSelectorMap;
	llmRepresentation?: (includeAttributes: string[]) => string;
}

// ============================================================================
// DOM Interacted Element
// ============================================================================

export interface DOMInteractedElement {
	nodeId: number;
	backendNodeId: number;
	frameId?: string | null;
	nodeType: NodeType;
	nodeValue: string;
	nodeName: string;
	attributes?: Record<string, string> | null;
	bounds?: DOMRect | null;
	xPath: string;
	elementHash: number;
	/** Stable hash with dynamic classes filtered - computed at save time for consistent matching */
	stableHash?: number | null;
	/** Accessibility name (visible text) - used for fallback matching when hash/xpath fail */
	axName?: string | null;
}

export const DOMInteractedElementSchema = z.object({
	nodeId: z.number(),
	backendNodeId: z.number(),
	frameId: z.string().nullable().optional(),
	nodeType: z.nativeEnum(NodeType),
	nodeValue: z.string(),
	nodeName: z.string(),
	attributes: z.record(z.string()).nullable().optional(),
	bounds: DOMRectSchema.nullable().optional(),
	xPath: z.string(),
	elementHash: z.number(),
	stableHash: z.number().nullable().optional(),
	axName: z.string().nullable().optional(),
});

/** A structure-aware chunk of markdown content */
export interface MarkdownChunk {
	content: string;
	chunkIndex: number;
	totalChunks: number;
	/** Offset in the original content */
	charOffsetStart: number;
	/** Offset in the original content (exclusive) */
	charOffsetEnd: number;
	/** Context from the previous chunk (e.g. table headers) */
	overlapPrefix: string;
	hasMore: boolean;
}

// ============================================================================
// Helper Functions for EnhancedDOMTreeNode
// ============================================================================

export function getTagName(node: EnhancedDOMTreeNode): string {
	return node.nodeName.toLowerCase();
}

export function getChildren(node: EnhancedDOMTreeNode): EnhancedDOMTreeNode[] {
	return node.childrenNodes || [];
}

export function getChildrenAndShadowRoots(node: EnhancedDOMTreeNode): EnhancedDOMTreeNode[] {
	const children = [...(node.childrenNodes || [])];
	if (node.shadowRoots) {
		children.push(...node.shadowRoots);
	}
	return children;
}

/**
 * Generate XPath for a DOM node
 */
export function getXPath(node: EnhancedDOMTreeNode): string {
	const segments: string[] = [];
	let current: EnhancedDOMTreeNode | null | undefined = node;

	while (
		current &&
		(current.nodeType === NodeType.ELEMENT_NODE ||
			current.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE)
	) {
		// Pass through shadow roots
		if (current.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
			current = current.parentNode;
			continue;
		}

		// Stop if we hit iframe
		if (current.parentNode && getTagName(current.parentNode) === 'iframe') {
			break;
		}

		const position = getElementPosition(current);
		const tagName = getTagName(current);
		const xpathIndex = position > 0 ? `[${position}]` : '';
		segments.unshift(`${tagName}${xpathIndex}`);

		current = current.parentNode;
	}

	return segments.join('/');
}

function getElementPosition(element: EnhancedDOMTreeNode): number {
	if (!element.parentNode || !element.parentNode.childrenNodes) {
		return 0;
	}

	const sameTagSiblings = element.parentNode.childrenNodes.filter(
		(child) =>
			child.nodeType === NodeType.ELEMENT_NODE &&
			getTagName(child) === getTagName(element)
	);

	if (sameTagSiblings.length <= 1) {
		return 0;
	}

	const index = sameTagSiblings.indexOf(element);
	return index >= 0 ? index + 1 : 0; // XPath is 1-indexed
}

/**
 * Get all text content from node and its children
 */
export function getAllChildrenText(
	node: EnhancedDOMTreeNode,
	maxDepth: number = -1
): string {
	const textParts: string[] = [];

	function collectText(n: EnhancedDOMTreeNode, currentDepth: number) {
		if (maxDepth !== -1 && currentDepth > maxDepth) {
			return;
		}

		if (n.nodeType === NodeType.TEXT_NODE) {
			textParts.push(n.nodeValue);
		} else if (n.nodeType === NodeType.ELEMENT_NODE) {
			for (const child of getChildren(n)) {
				collectText(child, currentDepth + 1);
			}
		}
	}

	collectText(node, 0);
	return textParts.join('\n').trim();
}

/**
 * Get meaningful text for LLM
 */
export function getMeaningfulTextForLLM(node: EnhancedDOMTreeNode): string {
	let meaningfulText = '';

	if (node.attributes) {
		// Priority order: value, aria-label, title, placeholder, alt, text content
		for (const attr of ['value', 'aria-label', 'title', 'placeholder', 'alt']) {
			if (node.attributes[attr]) {
				meaningfulText = node.attributes[attr];
				break;
			}
		}
	}

	// Fallback to text content
	if (!meaningfulText) {
		meaningfulText = getAllChildrenText(node);
	}

	return meaningfulText.trim();
}

/**
 * Check if element is actually scrollable
 */
export function isActuallyScrollable(node: EnhancedDOMTreeNode): boolean {
	// First check CDP detection
	if (node.isScrollable) {
		return true;
	}

	if (!node.snapshotNode) {
		return false;
	}

	const scrollRects = node.snapshotNode.scrollRects;
	const clientRects = node.snapshotNode.clientRects;

	if (scrollRects && clientRects) {
		const hasVerticalScroll = scrollRects.height > clientRects.height + 1;
		const hasHorizontalScroll = scrollRects.width > clientRects.width + 1;

		if (hasVerticalScroll || hasHorizontalScroll) {
			if (node.snapshotNode.computedStyles) {
				const styles = node.snapshotNode.computedStyles;
				const overflow = (styles['overflow'] || 'visible').toLowerCase();
				const overflowX = (styles['overflow-x'] || overflow).toLowerCase();
				const overflowY = (styles['overflow-y'] || overflow).toLowerCase();

				const allowsScroll =
					overflow === 'auto' ||
					overflow === 'scroll' ||
					overflow === 'overlay' ||
					overflowX === 'auto' ||
					overflowX === 'scroll' ||
					overflowX === 'overlay' ||
					overflowY === 'auto' ||
					overflowY === 'scroll' ||
					overflowY === 'overlay';

				return allowsScroll;
			} else {
				// No CSS info - be conservative
				const scrollableTags = new Set(['div', 'main', 'section', 'article', 'aside', 'body', 'html']);
				return scrollableTags.has(getTagName(node));
			}
		}
	}

	return false;
}

/**
 * Calculate element hash
 */
function hashToInt(combinedString: string): number {
	const hash = crypto.createHash('sha256').update(combinedString).digest('hex');
	// Convert first 16 chars from hex to int
	return parseInt(hash.substring(0, 16), 16);
}

function axNameSuffix(node: EnhancedDOMTreeNode): string {
	// Include the accessibility name if available - it distinguishes elements that have identical
	// structure and attributes but different visible text
	return node.axNode?.name ? `|ax_name=${node.axNode.name}` : '';
}

/**
 * Calculate element hash from its parent branch path, static attributes and accessibility name.
 */
export function calculateElementHash(node: EnhancedDOMTreeNode): number {
	const parentBranchPath = getParentBranchPath(node);
	const parentBranchPathString = parentBranchPath.join('/');

	const attributesString = Object.entries(node.attributes || {})
		.filter(([k]) => STATIC_ATTRIBUTES.has(k))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join('');

	return hashToInt(`${parentBranchPathString}|${attributesString}${axNameSuffix(node)}`);
}

/**
 * Hash with dynamic classes filtered out. More stable across sessions than
 * calculateElementHash since it excludes transient CSS state classes like focus, hover, animation.
 */
export function computeStableHash(node: EnhancedDOMTreeNode): number {
	const parentBranchPath = getParentBranchPath(node);
	const parentBranchPathString = parentBranchPath.join('/');

	const filteredAttrs: [string, string][] = [];
	for (const [k, rawValue] of Object.entries(node.attributes || {})) {
		if (!STATIC_ATTRIBUTES.has(k)) {
			continue;
		}
		let v = rawValue;
		if (k === 'class') {
			v = filterDynamicClasses(v);
			if (!v) {
				continue; // Skip empty class after filtering
			}
		}
		filteredAttrs.push([k, v]);
	}
	filteredAttrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const attributesString = filteredAttrs.map(([k, v]) => `${k}=${v}`).join('');

	return hashToInt(`${parentBranchPathString}|${attributesString}${axNameSuffix(node)}`);
}

function getParentBranchPath(node: EnhancedDOMTreeNode): string[] {
	const parents: EnhancedDOMTreeNode[] = [];
	let current: EnhancedDOMTreeNode | null | undefined = node;

	while (current) {
		if (current.nodeType === NodeType.ELEMENT_NODE) {
			parents.push(current);
		}
		current = current.parentNode;
	}

	parents.reverse();
	return parents.map((p) => getTagName(p));
}

/**
 * Create DOMInteractedElement from EnhancedDOMTreeNode
 */
export function createDOMInteractedElement(
	node: EnhancedDOMTreeNode
): DOMInteractedElement {
	return {
		nodeId: node.nodeId,
		backendNodeId: node.backendNodeId,
		frameId: node.frameId,
		nodeType: node.nodeType,
		nodeValue: node.nodeValue,
		nodeName: node.nodeName,
		attributes: node.attributes,
		bounds: node.snapshotNode?.bounds,
		xPath: getXPath(node),
		elementHash: calculateElementHash(node),
		// Computed from the source node so replay matching has a single source of truth
		stableHash: computeStableHash(node),
		axName: node.axNode?.name ?? null,
	};
}

// ============================================================================
// Scroll Info Types and Functions
// ============================================================================

export interface ScrollInfo {
	scrollTop: number;
	scrollLeft: number;
	scrollableHeight: number;
	scrollableWidth: number;
	visibleHeight: number;
	visibleWidth: number;
	contentAbove: number;
	contentBelow: number;
	contentLeft: number;
	contentRight: number;
	verticalScrollPercentage: number;
	horizontalScrollPercentage: number;
	pagesAbove: number;
	pagesBelow: number;
	totalPages: number;
	canScrollUp: boolean;
	canScrollDown: boolean;
	canScrollLeft: boolean;
	canScrollRight: boolean;
}

/**
 * Calculate scroll information for an element
 */
export function getScrollInfo(node: EnhancedDOMTreeNode): ScrollInfo | null {
	if (!isActuallyScrollable(node) || !node.snapshotNode) {
		return null;
	}

	const scrollRects = node.snapshotNode.scrollRects;
	const clientRects = node.snapshotNode.clientRects;

	if (!scrollRects || !clientRects) {
		return null;
	}

	const scrollTop = scrollRects.y;
	const scrollLeft = scrollRects.x;
	const scrollableHeight = scrollRects.height;
	const scrollableWidth = scrollRects.width;
	const visibleHeight = clientRects.height;
	const visibleWidth = clientRects.width;

	const contentAbove = Math.max(0, scrollTop);
	const contentBelow = Math.max(0, scrollableHeight - visibleHeight - scrollTop);
	const contentLeft = Math.max(0, scrollLeft);
	const contentRight = Math.max(0, scrollableWidth - visibleWidth - scrollLeft);

	let verticalScrollPercentage = 0;
	let horizontalScrollPercentage = 0;

	if (scrollableHeight > visibleHeight) {
		const maxScrollTop = scrollableHeight - visibleHeight;
		verticalScrollPercentage = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * 100 : 0;
	}

	if (scrollableWidth > visibleWidth) {
		const maxScrollLeft = scrollableWidth - visibleWidth;
		horizontalScrollPercentage = maxScrollLeft > 0 ? (scrollLeft / maxScrollLeft) * 100 : 0;
	}

	const pagesAbove = visibleHeight > 0 ? contentAbove / visibleHeight : 0;
	const pagesBelow = visibleHeight > 0 ? contentBelow / visibleHeight : 0;
	const totalPages = visibleHeight > 0 ? scrollableHeight / visibleHeight : 1;

	return {
		scrollTop,
		scrollLeft,
		scrollableHeight,
		scrollableWidth,
		visibleHeight,
		visibleWidth,
		contentAbove,
		contentBelow,
		contentLeft,
		contentRight,
		verticalScrollPercentage: Math.round(verticalScrollPercentage * 10) / 10,
		horizontalScrollPercentage: Math.round(horizontalScrollPercentage * 10) / 10,
		pagesAbove: Math.round(pagesAbove * 10) / 10,
		pagesBelow: Math.round(pagesBelow * 10) / 10,
		totalPages: Math.round(totalPages * 10) / 10,
		canScrollUp: contentAbove > 0,
		canScrollDown: contentBelow > 0,
		canScrollLeft: contentLeft > 0,
		canScrollRight: contentRight > 0,
	};
}

/**
 * Check if scroll info should be shown for this element
 */
export function shouldShowScrollInfo(node: EnhancedDOMTreeNode): boolean {
	// Special case: Always show scroll info for iframe elements
	if (getTagName(node) === 'iframe') {
		return true;
	}

	// Must be scrollable first for non-iframe elements
	if (!node.isScrollable && !isActuallyScrollable(node)) {
		return false;
	}

	// Always show for iframe content documents (body/html)
	const tagName = getTagName(node);
	if (tagName === 'body' || tagName === 'html') {
		return true;
	}

	// Don't show if parent is already scrollable (avoid nested spam)
	if (node.parentNode) {
		if (node.parentNode.isScrollable || isActuallyScrollable(node.parentNode)) {
			return false;
		}
	}

	return true;
}

/**
 * Get human-readable scroll information text
 */
export function getScrollInfoText(node: EnhancedDOMTreeNode): string {
	const tagName = getTagName(node);

	// Special case for iframes
	if (tagName === 'iframe') {
		if (node.contentDocument) {
			const htmlElement = findHtmlInContentDocument(node);
			if (htmlElement) {
				const info = getScrollInfo(htmlElement);
				if (info) {
					const pagesBelow = info.pagesBelow;
					const pagesAbove = info.pagesAbove;
					const vPct = Math.floor(info.verticalScrollPercentage);

					if (pagesBelow > 0 || pagesAbove > 0) {
						return `scroll: ${pagesAbove.toFixed(1)}↑ ${pagesBelow.toFixed(1)}↓ ${vPct}%`;
					}
				}
			}
		}
		return 'scroll';
	}

	const scrollInfo = getScrollInfo(node);
	if (!scrollInfo) {
		return '';
	}

	const parts: string[] = [];

	// Vertical scroll info (concise format)
	if (scrollInfo.scrollableHeight > scrollInfo.visibleHeight) {
		parts.push(
			`${scrollInfo.pagesAbove.toFixed(1)} pages above, ${scrollInfo.pagesBelow.toFixed(1)} pages below`
		);
	}

	// Horizontal scroll info (concise format)
	if (scrollInfo.scrollableWidth > scrollInfo.visibleWidth) {
		parts.push(`horizontal ${scrollInfo.horizontalScrollPercentage.toFixed(0)}%`);
	}

	return parts.join(' ');
}

/**
 * Find HTML element in iframe content document
 */
function findHtmlInContentDocument(node: EnhancedDOMTreeNode): EnhancedDOMTreeNode | null {
	if (!node.contentDocument) {
		return null;
	}

	// Check if content document itself is HTML
	if (getTagName(node.contentDocument) === 'html') {
		return node.contentDocument;
	}

	// Look through children for HTML element
	if (node.contentDocument.childrenNodes) {
		for (const child of node.contentDocument.childrenNodes) {
			if (getTagName(child) === 'html') {
				return child;
			}
		}
	}

	return null;
}

/**
 * Get LLM-friendly representation of a node
 */
export function llmRepresentation(node: EnhancedDOMTreeNode, maxTextLength: number = 100): string {
	const text = getAllChildrenText(node);
	const cappedText = text.length > maxTextLength ? text.substring(0, maxTextLength) + '...' : text;
	return `<${getTagName(node)}>${cappedText || ''}`;
}

/**
 * Calculate parent branch hash
 */
export function parentBranchHash(node: EnhancedDOMTreeNode): number {
	const parentBranchPath = getParentBranchPath(node);
	const parentBranchPathString = parentBranchPath.join('/');
	const hash = crypto.createHash('sha256').update(parentBranchPathString).digest('hex');
	return parseInt(hash.substring(0, 16), 16);
}

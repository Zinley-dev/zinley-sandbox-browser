/**
 * DOM extraction and processing service
 * Uses CDP DOM.getDocument for real backendNodeIds like Python browser-use
 */

import { Page, CDPSession } from 'patchright';
import { EnhancedDOMTreeNode, DOMPosition } from '../events/browser-events.js';

export interface DOMExtractionOptions {
	/** Include screenshots with element highlights */
	includeScreenshot?: boolean;

	/** Highlight interactive elements */
	highlightElements?: boolean;

	/** Attributes to extract from elements */
	includeAttributes?: string[];

	/** Use CDP accessibility tree for better element detection */
	useCDPAccessibility?: boolean;

	/** Include cross-origin iframes */
	crossOriginIframes?: boolean;

	/** Apply paint order filtering for visibility */
	paintOrderFiltering?: boolean;

	/** Apply bounding box filtering to remove elements contained within parent clickables */
	bboxFiltering?: boolean;

	/** Maximum number of iframes to process */
	maxIframes?: number;

	/** Maximum iframe nesting depth */
	maxIframeDepth?: number;

	/**
	 * Pixel margin beyond the viewport within which elements still count as visible.
	 * `null` disables viewport-based filtering (only CSS visibility is checked).
	 */
	viewportThreshold?: number | null;
}

/** A hidden interactive element inside an iframe, reported to the LLM as a scroll hint */
export interface HiddenElementInfo {
	tag: string;
	text: string;
	/** Scroll distance from the top of the iframe viewport, in viewport pages */
	pages: number;
}

export interface PageState {
	url: string;
	title: string;
	domTree: DOMTreeNode[];
	screenshot?: string;
	/** Selector map keyed by backendNodeId (like Python) */
	selectorMap: Map<number, EnhancedDOMTreeNode>;
	viewportInfo?: ViewportInfo;
}

export interface ViewportInfo {
	width: number;
	height: number;
	scrollX: number;
	scrollY: number;
	devicePixelRatio: number;
}

export interface DOMTreeNode {
	/** backendNodeId from CDP (like Python) - used as the index for LLM actions */
	index: number;
	tagName: string;
	text?: string;
	attributes?: Record<string, string>;
	children: DOMTreeNode[];
	isInteractive: boolean;
	isVisible?: boolean; // Element is visible in viewport (like Python - separate from isInteractive)
	position?: DOMPosition;
	isNew?: boolean; // Element appeared since last extraction
	role?: string; // ARIA role
	accessibleName?: string; // Accessible name from a11y tree
	/** Not visible only because it lies beyond the viewport threshold (not hidden by CSS) */
	hiddenByThreshold?: boolean;
	/** Iframes: interactive elements hidden below the iframe viewport, with scroll distances */
	hiddenElementsInfo?: HiddenElementInfo[];
	/** Iframes: there is non-interactive content hidden below the iframe viewport */
	hasHiddenContent?: boolean;
}

export interface AccessibilityNode {
	nodeId: string;
	ignored: boolean;
	role?: string;
	name?: string;
	description?: string;
	value?: string;
	childIds?: string[];
	backendDOMNodeId?: number;
	properties?: Array<{
		name: string;
		value: any;
	}>;
}

export interface DOMSnapshotNode {
	nodeType: number;
	nodeName: string;
	nodeValue?: string;
	backendNodeId: number;
	childNodeIndexes?: number[];
	attributes?: string[];
	contentDocumentIndex?: number;
	frameId?: string;
	layoutNodeIndex?: number;
}

export interface LayoutTreeNode {
	domNodeIndex: number;
	boundingBox: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	layoutText?: string;
	styleIndex?: number;
}

/** CDP DOM node structure from DOM.getDocument */
interface CDPDOMNode {
	nodeId: number;
	parentId?: number;
	backendNodeId: number;
	nodeType: number;
	nodeName: string;
	localName: string;
	nodeValue: string;
	childNodeCount?: number;
	children?: CDPDOMNode[];
	attributes?: string[];
	documentURL?: string;
	frameId?: string;
	contentDocument?: CDPDOMNode;
	shadowRoots?: CDPDOMNode[];
	isSVG?: boolean;
}

/** Snapshot node data with bounds and visibility (matches Python EnhancedSnapshotNode) */
interface SnapshotNodeData {
	bounds?: DOMPosition;
	isClickable?: boolean;
	cursorStyle?: string;
	computedStyles?: Record<string, string>;
	/** Viewport coordinates (origin = top-left of visible scrollport) - matches Python */
	clientRects?: DOMPosition;
	/** Scrollable area of the element - matches Python */
	scrollRects?: DOMPosition;
	/** Paint order for z-index handling */
	paintOrder?: number;
	/**
	 * Live value of an <input> or <textarea> (DOMSnapshot inputValue/textValue), which the
	 * value attribute misses when JS, autofill, or a framework set it.
	 */
	inputValue?: string | null;
	/** Live checked state of a checkbox or radio input (DOMSnapshot inputChecked) */
	inputChecked?: boolean | null;
}

// Live values of these fields never leave the snapshot: they could otherwise reach logs or the LLM.
const SENSITIVE_INPUT_TYPES = new Set(['password', 'file', 'hidden']);
const SENSITIVE_AUTOCOMPLETE_PREFIXES = ['cc-', 'one-time-code'];

/**
 * True for password/file/hidden inputs and payment or one-time-code autocomplete fields.
 * `nodes.attributes[snapshotIndex]` is the flat [nameIndex, valueIndex, ...] list of a snapshot node.
 */
export function isSensitiveSnapshotInput(strings: string[], nodes: any, snapshotIndex: number): boolean {
	const attributeLists = nodes?.attributes;
	if (!attributeLists || snapshotIndex >= attributeLists.length) {
		return false;
	}
	const indices: number[] = attributeLists[snapshotIndex] || [];
	for (let i = 0; i + 1 < indices.length; i += 2) {
		const nameIndex = indices[i];
		const valueIndex = indices[i + 1];
		if (nameIndex < 0 || nameIndex >= strings.length || valueIndex < 0 || valueIndex >= strings.length) {
			continue;
		}
		const name = strings[nameIndex].toLowerCase();
		const value = strings[valueIndex].toLowerCase();
		if (name === 'type' && SENSITIVE_INPUT_TYPES.has(value)) {
			return true;
		}
		if (name === 'autocomplete' && SENSITIVE_AUTOCOMPLETE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
			return true;
		}
	}
	return false;
}

/** Form controls whose presence makes a wrapping <label>/<span> clickable */
const FORM_CONTROL_TAGS = new Set(['input', 'select', 'textarea']);

/**
 * Detect nested form controls within a limited depth (handles label/span wrappers such as
 * Ant Design radios and checkboxes). Port of `has_form_control_descendant`.
 */
export function hasFormControlDescendant(node: { children?: any[]; shadowRoots?: any[] } | undefined, maxDepth = 2): boolean {
	if (!node || maxDepth <= 0) {
		return false;
	}
	const children = [...(node.children || []), ...(node.shadowRoots || [])];
	for (const child of children) {
		if (child?.nodeType !== 1) {
			continue;
		}
		const tag = (child.nodeName || '').toLowerCase();
		if (FORM_CONTROL_TAGS.has(tag)) {
			return true;
		}
		if (hasFormControlDescendant(child, maxDepth - 1)) {
			return true;
		}
	}
	return false;
}

/** ISO formats HTML5 date/time inputs always require for their `.value` */
const HTML5_DATE_FORMATS: Record<string, string> = {
	date: 'YYYY-MM-DD',
	time: 'HH:MM',
	'datetime-local': 'YYYY-MM-DDTHH:MM',
	month: 'YYYY-MM',
	week: 'YYYY-W##',
};

/**
 * Synthetic `format` / `expected_format` / `placeholder` hints for inputs whose required text
 * format the model would otherwise have to guess (HTML5 date/time inputs, tel, jQuery/Bootstrap
 * and AngularJS datepickers). Port of the format-hint block in `_build_attributes_string`.
 *
 * @param tag lower-case tag name
 * @param allAttributes every DOM attribute of the element (class is needed for datepicker detection)
 * @param existing attributes already selected for display (placeholder/pattern are respected)
 * @returns hints to merge into the displayed attributes
 */
export function buildInputFormatHints(
	tag: string,
	allAttributes: Record<string, string>,
	existing: Record<string, string> = {}
): Record<string, string> {
	const hints: Record<string, string> = {};
	if (tag !== 'input') {
		return hints;
	}
	const inputType = (allAttributes.type || '').toLowerCase();

	// For HTML5 date/time inputs, add a highly visible "format" attribute
	if (inputType in HTML5_DATE_FORMATS) {
		hints.format = HTML5_DATE_FORMATS[inputType];
	}

	// Only add placeholder if it doesn't already exist
	if (!('placeholder' in existing) && !allAttributes.placeholder) {
		if (inputType in HTML5_DATE_FORMATS) {
			hints.placeholder = HTML5_DATE_FORMATS[inputType];
		} else if (inputType === 'tel' && !('pattern' in existing) && !allAttributes.pattern) {
			hints.placeholder = '123-456-7890';
		} else if (inputType === 'text' || inputType === '') {
			const classAttr = (allAttributes.class || '').toLowerCase();
			if ('uib-datepicker-popup' in allAttributes) {
				// AngularJS UI Bootstrap datepicker: uib-datepicker-popup="MM/dd/yyyy"
				const dateFormat = allAttributes['uib-datepicker-popup'];
				if (dateFormat) {
					hints.expected_format = dateFormat;
					hints.format = dateFormat;
				}
			} else if (['datepicker', 'datetimepicker', 'daterangepicker'].some((indicator) => classAttr.includes(indicator))) {
				// jQuery/Bootstrap datepickers, format from data-date-format or the common US default
				const dateFormat = allAttributes['data-date-format'] || 'mm/dd/yyyy';
				hints.placeholder = dateFormat;
				hints.format = dateFormat;
			} else if ('data-datepicker' in allAttributes) {
				const dateFormat = allAttributes['data-date-format'] || 'mm/dd/yyyy';
				hints.placeholder = dateFormat;
				hints.format = dateFormat;
			}
		}
	}

	return hints;
}

/** Attributes that are never removed as duplicates (they serve distinct purposes) */
const PROTECTED_DISPLAY_ATTRIBUTES = new Set(['format', 'expected_format', 'placeholder', 'value', 'aria-label', 'title']);

// Matches Python's DEFAULT_INCLUDE_ATTRIBUTES in views.py exactly
const DEFAULT_ATTRIBUTES = [
	'title',
	'type',
	'checked',
	// 'class', // EXCLUDED like Python
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
	// ARIA value attributes for datetime/range inputs
	'aria-valuemin',
	'aria-valuemax',
	'aria-valuenow',
	'aria-placeholder',
	// Validation attributes - help agents avoid brute force attempts
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
	// Webkit shadow DOM identifiers
	'pseudo',
	// Accessibility properties from ax_node (ordered by importance for automation)
	// Note: 'checked' is duplicated in Python, we just include once
	'selected',
	'expanded',
	'pressed',
	'disabled',
	'invalid', // Current validation state from AX node
	'valuemin', // Min value from AX node (for datetime/range)
	'valuemax', // Max value from AX node (for datetime/range)
	'valuenow',
	'keyshortcuts',
	'haspopup',
	'multiselectable',
	// Less commonly needed (uncomment if required):
	// 'readonly',
	'required',
	'valuetext',
	'level',
	'busy',
	'live',
	// Accessibility name (contains text content for StaticText elements)
	'ax_name',
];

const INTERACTIVE_SELECTORS = [
	'a[href]',
	'button',
	'input:not([type="hidden"])',
	'select',
	'textarea',
	'[role="button"]',
	'[role="link"]',
	'[role="checkbox"]',
	'[role="radio"]',
	'[role="tab"]',
	'[role="menuitem"]',
	'[role="option"]',
	'[role="switch"]',
	'[role="slider"]',
	'[role="spinbutton"]',
	'[role="combobox"]',
	'[role="listbox"]',
	'[role="textbox"]',
	'[role="searchbox"]',
	'[onclick]',
	'[onmousedown]',
	'[onmouseup]',
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])',
	'summary',
	'details',
	'label[for]',
].join(', ');

const INTERACTIVE_ROLES = new Set([
	'button',
	'link',
	'checkbox',
	'radio',
	'tab',
	'menuitem',
	'option',
	'switch',
	'slider',
	'spinbutton',
	'combobox',
	'listbox',
	'textbox',
	'searchbox',
	'gridcell',
	'treeitem',
]);

/**
 * DOM extraction service for getting page state
 * Supports both basic JS extraction and CDP-based extraction
 */
export class DOMService {
	/** Above this many elements with click listeners, listener resolution is skipped */
	static readonly MAX_JS_CLICK_LISTENER_ELEMENTS = 100;
	/** DOM.describeNode calls in flight at once while resolving listener elements */
	static readonly DESCRIBE_NODE_BATCH_SIZE = 20;
	static readonly JS_CLICK_LISTENER_OVERFLOW = '__browser_use_too_many_click_listeners__';
	/** Cross-origin iframes smaller than this (per edge, px) are ignored */
	static readonly MIN_CROSS_ORIGIN_IFRAME_EDGE = 10;

	private cdpSession: CDPSession | null = null;
	private previousElements: Set<string> = new Set();
	private crossOriginIframes: boolean;
	private paintOrderFiltering: boolean;
	private maxIframes: number;
	private maxIframeDepth: number;
	/** Viewport margin (px) within which off-screen elements still count as visible; null disables */
	private viewportThreshold: number | null;

	/**
	 * Default viewport margin. Upstream uses 1000px; this port keeps the larger margin the
	 * Orion fork adopted for long forms (lazy-loaded content, Google Forms).
	 */
	static readonly DEFAULT_VIEWPORT_THRESHOLD = 2000;

	constructor(
		private page: Page,
		options: {
			crossOriginIframes?: boolean;
			paintOrderFiltering?: boolean;
			maxIframes?: number;
			maxIframeDepth?: number;
			viewportThreshold?: number | null;
		} = {}
	) {
		this.crossOriginIframes = options.crossOriginIframes ?? false;
		this.paintOrderFiltering = options.paintOrderFiltering ?? true;
		this.maxIframes = options.maxIframes ?? 100;
		this.maxIframeDepth = options.maxIframeDepth ?? 5;
		this.viewportThreshold =
			options.viewportThreshold === undefined ? DOMService.DEFAULT_VIEWPORT_THRESHOLD : options.viewportThreshold;
	}

	/**
	 * Get or create a CDP session
	 */
	private async getCDPSession(): Promise<CDPSession> {
		if (!this.cdpSession) {
			const context = this.page.context();
			this.cdpSession = await context.newCDPSession(this.page);
		}
		return this.cdpSession;
	}

	/**
	 * Get viewport information using CDP
	 */
	async getViewportInfo(): Promise<ViewportInfo> {
		try {
			const cdp = await this.getCDPSession();

			// Get layout metrics
			const metrics = await cdp.send('Page.getLayoutMetrics');

			// IMPORTANT: Use CSS viewport instead of device pixel viewport (matches Python)
			const visualViewport = (metrics as any).visualViewport || {};
			const cssVisualViewport = (metrics as any).cssVisualViewport || {};
			const cssLayoutViewport = (metrics as any).cssLayoutViewport || (metrics as any).layoutViewport || {};

			// Use CSS pixels (what JavaScript sees) instead of device pixels
			const width = cssVisualViewport.clientWidth || cssLayoutViewport.clientWidth || 1920;
			const height = cssVisualViewport.clientHeight || cssLayoutViewport.clientHeight || 1080;

			// Calculate device pixel ratio correctly (matches Python)
			// DPR = visualViewport.clientWidth (device pixels) / cssVisualViewport.clientWidth (CSS pixels)
			const deviceWidth = visualViewport.clientWidth || width;
			const cssWidth = cssVisualViewport.clientWidth || width;
			const devicePixelRatio = cssWidth > 0 ? deviceWidth / cssWidth : 1;

			return {
				width,
				height,
				scrollX: cssVisualViewport.pageX || 0,
				scrollY: cssVisualViewport.pageY || 0,
				devicePixelRatio,
			};
		} catch (error) {
			// Fallback to basic viewport info
			const viewport = this.page.viewportSize();
			return {
				width: viewport?.width || 1920,
				height: viewport?.height || 1080,
				scrollX: 0,
				scrollY: 0,
				devicePixelRatio: 1,
			};
		}
	}

	/**
	 * Recursively collect all frame IDs from frame tree
	 */
	private collectAllFrameIds(frameTreeNode: any): string[] {
		const frameIds: string[] = [frameTreeNode.frame.id];

		if (frameTreeNode.childFrames && frameTreeNode.childFrames.length > 0) {
			for (const childFrame of frameTreeNode.childFrames) {
				frameIds.push(...this.collectAllFrameIds(childFrame));
			}
		}

		return frameIds;
	}

	/**
	 * Get full accessibility tree using CDP for all frames
	 * Matches Python's _get_ax_tree_for_all_frames implementation
	 */
	async getAccessibilityTree(): Promise<Map<number, AccessibilityNode>> {
		const nodeMap = new Map<number, AccessibilityNode>();

		try {
			const cdp = await this.getCDPSession();

			// Enable Page domain to get frame tree
			await cdp.send('Page.enable');

			// Get the frame tree to find all frames
			let allFrameIds: string[] = [];
			try {
				const frameTreeResult = await cdp.send('Page.getFrameTree');
				const frameTree = (frameTreeResult as any).frameTree;
				if (frameTree) {
					allFrameIds = this.collectAllFrameIds(frameTree);
					console.debug(`Found ${allFrameIds.length} frames for AX tree extraction`);
				}
			} catch (error) {
				console.debug('Failed to get frame tree, falling back to main frame only:', error);
			}

			// Get accessibility tree for each frame and merge
			const axTreePromises: Promise<any>[] = [];

			if (allFrameIds.length > 0) {
				// Get AX tree for each frame
				for (const frameId of allFrameIds) {
					axTreePromises.push(
						cdp.send('Accessibility.getFullAXTree', { frameId }).catch((err) => {
							console.debug(`Failed to get AX tree for frame ${frameId}:`, err);
							return { nodes: [] };
						})
					);
				}
			} else {
				// Fallback to main frame only
				axTreePromises.push(cdp.send('Accessibility.getFullAXTree'));
			}

			// Wait for all requests to complete
			const axTrees = await Promise.all(axTreePromises);

			// Merge all AX nodes
			for (const result of axTrees) {
				const nodes = (result as any).nodes || [];
				for (const node of nodes) {
					if (node.backendDOMNodeId) {
						nodeMap.set(node.backendDOMNodeId, {
							nodeId: node.nodeId,
							ignored: node.ignored || false,
							role: node.role?.value,
							name: node.name?.value,
							description: node.description?.value,
							value: node.value?.value,
							childIds: node.childIds,
							backendDOMNodeId: node.backendDOMNodeId,
							properties: node.properties,
						});
					}
				}
			}
		} catch (error) {
			console.debug('Failed to get accessibility tree:', error);
		}

		return nodeMap;
	}

	/**
	 * Get DOM snapshot using CDP
	 */
	async getDOMSnapshot(): Promise<{
		documents: any[];
		strings: string[];
	} | null> {
		try {
			const cdp = await this.getCDPSession();

			// Get DOM snapshot with computed styles
			const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', {
				computedStyles: [
					'display',
					'visibility',
					'opacity',
					'position',
					'overflow',
					'z-index',
					'pointer-events',
				],
				includePaintOrder: this.paintOrderFiltering,
				includeDOMRects: true,
			});

			return snapshot as any;
		} catch (error) {
			console.debug('Failed to get DOM snapshot:', error);
			return null;
		}
	}

	/**
	 * Check if an element is visible based on computed styles
	 */
	private isElementVisible(computedStyles: Record<string, string>): boolean {
		const display = (computedStyles['display'] || '').toLowerCase();
		const visibility = (computedStyles['visibility'] || '').toLowerCase();
		const opacity = computedStyles['opacity'] || '1';
		const pointerEvents = (computedStyles['pointer-events'] || '').toLowerCase();

		if (display === 'none') return false;
		if (visibility === 'hidden') return false;
		if (pointerEvents === 'none') return false;

		try {
			if (parseFloat(opacity) <= 0) return false;
		} catch {
			// Ignore parse errors
		}

		return true;
	}

	/**
	 * Build snapshot lookup from DOMSnapshot.captureSnapshot result
	 * Maps backendNodeId -> SnapshotNodeData (bounds, visibility, etc.)
	 * Matches Python's build_snapshot_lookup exactly.
	 */
	private buildSnapshotLookup(snapshot: any, devicePixelRatio: number): Map<number, SnapshotNodeData> {
		const lookup = new Map<number, SnapshotNodeData>();

		if (!snapshot?.documents || snapshot.documents.length === 0) {
			return lookup;
		}

		const strings = snapshot.strings || [];

		// Required computed styles order (must match DOMSnapshot.captureSnapshot request)
		const REQUIRED_COMPUTED_STYLES = [
			'display',
			'visibility',
			'opacity',
			'overflow',
			'overflow-x',
			'overflow-y',
			'cursor',
			'pointer-events',
			'position',
			'background-color',
		];

		// Process each document (main document + iframes)
		for (const doc of snapshot.documents) {
			const nodes = doc.nodes || {};
			const layout = doc.layout || {};

			// Build backendNodeId to snapshot index mapping (matches Python)
			const backendNodeToSnapshotIndex = new Map<number, number>();
			const backendNodeIds = nodes.backendNodeId || [];
			for (let i = 0; i < backendNodeIds.length; i++) {
				backendNodeToSnapshotIndex.set(backendNodeIds[i], i);
			}

			// Build layout index map for quick lookup (matches Python - use FIRST occurrence)
			const layoutIndexMap = new Map<number, number>();
			const layoutNodeIndexes = layout.nodeIndex || [];
			for (let layoutIdx = 0; layoutIdx < layoutNodeIndexes.length; layoutIdx++) {
				const nodeIndex = layoutNodeIndexes[layoutIdx];
				if (!layoutIndexMap.has(nodeIndex)) {
					layoutIndexMap.set(nodeIndex, layoutIdx);
				}
			}

			// Pre-convert rare boolean data to sets for O(1) lookups: `index in list` per node was O(n²)
			// and the #1 bottleneck on heavy pages (20k elements: ~6s -> ~2ms).
			const hasClickableData = !!nodes.isClickable;
			const isClickableSet = new Set<number>(nodes.isClickable?.index || []);

			// Live form values live in the snapshot, not in the DOM attributes. Map snapshot
			// index -> string once so each node lookup stays O(1). Sensitive fields are skipped.
			const inputValueByIndex = new Map<number, string>();
			for (const key of ['inputValue', 'textValue']) {
				const rare = nodes[key];
				if (rare?.index && rare?.value) {
					for (let i = 0; i < rare.index.length; i++) {
						const idx = rare.index[i];
						const stringIndex = rare.value[i];
						if (stringIndex >= 0 && stringIndex < strings.length && !isSensitiveSnapshotInput(strings, nodes, idx)) {
							inputValueByIndex.set(idx, strings[stringIndex]);
						}
					}
				}
			}
			const hasCheckedData = !!nodes.inputChecked;
			const inputCheckedSet = new Set<number>(nodes.inputChecked?.index || []);

			// Process each backend node id (matches Python exactly)
			for (const [backendNodeId, snapshotIndex] of backendNodeToSnapshotIndex) {
				let nodeData: SnapshotNodeData = {};

				// Get isClickable if available (RareBooleanData format)
				if (hasClickableData) {
					nodeData.isClickable = isClickableSet.has(snapshotIndex);
				}

				if (inputValueByIndex.has(snapshotIndex)) {
					nodeData.inputValue = inputValueByIndex.get(snapshotIndex)!;
				}
				if (hasCheckedData) {
					nodeData.inputChecked = inputCheckedSet.has(snapshotIndex);
				}

				// Find corresponding layout node (matches Python)
				const layoutIdx = layoutIndexMap.get(snapshotIndex);
				if (layoutIdx !== undefined) {
					// Parse bounding box (matches Python)
					const boundsArray = layout.bounds || [];
					if (layoutIdx < boundsArray.length) {
						const bounds = boundsArray[layoutIdx];
						if (bounds && bounds.length >= 4) {
							// Apply device pixel ratio scaling (matches Python)
							nodeData.bounds = {
								x: bounds[0] / devicePixelRatio,
								y: bounds[1] / devicePixelRatio,
								width: bounds[2] / devicePixelRatio,
								height: bounds[3] / devicePixelRatio,
							};
						}
					}

					// Parse computed styles for this layout node (matches Python)
					const layoutStyles = layout.styles || [];
					if (layoutIdx < layoutStyles.length) {
						const styleIndices = layoutStyles[layoutIdx] || [];
						const computedStyles: Record<string, string> = {};
						for (let i = 0; i < styleIndices.length && i < REQUIRED_COMPUTED_STYLES.length; i++) {
							const stringIdx = styleIndices[i];
							if (stringIdx >= 0 && stringIdx < strings.length) {
								computedStyles[REQUIRED_COMPUTED_STYLES[i]] = strings[stringIdx];
							}
						}
						if (Object.keys(computedStyles).length > 0) {
							nodeData.computedStyles = computedStyles;
							nodeData.cursorStyle = computedStyles['cursor'];
						}
					}

					// Extract paint order if available (matches Python)
					const paintOrders = layout.paintOrders || [];
					if (layoutIdx < paintOrders.length) {
						nodeData.paintOrder = paintOrders[layoutIdx];
					}

					// Extract client rects if available (matches Python)
					const clientRectsArray = layout.clientRects || [];
					if (layoutIdx < clientRectsArray.length) {
						const clientRectData = clientRectsArray[layoutIdx];
						if (clientRectData && clientRectData.length >= 4) {
							nodeData.clientRects = {
								x: clientRectData[0],
								y: clientRectData[1],
								width: clientRectData[2],
								height: clientRectData[3],
							};
						}
					}

					// Extract scroll rects if available (matches Python)
					const scrollRectsArray = layout.scrollRects || [];
					if (layoutIdx < scrollRectsArray.length) {
						const scrollRectData = scrollRectsArray[layoutIdx];
						if (scrollRectData && scrollRectData.length >= 4) {
							nodeData.scrollRects = {
								x: scrollRectData[0],
								y: scrollRectData[1],
								width: scrollRectData[2],
								height: scrollRectData[3],
							};
						}
					}
				}

				lookup.set(backendNodeId, nodeData);
			}
		}

		return lookup;
	}

	/**
	 * Check if a DOM node is interactive based on its properties
	 * Matches Python browser-use ClickableElementDetector.is_interactive exactly
	 */
	private isInteractiveNode(
		nodeName: string,
		attributes: Record<string, string>,
		isClickable: boolean,
		axNode?: AccessibilityNode,
		bounds?: DOMPosition,
		cursorStyle?: string,
		hasJsClickListener?: boolean,
		cdpNode?: CDPDOMNode
	): boolean {
		const tag = nodeName.toLowerCase();

		// Skip html and body nodes (like Python)
		if (tag === 'html' || tag === 'body') {
			return false;
		}

		// CRITICAL: Elements with JS click listeners are interactive (matches Python line 675)
		// Python: has_js_click_listener=node['backendNodeId'] in js_click_listener_backend_ids
		// This is a strong signal that the element handles clicks
		if (hasJsClickListener) {
			return true;
		}

		// IFRAME elements handling (like Python - >100x100px)
		// NOTE: Unlike before, we DON'T early return false for small iframes
		// Small iframes might still have interactive roles that should be detected
		if (tag === 'iframe' || tag === 'frame') {
			if (bounds && bounds.width > 100 && bounds.height > 100) {
				return true;
			}
			// Don't return false - continue to check for interactive roles
			// This matches Python which doesn't early return for small iframes
		}

		// Specialized handling for labels used as component wrappers (e.g., Ant Design radio/checkbox)
		if (tag === 'label') {
			// Skip labels that proxy via "for" to avoid double-activating external inputs
			if (attributes.for) {
				return false;
			}
			// Detect labels that wrap form controls up to two levels deep (label > span > input)
			if (hasFormControlDescendant(cdpNode, 2)) {
				return true;
			}
			// Fall through to pointer/role/attribute heuristics for other label cases
		}

		// Span wrappers for UI components (detect clear interactive signals only)
		if (tag === 'span' && hasFormControlDescendant(cdpNode, 2)) {
			return true;
		}

		// SEARCH ELEMENT DETECTION (like Python)
		const searchIndicators = [
			'search', 'magnify', 'glass', 'lookup', 'find', 'query',
			'search-icon', 'search-btn', 'search-button', 'searchbox'
		];

		// Check class names for search indicators
		const classList = (attributes.class || '').toLowerCase();
		if (searchIndicators.some(indicator => classList.includes(indicator))) {
			return true;
		}

		// Check id for search indicators
		const elementId = (attributes.id || '').toLowerCase();
		if (searchIndicators.some(indicator => elementId.includes(indicator))) {
			return true;
		}

		// Check data attributes for search functionality
		for (const [attrName, attrValue] of Object.entries(attributes)) {
			if (attrName.startsWith('data-') && attrValue) {
				if (searchIndicators.some(indicator => attrValue.toLowerCase().includes(indicator))) {
					return true;
				}
			}
		}

		// Enhanced accessibility property checks (like Python)
		if (axNode && axNode.properties) {
			for (const prop of axNode.properties) {
				try {
					// aria disabled - skip disabled elements
					if (prop.name === 'disabled' && prop.value) {
						return false;
					}

					// aria hidden - skip hidden elements
					if (prop.name === 'hidden' && prop.value) {
						return false;
					}

					// Direct interactiveness indicators
					if (['focusable', 'editable', 'settable'].includes(prop.name) && prop.value) {
						return true;
					}

					// Interactive state properties (presence indicates interactive widget)
					if (['checked', 'expanded', 'pressed', 'selected'].includes(prop.name)) {
						return true;
					}

					// Form-related interactiveness
					if (['required', 'autocomplete'].includes(prop.name) && prop.value) {
						return true;
					}

					// Elements with keyboard shortcuts are interactive
					if (prop.name === 'keyshortcuts' && prop.value) {
						return true;
					}
				} catch {
					continue;
				}
			}
		}

		// ENHANCED TAG CHECK: Interactive elements (like Python)
		const interactiveTags = new Set([
			'button', 'input', 'select', 'textarea', 'a',
			'details', 'summary', 'option', 'optgroup'
		]);
		if (interactiveTags.has(tag)) {
			// Exclude hidden inputs
			if (tag === 'input' && attributes.type === 'hidden') {
				return false;
			}
			return true;
		}

		// Check for event handlers or interactive attributes (like Python)
		const interactiveAttributes = ['onclick', 'onmousedown', 'onmouseup', 'onkeydown', 'onkeyup', 'tabindex'];
		if (interactiveAttributes.some(attr => attr in attributes)) {
			return true;
		}

		// Check for interactive ARIA roles (like Python)
		const role = attributes.role?.toLowerCase();
		if (role) {
			const interactiveRoles = new Set([
				'button', 'link', 'menuitem', 'option', 'radio', 'checkbox',
				'tab', 'textbox', 'combobox', 'slider', 'spinbutton', 'search', 'searchbox',
				'row', 'cell', 'gridcell'
			]);
			if (interactiveRoles.has(role)) {
				return true;
			}
		}

		// Accessibility tree roles (like Python)
		if (axNode && axNode.role) {
			const interactiveAxRoles = new Set([
				'button', 'link', 'menuitem', 'option', 'radio', 'checkbox',
				'tab', 'textbox', 'combobox', 'slider', 'spinbutton', 'listbox', 'search', 'searchbox',
				'row', 'cell', 'gridcell'
			]);
			if (interactiveAxRoles.has(axNode.role.toLowerCase())) {
				return true;
			}
		}

		// ICON AND SMALL ELEMENT CHECK (like Python - 10-50px)
		if (bounds && bounds.width >= 10 && bounds.width <= 50 &&
			bounds.height >= 10 && bounds.height <= 50) {
			// Small elements with these attributes are likely interactive icons
			const iconAttributes = ['class', 'role', 'onclick', 'data-action', 'aria-label'];
			if (iconAttributes.some(attr => attr in attributes)) {
				return true;
			}
		}

		// NOTE: Python does NOT check isClickable from Chrome CDP here
		// Python only checks cursor_style === 'pointer' as final fallback
		// isClickable parameter is kept for potential future use but not used

		// Contenteditable elements
		if (attributes.contenteditable === 'true') {
			return true;
		}

		// Final fallback: cursor style indicates interactivity (matches Python exactly)
		// Python: if node.snapshot_node and node.snapshot_node.cursor_style and node.snapshot_node.cursor_style == 'pointer'
		if (cursorStyle === 'pointer') {
			return true;
		}

		return false;
	}

	/**
	 * Check if element is visible according to all parent HTML frames.
	 * Matches Python's is_element_visible_according_to_all_parents exactly.
	 *
	 * @param snapshotData The snapshot data for this node (bounds, computedStyles)
	 * @param htmlFrames List of HTML frame nodes encountered so far in the tree traversal
	 */
	private isElementVisibleAccordingToAllParents(
		snapshotData: SnapshotNodeData | undefined,
		htmlFrames: Array<{ nodeName: string; frameId?: string; snapshotData?: SnapshotNodeData }>,
		viewportThreshold: number | null = this.viewportThreshold
	): boolean {
		// Python: "If there are no bounds, the element is not visible"
		if (!snapshotData) return false;

		// Check computed styles (matches Python exactly)
		if (!DOMService.isVisibleByComputedStyles(snapshotData.computedStyles)) {
			return false;
		}

		// Start with the element's local bounds
		const bounds = snapshotData.bounds;
		if (!bounds) return false;

		// If threshold is null, skip all viewport-based filtering (only check CSS visibility)
		if (viewportThreshold === null) {
			return true;
		}

		// Work on a copy: snapshot bounds are shared, in-place mutation corrupts other consumers
		let currentBounds = { ...bounds };

		// Reverse iterate through html frames (matches Python exactly)
		// Check if element is visible within each frame's viewport
		for (let i = htmlFrames.length - 1; i >= 0; i--) {
			const frame = htmlFrames[i];

			// Skip self: a frame node appears in its own frame chain and must not offset itself
			if (frame.snapshotData === snapshotData) {
				continue;
			}

			// For IFRAME/FRAME elements: adjust coordinates by iframe position
			if (frame.nodeName.toUpperCase() === 'IFRAME' || frame.nodeName.toUpperCase() === 'FRAME') {
				if (frame.snapshotData?.bounds) {
					const iframeBounds = frame.snapshotData.bounds;
					// Negate the values added in tree construction (matches Python)
					currentBounds.x += iframeBounds.x;
					currentBounds.y += iframeBounds.y;
				}
			}

			// For HTML elements (document roots): check visibility within frame viewport
			if (frame.nodeName === 'HTML' && frame.snapshotData) {
				const scrollRects = frame.snapshotData.scrollRects;
				const clientRects = frame.snapshotData.clientRects;

				if (scrollRects && clientRects) {
					// The viewport of the frame (what's actually visible)
					const viewportLeft = 0;
					const viewportTop = 0;
					const viewportRight = clientRects.width;
					const viewportBottom = clientRects.height;

					// Adjust element bounds by scroll offset to get position relative to viewport
					const adjustedX = currentBounds.x - scrollRects.x;
					const adjustedY = currentBounds.y - scrollRects.y;

					// Check intersection with a +/- viewportThreshold margin (default 2000px, upstream 1000px).
					// This buffer ensures elements just outside the viewport are still captured,
					// which is critical for lazy-loaded content and long forms like Google Forms
					const frameIntersects = (
						adjustedX < viewportRight &&
						adjustedX + currentBounds.width > viewportLeft &&
						adjustedY < viewportBottom + viewportThreshold &&
						adjustedY + currentBounds.height > viewportTop - viewportThreshold
					);

					if (!frameIntersects) {
						return false;
					}

					// Keep coordinate adjustment for next frame (matches Python)
					currentBounds.x -= scrollRects.x;
					currentBounds.y -= scrollRects.y;
				}
			}
		}

		// If we reach here, element is visible in all containing frames
		return true;
	}

	/** CSS-level visibility (display/visibility/opacity) of a snapshot node */
	static isVisibleByComputedStyles(computedStyles: Record<string, string> | undefined | null): boolean {
		const styles = computedStyles || {};
		const display = (styles['display'] || '').toLowerCase();
		const visibility = (styles['visibility'] || '').toLowerCase();
		if (display === 'none' || visibility === 'hidden') {
			return false;
		}
		const opacity = parseFloat(styles['opacity'] || '1');
		if (!Number.isNaN(opacity) && opacity <= 0) {
			return false;
		}
		return true;
	}

	/**
	 * Collect hidden interactive elements inside an iframe's content for LLM hints.
	 * Port of `_count_hidden_elements_in_iframes`: returns up to 10 entries sorted by scroll
	 * distance, plus whether any (non-interactive) content is hidden below the viewport threshold.
	 */
	static collectHiddenIframeContent(
		contentNodes: DOMTreeNode[],
		viewportHeight: number
	): { hidden: HiddenElementInfo[]; hasHiddenContent: boolean } {
		const hidden: HiddenElementInfo[] = [];
		let hasHiddenContent = false;

		const visit = (node: DOMTreeNode) => {
			if (node.hiddenByThreshold) {
				hasHiddenContent = true;
				if (node.isInteractive) {
					const text =
						(node.text || node.attributes?.placeholder || node.attributes?.title || node.attributes?.['aria-label'] || '')
							.slice(0, 40) || '(no label)';
					const yPos = node.position?.y ?? 0;
					const pages = viewportHeight > 0 ? Math.round((yPos / viewportHeight) * 10) / 10 : 0;
					hidden.push({ tag: node.tagName || '?', text, pages });
				}
			}
			for (const child of node.children) {
				visit(child);
			}
		};
		for (const node of contentNodes) {
			visit(node);
		}

		hidden.sort((a, b) => a.pages - b.pages);
		return { hidden: hidden.slice(0, 10), hasHiddenContent: hidden.length === 0 && hasHiddenContent };
	}

	/**
	 * Axis-aligned rectangle with (x1,y1) bottom-left, (x2,y2) top-right.
	 * Matches Python's Rect dataclass in paint_order.py
	 */
	private static rectIntersects(
		r1: { x1: number; y1: number; x2: number; y2: number },
		r2: { x1: number; y1: number; x2: number; y2: number }
	): boolean {
		return !(r1.x2 <= r2.x1 || r2.x2 <= r1.x1 || r1.y2 <= r2.y1 || r2.y2 <= r1.y1);
	}

	private static rectContains(
		r1: { x1: number; y1: number; x2: number; y2: number },
		r2: { x1: number; y1: number; x2: number; y2: number }
	): boolean {
		return r1.x1 <= r2.x1 && r1.y1 <= r2.y1 && r1.x2 >= r2.x2 && r1.y2 >= r2.y2;
	}

	/**
	 * Split rectangle a by removing the intersection with b.
	 * Returns list of up to 4 rectangles = a \ b.
	 * Assumes a intersects b.
	 * Matches Python's RectUnionPure._split_diff exactly
	 */
	private static splitDiff(
		a: { x1: number; y1: number; x2: number; y2: number },
		b: { x1: number; y1: number; x2: number; y2: number }
	): Array<{ x1: number; y1: number; x2: number; y2: number }> {
		const parts: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

		// Bottom slice
		if (a.y1 < b.y1) {
			parts.push({ x1: a.x1, y1: a.y1, x2: a.x2, y2: b.y1 });
		}
		// Top slice
		if (b.y2 < a.y2) {
			parts.push({ x1: a.x1, y1: b.y2, x2: a.x2, y2: a.y2 });
		}

		// Middle (vertical) strip: y overlap is [max(a.y1,b.y1), min(a.y2,b.y2)]
		const yLo = Math.max(a.y1, b.y1);
		const yHi = Math.min(a.y2, b.y2);

		// Left slice
		if (a.x1 < b.x1) {
			parts.push({ x1: a.x1, y1: yLo, x2: b.x1, y2: yHi });
		}
		// Right slice
		if (b.x2 < a.x2) {
			parts.push({ x1: b.x2, y1: yLo, x2: a.x2, y2: yHi });
		}

		return parts;
	}

	/**
	 * Check if rectangle r is fully covered by the union of rectangles.
	 * Matches Python's RectUnionPure.contains exactly.
	 * Uses geometric splitting to detect multi-rectangle coverage.
	 */
	private static rectUnionContains(
		rects: Array<{ x1: number; y1: number; x2: number; y2: number }>,
		r: { x1: number; y1: number; x2: number; y2: number }
	): boolean {
		if (rects.length === 0) {
			return false;
		}

		let stack = [r];
		for (const s of rects) {
			const newStack: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
			for (const piece of stack) {
				if (DOMService.rectContains(s, piece)) {
					// piece completely gone - eaten by s
					continue;
				}
				if (DOMService.rectIntersects(piece, s)) {
					newStack.push(...DOMService.splitDiff(piece, s));
				} else {
					newStack.push(piece);
				}
			}
			if (newStack.length === 0) {
				// everything eaten – covered
				return true;
			}
			stack = newStack;
		}
		return false; // something survived
	}

	/**
	 * Add rectangle r to the union, splitting it by existing rectangles.
	 * Returns the new parts that were added (non-overlapping with existing).
	 * Matches Python's RectUnionPure.add logic.
	 */
	private static rectUnionAdd(
		rects: Array<{ x1: number; y1: number; x2: number; y2: number }>,
		r: { x1: number; y1: number; x2: number; y2: number }
	): Array<{ x1: number; y1: number; x2: number; y2: number }> {
		// If already covered, don't add anything
		if (DOMService.rectUnionContains(rects, r)) {
			return [];
		}

		let pending = [r];
		for (const s of rects) {
			const newPending: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
			for (const piece of pending) {
				if (DOMService.rectIntersects(piece, s)) {
					newPending.push(...DOMService.splitDiff(piece, s));
				} else {
					newPending.push(piece);
				}
			}
			pending = newPending;
		}

		// Any left-over pieces are new, non-overlapping areas
		return pending;
	}

	/**
	 * Apply paint order filtering to selectorMap.
	 * Elements that are covered by higher paint order elements are removed.
	 * Matches Python's PaintOrderRemover.calculate_paint_order exactly.
	 */
	private applyPaintOrderFiltering(selectorMap: Map<number, EnhancedDOMTreeNode>): Map<number, EnhancedDOMTreeNode> {
		// Collect elements with paint order and bounds
		interface ElementWithPaintOrder {
			backendNodeId: number;
			node: EnhancedDOMTreeNode;
			paintOrder: number;
			bounds: { x: number; y: number; width: number; height: number };
		}

		const elementsWithPaintOrder: ElementWithPaintOrder[] = [];
		for (const [backendNodeId, node] of selectorMap.entries()) {
			if (node.snapshotNode?.paintOrder !== undefined &&
				node.snapshotNode?.paintOrder !== null &&
				node.snapshotNode?.bounds) {
				elementsWithPaintOrder.push({
					backendNodeId,
					node,
					paintOrder: node.snapshotNode.paintOrder,
					bounds: node.snapshotNode.bounds,
				});
			}
		}

		if (elementsWithPaintOrder.length === 0) {
			return selectorMap;
		}

		// Group by paint order (matches Python's grouped_by_paint_order)
		const groupedByPaintOrder = new Map<number, ElementWithPaintOrder[]>();
		for (const elem of elementsWithPaintOrder) {
			if (!groupedByPaintOrder.has(elem.paintOrder)) {
				groupedByPaintOrder.set(elem.paintOrder, []);
			}
			groupedByPaintOrder.get(elem.paintOrder)!.push(elem);
		}

		// RectUnion - maintains a disjoint set of rectangles (matches Python's RectUnionPure)
		const coveredBackendIds = new Set<number>();
		let rectsInUnion: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

		// Process paint orders in descending order (highest first)
		// Matches Python: sorted(grouped_by_paint_order.items(), key=lambda x: -x[0])
		const sortedPaintOrders = Array.from(groupedByPaintOrder.keys()).sort((a, b) => b - a);

		for (const paintOrder of sortedPaintOrders) {
			const elements = groupedByPaintOrder.get(paintOrder)!;

			// CRITICAL: Collect rects to add AFTER checking all elements in this paint order group
			// This matches Python's batching behavior where elements with same paint_order
			// don't cover each other - all are checked first, then all are added
			const rectsToAdd: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

			for (const elem of elements) {
				const rect = {
					x1: elem.bounds.x,
					y1: elem.bounds.y,
					x2: elem.bounds.x + elem.bounds.width,
					y2: elem.bounds.y + elem.bounds.height,
				};

				// Check if element is fully covered by higher paint order elements
				// Uses geometric union containment (not simple single-rect containment)
				if (DOMService.rectUnionContains(rectsInUnion, rect)) {
					coveredBackendIds.add(elem.backendNodeId);
					// Don't continue - still need to consider for adding if not transparent
				}

				// Check if should add to union (matches Python's transparency check)
				// Python: don't add if opacity < 0.8 or background-color is transparent
				const computedStyles = elem.node.snapshotNode?.computedStyles;
				if (computedStyles) {
					const bgColor = computedStyles['background-color'] || 'rgba(0, 0, 0, 0)';
					const opacity = parseFloat(computedStyles['opacity'] || '1');

					// Skip transparent elements - they don't occlude
					if (bgColor === 'rgba(0, 0, 0, 0)' || opacity < 0.8) {
						continue;
					}
				}

				// Collect rect for batch add (matches Python's rects_to_add.append)
				rectsToAdd.push(rect);
			}

			// BATCH ADD: Add all rects from this paint order group to the union
			// This is the key difference from the old implementation
			// Matches Python: for rect in rects_to_add: rect_union.add(rect)
			for (const rect of rectsToAdd) {
				const newParts = DOMService.rectUnionAdd(rectsInUnion, rect);
				rectsInUnion.push(...newParts);
			}
		}

		// Remove covered elements from selectorMap
		if (coveredBackendIds.size > 0) {
			console.debug(`🎨 [Paint Order] Filtering ${coveredBackendIds.size} covered elements`);
			const filteredMap = new Map<number, EnhancedDOMTreeNode>();
			for (const [backendNodeId, node] of selectorMap.entries()) {
				if (!coveredBackendIds.has(backendNodeId)) {
					filteredMap.set(backendNodeId, node);
				}
			}
			return filteredMap;
		}

		return selectorMap;
	}

	/**
	 * Configuration for propagating elements - elements that propagate bounds to children.
	 * Children of these elements are excluded if fully contained within parent bounds.
	 * Matches Python DOMTreeSerializer.PROPAGATING_ELEMENTS
	 */
	private static readonly PROPAGATING_ELEMENTS = [
		{ tag: 'a', role: null },        // Any <a> tag
		{ tag: 'button', role: null },   // Any <button> tag
		{ tag: 'div', role: 'button' },  // <div role="button">
		{ tag: 'div', role: 'combobox' }, // <div role="combobox"> - dropdowns/selects
		{ tag: 'span', role: 'button' }, // <span role="button">
		{ tag: 'span', role: 'combobox' }, // <span role="combobox">
		{ tag: 'input', role: 'combobox' }, // <input role="combobox"> - autocomplete inputs
	];

	private static readonly DEFAULT_CONTAINMENT_THRESHOLD = 0.99; // 99% containment by default

	/**
	 * Check if an element is a propagating element (like buttons, links).
	 * Matches Python DOMTreeSerializer._is_propagating_element
	 */
	private isPropagatingElement(tag: string, role: string | null | undefined): boolean {
		const lowerTag = tag.toLowerCase();
		const keysToCheck = ['tag', 'role'] as const;

		for (const pattern of DOMService.PROPAGATING_ELEMENTS) {
			const check = keysToCheck.map(key => {
				if (key === 'tag') {
					return pattern.tag === null || pattern.tag === lowerTag;
				} else {
					return pattern.role === null || pattern.role === role;
				}
			});
			if (check.every(Boolean)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Check if a child bounds is contained within parent bounds.
	 * Matches Python DOMTreeSerializer._is_contained
	 */
	private isContained(
		childBounds: { x: number; y: number; width: number; height: number },
		parentBounds: { x: number; y: number; width: number; height: number },
		threshold: number = DOMService.DEFAULT_CONTAINMENT_THRESHOLD
	): boolean {
		// Calculate intersection
		const xOverlap = Math.max(0,
			Math.min(childBounds.x + childBounds.width, parentBounds.x + parentBounds.width) -
			Math.max(childBounds.x, parentBounds.x)
		);
		const yOverlap = Math.max(0,
			Math.min(childBounds.y + childBounds.height, parentBounds.y + parentBounds.height) -
			Math.max(childBounds.y, parentBounds.y)
		);

		const intersectionArea = xOverlap * yOverlap;
		const childArea = childBounds.width * childBounds.height;

		if (childArea === 0) {
			return false; // Zero-area element
		}

		const containmentRatio = intersectionArea / childArea;
		return containmentRatio >= threshold;
	}

	/**
	 * Check if a child element should be excluded based on being contained in a parent.
	 * Matches Python DOMTreeSerializer._should_exclude_child
	 */
	private shouldExcludeChild(
		childNode: EnhancedDOMTreeNode,
		parentBounds: { x: number; y: number; width: number; height: number }
	): boolean {
		// Get child bounds
		const childBounds = childNode.absolutePosition || childNode.snapshotNode?.bounds;
		if (!childBounds) {
			return false; // No bounds = can't determine containment
		}

		// Check containment with threshold
		if (!this.isContained(childBounds, parentBounds)) {
			return false; // Not sufficiently contained
		}

		// EXCEPTION RULES - Keep these even if contained:
		const childTag = childNode.nodeName.toLowerCase();
		const childRole = childNode.attributes?.role;

		// 1. Never exclude form elements (they need individual interaction)
		if (['input', 'select', 'textarea', 'label'].includes(childTag)) {
			return false;
		}

		// 2. Keep if child is also a propagating element
		// (might have stopPropagation, e.g., button in button)
		if (this.isPropagatingElement(childTag, childRole)) {
			return false;
		}

		// 3. Keep if has explicit onclick handler
		if (childNode.attributes?.onclick) {
			return false;
		}

		// 4. Keep if has aria-label suggesting it's independently interactive
		const ariaLabel = childNode.attributes?.['aria-label'];
		if (ariaLabel && ariaLabel.trim()) {
			return false;
		}

		// 5. Keep if has role suggesting interactivity
		if (childRole && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option'].includes(childRole)) {
			return false;
		}

		// Default: exclude this child
		return true;
	}

	/**
	 * Apply bounding box filtering to selectorMap.
	 * Elements that are fully contained within propagating parent elements are removed.
	 * Matches Python DOMTreeSerializer._apply_bounding_box_filtering
	 */
	private applyBoundingBoxFiltering(selectorMap: Map<number, EnhancedDOMTreeNode>): Map<number, EnhancedDOMTreeNode> {
		// Collect propagating elements with bounds
		interface PropagatingElement {
			backendNodeId: number;
			bounds: { x: number; y: number; width: number; height: number };
		}

		const propagatingElements: PropagatingElement[] = [];
		for (const [backendNodeId, node] of selectorMap.entries()) {
			const tag = node.nodeName;
			const role = node.attributes?.role;
			const bounds = node.absolutePosition || node.snapshotNode?.bounds;

			if (this.isPropagatingElement(tag, role) && bounds) {
				propagatingElements.push({
					backendNodeId,
					bounds,
				});
			}
		}

		if (propagatingElements.length === 0) {
			return selectorMap;
		}

		// Check which elements should be excluded
		const excludedBackendIds = new Set<number>();
		for (const [childBackendNodeId, childNode] of selectorMap.entries()) {
			// Don't check propagating elements against themselves
			if (propagatingElements.some(p => p.backendNodeId === childBackendNodeId)) {
				continue;
			}

			// Check if this element should be excluded by any propagating parent
			for (const parent of propagatingElements) {
				if (this.shouldExcludeChild(childNode, parent.bounds)) {
					excludedBackendIds.add(childBackendNodeId);
					break; // Only need to be excluded by one parent
				}
			}
		}

		if (excludedBackendIds.size > 0) {
			console.debug(`📦 [BBox Filter] Excluding ${excludedBackendIds.size} elements contained within parent bounds`);
			const filteredMap = new Map<number, EnhancedDOMTreeNode>();
			for (const [backendNodeId, node] of selectorMap.entries()) {
				if (!excludedBackendIds.has(backendNodeId)) {
					filteredMap.set(backendNodeId, node);
				}
			}
			return filteredMap;
		}

		return selectorMap;
	}

	/**
	 * Detect potential modal/overlay elements that might block clicks.
	 * This helps the agent understand when something is blocking their target element.
	 * Looks for elements with:
	 * - Fixed/absolute positioning that covers significant viewport area
	 * - High z-index
	 * - Common modal class names/roles
	 */
	private detectModalOverlays(
		selectorMap: Map<number, EnhancedDOMTreeNode>,
		viewportInfo: ViewportInfo
	): Array<{ backendNodeId: number; nodeName: string; reason: string }> {
		const overlays: Array<{ backendNodeId: number; nodeName: string; reason: string }> = [];
		const viewportArea = viewportInfo.width * viewportInfo.height;
		const MIN_COVERAGE_RATIO = 0.3; // Element covers at least 30% of viewport

		for (const [backendNodeId, node] of selectorMap.entries()) {
			const computedStyles = node.snapshotNode?.computedStyles;
			const bounds = node.absolutePosition || node.snapshotNode?.bounds;
			const nodeName = node.nodeName.toLowerCase();
			const attrs = node.attributes || {};

			const reasons: string[] = [];

			// Check for modal-related attributes
			const role = attrs.role?.toLowerCase() || '';
			const ariaModal = attrs['aria-modal']?.toLowerCase();
			const className = (attrs.class || '').toLowerCase();
			const id = (attrs.id || '').toLowerCase();

			// Direct modal indicators
			if (role === 'dialog' || role === 'alertdialog' || ariaModal === 'true') {
				reasons.push(`role=${role || 'aria-modal'}`);
			}

			// Common modal class patterns
			const modalPatterns = ['modal', 'overlay', 'dialog', 'popup', 'drawer', 'backdrop', 'lightbox'];
			for (const pattern of modalPatterns) {
				if (className.includes(pattern) || id.includes(pattern)) {
					reasons.push(`class/id contains "${pattern}"`);
					break;
				}
			}

			// Check positioning and coverage
			if (computedStyles && bounds) {
				const position = (computedStyles['position'] || '').toLowerCase();
				const elementArea = bounds.width * bounds.height;
				const coverageRatio = elementArea / viewportArea;

				// Fixed/absolute positioned elements covering significant area
				if ((position === 'fixed' || position === 'absolute') && coverageRatio >= MIN_COVERAGE_RATIO) {
					reasons.push(`${position} position, covers ${(coverageRatio * 100).toFixed(0)}% of viewport`);
				}

				// Full-screen overlay detection (covers almost entire viewport)
				if (coverageRatio >= 0.8) {
					const opacity = parseFloat(computedStyles['opacity'] || '1');
					const bgColor = computedStyles['background-color'] || '';

					// Check if it's a semi-transparent overlay
					if (bgColor.includes('rgba') || opacity < 1) {
						reasons.push('full-screen semi-transparent overlay');
					}
				}
			}

			if (reasons.length > 0) {
				overlays.push({
					backendNodeId,
					nodeName,
					reason: reasons.join(', '),
				});
			}
		}

		return overlays;
	}

	/**
	 * Detect elements with JavaScript click event listeners using CDP.
	 * Matches Python's js_click_listener detection (lines 302-388 in Python service.py).
	 * Elements with click handlers are more likely to be truly interactive.
	 */
	private async detectJsClickListeners(cdp: CDPSession): Promise<Set<number>> {
		const jsClickListenerBackendIds = new Set<number>();

		try {
			// Step 1: Run JS to find elements with click listeners and return them by reference
			// Uses getEventListeners which is only available in DevTools context via includeCommandLineAPI
			// Bounding only the total DOM size is insufficient: framework-heavy pages can attach
			// hundreds of listeners to fewer than 10k elements. Resolving every listener with an
			// unbounded fan-out floods the CDP connection and can make the session appear stale,
			// so the scan bails out above MAX_JS_CLICK_LISTENER_ELEMENTS (elements are still
			// detected via the accessibility tree and the interactivity heuristics).
			const jsListenerResult = await cdp.send('Runtime.evaluate', {
				expression: `
					(() => {
						// getEventListeners is only available in DevTools context via includeCommandLineAPI
						if (typeof getEventListeners !== 'function') {
							return null;
						}

						const allElements = document.querySelectorAll('*');

						// Skip on heavy pages — listener detection is too expensive
						if (allElements.length > 10000) {
							return null;
						}

						const elementsWithListeners = [];

						for (const el of allElements) {
							try {
								const listeners = getEventListeners(el);
								// Check for click-related event listeners
								if (listeners.click || listeners.mousedown || listeners.mouseup || listeners.pointerdown || listeners.pointerup) {
									elementsWithListeners.push(el);
									if (elementsWithListeners.length > ${DOMService.MAX_JS_CLICK_LISTENER_ELEMENTS}) {
										return ${JSON.stringify(DOMService.JS_CLICK_LISTENER_OVERFLOW)};
									}
								}
							} catch (e) {
								// Ignore errors for individual elements (e.g., cross-origin)
							}
						}

						return elementsWithListeners;
					})()
				`,
				includeCommandLineAPI: true, // Enables getEventListeners()
				returnByValue: false, // Return object references, not values
			});

			if ((jsListenerResult as any).result?.value === DOMService.JS_CLICK_LISTENER_OVERFLOW) {
				console.debug(
					`Skipping JS listener resolution: more than ${DOMService.MAX_JS_CLICK_LISTENER_ELEMENTS} elements have click listeners`
				);
			}

			const resultObjectId = (jsListenerResult as any).result?.objectId;
			if (resultObjectId) {
				// Step 2: Get array properties to access each element
				const arrayProps = await cdp.send('Runtime.getProperties', {
					objectId: resultObjectId,
					ownProperties: true,
				});

				// Step 3: For each element, get its backend node ID via DOM.describeNode
				const elementObjectIds: string[] = [];
				for (const prop of (arrayProps as any).result || []) {
					const propName = prop?.name || '';
					if (typeof propName === 'string' && /^\d+$/.test(propName)) {
						const objectId = prop?.value?.objectId;
						if (objectId && typeof objectId === 'string') {
							elementObjectIds.push(objectId);
						}
					}
				}

				// Keep concurrency bounded. Each describeNode call can trigger target/session
				// bookkeeping, so even a few dozen simultaneous calls can starve screenshots
				// and the other CDP requests needed to build browser state.
				const resolveBackendNodeId = async (objectId: string): Promise<number | null> => {
					try {
						const nodeInfo = await cdp.send('DOM.describeNode', { objectId });
						return (nodeInfo as any).node?.backendNodeId ?? null;
					} catch {
						return null;
					}
				};
				for (let start = 0; start < elementObjectIds.length; start += DOMService.DESCRIBE_NODE_BATCH_SIZE) {
					const batch = elementObjectIds.slice(start, start + DOMService.DESCRIBE_NODE_BATCH_SIZE);
					const backendIds = await Promise.all(batch.map(resolveBackendNodeId));
					for (const bid of backendIds) {
						if (bid !== null && bid !== undefined) {
							jsClickListenerBackendIds.add(bid);
						}
					}
				}

				// Release the array object to avoid memory leaks
				try {
					await cdp.send('Runtime.releaseObject', { objectId: resultObjectId });
				} catch {
					// Best effort cleanup
				}

				console.debug(`🔍 Detected ${jsClickListenerBackendIds.size} elements with JS click listeners`);
			}
		} catch (error) {
			console.debug('Failed to detect JS event listeners:', error);
		}

		return jsClickListenerBackendIds;
	}

	/**
	 * Get page state using CDP DOM.getDocument for real backendNodeIds
	 * This matches Python browser-use's approach for reliable element identification
	 */
	async getPageState(options: DOMExtractionOptions = {}): Promise<PageState> {
		const includeAttrs = options.includeAttributes || DEFAULT_ATTRIBUTES;

		// Get CDP session
		const cdp = await this.getCDPSession();

		// Wait for document to be ready before capturing snapshot (matches Python lines 252-257)
		try {
			const readyStateResult = await cdp.send('Runtime.evaluate', {
				expression: 'document.readyState',
			});
			console.debug(`📄 Document readyState: ${(readyStateResult as any).result?.value}`);
		} catch (error) {
			console.debug('Failed to get document readyState:', error);
		}

		// Detect elements with JS click listeners (matches Python lines 302-388)
		// This helps identify truly interactive elements
		const jsClickListenerBackendIds = await this.detectJsClickListeners(cdp);

		// Get viewport info
		const viewportInfo = await this.getViewportInfo();

		// Get accessibility tree for element names/roles
		const accessibilityTree = await this.getAccessibilityTree();

		// Get DOM tree using CDP - this gives us real backendNodeIds
		let domTree: CDPDOMNode;
		try {
			const result = await cdp.send('DOM.getDocument', {
				depth: -1, // Get full tree
				pierce: true, // Pierce shadow DOMs and iframes
			});
			domTree = result.root as CDPDOMNode;
		} catch (error) {
			console.error('Failed to get DOM via CDP:', error);
			throw error;
		}

		// Get actual scroll positions for all iframes before capturing snapshot
		// Matches Python's iframe scroll tracking
		const iframeScrollPositions = new Map<number, { scrollTop: number; scrollLeft: number }>();
		try {
			const scrollResult = await cdp.send('Runtime.evaluate', {
				expression: `
					(() => {
						const scrollData = {};
						const iframes = document.querySelectorAll('iframe');
						iframes.forEach((iframe, index) => {
							try {
								const doc = iframe.contentDocument || iframe.contentWindow.document;
								if (doc) {
									scrollData[index] = {
										scrollTop: doc.documentElement.scrollTop || doc.body.scrollTop || 0,
										scrollLeft: doc.documentElement.scrollLeft || doc.body.scrollLeft || 0
									};
								}
							} catch (e) {
								// Cross-origin iframe, can't access
							}
						});
						return scrollData;
					})()
				`,
				returnByValue: true,
			});
			const scrollData = (scrollResult as any).result?.value;
			if (scrollData) {
				for (const [idx, data] of Object.entries(scrollData)) {
					const parsed = data as { scrollTop: number; scrollLeft: number };
					iframeScrollPositions.set(parseInt(idx), parsed);
					console.debug(
						`Iframe ${idx} scroll position - scrollTop=${parsed.scrollTop}, scrollLeft=${parsed.scrollLeft}`
					);
				}
			}
		} catch (error) {
			console.debug('Failed to get iframe scroll positions:', error);
		}

		// Get DOM snapshot for bounds and visibility
		// Match Python's REQUIRED_COMPUTED_STYLES exactly (10 styles)
		let snapshotLookup = new Map<number, SnapshotNodeData>();
		try {
			const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', {
				computedStyles: [
					'display',
					'visibility',
					'opacity',
					'overflow',
					'overflow-x',
					'overflow-y',
					'cursor',
					'pointer-events',
					'position',
					'background-color',
				],
				includePaintOrder: this.paintOrderFiltering,
				includeDOMRects: true,
				includeBlendedBackgroundColors: false,
				includeTextColorOpacities: false,
			});
			snapshotLookup = this.buildSnapshotLookup(snapshot, viewportInfo.devicePixelRatio);
		} catch (error) {
			console.debug('Failed to get DOM snapshot:', error);
		}

		// Build selector map keyed by backendNodeId (like Python)
		const selectorMap = new Map<number, EnhancedDOMTreeNode>();
		const domTreeNodes: DOMTreeNode[] = [];
		const currentBackendIds = new Set<number>();

		// Type for HTML frame tracking (matches Python's html_frames list)
		type HtmlFrame = {
			nodeName: string;
			frameId?: string;
			snapshotData?: SnapshotNodeData;
		};

		// Type for total frame offset (matches Python's total_frame_offset DOMRect)
		type FrameOffset = {
			x: number;
			y: number;
		};

		// Track cross-origin iframes to process after main tree is built
		const pendingCrossOriginIframes: Array<{
			treeNode: DOMTreeNode;
			frameId: string;
			htmlFrames: HtmlFrame[];
			totalFrameOffset: FrameOffset;
			depth: number;
		}> = [];

		/**
		 * Recursively process DOM tree - matches Python's _construct_enhanced_node exactly.
		 *
		 * @param node The CDP DOM node to process
		 * @param htmlFrames List of HTML frame nodes encountered so far (for visibility checking)
		 * @param totalFrameOffset Accumulated coordinate offset from parent frames
		 * @param depth Current recursion depth
		 */
		const processNode = (
			node: CDPDOMNode,
			htmlFrames: HtmlFrame[] | null,
			totalFrameOffset: FrameOffset | null,
			depth: number = 0
		): DOMTreeNode | null => {
			// NOTE: Python has NO element depth limit - only iframe depth is limited
			// Removing the `depth > 50` hard limit that was incorrectly cutting off deeply nested elements
			// This was causing bottom form elements to be missed in long forms

			// Initialize lists if not provided (matches Python)
			if (htmlFrames === null) {
				htmlFrames = [];
			}

			// Clone offset to avoid pointer reference issues (matches Python)
			if (totalFrameOffset === null) {
				totalFrameOffset = { x: 0, y: 0 };
			} else {
				totalFrameOffset = { x: totalFrameOffset.x, y: totalFrameOffset.y };
			}

			const backendNodeId = node.backendNodeId;
			const nodeName = node.nodeName?.toLowerCase() || '';
			const nodeType = node.nodeType;

			// Handle Document nodes (nodeType 9) and DocumentFragment nodes (nodeType 11)
			// These are container nodes that we need to traverse through to get to elements
			if (nodeType === 9 || nodeType === 11) {
				// Process children directly for document/fragment nodes
				const children: DOMTreeNode[] = [];
				if (node.children) {
					for (const child of node.children) {
						const childNode = processNode(child, htmlFrames, totalFrameOffset, depth);
						if (childNode) {
							children.push(childNode);
						}
					}
				}
				// Return first child if only one, or create a wrapper
				if (children.length === 1) {
					return children[0];
				}
				if (children.length > 0) {
					// Create a virtual root to hold multiple roots
					return {
						index: -1,
						tagName: nodeName,
						children,
						isInteractive: false,
						position: undefined,
					};
				}
				return null;
			}

			// Skip non-element nodes (text, comments, etc.)
			if (nodeType !== 1) return null;

			// Parse ALL attributes into a map (need all for interactivity detection)
			const allAttributes: Record<string, string> = {};
			if (node.attributes) {
				for (let i = 0; i < node.attributes.length; i += 2) {
					const name = node.attributes[i];
					const value = node.attributes[i + 1];
					if (name) {
						allAttributes[name] = value || '';
					}
				}
			}

			// Get snapshot data for bounds/clickable/cursorStyle
			const snapshotData = snapshotLookup.get(backendNodeId);
			const isClickable = snapshotData?.isClickable ?? false;
			const bounds = snapshotData?.bounds;
			const cursorStyle = snapshotData?.cursorStyle;

			// Show the value a field currently holds, not only the static attribute. JS, autofill and
			// framework bindings set the property without touching the attribute, so pre-filled
			// fields used to look empty to the agent. Sensitive fields never carry a snapshot value.
			if (snapshotData && (nodeName === 'input' || nodeName === 'textarea')) {
				if (snapshotData.inputValue !== undefined && snapshotData.inputValue !== null) {
					allAttributes.value = snapshotData.inputValue;
				}
				if (snapshotData.inputChecked !== undefined && snapshotData.inputChecked !== null) {
					if (snapshotData.inputChecked) {
						allAttributes.checked = 'true';
					} else {
						delete allAttributes.checked;
					}
				}
			}
			// Never expose values of password fields: they must not leak into DOM snapshots sent to the LLM
			const isPasswordField = nodeName === 'input' && (allAttributes.type || '').toLowerCase() === 'password';
			if (isPasswordField) {
				delete allAttributes.value;
			}

			// Filter to included attributes for output
			const attributes: Record<string, string> = {};
			for (const attr of includeAttrs) {
				if (allAttributes[attr]) {
					attributes[attr] = allAttributes[attr];
				}
			}

			// Synthetic format hints for date/time inputs and datepickers so the model uses the right format
			Object.assign(attributes, buildInputFormatHints(nodeName, allAttributes, attributes));

			// Get accessibility node for this element
			const axNode = accessibilityTree.get(backendNodeId);

			// Calculate absolute position (bounds + totalFrameOffset) - matches Python
			let absolutePosition: DOMPosition | undefined;
			if (bounds) {
				absolutePosition = {
					x: bounds.x + totalFrameOffset.x,
					y: bounds.y + totalFrameOffset.y,
					width: bounds.width,
					height: bounds.height,
				};
			}

			// Track HTML frames for visibility checking (matches Python exactly)
			// Create a copy of htmlFrames for children
			let updatedHtmlFrames = [...htmlFrames];

			// Check if this is an HTML frame node and add it to the list (matches Python)
			// Python: if node['nodeType'] == NodeType.ELEMENT_NODE.value and node['nodeName'] == 'HTML' and node.get('frameId') is not None
			if (nodeType === 1 && nodeName === 'html' && node.frameId) {
				updatedHtmlFrames.push({
					nodeName: 'HTML',
					frameId: node.frameId,
					snapshotData: snapshotData,
				});

				// Adjust total frame offset by scroll (matches Python exactly)
				// Python: total_frame_offset.x -= snapshot_data.scrollRects.x
				if (snapshotData?.scrollRects) {
					totalFrameOffset.x -= snapshotData.scrollRects.x;
					totalFrameOffset.y -= snapshotData.scrollRects.y;
				}
			}

			// Calculate new iframe offset for content documents (matches Python)
			// Python: if (node['nodeName'].upper() == 'IFRAME' or node['nodeName'].upper() == 'FRAME') and snapshot_data and snapshot_data.bounds
			if ((nodeName === 'iframe' || nodeName === 'frame') && bounds) {
				updatedHtmlFrames.push({
					nodeName: nodeName.toUpperCase(),
					frameId: node.frameId,
					snapshotData: snapshotData,
				});

				// Add iframe bounds to offset (matches Python)
				totalFrameOffset.x += bounds.x;
				totalFrameOffset.y += bounds.y;
			}

			// Check visibility using frame hierarchy (matches Python exactly)
			// Python sets is_visible as a SEPARATE property, not coupled with interactivity
			const isVisible = this.isElementVisibleAccordingToAllParents(snapshotData, updatedHtmlFrames);

			// Check if this element has JS click listeners (matches Python line 675)
			// Python: has_js_click_listener=node['backendNodeId'] in js_click_listener_backend_ids
			const hasJsClickListener = jsClickListenerBackendIds.has(backendNodeId);

			// Check if interactive (use allAttributes for detection, not filtered attributes)
			// Pass axNode, bounds, and cursorStyle to match Python's ClickableElementDetector behavior
			// IMPORTANT: Python does NOT couple is_interactive with is_visible
			// Elements can be interactive even if outside viewport - visibility is a separate property
			// The serializer will handle visibility filtering later
			const isInteractive = this.isInteractiveNode(
				nodeName,
				allAttributes,
				isClickable,
				axNode,
				bounds,
				cursorStyle,
				hasJsClickListener,
				node
			);

			// Create DOM tree node
			const treeNode: DOMTreeNode = {
				// Use backendNodeId as the index (like Python)
				index: isInteractive ? backendNodeId : -1,
				tagName: nodeName,
				children: [],
				isInteractive,
				isVisible, // Store visibility separately (like Python)
				position: absolutePosition || bounds,
			};
			// Off-screen but not CSS-hidden: candidates for "scroll to reveal" hints inside iframes
			if (!isVisible && snapshotData?.bounds && DOMService.isVisibleByComputedStyles(snapshotData.computedStyles)) {
				treeNode.hiddenByThreshold = true;
			}

			// Get text content and accessibility info for interactive elements
			// CRITICAL: Only add to selectorMap if BOTH interactive AND visible (matches Python serializer.py:576-584)
			// Python: if is_interactive_assign and is_visible: self._selector_map[backend_node_id] = node
			if (isInteractive && isVisible) {
				currentBackendIds.add(backendNodeId);

				// Get accessibility info (like Python - ax_node.name is primary source)
				// Note: axNode is already retrieved above for interactivity detection
				let text = '';
				let role = attributes.role;

				if (axNode) {
					text = axNode.name || '';
					role = axNode.role || role;
				}

				// Fallback: Extract text from ALL descendant TEXT_NODEs recursively (like Python get_all_children_text)
				// Python's get_all_children_text is RECURSIVE - collects from entire subtree
				if (!text && node.children) {
					const collectTextRecursive = (n: CDPDOMNode): string[] => {
						const parts: string[] = [];
						// nodeType 3 = TEXT_NODE
						// Python requires len > 1 (minimum 2 chars) to filter single-char noise
						if (n.nodeType === 3 && n.nodeValue) {
							const trimmed = n.nodeValue.trim();
							if (trimmed.length > 1) {
								parts.push(trimmed);
							}
						}
						// Recurse into children
						if (n.children) {
							for (const child of n.children) {
								parts.push(...collectTextRecursive(child));
							}
						}
						return parts;
					};
					const textParts = collectTextRecursive(node);
					text = textParts.join('\n').trim();
				}

				// Fallback: Use nodeValue for text content (for text nodes themselves)
				if (!text && node.nodeValue) {
					text = node.nodeValue.trim().substring(0, 200);
				}

				treeNode.text = text;
				treeNode.role = role;

				// Merge axNode.properties into attributes (matches Python serializer.py _build_attributes_string)
				// Python merges AX properties like: checked, selected, expanded, pressed, disabled, invalid, etc.
				const mergedAttributes: Record<string, string> = { ...attributes };
				if (axNode && axNode.properties) {
					for (const prop of axNode.properties) {
						try {
							// Password fields: AX value/valuetext carry the secret too
							if (isPasswordField && (prop.name === 'value' || prop.name === 'valuetext')) {
								continue;
							}
							// Only include properties that are in DEFAULT_ATTRIBUTES
							if (DEFAULT_ATTRIBUTES.includes(prop.name) && prop.value !== null && prop.value !== undefined) {
								// Handle nested value structure (some CDP props have {value: ...} structure)
								const propValue = prop.value?.value !== undefined ? prop.value.value : prop.value;

								// Convert boolean to lowercase string, keep others as-is (matches Python)
								if (typeof propValue === 'boolean') {
									mergedAttributes[prop.name] = propValue.toString().toLowerCase();
								} else {
									const propValueStr = String(propValue).trim();
									if (propValueStr) {
										mergedAttributes[prop.name] = propValueStr;
									}
								}
							}
						} catch {
							// Ignore AttributeError/ValueError like Python
							continue;
						}
					}
				}
				// Add ax_name from axNode.name if not already set (matches Python)
				if (axNode?.name && !mergedAttributes['ax_name']) {
					mergedAttributes['ax_name'] = axNode.name;
				}

				treeNode.attributes = mergedAttributes;

				// Check if element is new
				const isNew = !this.previousElements.has(backendNodeId.toString());
				treeNode.isNew = isNew;

				// Add to selector map keyed by backendNodeId
				// Include snapshotNode for paint order filtering (matches Python)
				const enhancedNode: EnhancedDOMTreeNode = {
					nodeId: node.nodeId,
					backendNodeId: backendNodeId,
					sessionId: '',
					frameId: node.frameId || '',
					targetId: '',
					nodeType: 'element',
					nodeName: nodeName,
					attributes: mergedAttributes, // Use merged attributes (includes ax_node properties)
					isVisible: isVisible,
					absolutePosition: absolutePosition || bounds,
					text: text,
					role: role,
					isNew: isNew,
					// Matches Python: has_js_click_listener property for truly interactive elements
					hasJsClickListener: hasJsClickListener,
					// Include snapshotNode data for paint order filtering (matches Python)
					snapshotNode: snapshotData ? {
						isClickable: snapshotData.isClickable,
						cursorStyle: snapshotData.cursorStyle,
						bounds: snapshotData.bounds,
						clientRects: snapshotData.clientRects,
						scrollRects: snapshotData.scrollRects,
						computedStyles: snapshotData.computedStyles,
						paintOrder: snapshotData.paintOrder,
					} : null,
				};
				selectorMap.set(backendNodeId, enhancedNode);
			}

			// Build set of shadow root node IDs to filter them out from children (matches Python)
			const shadowRootNodeIds = new Set<number>();
			if (node.shadowRoots) {
				for (const shadowRoot of node.shadowRoots) {
					if (shadowRoot.nodeId) {
						shadowRootNodeIds.add(shadowRoot.nodeId);
					}
				}
			}

			// Process children with updated htmlFrames and totalFrameOffset (matches Python)
			// Skip shadow roots - they should only be in shadowRoots list
			if (node.children) {
				for (const child of node.children) {
					// Skip shadow roots - they should only be in shadow_roots list (matches Python)
					if (child.nodeId && shadowRootNodeIds.has(child.nodeId)) {
						continue;
					}
					const childNode = processNode(child, updatedHtmlFrames, totalFrameOffset, depth + 1);
					if (childNode) {
						treeNode.children.push(childNode);
					}
				}
			}

			// Process content document (iframes) with updated frames (matches Python)
			if (node.contentDocument) {
				const contentNode = processNode(node.contentDocument, updatedHtmlFrames, totalFrameOffset, depth + 1);
				if (contentNode) {
					treeNode.children.push(contentNode);
				}
				// Tell the LLM what is hidden below the iframe viewport and how far to scroll
				if (nodeName === 'iframe' || nodeName === 'frame') {
					const iframeViewportHeight = snapshotData?.clientRects?.height ?? 0;
					const { hidden, hasHiddenContent } = DOMService.collectHiddenIframeContent(
						contentNode ? [contentNode] : [],
						iframeViewportHeight
					);
					if (hidden.length > 0) {
						treeNode.hiddenElementsInfo = hidden;
					} else if (hasHiddenContent) {
						treeNode.hasHiddenContent = true;
					}
				}
			} else if (
				// Handle cross-origin iframes (no contentDocument means cross-origin)
				(nodeName === 'iframe' || nodeName === 'frame') &&
				this.crossOriginIframes &&
				depth < this.maxIframeDepth &&
				node.frameId
			) {
				// Mark this iframe for later async processing
				// Ignore only frames smaller than MIN_CROSS_ORIGIN_IFRAME_EDGE px in either dimension
				const iframeBounds = bounds || snapshotData?.bounds;
				const shouldProcess =
					isVisible &&
					iframeBounds &&
					iframeBounds.width >= DOMService.MIN_CROSS_ORIGIN_IFRAME_EDGE &&
					iframeBounds.height >= DOMService.MIN_CROSS_ORIGIN_IFRAME_EDGE;

				if (shouldProcess) {
					pendingCrossOriginIframes.push({
						treeNode,
						frameId: node.frameId,
						htmlFrames: updatedHtmlFrames,
						totalFrameOffset: { ...totalFrameOffset },
						depth: depth + 1,
					});
				}
			}

			// Process shadow roots with updated frames (matches Python)
			if (node.shadowRoots) {
				for (const shadowRoot of node.shadowRoots) {
					const shadowNode = processNode(shadowRoot, updatedHtmlFrames, totalFrameOffset, depth + 1);
					if (shadowNode) {
						treeNode.children.push(shadowNode);
					}
				}
			}

			return treeNode;
		};

		// Start processing from root with null htmlFrames and totalFrameOffset (matches Python)
		const rootTreeNode = processNode(domTree, null, null, 0);
		if (rootTreeNode) {
			domTreeNodes.push(rootTreeNode);
		}

		// Process pending cross-origin iframes asynchronously
		if (pendingCrossOriginIframes.length > 0 && this.crossOriginIframes) {
			console.debug(`Processing ${pendingCrossOriginIframes.length} cross-origin iframes...`);

			try {
				// Get all targets including iframes
				const targetsResult = await cdp.send('Target.getTargets');
				const targets = (targetsResult as any).targetInfos || [];

				// Enable Page domain to get frame tree
				await cdp.send('Page.enable');
				const frameTreeResult = await cdp.send('Page.getFrameTree');
				const frameTree = (frameTreeResult as any).frameTree;

				// Build frame ID to target ID mapping
				const frameToTarget = new Map<string, string>();
				const collectFrameTargets = (node: any) => {
					const frame = node.frame || {};
					if (frame.id) {
						// Find target for this frame
						const iframeTarget = targets.find(
							(t: any) =>
								t.type === 'iframe' && t.url && frame.url && t.url === frame.url
						);
						if (iframeTarget) {
							frameToTarget.set(frame.id, iframeTarget.targetId);
						}
					}
					// Process child frames
					for (const child of node.childFrames || []) {
						collectFrameTargets(child);
					}
				};
				if (frameTree) {
					collectFrameTargets(frameTree);
				}

				// Process each cross-origin iframe
				// Note: Full cross-origin DOM extraction requires separate CDP sessions per target
				// This implementation identifies cross-origin iframes but doesn't extract their full DOM
				// To fully support this, we'd need to use Playwright frames API or create CDP sessions per target
				for (const pending of pendingCrossOriginIframes) {
					const targetId = frameToTarget.get(pending.frameId);
					if (!targetId) {
						console.debug(`No target found for cross-origin iframe ${pending.frameId}`);
						continue;
					}

					try {
						// For cross-origin iframes with their own target, we need to use
						// Playwright's frame API or create a new CDP session for that target
						// For now, log that we found the target and mark the iframe for future handling
						console.debug(`Found cross-origin iframe target: ${targetId} for frame ${pending.frameId}`);

						// Try to get the frame from Playwright's frame tree
						const frames = this.page.frames();
						const matchingFrame = frames.find(f => f.url().includes(pending.frameId) || f.name() === pending.frameId);
						if (matchingFrame) {
							// Use Playwright to get basic info from the frame
							try {
								const frameContent = await matchingFrame.content();
								if (frameContent) {
									console.debug(`Got content from cross-origin frame ${pending.frameId} (${frameContent.length} chars)`);
								}
							} catch (e) {
								// Frame content not accessible
							}
						}
					} catch (error) {
						console.debug(`Failed to process cross-origin iframe ${pending.frameId}:`, error);
					}
				}
			} catch (error) {
				console.debug('Failed to process cross-origin iframes:', error);
			}
		}

		// Update previous elements for tracking new elements
		this.previousElements = new Set(
			Array.from(currentBackendIds).map(id => id.toString())
		);

		// Detect potential modal/overlay elements that might block clicks
		// This helps the agent understand when something is blocking their target
		const modalOverlays = this.detectModalOverlays(selectorMap, viewportInfo);
		if (modalOverlays.length > 0) {
			console.log(`🚨 [DOM] Detected ${modalOverlays.length} potential modal/overlay elements that may block clicks`);
			for (const overlay of modalOverlays) {
				console.debug(`  - ${overlay.nodeName} (backendNodeId=${overlay.backendNodeId}): ${overlay.reason}`);
			}
		}

		// Apply paint order filtering if enabled (matches Python)
		let filteredSelectorMap = selectorMap;
		const paintOrderFilteredCount = selectorMap.size;
		if (options.paintOrderFiltering !== false) {
			filteredSelectorMap = this.applyPaintOrderFiltering(selectorMap);
		}

		// Apply bounding box filtering if enabled (matches Python DOMTreeSerializer._apply_bounding_box_filtering)
		// This removes elements that are fully contained within propagating parent elements (buttons, links, etc.)
		const afterPaintOrderCount = filteredSelectorMap.size;
		if (options.bboxFiltering !== false) {
			filteredSelectorMap = this.applyBoundingBoxFiltering(filteredSelectorMap);
		}

		const state: PageState = {
			url: this.page.url(),
			title: await this.page.title(),
			domTree: domTreeNodes,
			selectorMap: filteredSelectorMap,
			viewportInfo,
		};

		// Take screenshot if requested
		if (options.includeScreenshot !== false) {
			const screenshot = await this.page.screenshot({ type: 'png' });
			state.screenshot = screenshot.toString('base64');
		}

		const paintOrderFiltered = paintOrderFilteredCount - afterPaintOrderCount;
		const bboxFiltered = afterPaintOrderCount - filteredSelectorMap.size;
		console.log(`📋 [DOM] Extracted ${filteredSelectorMap.size} interactive elements with real backendNodeIds (${paintOrderFiltered} filtered by paint order, ${bboxFiltered} filtered by bbox)`);

		return state;
	}

	/**
	 * Format DOM tree as text for LLM consumption
	 * Uses format: [backendNodeId]<tag attr=value />
	 * Matches Python browser-use serializer.py exactly
	 *
	 * @param domTree - The DOM tree nodes to format
	 * @param indent - Current indentation level
	 * @param showNewElements - Whether to mark new elements with *
	 * @param selectorMap - Optional filtered selector map. If provided, only elements
	 *                      whose index exists in this map will be included in the output.
	 *                      This ensures the LLM only sees indices that are valid for actions.
	 */
	formatDOMForLLM(
		domTree: DOMTreeNode[],
		indent: number = 0,
		showNewElements: boolean = true,
		selectorMap?: Map<number, EnhancedDOMTreeNode>
	): string {
		let output = '';

		for (const node of domTree) {
			// Only show interactive elements that exist in the filtered selectorMap
			// This fixes the index mismatch bug where LLM would see indices that were filtered out
			const isInSelectorMap = !selectorMap || selectorMap.has(node.index);
			if (node.isInteractive && isInSelectorMap) {
				const prefix = '\t'.repeat(indent);
				const newMarker = showNewElements && node.isNew ? '*' : '';
				// Use [X] format to match Python browser-use serializer.py exactly
				const index = `${newMarker}[${node.index}]`;
				const tag = `<${node.tagName}`;

				// Build attribute string - matches Python's _build_attributes_string exactly
				// Python format: key=value (no quotes, 100 char limit)
				let attrs = '';
				if (node.attributes) {
					const attrPairs: string[] = [];
					const attributesToInclude: Record<string, string> = {};

					// Matches Python's DEFAULT_INCLUDE_ATTRIBUTES in views.py (class excluded)
					const includeAttributes = DEFAULT_ATTRIBUTES;

					for (const key of includeAttributes) {
						if (node.attributes[key] !== undefined && node.attributes[key] !== '') {
							attributesToInclude[key] = String(node.attributes[key]).trim();
						}
					}

					// Python: Remove duplicate values (like Python lines 977-990), except for attributes
					// that serve distinct purposes even when their values coincide
					if (Object.keys(attributesToInclude).length > 1) {
						const seenValues: Record<string, string> = {};
						const keysToRemove: string[] = [];

						for (const key of includeAttributes) {
							if (attributesToInclude[key]) {
								const value = attributesToInclude[key];
								if (value.length > 5) {
									if (seenValues[value] && !PROTECTED_DISPLAY_ATTRIBUTES.has(key)) {
										keysToRemove.push(key);
									} else if (!seenValues[value]) {
										seenValues[value] = key;
									}
								}
							}
						}

						for (const key of keysToRemove) {
							delete attributesToInclude[key];
						}
					}

					// Boolean attributes that carry no information when false
					if (attributesToInclude['required'] && ['false', '0', 'no'].includes(attributesToInclude['required'].toLowerCase())) {
						delete attributesToInclude['required'];
					}

					// Python: Remove role if it matches nodeName (lines 993-995)
					// e.g., <button role="button"> -> <button>
					if (attributesToInclude['role'] && attributesToInclude['role'].toLowerCase() === node.tagName.toLowerCase()) {
						delete attributesToInclude['role'];
					}

					// Python: Remove type if it matches tag name (lines 997-999)
					// e.g., <button type="button"> -> <button>
					if (attributesToInclude['type'] && attributesToInclude['type'].toLowerCase() === node.tagName.toLowerCase()) {
						delete attributesToInclude['type'];
					}

					// Python: Remove invalid if false (line 1001-1003)
					if (attributesToInclude['invalid']?.toLowerCase() === 'false') {
						delete attributesToInclude['invalid'];
					}

					// Python: Remove aria-expanded if we have expanded (line 1005-1007)
					if (attributesToInclude['expanded'] && attributesToInclude['aria-expanded']) {
						delete attributesToInclude['aria-expanded'];
					}

					// Python: Remove attrs that duplicate text (lines 1009-1012)
					const text = node.text?.trim().toLowerCase() || '';
					for (const attr of ['aria-label', 'placeholder', 'title']) {
						if (attributesToInclude[attr]?.trim().toLowerCase() === text) {
							delete attributesToInclude[attr];
						}
					}

					// Build final attribute string - Python format: key=value (no quotes, 100 char limit)
					for (const key of includeAttributes) {
						if (attributesToInclude[key]) {
							let value = attributesToInclude[key];
							// Python: cap_text_length(value, 100)
							if (value.length > 100) {
								value = value.substring(0, 100) + '...';
							}
							attrPairs.push(`${key}=${value}`);
						}
					}

					if (attrPairs.length > 0) {
						attrs = ' ' + attrPairs.join(' ');
					}
				}

				// Python uses self-closing tags: /> (line 891)
				output += `${prefix}${index}${tag}${attrs} />`;

				// For select elements, extract and show options (like Python)
				if (node.tagName.toLowerCase() === 'select' && node.children.length > 0) {
					const options = this.extractSelectOptions(node.children);
					if (options.length > 0) {
						output += ` [options: ${options.join(', ')}]`;
					}
				}

				output += '\n';

				// Python: Text nodes are shown on separate lines (lines 920-930)
				if (node.text && node.text.trim().length > 1) {
					output += `${prefix}\t${node.text.trim()}\n`;
				}

				// Iframes: hint at content hidden below the iframe viewport (port of the upstream scroll hints)
				if (node.hiddenElementsInfo && node.hiddenElementsInfo.length > 0) {
					output += `${prefix}\t... (${node.hiddenElementsInfo.length} more elements below - scroll to reveal):\n`;
					for (const elem of node.hiddenElementsInfo) {
						output += `${prefix}\t    <${elem.tag}> "${elem.text}" ~${elem.pages} pages down\n`;
					}
				} else if (node.hasHiddenContent) {
					output += `${prefix}\t... (more content below viewport - scroll to reveal)\n`;
				}
			}

			if (node.children.length > 0) {
				// Don't recurse into select children as we've already shown options
				if (node.tagName.toLowerCase() !== 'select') {
					// Only increase indent if this node was actually shown (interactive AND in selectorMap)
					const wasShown = node.isInteractive && isInSelectorMap;
					output += this.formatDOMForLLM(
						node.children,
						indent + (wasShown ? 1 : 0),
						showNewElements,
						selectorMap
					);
				}
			}
		}

		return output;
	}

	/**
	 * Extract option values from select element children (like Python)
	 */
	private extractSelectOptions(children: DOMTreeNode[]): string[] {
		const options: string[] = [];
		for (const child of children) {
			const tagName = child.tagName.toLowerCase();
			if (tagName === 'option') {
				// Get the option text or value
				const text = child.text?.trim() || child.attributes?.value || '';
				if (text) {
					// Mark selected options
					const isSelected = child.attributes?.selected !== undefined || child.attributes?.['aria-selected'] === 'true';
					options.push(isSelected ? `*${text}*` : text);
				}
			} else if (tagName === 'optgroup') {
				// Recurse into optgroups
				const groupOptions = this.extractSelectOptions(child.children);
				const groupLabel = child.attributes?.label || 'Group';
				if (groupOptions.length > 0) {
					options.push(`${groupLabel}: ${groupOptions.join(', ')}`);
				}
			}
		}
		return options;
	}

	/**
	 * Generate LLM representation of the DOM state
	 */
	generateLLMRepresentation(
		state: PageState,
		options: { showNewElements?: boolean; maxLength?: number } = {}
	): string {
		const { showNewElements = true, maxLength = 50000 } = options;

		let output = `Current URL: ${state.url}\n`;
		output += `Page Title: ${state.title}\n\n`;

		if (state.viewportInfo) {
			output += `Viewport: ${state.viewportInfo.width}x${state.viewportInfo.height}, `;
			output += `Scroll: (${state.viewportInfo.scrollX}, ${state.viewportInfo.scrollY})\n\n`;
		}

		output += `Interactive Elements:\n`;
		output += this.formatDOMForLLM(state.domTree, 0, showNewElements);

		// Truncate if too long
		if (output.length > maxLength) {
			output = output.substring(0, maxLength) + '\n...[truncated]';
		}

		return output;
	}

	/**
	 * Get element by index from selector map
	 */
	async getElementByIndex(
		index: number,
		selectorMap: Map<number, EnhancedDOMTreeNode>
	): Promise<EnhancedDOMTreeNode | null> {
		return selectorMap.get(index) || null;
	}

	/**
	 * Find elements by text content
	 */
	async findElementsByText(text: string, selectorMap: Map<number, EnhancedDOMTreeNode>): Promise<EnhancedDOMTreeNode[]> {
		const results: EnhancedDOMTreeNode[] = [];
		const lowerText = text.toLowerCase();

		for (const node of selectorMap.values()) {
			if (node.text?.toLowerCase().includes(lowerText)) {
				results.push(node);
			}
		}

		return results;
	}

	/**
	 * Find elements by role
	 */
	async findElementsByRole(role: string, selectorMap: Map<number, EnhancedDOMTreeNode>): Promise<EnhancedDOMTreeNode[]> {
		const results: EnhancedDOMTreeNode[] = [];

		for (const node of selectorMap.values()) {
			if (node.role === role || node.attributes?.role === role) {
				results.push(node);
			}
		}

		return results;
	}

	/**
	 * Close CDP session
	 */
	async close(): Promise<void> {
		if (this.cdpSession) {
			await this.cdpSession.detach();
			this.cdpSession = null;
		}
	}
}

/**
 * Serializes enhanced DOM trees to string format for LLM consumption
 */

import {
	DOMRect,
	DOMSelectorMap,
	EnhancedDOMTreeNode,
	NodeType,
	SerializedDOMState,
	SimplifiedNode,
	getScrollInfoText,
} from '../views.js';
import { capTextLength } from '../utils.js';
import { applyPaintOrderFiltering } from './paint_order.js';

export const DISABLED_ELEMENTS = new Set(['style', 'script', 'head', 'meta', 'link', 'title']);

// SVG child elements to skip (decorative only, no interaction value)
export const SVG_ELEMENTS = new Set([
	'path',
	'rect',
	'g',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	'use',
	'defs',
	'clipPath',
	'mask',
	'pattern',
	'image',
	'text',
	'tspan',
]);

interface PropagatingBounds {
	tag: string;
	bounds: DOMRect;
	nodeId: number;
	depth: number;
}

/**
 * Serializes enhanced DOM trees to string format
 */
export class DOMTreeSerializer {
	// Configuration - elements that propagate bounds to their children
	static PROPAGATING_ELEMENTS = [
		{ tag: 'a', role: null }, // Any <a> tag
		{ tag: 'button', role: null }, // Any <button> tag
		{ tag: 'div', role: 'button' }, // <div role="button">
		{ tag: 'div', role: 'combobox' }, // <div role="combobox">
		{ tag: 'span', role: 'button' }, // <span role="button">
		{ tag: 'span', role: 'combobox' }, // <span role="combobox">
		{ tag: 'input', role: 'combobox' }, // <input role="combobox">
	];

	static DEFAULT_CONTAINMENT_THRESHOLD = 0.99; // 99% containment by default

	private rootNode: EnhancedDOMTreeNode;
	private interactiveCounter: number = 1;
	private selectorMap: DOMSelectorMap = new Map();
	private previousCachedSelectorMap: DOMSelectorMap | null = null;
	/** (session id, backend node id) pairs of the previous state, for "new element" marking */
	private previousNodeIds: Set<string> = new Set();
	private timingInfo: Record<string, number> = {};
	/** CDP node IDs are scoped to a session and can be reused by unrelated elements in cross-origin iframes */
	private clickableCache: Map<string, boolean> = new Map();
	private reservedBackendNodeIds: Set<number> = new Set();
	private nextSyntheticIndex: number = 1;
	private enableBboxFiltering: boolean;
	private containmentThreshold: number;
	private paintOrderFiltering: boolean;
	/** Session id for the session-specific `data-browser-use-exclude-<id>` attribute */
	private sessionId: string | null;

	constructor(
		rootNode: EnhancedDOMTreeNode,
		previousCachedState: SerializedDOMState | null = null,
		enableBboxFiltering: boolean = true,
		containmentThreshold: number | null = null,
		paintOrderFiltering: boolean = true,
		sessionId: string | null = null
	) {
		this.rootNode = rootNode;
		this.previousCachedSelectorMap = previousCachedState?.selectorMap || null;
		if (this.previousCachedSelectorMap) {
			for (const previousNode of this.previousCachedSelectorMap.values()) {
				this.previousNodeIds.add(DOMTreeSerializer.nodeIdentity(previousNode));
			}
		}
		this.enableBboxFiltering = enableBboxFiltering;
		this.containmentThreshold = containmentThreshold ?? DOMTreeSerializer.DEFAULT_CONTAINMENT_THRESHOLD;
		this.paintOrderFiltering = paintOrderFiltering;
		this.sessionId = sessionId;
	}

	private static nodeIdentity(node: EnhancedDOMTreeNode): string {
		return `${node.sessionId ?? ''}:${node.backendNodeId}`;
	}

	private static isFileInput(node: EnhancedDOMTreeNode): boolean {
		return node.nodeName?.toLowerCase() === 'input' && node.attributes?.type === 'file';
	}

	private safeParseNumber(valueStr: string, defaultVal: number): number {
		try {
			return parseFloat(valueStr);
		} catch {
			return defaultVal;
		}
	}

	private safeParseOptionalNumber(valueStr: string | null | undefined): number | null {
		if (!valueStr) return null;
		try {
			return parseFloat(valueStr);
		} catch {
			return null;
		}
	}

	/**
	 * Main serialization entry point
	 */
	serializeAccessibleElements(): [SerializedDOMState, Record<string, number>] {
		const startTotal = Date.now();

		// Reset state
		this.interactiveCounter = 1;
		this.selectorMap = new Map();
		this.clickableCache = new Map();
		this.reservedBackendNodeIds = new Set();
		this.nextSyntheticIndex = 1;

		// Step 1: Create simplified tree
		const startStep1 = Date.now();
		const simplifiedTree = this.createSimplifiedTree(this.rootNode);
		const endStep1 = Date.now();
		this.timingInfo.createSimplifiedTree = (endStep1 - startStep1) / 1000;

		// Step 2: Paint order filtering - removes visually obscured elements
		const startStep2 = Date.now();
		if (this.paintOrderFiltering && simplifiedTree) {
			applyPaintOrderFiltering(simplifiedTree);
		}
		const endStep2 = Date.now();
		this.timingInfo.calculatePaintOrder = (endStep2 - startStep2) / 1000;

		// Step 3: Optimize tree
		const startStep3 = Date.now();
		const optimizedTree = this.optimizeTree(simplifiedTree);
		const endStep3 = Date.now();
		this.timingInfo.optimizeTree = (endStep3 - startStep3) / 1000;

		// Step 4: Bounding box filtering
		let filteredTree = optimizedTree;
		if (this.enableBboxFiltering && optimizedTree) {
			const startStep4 = Date.now();
			filteredTree = this.applyBoundingBoxFiltering(optimizedTree);
			const endStep4 = Date.now();
			this.timingInfo.bboxFiltering = (endStep4 - startStep4) / 1000;
		}

		// Step 5: Assign interactive indices
		const startStep5 = Date.now();
		this.reserveBackendNodeIds(filteredTree);
		this.assignInteractiveIndicesAndMarkNewNodes(filteredTree);
		const endStep5 = Date.now();
		this.timingInfo.assignInteractiveIndices = (endStep5 - startStep5) / 1000;

		const endTotal = Date.now();
		this.timingInfo.serializeAccessibleElementsTotal = (endTotal - startTotal) / 1000;

		return [
			{
				root: filteredTree,
				selectorMap: this.selectorMap,
			},
			this.timingInfo,
		];
	}

	/**
	 * Check if element is interactive (simplified - full logic would use ClickableElementDetector)
	 */
	private isInteractiveCached(node: EnhancedDOMTreeNode): boolean {
		// CDP node IDs are scoped to a session and can be reused by unrelated elements in
		// cross-origin iframe targets, so the cache key carries the session id
		const cacheKey = `${node.sessionId ?? ''}:${node.nodeId}`;
		if (this.clickableCache.has(cacheKey)) {
			return this.clickableCache.get(cacheKey)!;
		}

		// Simplified interactive detection
		let result = false;

		if (node.hasJsClickListener || node.snapshotNode?.isClickable) {
			result = true;
		} else if (node.attributes) {
			const tag = node.nodeName.toLowerCase();
			const role = node.attributes.role;

			// Common interactive elements
			if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) {
				result = true;
			} else if (role && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem'].includes(role)) {
				result = true;
			} else if (node.attributes.onclick || node.attributes['aria-label']) {
				result = true;
			}
		}

		this.clickableCache.set(cacheKey, result);
		return result;
	}

	/** Check if a node has any interactive descendants (not including the node itself). */
	private hasInteractiveDescendants(node: SimplifiedNode): boolean {
		for (const child of node.children) {
			if (this.isInteractiveCached(child.originalNode)) {
				return true;
			}
			if (this.hasInteractiveDescendants(child)) {
				return true;
			}
		}
		return false;
	}

	/** Reserve every CDP backend ID in one linear traversal so synthetic indices never collide. */
	private reserveBackendNodeIds(root: SimplifiedNode | null): void {
		if (!root) {
			return;
		}
		const stack: SimplifiedNode[] = [root];
		while (stack.length > 0) {
			const node = stack.pop()!;
			this.reservedBackendNodeIds.add(node.originalNode.backendNodeId);
			stack.push(...node.children);
		}
		this.nextSyntheticIndex = (this.reservedBackendNodeIds.size > 0 ? Math.max(...this.reservedBackendNodeIds) : 0) + 1;
	}

	/**
	 * Preserve unique backend IDs as model indices and allocate a collision-free synthetic index
	 * when two targets (e.g. cross-origin iframes) reuse the same backend node id.
	 */
	private allocateSelectorIndex(backendNodeId: number): number {
		if (!this.selectorMap.has(backendNodeId)) {
			return backendNodeId;
		}
		while (this.reservedBackendNodeIds.has(this.nextSyntheticIndex)) {
			this.nextSyntheticIndex += 1;
		}
		const selectorIndex = this.nextSyntheticIndex;
		this.nextSyntheticIndex += 1;
		return selectorIndex;
	}

	/** Whether a scrollable element is a dropdown container that must stay targetable */
	private static isDropdownContainer(node: EnhancedDOMTreeNode): boolean {
		const attrs = node.attributes || {};
		const role = (attrs.role || '').toLowerCase();
		const tagName = (node.nodeName || '').toLowerCase();
		const classAttr = (attrs.class || '').toLowerCase();
		const classList = classAttr ? classAttr.split(/\s+/) : [];

		const byRole = ['listbox', 'menu', 'combobox', 'menubar', 'tree', 'grid'].includes(role);
		const byTag = tagName === 'select';
		const byClass =
			classList.includes('dropdown') ||
			classList.includes('dropdown-menu') ||
			classList.includes('select-menu') ||
			(classList.includes('ui') && classAttr.includes('dropdown')); // Semantic UI
		return byRole || byTag || byClass;
	}

	/**
	 * Create simplified tree
	 */
	private createSimplifiedTree(node: EnhancedDOMTreeNode, depth: number = 0): SimplifiedNode | null {
		if (node.nodeType === NodeType.DOCUMENT_NODE) {
			// Process children
			const children = node.childrenNodes || [];
			const shadowRoots = node.shadowRoots || [];
			const allChildren = [...children, ...shadowRoots];

			for (const child of allChildren) {
				const simplifiedChild = this.createSimplifiedTree(child, depth + 1);
				if (simplifiedChild) {
					return simplifiedChild;
				}
			}
			return null;
		}

		if (node.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
			// Shadow DOM processing
			const simplified: SimplifiedNode = {
				originalNode: node,
				children: [],
				shouldDisplay: true,
				isInteractive: false,
				isNew: false,
				ignoredByPaintOrder: false,
				excludedByParent: false,
				isShadowHost: false,
				isCompoundComponent: false,
			};

			const children = node.childrenNodes || [];
			const shadowRoots = node.shadowRoots || [];
			const allChildren = [...children, ...shadowRoots];

			for (const child of allChildren) {
				const simplifiedChild = this.createSimplifiedTree(child, depth + 1);
				if (simplifiedChild) {
					simplified.children.push(simplifiedChild);
				}
			}

			return simplified.children.length > 0 ? simplified : null;
		} else if (node.nodeType === NodeType.ELEMENT_NODE) {
			// Skip non-content elements
			if (DISABLED_ELEMENTS.has(node.nodeName.toLowerCase())) {
				return null;
			}

			// Skip SVG child elements
			if (SVG_ELEMENTS.has(node.nodeName.toLowerCase())) {
				return null;
			}

			// Elements the host page asked us to ignore: session-specific attribute first, then the legacy one
			const attributes = node.attributes || {};
			let excludeAttr: string | undefined;
			if (this.sessionId) {
				excludeAttr = attributes[`data-browser-use-exclude-${this.sessionId}`];
			}
			if (!excludeAttr) {
				excludeAttr = attributes['data-browser-use-exclude'];
			}
			if (typeof excludeAttr === 'string' && excludeAttr.toLowerCase() === 'true') {
				return null;
			}

			// Handle iframes
			if (node.nodeName === 'IFRAME' || node.nodeName === 'FRAME') {
				if (node.contentDocument) {
					const simplified: SimplifiedNode = {
						originalNode: node,
						children: [],
						shouldDisplay: true,
						isInteractive: false,
						isNew: false,
						ignoredByPaintOrder: false,
						excludedByParent: false,
						isShadowHost: false,
						isCompoundComponent: false,
					};

					const docChildren = node.contentDocument.childrenNodes || [];
					for (const child of docChildren) {
						const simplifiedChild = this.createSimplifiedTree(child, depth + 1);
						if (simplifiedChild) {
							simplified.children.push(simplifiedChild);
						}
					}
					return simplified;
				}
			}

			// File inputs are often hidden with opacity:0 but are still functional (Bootstrap and
			// other frameworks use this pattern with custom-styled file pickers)
			const isVisible = (node.isVisible || false) || DOMTreeSerializer.isFileInput(node);
			const isScrollable = node.isScrollable || false;
			const children = node.childrenNodes || [];
			const shadowRoots = node.shadowRoots || [];
			const allChildren = [...children, ...shadowRoots];
			const hasShadowContent = allChildren.length > 0;

			// Check if shadow host
			const isShadowHost = shadowRoots.length > 0;

			// Include if visible, scrollable, has children, or is shadow host
			if (isVisible || isScrollable || hasShadowContent || isShadowHost) {
				const simplified: SimplifiedNode = {
					originalNode: node,
					children: [],
					shouldDisplay: true,
					isInteractive: false,
					isNew: false,
					ignoredByPaintOrder: false,
					excludedByParent: false,
					isShadowHost: isShadowHost,
					isCompoundComponent: false,
				};

				// Process all children including shadow roots
				for (const child of allChildren) {
					const simplifiedChild = this.createSimplifiedTree(child, depth + 1);
					if (simplifiedChild) {
						simplified.children.push(simplifiedChild);
					}
				}

				// Return if meaningful or has meaningful children
				if (isVisible || isScrollable || simplified.children.length > 0) {
					return simplified;
				}
			}
		} else if (node.nodeType === NodeType.TEXT_NODE) {
			// Include meaningful text nodes
			const isVisible = node.snapshotNode && node.isVisible;
			if (isVisible && node.nodeValue && node.nodeValue.trim().length > 1) {
				return {
					originalNode: node,
					children: [],
					shouldDisplay: true,
					isInteractive: false,
					isNew: false,
					ignoredByPaintOrder: false,
					excludedByParent: false,
					isShadowHost: false,
					isCompoundComponent: false,
				};
			}
		}

		return null;
	}

	/**
	 * Optimize tree structure
	 */
	private optimizeTree(node: SimplifiedNode | null): SimplifiedNode | null {
		if (!node) return null;

		// Process children
		const optimizedChildren: SimplifiedNode[] = [];
		for (const child of node.children) {
			const optimizedChild = this.optimizeTree(child);
			if (optimizedChild) {
				optimizedChildren.push(optimizedChild);
			}
		}

		node.children = optimizedChildren;

		// Keep meaningful nodes
		const isVisible = node.originalNode.snapshotNode && node.originalNode.isVisible;

		if (
			isVisible ||
			node.originalNode.isScrollable ||
			node.originalNode.nodeType === NodeType.TEXT_NODE ||
			node.children.length > 0 ||
			DOMTreeSerializer.isFileInput(node.originalNode) // Keep file inputs even if not visible
		) {
			return node;
		}

		return null;
	}

	/**
	 * Apply bounding box filtering
	 */
	private applyBoundingBoxFiltering(node: SimplifiedNode | null): SimplifiedNode | null {
		if (!node) return null;

		// Start with no active bounds
		this.filterTreeRecursive(node, null, 0);

		return node;
	}

	/**
	 * Recursively filter tree with bounding box propagation
	 */
	private filterTreeRecursive(
		node: SimplifiedNode,
		activeBounds: PropagatingBounds | null = null,
		depth: number = 0
	): void {
		// Check if this node should be excluded by active bounds
		if (activeBounds && this.shouldExcludeChild(node, activeBounds)) {
			node.excludedByParent = true;
		}

		// Check if this node starts new propagation
		let newBounds: PropagatingBounds | null = null;
		const tag = node.originalNode.nodeName.toLowerCase();
		const role = node.originalNode.attributes?.role || null;

		if (this.isPropagatingElement({ tag, role })) {
			if (node.originalNode.snapshotNode?.bounds) {
				newBounds = {
					tag,
					bounds: node.originalNode.snapshotNode.bounds,
					nodeId: node.originalNode.nodeId,
					depth,
				};
			}
		}

		// Propagate to all children
		const propagateBounds = newBounds || activeBounds;

		for (const child of node.children) {
			this.filterTreeRecursive(child, propagateBounds, depth + 1);
		}
	}

	/**
	 * Determine if child should be excluded based on propagating bounds
	 */
	private shouldExcludeChild(node: SimplifiedNode, activeBounds: PropagatingBounds): boolean {
		// Never exclude text nodes
		if (node.originalNode.nodeType === NodeType.TEXT_NODE) {
			return false;
		}

		// Get child bounds
		if (!node.originalNode.snapshotNode?.bounds) {
			return false;
		}

		const childBounds = node.originalNode.snapshotNode.bounds;

		// Check containment
		if (!this.isContained(childBounds, activeBounds.bounds, this.containmentThreshold)) {
			return false;
		}

		// Exception rules - keep these even if contained
		const childTag = node.originalNode.nodeName.toLowerCase();
		const childRole = node.originalNode.attributes?.role || null;

		// Never exclude form elements
		if (['input', 'select', 'textarea', 'label'].includes(childTag)) {
			return false;
		}

		// Keep if child is also a propagating element
		if (this.isPropagatingElement({ tag: childTag, role: childRole })) {
			return false;
		}

		// Keep if has explicit onclick handler
		if (node.originalNode.attributes?.onclick) {
			return false;
		}

		// Keep if has aria-label
		if (node.originalNode.attributes?.['aria-label']?.trim()) {
			return false;
		}

		// Keep if has interactive role
		if (childRole && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option'].includes(childRole)) {
			return false;
		}

		return true;
	}

	/**
	 * Check if child is contained within parent bounds
	 */
	private isContained(child: DOMRect, parent: DOMRect, threshold: number): boolean {
		// Calculate intersection
		const xOverlap = Math.max(0, Math.min(child.x + child.width, parent.x + parent.width) - Math.max(child.x, parent.x));
		const yOverlap = Math.max(
			0,
			Math.min(child.y + child.height, parent.y + parent.height) - Math.max(child.y, parent.y)
		);

		const intersectionArea = xOverlap * yOverlap;
		const childArea = child.width * child.height;

		if (childArea === 0) return false;

		const containmentRatio = intersectionArea / childArea;
		return containmentRatio >= threshold;
	}

	/**
	 * Check if element should propagate bounds
	 */
	private isPropagatingElement(attributes: { tag: string; role: string | null }): boolean {
		for (const pattern of DOMTreeSerializer.PROPAGATING_ELEMENTS) {
			const tagMatch = pattern.tag === null || pattern.tag === attributes.tag;
			const roleMatch = pattern.role === null || pattern.role === attributes.role;

			if (tagMatch && roleMatch) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Assign interactive indices to clickable elements
	 */
	private assignInteractiveIndicesAndMarkNewNodes(node: SimplifiedNode | null): void {
		if (!node) return;

		// Skip assigning index to excluded nodes or ignored by paint order
		if (!node.excludedByParent && !node.ignoredByPaintOrder) {
			const original = node.originalNode;
			const isInteractive = this.isInteractiveCached(original);
			const isVisible = !!(original.snapshotNode && original.isVisible);
			const isScrollable = !!original.isScrollable;
			// File inputs are often hidden with opacity:0 but are still functional
			const isFileInput = DOMTreeSerializer.isFileInput(original);
			// Shadow DOM form elements may lack DOMSnapshot layout data but are still interactive
			const isShadowDomFormElement =
				isInteractive &&
				!original.snapshotNode &&
				['input', 'button', 'select', 'textarea', 'a'].includes(original.nodeName?.toLowerCase() || '') &&
				this.isInsideShadowDom(original);

			let shouldMakeInteractive = false;
			if (isScrollable) {
				// Dropdown containers must stay targetable for select_dropdown; other scrollable
				// containers are only indexed when they have no interactive descendants
				shouldMakeInteractive = DOMTreeSerializer.isDropdownContainer(original) || !this.hasInteractiveDescendants(node);
			} else if (isInteractive && (isVisible || isFileInput || isShadowDomFormElement)) {
				shouldMakeInteractive = true;
			}

			if (shouldMakeInteractive) {
				node.isInteractive = true;
				node.selectorIndex = this.allocateSelectorIndex(original.backendNodeId);
				this.selectorMap.set(node.selectorIndex, original);
				this.interactiveCounter += 1;

				// Add compound component information
				this.addCompoundComponents(node);

				// Mark compound components as new for visibility; otherwise compare with the previous state
				if (node.isCompoundComponent) {
					node.isNew = true;
				} else if (this.previousNodeIds.size > 0 && !this.previousNodeIds.has(DOMTreeSerializer.nodeIdentity(original))) {
					node.isNew = true;
				}
			}
		}

		// Process children
		for (const child of node.children) {
			this.assignInteractiveIndicesAndMarkNewNodes(child);
		}
	}

	/**
	 * Check if a node is inside a shadow DOM by walking up the parent chain.
	 * Shadow roots are DOCUMENT_FRAGMENT nodes with shadowRootType set.
	 */
	private isInsideShadowDom(node: EnhancedDOMTreeNode): boolean {
		let current = node.parentNode;
		while (current) {
			if (current.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE && current.shadowRootType) {
				return true;
			}
			current = current.parentNode;
		}
		return false;
	}

	/**
	 * Add compound component information to element
	 * Enhances compound controls with information from their child components
	 */
	private addCompoundComponents(node: SimplifiedNode): void {
		const originalNode = node.originalNode;
		const tagName = originalNode.nodeName.toLowerCase();

		// Only process elements that might have compound components
		if (!['input', 'select', 'details', 'audio', 'video'].includes(tagName)) {
			return;
		}

		const attributes = originalNode.attributes || {};
		const compoundChildren: any[] = [];

		if (tagName === 'input') {
			const inputType = attributes.type || 'text';

			// NOTE: date/time inputs get NO compound components: "Day, Month, Year" suggests a
			// DD.MM.YYYY format while HTML5 date/time inputs always require ISO values, which the
			// synthetic format/placeholder attributes already show.
			if (['date', 'time', 'datetime-local', 'month', 'week'].includes(inputType)) {
				// intentionally empty
			} else if (inputType === 'range') {
				const minVal = this.safeParseNumber(attributes.min || '0', 0);
				const maxVal = this.safeParseNumber(attributes.max || '100', 100);
				compoundChildren.push({
					role: 'slider',
					name: 'Value',
					valuemin: minVal,
					valuemax: maxVal,
					valuenow: null
				});
				node.isCompoundComponent = true;
			} else if (inputType === 'number') {
				// Python uses 'textbox' for Value component, not 'spinbutton'
				const minVal = this.safeParseOptionalNumber(attributes.min);
				const maxVal = this.safeParseOptionalNumber(attributes.max);
				compoundChildren.push(
					{ role: 'button', name: 'Increment', valuemin: null, valuemax: null, valuenow: null },
					{ role: 'button', name: 'Decrement', valuemin: null, valuemax: null, valuenow: null },
					{
						role: 'textbox',
						name: 'Value',
						valuemin: minVal,
						valuemax: maxVal,
						valuenow: null
					}
				);
				node.isCompoundComponent = true;
			} else if (inputType === 'color') {
				compoundChildren.push(
					{ role: 'textbox', name: 'Hex Value', valuemin: null, valuemax: null, valuenow: null },
					{ role: 'button', name: 'Color Picker', valuemin: null, valuemax: null, valuenow: null }
				);
				node.isCompoundComponent = true;
			} else if (inputType === 'file') {
				// Python uses 'textbox' for Files Selected, not 'list'
				const isMultiple = 'multiple' in attributes;

				// Extract the current file selection state from the AX tree: explicit "None" when empty
				let currentValue = 'None';
				for (const prop of originalNode.axNode?.properties || []) {
					if (prop.name === 'valuetext' && prop.value) {
						// Human-readable display like "file.pdf"
						const valueStr = String(prop.value).trim();
						if (valueStr && !['no file chosen', 'no file selected'].includes(valueStr.toLowerCase())) {
							currentValue = valueStr;
						}
						break;
					} else if (prop.name === 'value' && prop.value) {
						// May include a full path - keep just the filename
						const valueStr = String(prop.value).trim();
						if (valueStr) {
							currentValue = valueStr.split(/[\\/]/).pop() || valueStr;
							break;
						}
					}
				}

				compoundChildren.push(
					{ role: 'button', name: 'Browse Files', valuemin: null, valuemax: null, valuenow: null },
					{
						role: 'textbox',
						name: isMultiple ? 'Files Selected' : 'File Selected',
						valuemin: null,
						valuemax: null,
						valuenow: currentValue, // Always shows state: filename or "None"
					}
				);
				node.isCompoundComponent = true;
			}
		} else if (tagName === 'select') {
			// Get select information
			const isMultiple = 'multiple' in attributes;
			const optionInfo = this.extractSelectOptions(originalNode);
			if (optionInfo) {
				compoundChildren.push({
					role: 'combobox',
					name: 'Dropdown',
					options: optionInfo,
					multiple: isMultiple
				});
			}
			node.isCompoundComponent = true;
		} else if (tagName === 'details') {
			compoundChildren.push(
				{ role: 'button', name: 'Toggle Disclosure', valuemin: null, valuemax: null, valuenow: null },
				{ role: 'region', name: 'Content Area', valuemin: null, valuemax: null, valuenow: null }
			);
			node.isCompoundComponent = true;
		} else if (tagName === 'audio') {
			compoundChildren.push(
				{ role: 'button', name: 'Play/Pause', valuemin: null, valuemax: null, valuenow: null },
				{ role: 'slider', name: 'Progress', valuemin: 0, valuemax: 100, valuenow: null },
				{ role: 'slider', name: 'Volume', valuemin: 0, valuemax: 100, valuenow: null },
				{ role: 'button', name: 'Mute', valuemin: null, valuemax: null, valuenow: null }
			);
			node.isCompoundComponent = true;
		} else if (tagName === 'video') {
			compoundChildren.push(
				{ role: 'button', name: 'Play/Pause', valuemin: null, valuemax: null, valuenow: null },
				{ role: 'slider', name: 'Progress', valuemin: 0, valuemax: 100, valuenow: null },
				{ role: 'slider', name: 'Volume', valuemin: 0, valuemax: 100, valuenow: null },
				{ role: 'button', name: 'Mute', valuemin: null, valuemax: null, valuenow: null },
				{ role: 'button', name: 'Fullscreen', valuemin: null, valuemax: null, valuenow: null }
			);
			node.isCompoundComponent = true;
		}

		// Store compound children on the original node
		if (compoundChildren.length > 0) {
			originalNode.compoundChildren = compoundChildren;
		}
	}

	/**
	 * Extract option information from a select element.
	 * Matches Python's _extract_select_options exactly.
	 * Returns { count, first_options, format_hint } or null.
	 */
	private extractSelectOptions(node: EnhancedDOMTreeNode): { count: number; first_options: string[]; format_hint: string | null } | null {
		if (!node.childrenNodes || node.childrenNodes.length === 0) {
			return null;
		}

		const options: Array<{ text: string; value: string }> = [];
		const optionValues: string[] = [];

		// Recursively extract option elements, including from optgroups
		const extractOptionsRecursive = (n: EnhancedDOMTreeNode): void => {
			const tagName = n.nodeName?.toLowerCase() || '';

			if (tagName === 'option') {
				// Get value attribute if present
				let optionValue = '';
				if (n.attributes?.value) {
					optionValue = String(n.attributes.value).trim();
				}

				// Get text content from direct child text nodes only to avoid duplication
				let optionText = '';
				if (n.childrenNodes) {
					for (const child of n.childrenNodes) {
						if (child.nodeType === NodeType.TEXT_NODE && child.nodeValue) {
							optionText += child.nodeValue.trim() + ' ';
						}
					}
				}
				optionText = optionText.trim();

				// Use text as value if no explicit value
				if (!optionValue && optionText) {
					optionValue = optionText;
				}

				if (optionText || optionValue) {
					options.push({ text: optionText, value: optionValue });
					optionValues.push(optionValue);
				}
			} else if (tagName === 'optgroup') {
				// Process optgroup children
				if (n.childrenNodes) {
					for (const child of n.childrenNodes) {
						extractOptionsRecursive(child);
					}
				}
			} else {
				// Process other children that might contain options
				if (n.childrenNodes) {
					for (const child of n.childrenNodes) {
						extractOptionsRecursive(child);
					}
				}
			}
		};

		// Extract all options from select children
		for (const child of node.childrenNodes) {
			extractOptionsRecursive(child);
		}

		if (options.length === 0) {
			return null;
		}

		// Prepare first 4 options for display: always the text if available, otherwise the value
		const firstOptions: string[] = [];
		for (const option of options.slice(0, 4)) {
			const displayText = option.text || option.value;
			if (displayText) {
				// Limit individual option text to avoid overly long attributes
				firstOptions.push(displayText.length > 30 ? displayText.substring(0, 30) + '...' : displayText);
			}
		}

		// Add ellipsis indicator if there are more options than shown
		if (options.length > 4) {
			firstOptions.push(`... ${options.length - 4} more options...`);
		}

		// Try to infer format hint from option values
		let formatHint: string | null = null;
		if (optionValues.length >= 2) {
			// Check for common patterns
			const checkValues = optionValues.slice(0, 5).filter(v => v);

			if (checkValues.every(val => /^\d+$/.test(val))) {
				formatHint = 'numeric';
			} else if (checkValues.every(val => val.length === 2 && /^[A-Z]+$/.test(val))) {
				formatHint = 'country/state codes';
			} else if (checkValues.every(val => val.includes('/') || val.includes('-'))) {
				formatHint = 'date/path format';
			} else if (checkValues.some(val => val.includes('@'))) {
				formatHint = 'email addresses';
			}
		}

		return { count: options.length, first_options: firstOptions, format_hint: formatHint };
	}

	/**
	 * Serialize tree to string format
	 * Matches Python's serialize_tree output format exactly
	 */
	static serializeTree(
		node: SimplifiedNode | null,
		includeAttributes: string[],
		depth: number = 0
	): string {
		if (!node) return '';

		// Skip rendering excluded nodes, but process their children
		if (node.excludedByParent) {
			const formattedText: string[] = [];
			for (const child of node.children) {
				const childText = DOMTreeSerializer.serializeTree(child, includeAttributes, depth);
				if (childText) {
					formattedText.push(childText);
				}
			}
			return formattedText.join('\n');
		}

		const formattedText: string[] = [];
		const depthStr = '\t'.repeat(depth);
		let nextDepth = depth;

		if (node.originalNode.nodeType === NodeType.ELEMENT_NODE) {
			// Skip displaying nodes marked as should_display=false
			if (!node.shouldDisplay) {
				for (const child of node.children) {
					const childText = DOMTreeSerializer.serializeTree(child, includeAttributes, depth);
					if (childText) {
						formattedText.push(childText);
					}
				}
				return formattedText.join('\n');
			}

			const tagName = node.originalNode.nodeName.toLowerCase();

			// Special handling for SVG elements - show the tag but collapse children
			if (tagName === 'svg') {
				let shadowPrefix = '';
				if (node.isShadowHost) {
					const hasClosedShadow = node.children.some(
						(child) =>
							child.originalNode.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE &&
							child.originalNode.shadowRootType &&
							child.originalNode.shadowRootType.toLowerCase() === 'closed'
					);
					shadowPrefix = hasClosedShadow ? '|SHADOW(closed)|' : '|SHADOW(open)|';
				}

				let line = `${depthStr}${shadowPrefix}`;
				if (node.isInteractive) {
					const newPrefix = node.isNew ? '*' : '';
					line += `${newPrefix}[${node.selectorIndex ?? node.originalNode.backendNodeId}]`;
				}
				line += '<svg';

				// Add attributes
				if (node.originalNode.attributes) {
					for (const attr of includeAttributes) {
						if (node.originalNode.attributes[attr]) {
							const value = node.originalNode.attributes[attr];
							line += ` ${attr}="${capTextLength(value, 100)}"`;
						}
					}
				}

				line += ' /> <!-- SVG content collapsed -->';
				formattedText.push(line);
				// Don't process children for SVG
				return formattedText.join('\n');
			}

			// Add element if clickable, scrollable, or iframe
			const isScrollable = node.originalNode.isScrollable || false;
			const isIframe = tagName === 'iframe';
			const isFrame = tagName === 'frame';

			if (node.isInteractive || isScrollable || isIframe || isFrame) {
				nextDepth = depth + 1;

				// Build attributes string with compound component info
				let attributesStr = '';
				if (node.originalNode.attributes) {
					for (const attr of includeAttributes) {
						if (node.originalNode.attributes[attr]) {
							const value = node.originalNode.attributes[attr];
							attributesStr += ` ${attr}="${capTextLength(value, 100)}"`;
						}
					}
				}

				// Add compound component information if present
				if (node.originalNode.compoundChildren && node.originalNode.compoundChildren.length > 0) {
					const compoundInfo = DOMTreeSerializer.formatCompoundComponents(node.originalNode.compoundChildren);
					if (compoundInfo) {
						attributesStr += ` ${compoundInfo}`;
					}
				}

				// Build the line with shadow host indicator
				let shadowPrefix = '';
				if (node.isShadowHost) {
					const hasClosedShadow = node.children.some(
						(child) =>
							child.originalNode.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE &&
							child.originalNode.shadowRootType &&
							child.originalNode.shadowRootType.toLowerCase() === 'closed'
					);
					shadowPrefix = hasClosedShadow ? '|SHADOW(closed)|' : '|SHADOW(open)|';
				}

				let line: string;
				if (isScrollable && !node.isInteractive) {
					// Scrollable container but not clickable
					line = `${depthStr}${shadowPrefix}|scroll element|<${tagName}`;
				} else if (node.isInteractive) {
					// Clickable (and possibly scrollable) - show the model-visible selector index
					const newPrefix = node.isNew ? '*' : '';
					const scrollPrefix = isScrollable ? '|scroll element[' : '[';
					const index = node.selectorIndex ?? node.originalNode.backendNodeId;
					line = `${depthStr}${shadowPrefix}${newPrefix}${scrollPrefix}${index}]<${tagName}`;
				} else if (isIframe) {
					// Iframe element (not interactive)
					line = `${depthStr}${shadowPrefix}|IFRAME|<${tagName}`;
				} else if (isFrame) {
					// Frame element (not interactive)
					line = `${depthStr}${shadowPrefix}|FRAME|<${tagName}`;
				} else {
					line = `${depthStr}${shadowPrefix}<${tagName}`;
				}

				if (attributesStr) {
					line += attributesStr;
				}

				line += ' />';

				// Add scroll information if scrollable (matching Python's scroll info)
				if (isScrollable) {
					const scrollInfoText = getScrollInfoText(node.originalNode);
					if (scrollInfoText) {
						line += ` (${scrollInfoText})`;
					}
				}

				formattedText.push(line);
			}
		} else if (node.originalNode.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
			// Shadow DOM representation - show clearly to LLM
			if (node.originalNode.shadowRootType && node.originalNode.shadowRootType.toLowerCase() === 'closed') {
				formattedText.push(`${depthStr}Closed Shadow`);
			} else {
				formattedText.push(`${depthStr}Open Shadow`);
			}

			nextDepth = depth + 1;

			// Process shadow DOM children
			for (const child of node.children) {
				const childText = DOMTreeSerializer.serializeTree(child, includeAttributes, nextDepth);
				if (childText) {
					formattedText.push(childText);
				}
			}

			// Close shadow DOM indicator
			if (node.children.length > 0) {
				formattedText.push(`${depthStr}Shadow End`);
			}

			return formattedText.join('\n');
		} else if (node.originalNode.nodeType === NodeType.TEXT_NODE) {
			// Include visible text that isn't fully covered by another element painted on top of
			// it (e.g. text underneath an open modal/dropdown)
			const isVisible = node.originalNode.snapshotNode && node.originalNode.isVisible;
			if (
				isVisible &&
				!node.ignoredByPaintOrder &&
				node.originalNode.nodeValue &&
				node.originalNode.nodeValue.trim() &&
				node.originalNode.nodeValue.trim().length > 1
			) {
				const cleanText = node.originalNode.nodeValue.trim();
				formattedText.push(`${depthStr}${capTextLength(cleanText, 200)}`);
			}
		}

		// Process children for ELEMENT_NODE and TEXT_NODE
		// (DOCUMENT_FRAGMENT_NODE handles its own children and returns early above)
		for (const child of node.children) {
			const childText = DOMTreeSerializer.serializeTree(child, includeAttributes, nextDepth);
			if (childText) {
				formattedText.push(childText);
			}
		}

		// Add hidden content hint for iframes
		const originalTag = node.originalNode.nodeName?.toUpperCase();
		if (node.originalNode.nodeType === NodeType.ELEMENT_NODE && (originalTag === 'IFRAME' || originalTag === 'FRAME')) {
			const hidden = node.originalNode.hiddenElementsInfo;
			if (hidden && hidden.length > 0) {
				// Show specific interactive elements with scroll distances
				formattedText.push(`${depthStr}... (${hidden.length} more elements below - scroll to reveal):`);
				for (const elem of hidden) {
					formattedText.push(`${depthStr}    <${elem.tag}> "${elem.text}" ~${elem.pages} pages down`);
				}
			} else if (node.originalNode.hasHiddenContent) {
				// Generic hint for non-interactive hidden content
				formattedText.push(`${depthStr}... (more content below viewport - scroll to reveal)`);
			}
		}

		return formattedText.join('\n');
	}

	/**
	 * Format compound component children for display
	 * Matches Python's compound_components format exactly
	 */
	static formatCompoundComponents(compoundChildren: any[]): string {
		const parts: string[] = [];

		for (const child of compoundChildren) {
			const infoParts: string[] = [];

			if (child.name) {
				infoParts.push(`name=${child.name}`);
			}
			if (child.role) {
				infoParts.push(`role=${child.role}`);
			}
			if (child.valuemin !== null && child.valuemin !== undefined) {
				infoParts.push(`min=${child.valuemin}`);
			}
			if (child.valuemax !== null && child.valuemax !== undefined) {
				infoParts.push(`max=${child.valuemax}`);
			}
			// Python uses 'current=' for valuenow, not 'value='
			if (child.valuenow !== null && child.valuenow !== undefined) {
				infoParts.push(`current=${child.valuenow}`);
			}

			// Add select-specific information (matching Python)
			if (child.options_count !== null && child.options_count !== undefined) {
				infoParts.push(`count=${child.options_count}`);
			}
			if (child.first_options && child.first_options.length > 0) {
				const optionsStr = child.first_options.slice(0, 4).join('|'); // Limit to 4 options
				infoParts.push(`options=${optionsStr}`);
			}
			if (child.format_hint) {
				infoParts.push(`format=${child.format_hint}`);
			}

			// Legacy support for simple options array
			if (child.options && !child.options_count) {
				infoParts.push(`count=${child.options.length}`);
			}
			if (child.multiple) {
				infoParts.push('multiple');
			}

			if (infoParts.length > 0) {
				parts.push(`(${infoParts.join(',')})`);
			}
		}

		if (parts.length > 0) {
			return `compound_components=${parts.join(',')}`;
		}
		return '';
	}
}

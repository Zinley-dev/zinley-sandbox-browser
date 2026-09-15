/**
 * Enhanced snapshot processing for browser-use DOM tree extraction.
 * Port from browser_use/dom/enhanced_snapshot.py (synced with 0.13.10)
 *
 * This module provides stateless functions for parsing Chrome DevTools Protocol (CDP) DOMSnapshot data
 * to extract visibility, clickability, cursor styles, live form values and other layout information.
 */

import { DOMRect, EnhancedSnapshotNode } from './views.js';

// Only the ESSENTIAL computed styles for interactivity and visibility detection
export const REQUIRED_COMPUTED_STYLES = [
	// Only styles actually accessed in the codebase (prevents Chrome crashes on heavy sites)
	'display', // Used in service.py visibility detection
	'visibility', // Used in service.py visibility detection
	'opacity', // Used in service.py visibility detection
	'overflow', // Used in views.py scrollability detection
	'overflow-x', // Used in views.py scrollability detection
	'overflow-y', // Used in views.py scrollability detection
	'cursor', // Used in enhanced_snapshot.py cursor extraction
	'pointer-events', // Used for clickability logic
	'position', // Used for visibility logic
	'background-color', // Used for visibility logic
];

/**
 * CDP DOMSnapshot types
 */
interface RareBooleanData {
	index: number[];
}

interface RareStringData {
	index: number[];
	value: number[];
}

interface NodeTreeSnapshot {
	backendNodeId?: number[];
	attributes?: number[][];
	isClickable?: RareBooleanData;
	inputValue?: RareStringData;
	textValue?: RareStringData;
	inputChecked?: RareBooleanData;
	[key: string]: any;
}

interface LayoutTreeSnapshot {
	nodeIndex?: number[];
	bounds?: number[][];
	styles?: number[][];
	paintOrders?: number[];
	clientRects?: number[][];
	scrollRects?: number[][];
	stackingContexts?: { index?: number[] };
	[key: string]: any;
}

interface DocumentSnapshot {
	nodes: NodeTreeSnapshot;
	layout: LayoutTreeSnapshot;
	documentURL?: number;
}

interface CaptureSnapshotReturns {
	documents: DocumentSnapshot[];
	strings: string[];
}

// Live values of these fields never leave the snapshot: they would otherwise be serialized
// and could reach logs or the LLM.
const SENSITIVE_INPUT_TYPES = new Set(['password', 'file', 'hidden']);
const SENSITIVE_AUTOCOMPLETE_PREFIXES = ['cc-', 'one-time-code'];

/**
 * True for password/file/hidden inputs and payment or one-time-code autocomplete fields.
 */
export function isSensitiveInput(strings: string[], nodes: NodeTreeSnapshot, snapshotIndex: number): boolean {
	const attributeLists = nodes.attributes;
	if (!attributeLists || snapshotIndex >= attributeLists.length) {
		return false;
	}
	const indices = attributeLists[snapshotIndex] || [];
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

/**
 * Parse computed styles from layout tree using string indices.
 */
function parseComputedStyles(strings: string[], styleIndices: number[]): Record<string, string> {
	const styles: Record<string, string> = {};
	for (let i = 0; i < styleIndices.length; i++) {
		const styleIndex = styleIndices[i];
		if (i < REQUIRED_COMPUTED_STYLES.length && styleIndex >= 0 && styleIndex < strings.length) {
			styles[REQUIRED_COMPUTED_STYLES[i]] = strings[styleIndex];
		}
	}
	return styles;
}

/**
 * Build a lookup table of backend node ID to enhanced snapshot data with everything calculated upfront.
 *
 * @param snapshot - CDP DOMSnapshot.captureSnapshot result
 * @param devicePixelRatio - Device pixel ratio for coordinate conversion (default: 1.0)
 * @returns Map of backend node ID to EnhancedSnapshotNode
 */
export function buildSnapshotLookup(
	snapshot: CaptureSnapshotReturns,
	devicePixelRatio: number = 1.0
): Map<number, EnhancedSnapshotNode> {
	const snapshotLookup = new Map<number, EnhancedSnapshotNode>();

	if (!snapshot.documents || snapshot.documents.length === 0) {
		return snapshotLookup;
	}

	const strings = snapshot.strings;

	for (const document of snapshot.documents) {
		const nodes = document.nodes;
		const layout = document.layout;

		// Build backend node id to snapshot index lookup
		const backendNodeToSnapshotIndex = new Map<number, number>();
		if (nodes.backendNodeId) {
			for (let i = 0; i < nodes.backendNodeId.length; i++) {
				const backendNodeId = nodes.backendNodeId[i];
				backendNodeToSnapshotIndex.set(backendNodeId, i);
			}
		}

		// PERFORMANCE: Pre-build layout index map to eliminate O(n²) double lookups
		// Preserve original behavior: use FIRST occurrence for duplicates
		const layoutIndexMap = new Map<number, number>();
		if (layout && layout.nodeIndex) {
			for (let layoutIdx = 0; layoutIdx < layout.nodeIndex.length; layoutIdx++) {
				const nodeIndex = layout.nodeIndex[layoutIdx];
				if (!layoutIndexMap.has(nodeIndex)) {
					// Only store first occurrence
					layoutIndexMap.set(nodeIndex, layoutIdx);
				}
			}
		}

		// Pre-convert rare boolean data from list to set for O(1) lookups. The raw CDP data uses
		// number[] which makes `includes` O(n); called once per node this was O(n²) total, the
		// #1 bottleneck on heavy pages (20k elements: ~6s -> ~2ms).
		const hasClickableData = !!nodes.isClickable;
		const isClickableSet = new Set<number>(nodes.isClickable?.index ?? []);

		// Live form values live in the snapshot, not in the DOM attributes. Map snapshot index ->
		// string once so each node lookup stays O(1). Sensitive fields are skipped.
		const inputValueByIndex = new Map<number, string>();
		for (const key of ['inputValue', 'textValue'] as const) {
			const rare = nodes[key];
			if (rare?.index && rare?.value) {
				for (let i = 0; i < rare.index.length; i++) {
					const idx = rare.index[i];
					const stringIndex = rare.value[i];
					if (stringIndex >= 0 && stringIndex < strings.length && !isSensitiveInput(strings, nodes, idx)) {
						inputValueByIndex.set(idx, strings[stringIndex]);
					}
				}
			}
		}
		const hasCheckedData = !!nodes.inputChecked;
		const inputCheckedSet = new Set<number>(nodes.inputChecked?.index ?? []);

		// Build snapshot lookup for each backend node id
		for (const [backendNodeId, snapshotIndex] of backendNodeToSnapshotIndex.entries()) {
			let isClickable: boolean = false;
			if (hasClickableData) {
				isClickable = isClickableSet.has(snapshotIndex);
			}

			// Find corresponding layout node
			let cursorStyle: string | null = null;
			let boundingBox: DOMRect | null = null;
			let computedStyles: Record<string, string> = {};
			let paintOrder: number | null = null;
			let clientRects: DOMRect | null = null;
			let scrollRects: DOMRect | null = null;
			let stackingContexts: number | null = null;

			// Look for layout tree node that corresponds to this snapshot node
			if (layoutIndexMap.has(snapshotIndex)) {
				const layoutIdx = layoutIndexMap.get(snapshotIndex)!;

				// Parse bounding box
				if (layout.bounds && layoutIdx < layout.bounds.length) {
					const bounds = layout.bounds[layoutIdx];
					if (bounds && bounds.length >= 4) {
						// IMPORTANT: CDP coordinates are in device pixels, convert to CSS pixels
						// by dividing by the device pixel ratio
						const [rawX, rawY, rawWidth, rawHeight] = bounds;
						boundingBox = {
							x: rawX / devicePixelRatio,
							y: rawY / devicePixelRatio,
							width: rawWidth / devicePixelRatio,
							height: rawHeight / devicePixelRatio,
						};
					}
				}

				// Parse computed styles for this layout node
				if (layout.styles && layoutIdx < layout.styles.length) {
					const styleIndices = layout.styles[layoutIdx];
					computedStyles = parseComputedStyles(strings, styleIndices);
					cursorStyle = computedStyles['cursor'] || null;
				}

				// Extract paint order if available
				if (layout.paintOrders && layoutIdx < layout.paintOrders.length) {
					paintOrder = layout.paintOrders[layoutIdx];
				}

				// Extract client rects if available
				if (layout.clientRects && layoutIdx < layout.clientRects.length) {
					const clientRectData = layout.clientRects[layoutIdx];
					if (clientRectData && clientRectData.length >= 4) {
						clientRects = {
							x: clientRectData[0],
							y: clientRectData[1],
							width: clientRectData[2],
							height: clientRectData[3],
						};
					}
				}

				// Extract scroll rects if available
				if (layout.scrollRects && layoutIdx < layout.scrollRects.length) {
					const scrollRectData = layout.scrollRects[layoutIdx];
					if (scrollRectData && scrollRectData.length >= 4) {
						scrollRects = {
							x: scrollRectData[0],
							y: scrollRectData[1],
							width: scrollRectData[2],
							height: scrollRectData[3],
						};
					}
				}

				// Extract stacking contexts if available
				if (layout.stackingContexts?.index && layoutIdx < layout.stackingContexts.index.length) {
					stackingContexts = layout.stackingContexts.index[layoutIdx];
				}
			}

			snapshotLookup.set(backendNodeId, {
				isClickable: isClickable,
				cursorStyle: cursorStyle,
				bounds: boundingBox,
				clientRects: clientRects,
				scrollRects: scrollRects,
				computedStyles: Object.keys(computedStyles).length > 0 ? computedStyles : null,
				paintOrder: paintOrder,
				stackingContexts: stackingContexts,
				inputValue: inputValueByIndex.get(snapshotIndex) ?? null,
				inputChecked: hasCheckedData ? inputCheckedSet.has(snapshotIndex) : null,
			});
		}
	}

	return snapshotLookup;
}

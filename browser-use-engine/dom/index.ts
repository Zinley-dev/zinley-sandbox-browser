/**
 * DOM module exports
 */

export * from './service.js';
export {
	// Constants
	DEFAULT_INCLUDE_ATTRIBUTES,
	STATIC_ATTRIBUTES,
	DYNAMIC_CLASS_PATTERNS,
	NodeType,
	MatchLevel,
	// Types
	type DOMRect,
	type EnhancedSnapshotNode,
	type EnhancedDOMTreeNode,
	type SerializedDOMState,
	type DOMSelectorMap,
	type DOMInteractedElement,
	type SimplifiedNode,
	type EnhancedAXProperty,
	type EnhancedAXNode,
	type MarkdownChunk,
	// Schemas
	DOMRectSchema,
	DOMInteractedElementSchema,
	// Functions
	getTagName,
	getChildren,
	getChildrenAndShadowRoots,
	getXPath,
	getAllChildrenText,
	getMeaningfulTextForLLM,
	isActuallyScrollable,
	calculateElementHash,
	computeStableHash,
	filterDynamicClasses,
	createDOMInteractedElement,
} from './views.js';
export { preprocessMarkdownContent, chunkMarkdownByStructure, type ChunkMarkdownOptions } from './markdown_chunking.js';
export {
	capTextLength,
	normalizeWhitespace,
	extractVisibleText,
	isLikelyInteractive,
	isFormControl,
	sanitizeAttributeValue,
	getElementDescription,
	isDataURL,
	isBlobURL,
	isAboutBlank,
	generateCssSelectorForElement,
} from './utils.js';
export {
	REQUIRED_COMPUTED_STYLES,
	buildSnapshotLookup,
	isSensitiveInput,
} from './enhanced_snapshot.js';

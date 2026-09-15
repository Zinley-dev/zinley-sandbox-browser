/**
 * Ultra-compact serializer optimized for code-use agents
 * Port from browser_use/dom/serializer/code_use_serializer.py
 *
 * Focuses on minimal token usage while preserving essential interactive context.
 */

import { EnhancedDOMTreeNode, NodeType, SimplifiedNode } from '../views.js';
import { capTextLength } from '../utils.js';

// Minimal but sufficient attribute list for code agents
const CODE_USE_KEY_ATTRIBUTES = [
	'id', // Essential for element selection
	'name', // For form inputs
	'type', // For input types
	'placeholder', // For empty inputs
	'aria-label', // For buttons without text
	'value', // Current values
	'alt', // For images
	'class', // Keep top 2 classes for common selectors
];

// Interactive elements agent can use
const INTERACTIVE_ELEMENTS = new Set([
	'a',
	'button',
	'input',
	'textarea',
	'select',
	'form',
]);

// Semantic structure elements - expanded to include more content containers
const SEMANTIC_STRUCTURE = new Set([
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'nav', 'main', 'header', 'footer',
	'article', 'section',
	'p', // Paragraphs often contain prices and product info
	'span', // Spans often contain prices and labels
	'div', // Divs with useful attributes (id/class) should be shown
	'ul', 'ol', 'li',
	'label',
	'img',
]);

/**
 * Optimized DOM serializer for code-use agents - balances token efficiency with context.
 */
export class DOMCodeAgentSerializer {
	/**
	 * Serialize DOM tree with smart token optimization.
	 *
	 * Strategy:
	 * - Keep top 2 CSS classes for querySelector compatibility
	 * - Show div/span/p elements with useful attributes or text
	 * - Show all interactive + semantic elements
	 * - Inline text up to 80 chars for better context
	 */
	static serializeTree(
		node: SimplifiedNode | null,
		includeAttributes: string[],
		depth: number = 0
	): string {
		if (!node) return '';

		// Skip excluded/hidden nodes
		if (node.excludedByParent) {
			return DOMCodeAgentSerializer._serializeChildren(node, includeAttributes, depth);
		}

		if (!node.shouldDisplay) {
			return DOMCodeAgentSerializer._serializeChildren(node, includeAttributes, depth);
		}

		const formattedText: string[] = [];
		const depthStr = '  '.repeat(depth); // Use 2 spaces instead of tabs for compactness

		if (node.originalNode.nodeType === NodeType.ELEMENT_NODE) {
			const tag = node.originalNode.nodeName.toLowerCase();
			const isVisible = node.originalNode.snapshotNode && node.originalNode.isVisible;

			// Skip invisible (except iframes)
			if (!isVisible && !['iframe', 'frame'].includes(tag)) {
				return DOMCodeAgentSerializer._serializeChildren(node, includeAttributes, depth);
			}

			// Special handling for iframes
			if (['iframe', 'frame'].includes(tag)) {
				return DOMCodeAgentSerializer._serializeIframe(node, includeAttributes, depth);
			}

			// Build minimal attributes
			const attributesStr = DOMCodeAgentSerializer._buildMinimalAttributes(node.originalNode);

			// Decide if element should be shown
			const isInteractive = INTERACTIVE_ELEMENTS.has(tag);
			const isSemantic = SEMANTIC_STRUCTURE.has(tag);
			const hasUsefulAttrs = Boolean(attributesStr);
			const hasText = DOMCodeAgentSerializer._hasDirectText(node);

			// Skip non-semantic, non-interactive containers without attributes
			if (!isInteractive && !isSemantic && !hasUsefulAttrs && !hasText) {
				return DOMCodeAgentSerializer._serializeChildren(node, includeAttributes, depth);
			}

			// Collapse pointless wrappers
			if (['div', 'span'].includes(tag) && !hasUsefulAttrs && !hasText && node.children.length === 1) {
				return DOMCodeAgentSerializer._serializeChildren(node, includeAttributes, depth);
			}

			// Build element
			let line = `${depthStr}<${tag}`;

			if (attributesStr) {
				line += ` ${attributesStr}`;
			}

			// Inline text
			const inlineText = DOMCodeAgentSerializer._getInlineText(node);
			if (inlineText) {
				line += `>${inlineText}`;
			} else {
				line += '>';
			}

			formattedText.push(line);

			// Children (only if no inline text)
			if (node.children.length > 0 && !inlineText) {
				const childrenText = DOMCodeAgentSerializer._serializeChildren(node, includeAttributes, depth + 1);
				if (childrenText) {
					formattedText.push(childrenText);
				}
			}
		} else if (node.originalNode.nodeType === NodeType.TEXT_NODE) {
			// Handled inline with parent
		} else if (node.originalNode.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
			// Shadow DOM - minimal marker
			if (node.children.length > 0) {
				formattedText.push(`${depthStr}#shadow`);
				const childrenText = DOMCodeAgentSerializer._serializeChildren(node, includeAttributes, depth + 1);
				if (childrenText) {
					formattedText.push(childrenText);
				}
			}
		}

		return formattedText.join('\n');
	}

	private static _serializeChildren(
		node: SimplifiedNode,
		includeAttributes: string[],
		depth: number
	): string {
		const childrenOutput: string[] = [];
		for (const child of node.children) {
			const childText = DOMCodeAgentSerializer.serializeTree(child, includeAttributes, depth);
			if (childText) {
				childrenOutput.push(childText);
			}
		}
		return childrenOutput.join('\n');
	}

	private static _buildMinimalAttributes(node: EnhancedDOMTreeNode): string {
		const attrs: string[] = [];

		if (node.attributes) {
			for (const attr of CODE_USE_KEY_ATTRIBUTES) {
				if (node.attributes[attr]) {
					let value = String(node.attributes[attr]).trim();
					if (value) {
						// Special handling for class - keep only first 2 classes
						if (attr === 'class') {
							const classes = value.split(/\s+/).slice(0, 2);
							value = classes.join(' ');
						}
						// Cap at 25 chars
						value = capTextLength(value, 25);
						attrs.push(`${attr}="${value}"`);
					}
				}
			}
		}

		return attrs.join(' ');
	}

	private static _hasDirectText(node: SimplifiedNode): boolean {
		for (const child of node.children) {
			if (child.originalNode.nodeType === NodeType.TEXT_NODE) {
				const text = child.originalNode.nodeValue?.trim() || '';
				if (text.length > 1) {
					return true;
				}
			}
		}
		return false;
	}

	private static _getInlineText(node: SimplifiedNode): string {
		const textParts: string[] = [];
		for (const child of node.children) {
			if (child.originalNode.nodeType === NodeType.TEXT_NODE) {
				const text = child.originalNode.nodeValue?.trim() || '';
				if (text && text.length > 1) {
					textParts.push(text);
				}
			}
		}

		if (textParts.length === 0) return '';

		const combined = textParts.join(' ');
		return capTextLength(combined, 40);
	}

	private static _serializeIframe(
		node: SimplifiedNode,
		includeAttributes: string[],
		depth: number
	): string {
		const formattedText: string[] = [];
		const depthStr = '  '.repeat(depth);
		const tag = node.originalNode.nodeName.toLowerCase();

		// Minimal iframe marker
		const attributesStr = DOMCodeAgentSerializer._buildMinimalAttributes(node.originalNode);
		let line = `${depthStr}<${tag}`;
		if (attributesStr) {
			line += ` ${attributesStr}`;
		}
		line += '>';
		formattedText.push(line);

		// Iframe content
		if (node.originalNode.contentDocument) {
			formattedText.push(`${depthStr}  #iframe-content`);

			// Find and serialize body content only
			for (const childNode of node.originalNode.contentDocument.childrenNodes || []) {
				if (childNode.nodeName.toLowerCase() === 'html') {
					for (const htmlChild of childNode.childrenNodes || []) {
						if (htmlChild.nodeName.toLowerCase() === 'body') {
							for (const bodyChild of htmlChild.childrenNodes || []) {
								DOMCodeAgentSerializer._serializeDocumentNode(
									bodyChild,
									formattedText,
									includeAttributes,
									depth + 2
								);
							}
							break;
						}
					}
				}
			}
		}

		return formattedText.join('\n');
	}

	private static _serializeDocumentNode(
		domNode: EnhancedDOMTreeNode,
		output: string[],
		includeAttributes: string[],
		depth: number
	): void {
		const depthStr = '  '.repeat(depth);

		if (domNode.nodeType === NodeType.ELEMENT_NODE) {
			const tag = domNode.nodeName.toLowerCase();

			// Skip invisible
			const isVisible = domNode.snapshotNode && domNode.isVisible;
			if (!isVisible) {
				return;
			}

			// Check if worth showing
			const isInteractive = INTERACTIVE_ELEMENTS.has(tag);
			const isSemantic = SEMANTIC_STRUCTURE.has(tag);
			const attributesStr = DOMCodeAgentSerializer._buildMinimalAttributes(domNode);

			if (!isInteractive && !isSemantic && !attributesStr) {
				// Skip but process children
				for (const child of domNode.childrenNodes || []) {
					DOMCodeAgentSerializer._serializeDocumentNode(child, output, includeAttributes, depth);
				}
				return;
			}

			// Build element
			let line = `${depthStr}<${tag}`;
			if (attributesStr) {
				line += ` ${attributesStr}`;
			}

			// Get text
			const textParts: string[] = [];
			for (const child of domNode.childrenNodes || []) {
				if (child.nodeType === NodeType.TEXT_NODE && child.nodeValue) {
					const text = child.nodeValue.trim();
					if (text && text.length > 1) {
						textParts.push(text);
					}
				}
			}

			if (textParts.length > 0) {
				const combined = textParts.join(' ');
				line += `>${capTextLength(combined, 25)}`;
			} else {
				line += '>';
			}

			output.push(line);

			// Process non-text children
			for (const child of domNode.childrenNodes || []) {
				if (child.nodeType !== NodeType.TEXT_NODE) {
					DOMCodeAgentSerializer._serializeDocumentNode(child, output, includeAttributes, depth + 1);
				}
			}
		}
	}
}

// Legacy alias
export class CodeUseSerializer {
	serialize(domTree: SimplifiedNode): string {
		return DOMCodeAgentSerializer.serializeTree(domTree, CODE_USE_KEY_ATTRIBUTES);
	}
}

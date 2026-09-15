/**
 * Concise evaluation serializer for DOM trees - optimized for LLM query writing
 * Port from browser_use/dom/serializer/eval_serializer.py
 */

import { EnhancedDOMTreeNode, NodeType, SimplifiedNode } from '../views.js';
import { capTextLength } from '../utils.js';
import { SVG_ELEMENTS } from './serializer.js';

// Critical attributes for query writing and form interaction
const EVAL_KEY_ATTRIBUTES = [
	'id',
	'class',
	'name',
	'type',
	'placeholder',
	'aria-label',
	'role',
	'value',
	'data-testid',
	'alt',
	'title',
	// State attributes (critical for form interaction)
	'checked',
	'selected',
	'disabled',
	'required',
	'readonly',
	// ARIA states
	'aria-expanded',
	'aria-pressed',
	'aria-checked',
	'aria-selected',
	'aria-invalid',
	// Validation attributes
	'pattern',
	'min',
	'max',
	'minlength',
	'maxlength',
	'step',
	'aria-valuemin',
	'aria-valuemax',
	'aria-valuenow',
];

// Semantic elements that should always be shown
const SEMANTIC_ELEMENTS = new Set([
	'html', 'body',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'a', 'button', 'input', 'textarea', 'select', 'form', 'label',
	'nav', 'header', 'footer', 'main', 'article', 'section',
	'table', 'thead', 'tbody', 'tr', 'th', 'td',
	'ul', 'ol', 'li',
	'img', 'iframe', 'video', 'audio',
]);

// Container elements that can be collapsed if they only wrap one child
const CONTAINER_TAGS = new Set([
	'html', 'body', 'div', 'main', 'section', 'article', 'aside', 'header', 'footer', 'nav',
]);

/**
 * Ultra-concise DOM serializer for quick LLM query writing.
 */
export class DOMEvalSerializer {
	/**
	 * Serialize complete DOM tree structure for LLM understanding.
	 *
	 * Strategy:
	 * - Show ALL elements to preserve DOM structure
	 * - Non-interactive elements show just tag name
	 * - Interactive elements show full attributes + [index]
	 * - Self-closing tags only (no closing tags)
	 */
	static serializeTree(
		node: SimplifiedNode | null,
		includeAttributes: string[],
		depth: number = 0
	): string {
		if (!node) return '';

		// Skip excluded nodes but process children
		if (node.excludedByParent) {
			return DOMEvalSerializer._serializeChildren(node, includeAttributes, depth);
		}

		// Skip nodes marked as should_display=False
		if (!node.shouldDisplay) {
			return DOMEvalSerializer._serializeChildren(node, includeAttributes, depth);
		}

		const formattedText: string[] = [];
		const depthStr = '\t'.repeat(depth);

		if (node.originalNode.nodeType === NodeType.ELEMENT_NODE) {
			const tag = node.originalNode.nodeName.toLowerCase();
			const isVisible = node.originalNode.snapshotNode && node.originalNode.isVisible;

			// Skip invisible elements UNLESS they're containers or iframes
			if (!isVisible && !CONTAINER_TAGS.has(tag) && !['iframe', 'frame'].includes(tag)) {
				return DOMEvalSerializer._serializeChildren(node, includeAttributes, depth);
			}

			// Special handling for iframes
			if (['iframe', 'frame'].includes(tag)) {
				return DOMEvalSerializer._serializeIframe(node, includeAttributes, depth);
			}

			// Skip SVG elements entirely
			if (tag === 'svg') {
				let line = depthStr;
				if (node.isInteractive) {
					// Model-visible selector index (falls back to the backend node id)
					line += `[${node.selectorIndex ?? node.originalNode.backendNodeId}] `;
				}
				line += '<svg';
				const attributesStr = DOMEvalSerializer._buildCompactAttributes(node.originalNode);
				if (attributesStr) {
					line += ` ${attributesStr}`;
				}
				line += ' /> <!-- SVG content collapsed -->';
				return line;
			}

			// Skip SVG child elements entirely
			if (SVG_ELEMENTS.has(tag)) {
				return '';
			}

			// Build compact attributes string
			const attributesStr = DOMEvalSerializer._buildCompactAttributes(node.originalNode);

			// Build compact element representation
			let line = depthStr;
			// Add model-visible selector notation - [X] for interactive elements only (matches Python)
			if (node.isInteractive) {
				line += `[${node.selectorIndex ?? node.originalNode.backendNodeId}] `;
			}
			line += `<${tag}`;

			if (attributesStr) {
				line += ` ${attributesStr}`;
			}

			// Add scroll info if element is scrollable
			if (node.originalNode.isScrollable) {
				line += ' scroll="yes"';
			}

			// Add inline text if present
			const inlineText = DOMEvalSerializer._getInlineText(node);
			const isContainer = CONTAINER_TAGS.has(tag);

			if (inlineText && !isContainer) {
				line += `>${inlineText}`;
			} else {
				line += ' />';
			}

			formattedText.push(line);

			// Process children (always for containers, only if no inline_text for others)
			const hasChildren = node.children.length > 0;
			if (hasChildren && (isContainer || !inlineText)) {
				const childrenText = DOMEvalSerializer._serializeChildren(node, includeAttributes, depth + 1);
				if (childrenText) {
					formattedText.push(childrenText);
				}
			}
		} else if (node.originalNode.nodeType === NodeType.TEXT_NODE) {
			// Text nodes are handled inline with their parent
		} else if (node.originalNode.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
			// Shadow DOM - just show children directly with minimal marker
			if (node.children.length > 0) {
				formattedText.push(`${depthStr}#shadow`);
				const childrenText = DOMEvalSerializer._serializeChildren(node, includeAttributes, depth + 1);
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

		// Check if parent is a list container
		const isListContainer = node.originalNode.nodeType === NodeType.ELEMENT_NODE &&
			['ul', 'ol'].includes(node.originalNode.nodeName.toLowerCase());

		// Track list items and consecutive links
		let liCount = 0;
		const maxListItems = 50;
		let consecutiveLinkCount = 0;
		const maxConsecutiveLinks = 50;
		let totalLinksSkipped = 0;

		for (const child of node.children) {
			// Get tag name for this child
			let currentTag: string | null = null;
			if (child.originalNode.nodeType === NodeType.ELEMENT_NODE) {
				currentTag = child.originalNode.nodeName.toLowerCase();
			}

			// If we're in a list container and this child is an li element
			if (isListContainer && currentTag === 'li') {
				liCount++;
				if (liCount > maxListItems) {
					continue;
				}
			}

			// Track consecutive anchor tags (links)
			if (currentTag === 'a') {
				consecutiveLinkCount++;
				if (consecutiveLinkCount > maxConsecutiveLinks) {
					totalLinksSkipped++;
					continue;
				}
			} else {
				// Reset counter when we hit a non-link element
				if (totalLinksSkipped > 0) {
					const depthStr = '\t'.repeat(depth);
					childrenOutput.push(`${depthStr}... (${totalLinksSkipped} more links in this list)`);
					totalLinksSkipped = 0;
				}
				consecutiveLinkCount = 0;
			}

			const childText = DOMEvalSerializer.serializeTree(child, includeAttributes, depth);
			if (childText) {
				childrenOutput.push(childText);
			}
		}

		// Add truncation message if we skipped items at the end
		if (isListContainer && liCount > maxListItems) {
			const depthStr = '\t'.repeat(depth);
			childrenOutput.push(
				`${depthStr}... (${liCount - maxListItems} more items in this list (truncated) use evaluate to get more.`
			);
		}

		// Add truncation message for links if we skipped any at the end
		if (totalLinksSkipped > 0) {
			const depthStr = '\t'.repeat(depth);
			childrenOutput.push(
				`${depthStr}... (${totalLinksSkipped} more links in this list) (truncated) use evaluate to get more.`
			);
		}

		return childrenOutput.join('\n');
	}

	private static _buildCompactAttributes(node: EnhancedDOMTreeNode): string {
		const attrs: string[] = [];

		if (node.attributes) {
			for (const attr of EVAL_KEY_ATTRIBUTES) {
				if (node.attributes[attr]) {
					let value = String(node.attributes[attr]).trim();
					if (!value) continue;

					// Special handling for different attributes
					if (attr === 'class') {
						// For class, limit to first 3 classes to save space
						const classes = value.split(/\s+/).slice(0, 3);
						value = classes.join(' ');
					} else if (attr === 'href') {
						// For href, cap at 80 chars
						value = capTextLength(value, 80);
					} else {
						// Cap at 80 chars for other attributes
						value = capTextLength(value, 80);
					}

					attrs.push(`${attr}="${value}"`);
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
		return capTextLength(combined, 80);
	}

	private static _serializeIframe(
		node: SimplifiedNode,
		includeAttributes: string[],
		depth: number
	): string {
		const formattedText: string[] = [];
		const depthStr = '\t'.repeat(depth);
		const tag = node.originalNode.nodeName.toLowerCase();

		// Build minimal iframe marker with key attributes
		const attributesStr = DOMEvalSerializer._buildCompactAttributes(node.originalNode);
		let line = `${depthStr}<${tag}`;
		if (attributesStr) {
			line += ` ${attributesStr}`;
		}

		// Add scroll info for iframe content
		if (node.originalNode.isScrollable) {
			line += ' scroll="yes"';
		}

		line += ' />';
		formattedText.push(line);

		// If iframe has content document, serialize its content
		if (node.originalNode.contentDocument) {
			formattedText.push(`${depthStr}\t#iframe-content`);

			// Process content document children
			for (const childNode of node.originalNode.contentDocument.childrenNodes || []) {
				if (childNode.nodeName.toLowerCase() === 'html') {
					for (const htmlChild of childNode.childrenNodes || []) {
						if (htmlChild.nodeName.toLowerCase() === 'body') {
							for (const bodyChild of htmlChild.childrenNodes || []) {
								DOMEvalSerializer._serializeDocumentNode(
									bodyChild,
									formattedText,
									includeAttributes,
									depth + 2,
									true
								);
							}
							break;
						}
					}
				} else {
					DOMEvalSerializer._serializeDocumentNode(
						childNode,
						formattedText,
						includeAttributes,
						depth + 1,
						true
					);
				}
			}
		}

		return formattedText.join('\n');
	}

	private static _serializeDocumentNode(
		domNode: EnhancedDOMTreeNode,
		output: string[],
		includeAttributes: string[],
		depth: number,
		isIframeContent: boolean = true
	): void {
		const depthStr = '\t'.repeat(depth);

		if (domNode.nodeType === NodeType.ELEMENT_NODE) {
			const tag = domNode.nodeName.toLowerCase();

			// For iframe content, be permissive
			let isVisible: boolean;
			if (isIframeContent) {
				isVisible = !domNode.snapshotNode || !!domNode.isVisible;
			} else {
				isVisible = !!domNode.snapshotNode && !!domNode.isVisible;
			}

			if (!isVisible) {
				return;
			}

			// Check if semantic or has useful attributes
			const isSemantic = SEMANTIC_ELEMENTS.has(tag);
			const attributesStr = DOMEvalSerializer._buildCompactAttributes(domNode);

			if (!isSemantic && !attributesStr) {
				// Skip but process children
				for (const child of domNode.childrenNodes || []) {
					DOMEvalSerializer._serializeDocumentNode(
						child,
						output,
						includeAttributes,
						depth,
						isIframeContent
					);
				}
				return;
			}

			// Build element line
			let line = `${depthStr}<${tag}`;
			if (attributesStr) {
				line += ` ${attributesStr}`;
			}

			// Get direct text content
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
				line += `>${capTextLength(combined, 100)}`;
			} else {
				line += ' />';
			}

			output.push(line);

			// Process non-text children
			for (const child of domNode.childrenNodes || []) {
				if (child.nodeType !== NodeType.TEXT_NODE) {
					DOMEvalSerializer._serializeDocumentNode(
						child,
						output,
						includeAttributes,
						depth + 1,
						isIframeContent
					);
				}
			}
		}
	}
}

// Legacy alias
export class EvalSerializer {
	serialize(domTree: SimplifiedNode): string {
		return DOMEvalSerializer.serializeTree(domTree, EVAL_KEY_ATTRIBUTES);
	}
}

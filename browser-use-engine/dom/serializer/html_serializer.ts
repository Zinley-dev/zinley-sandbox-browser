/**
 * Serializes enhanced DOM trees to HTML format including shadow roots
 * Port from browser_use/dom/serializer/html_serializer.py
 */

import { EnhancedDOMTreeNode, NodeType } from '../views.js';

/**
 * Serializes enhanced DOM trees back to HTML format.
 *
 * This serializer reconstructs HTML from the enhanced DOM tree, including:
 * - Shadow DOM content (both open and closed)
 * - Iframe content documents
 * - All attributes and text nodes
 * - Proper HTML structure
 *
 * Unlike getOuterHTML which only captures light DOM, this captures the full
 * enhanced tree including shadow roots that are crucial for modern SPAs.
 */
export class HTMLSerializer {
	private extractLinks: boolean;

	/**
	 * Initialize the HTML serializer.
	 *
	 * @param extractLinks If true, preserves all links. If false, removes href attributes.
	 */
	constructor(extractLinks: boolean = false) {
		this.extractLinks = extractLinks;
	}

	/**
	 * Serialize an enhanced DOM tree node to HTML.
	 *
	 * @param node The enhanced DOM tree node to serialize
	 * @param depth Current depth for indentation (internal use)
	 * @returns HTML string representation of the node and its descendants
	 */
	serialize(node: EnhancedDOMTreeNode, depth: number = 0): string {
		if (node.nodeType === NodeType.DOCUMENT_NODE) {
			// Process document root - serialize all children
			const parts: string[] = [];
			for (const child of this._getChildrenAndShadowRoots(node)) {
				const childHtml = this.serialize(child, depth);
				if (childHtml) {
					parts.push(childHtml);
				}
			}
			return parts.join('');
		} else if (node.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
			// Shadow DOM root - wrap in template with shadowrootmode attribute
			const parts: string[] = [];

			// Add shadow root opening
			const shadowType = node.shadowRootType || 'open';
			parts.push(`<template shadowroot="${shadowType.toLowerCase()}">`);

			// Serialize shadow children
			for (const child of node.childrenNodes || []) {
				const childHtml = this.serialize(child, depth + 1);
				if (childHtml) {
					parts.push(childHtml);
				}
			}

			// Close shadow root
			parts.push('</template>');

			return parts.join('');
		} else if (node.nodeType === NodeType.ELEMENT_NODE) {
			const parts: string[] = [];
			const tagName = node.nodeName.toLowerCase();

			// Skip non-content elements
			if (['style', 'script', 'head', 'meta', 'link', 'title'].includes(tagName)) {
				return '';
			}

			// Skip code tags with display:none - these often contain JSON state for SPAs
			if (tagName === 'code' && node.attributes) {
				const style = node.attributes['style'] || '';
				// Check if element is hidden (display:none) - likely JSON data
				if (style.replace(/\s/g, '').includes('display:none')) {
					return '';
				}
				// Also check for bpr-guid IDs (LinkedIn's JSON data pattern)
				const elementId = node.attributes['id'] || '';
				if (
					elementId.includes('bpr-guid') ||
					elementId.includes('data') ||
					elementId.includes('state')
				) {
					return '';
				}
			}

			// Skip base64 inline images - these are usually placeholders or tracking pixels
			if (tagName === 'img' && node.attributes) {
				const src = node.attributes['src'] || '';
				if (src.startsWith('data:image/')) {
					return '';
				}
			}

			// Opening tag
			parts.push(`<${tagName}`);

			// Add attributes
			if (node.attributes) {
				const attrs = this._serializeAttributes(node.attributes);
				if (attrs) {
					parts.push(' ' + attrs);
				}
			}

			// Handle void elements (self-closing)
			const voidElements = new Set([
				'area',
				'base',
				'br',
				'col',
				'embed',
				'hr',
				'img',
				'input',
				'link',
				'meta',
				'param',
				'source',
				'track',
				'wbr',
			]);

			if (voidElements.has(tagName)) {
				parts.push(' />');
				return parts.join('');
			}

			parts.push('>');

			// Handle table normalization (ensure thead/tbody so markdown conversion renders headers)
			if (tagName === 'table') {
				// Serialize shadow roots first (same as the general path)
				if (node.shadowRoots && node.shadowRoots.length > 0) {
					for (const shadowRoot of node.shadowRoots) {
						const childHtml = this.serialize(shadowRoot, depth + 1);
						if (childHtml) {
							parts.push(childHtml);
						}
					}
				}
				parts.push(this._serializeTableChildren(node, depth));
			}
			// Handle iframe content document
			else if (['iframe', 'frame'].includes(tagName) && node.contentDocument) {
				// Serialize iframe content
				for (const child of node.contentDocument.childrenNodes || []) {
					const childHtml = this.serialize(child, depth + 1);
					if (childHtml) {
						parts.push(childHtml);
					}
				}
			} else {
				// Serialize shadow roots FIRST (for declarative shadow DOM)
				if (node.shadowRoots && node.shadowRoots.length > 0) {
					for (const shadowRoot of node.shadowRoots) {
						const childHtml = this.serialize(shadowRoot, depth + 1);
						if (childHtml) {
							parts.push(childHtml);
						}
					}
				}

				// Then serialize light DOM children (for slot projection)
				for (const child of node.childrenNodes || []) {
					const childHtml = this.serialize(child, depth + 1);
					if (childHtml) {
						parts.push(childHtml);
					}
				}
			}

			// Closing tag
			parts.push(`</${tagName}>`);

			return parts.join('');
		} else if (node.nodeType === NodeType.TEXT_NODE) {
			// Return text content with basic HTML escaping
			if (node.nodeValue) {
				return this._escapeHtml(node.nodeValue);
			}
			return '';
		} else if (node.nodeType === NodeType.COMMENT_NODE) {
			// Skip comments to reduce noise
			return '';
		} else {
			// Unknown node type - skip
			return '';
		}
	}

	/**
	 * Get children and shadow roots combined
	 */
	/**
	 * Normalize table structure to ensure thead/tbody for markdown conversion.
	 *
	 * When a <table> has no <thead> but the first <tr> contains <th> cells, wrap that row in
	 * <thead> and the remaining rows in <tbody>.
	 */
	private _serializeTableChildren(tableNode: EnhancedDOMTreeNode, depth: number): string {
		const children = tableNode.childrenNodes || [];
		if (children.length === 0) {
			return '';
		}

		const serializeAll = (nodes: EnhancedDOMTreeNode[], childDepth: number): string => {
			const parts: string[] = [];
			for (const child of nodes) {
				const childHtml = this.serialize(child, childDepth);
				if (childHtml) {
					parts.push(childHtml);
				}
			}
			return parts.join('');
		};

		const elementChildren = children.filter((c) => c.nodeType === NodeType.ELEMENT_NODE);
		const childTags = elementChildren.map((c) => c.nodeName.toLowerCase());
		const hasThead = childTags.includes('thead');
		const hasTbody = childTags.includes('tbody');

		if (hasThead || childTags.length === 0) {
			// Already normalized or empty — serialize normally
			return serializeAll(children, depth + 1);
		}

		// Find the first <tr>; it is a header row only if it contains <th> cells
		let firstTr: EnhancedDOMTreeNode | null = null;
		let firstTrIdx = -1;
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (child.nodeType === NodeType.ELEMENT_NODE && child.nodeName.toLowerCase() === 'tr') {
				const hasTh = (child.childrenNodes || []).some(
					(c) => c.nodeType === NodeType.ELEMENT_NODE && c.nodeName.toLowerCase() === 'th'
				);
				if (hasTh) {
					firstTr = child;
					firstTrIdx = i;
				}
				break; // Only check the first <tr>
			}
		}

		if (firstTr === null) {
			// No header row detected — serialize normally
			return serializeAll(children, depth + 1);
		}

		// Wrap firstTr in <thead>, remaining <tr> in <tbody>
		const parts: string[] = [];

		// Emit any children before the header row (e.g. colgroup, caption)
		parts.push(serializeAll(children.slice(0, firstTrIdx), depth + 1));

		parts.push('<thead>');
		parts.push(this.serialize(firstTr, depth + 2));
		parts.push('</thead>');

		const remaining = children.slice(firstTrIdx + 1);
		if (remaining.length > 0 && !hasTbody) {
			parts.push('<tbody>');
			parts.push(serializeAll(remaining, depth + 2));
			parts.push('</tbody>');
		} else {
			parts.push(serializeAll(remaining, depth + 1));
		}

		return parts.join('');
	}

	private _getChildrenAndShadowRoots(node: EnhancedDOMTreeNode): EnhancedDOMTreeNode[] {
		const result: EnhancedDOMTreeNode[] = [];

		if (node.childrenNodes) {
			result.push(...node.childrenNodes);
		}
		if (node.shadowRoots) {
			result.push(...node.shadowRoots);
		}

		return result;
	}

	/**
	 * Serialize element attributes to HTML attribute string.
	 *
	 * @param attributes Dictionary of attribute names to values
	 * @returns HTML attribute string (e.g., 'class="foo" id="bar"')
	 */
	private _serializeAttributes(attributes: Record<string, string>): string {
		const parts: string[] = [];

		for (const [key, value] of Object.entries(attributes)) {
			// Skip href if not extracting links
			if (!this.extractLinks && key === 'href') {
				continue;
			}

			// Skip data-* attributes as they often contain JSON payloads
			// These are used by modern SPAs (React, Vue, Angular) for state management
			if (key.startsWith('data-')) {
				continue;
			}

			// Handle boolean attributes
			if (value === '' || value === null || value === undefined) {
				parts.push(key);
			} else {
				// Escape attribute value
				const escapedValue = this._escapeAttribute(value);
				parts.push(`${key}="${escapedValue}"`);
			}
		}

		return parts.join(' ');
	}

	/**
	 * Escape HTML special characters in text content.
	 *
	 * @param text Raw text content
	 * @returns HTML-escaped text
	 */
	private _escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	/**
	 * Escape HTML special characters in attribute values.
	 *
	 * @param value Raw attribute value
	 * @returns HTML-escaped attribute value
	 */
	private _escapeAttribute(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#x27;');
	}
}

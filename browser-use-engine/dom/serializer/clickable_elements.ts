/**
 * Clickable elements detection
 * Port from browser_use/dom/serializer/clickable_elements.py - EXACT MATCH
 */

import { NodeType, getChildrenAndShadowRoots } from '../views.js';
import type { EnhancedDOMTreeNode } from '../views.js';

// Search indicators for detecting search-related elements
const SEARCH_INDICATORS = new Set([
	'search',
	'magnify',
	'glass',
	'lookup',
	'find',
	'query',
	'search-icon',
	'search-btn',
	'search-button',
	'searchbox',
]);

// Interactive tags - matches Python exactly (Note: 'label' removed per Python comment)
const INTERACTIVE_TAGS = new Set([
	'button',
	'input',
	'select',
	'textarea',
	'a',
	'details',
	'summary',
	'option',
	'optgroup',
]);

// Interactive ARIA roles (for attribute check)
const INTERACTIVE_ROLES = new Set([
	'button',
	'link',
	'menuitem',
	'option',
	'radio',
	'checkbox',
	'tab',
	'textbox',
	'combobox',
	'slider',
	'spinbutton',
	'search',
	'searchbox',
	'row',
	'cell',
	'gridcell',
]);

// Interactive accessibility tree roles
const INTERACTIVE_AX_ROLES = new Set([
	'button',
	'link',
	'menuitem',
	'option',
	'radio',
	'checkbox',
	'tab',
	'textbox',
	'combobox',
	'slider',
	'spinbutton',
	'listbox',
	'search',
	'searchbox',
	'row',
	'cell',
	'gridcell',
]);

// Form controls whose presence makes a wrapping <label>/<span> clickable
const FORM_CONTROL_TAGS = new Set(['input', 'select', 'textarea']);

/**
 * Detect nested form controls within limited depth (handles label/span wrappers such as
 * Ant Design radios and checkboxes). Port of `has_form_control_descendant`.
 */
export function hasFormControlDescendant(element: EnhancedDOMTreeNode, maxDepth: number = 2): boolean {
	if (maxDepth <= 0) {
		return false;
	}
	for (const child of getChildrenAndShadowRoots(element)) {
		if (child.nodeType !== NodeType.ELEMENT_NODE) {
			continue;
		}
		if (FORM_CONTROL_TAGS.has(child.nodeName?.toLowerCase() || '')) {
			return true;
		}
		if (hasFormControlDescendant(child, maxDepth - 1)) {
			return true;
		}
	}
	return false;
}

// Interactive attributes
const INTERACTIVE_ATTRIBUTES = new Set([
	'onclick',
	'onmousedown',
	'onmouseup',
	'onkeydown',
	'onkeyup',
	'tabindex',
]);

// Icon-related attributes for small elements
const ICON_ATTRIBUTES = new Set([
	'class',
	'role',
	'onclick',
	'data-action',
	'aria-label',
]);

/**
 * Check if this node is clickable/interactive using enhanced scoring.
 * Matches Python's ClickableElementDetector.is_interactive() exactly.
 *
 * @param node The enhanced DOM tree node to check
 * @returns true if the node is interactive
 */
export function isInteractive(node: EnhancedDOMTreeNode): boolean {
	if (!node) return false;

	// Skip non-element nodes
	if (node.nodeType !== NodeType.ELEMENT_NODE) {
		return false;
	}

	const tagName = node.nodeName?.toLowerCase() || '';

	// Remove html and body nodes
	if (tagName === 'html' || tagName === 'body') {
		return false;
	}

	// JavaScript click event listeners detected via CDP (without DOM mutation): handles
	// vue.js @click, react onClick, angular (click), etc.
	if (node.hasJsClickListener) {
		return true;
	}

	// IFRAME elements should be interactive if they're large enough to potentially need scrolling
	// Small iframes (< 100px width or height) are unlikely to have scrollable content
	if (tagName === 'iframe' || tagName === 'frame') {
		if (node.snapshotNode?.bounds) {
			const width = node.snapshotNode.bounds.width;
			const height = node.snapshotNode.bounds.height;
			// Only include iframes larger than 100x100px
			if (width > 100 && height > 100) {
				return true;
			}
		}
	}

	// Specialized handling for labels used as component wrappers (e.g., Ant Design radio/checkbox)
	if (tagName === 'label') {
		// Skip labels that proxy via "for" to avoid double-activating external inputs
		if (node.attributes?.for) {
			return false;
		}
		// Detect labels that wrap form controls up to two levels deep (label > span > input)
		if (hasFormControlDescendant(node, 2)) {
			return true;
		}
		// Fall through to pointer/role/attribute heuristics for other label cases
	}

	// Span wrappers for UI components (detect clear interactive signals only)
	if (tagName === 'span' && hasFormControlDescendant(node, 2)) {
		return true;
	}

	// SEARCH ELEMENT DETECTION: Check for search-related classes and attributes
	if (node.attributes) {
		// Check class names for search indicators
		const classList = (node.attributes.class || '').toLowerCase().split(/\s+/);
		const classString = classList.join(' ');
		for (const indicator of SEARCH_INDICATORS) {
			if (classString.includes(indicator)) {
				return true;
			}
		}

		// Check id for search indicators
		const elementId = (node.attributes.id || '').toLowerCase();
		for (const indicator of SEARCH_INDICATORS) {
			if (elementId.includes(indicator)) {
				return true;
			}
		}

		// Check data attributes for search functionality
		for (const [attrName, attrValue] of Object.entries(node.attributes)) {
			if (attrName.startsWith('data-') && typeof attrValue === 'string') {
				const valueLower = attrValue.toLowerCase();
				for (const indicator of SEARCH_INDICATORS) {
					if (valueLower.includes(indicator)) {
						return true;
					}
				}
			}
		}
	}

	// Enhanced accessibility property checks - direct clear indicators only
	if (node.axNode?.properties) {
		for (const prop of node.axNode.properties) {
			try {
				// aria disabled
				if (prop.name === 'disabled' && prop.value?.value === true) {
					return false;
				}

				// aria hidden
				if (prop.name === 'hidden' && prop.value?.value === true) {
					return false;
				}

				// Direct interactiveness indicators
				if (['focusable', 'editable', 'settable'].includes(prop.name) && prop.value?.value === true) {
					return true;
				}

				// Interactive state properties (presence indicates interactive widget)
				if (['checked', 'expanded', 'pressed', 'selected'].includes(prop.name)) {
					// These properties only exist on interactive elements
					return true;
				}

				// Form-related interactiveness
				if (['required', 'autocomplete'].includes(prop.name) && prop.value?.value) {
					return true;
				}

				// Elements with keyboard shortcuts are interactive
				if (prop.name === 'keyshortcuts' && prop.value?.value) {
					return true;
				}
			} catch {
				// Skip properties we can't process
				continue;
			}
		}
	}

	// ENHANCED TAG CHECK: Include truly interactive elements
	if (INTERACTIVE_TAGS.has(tagName)) {
		return true;
	}

	// Tertiary check: elements with interactive attributes
	if (node.attributes) {
		// Check for event handlers or interactive attributes
		for (const attr of INTERACTIVE_ATTRIBUTES) {
			if (attr in node.attributes) {
				return true;
			}
		}

		// Check for interactive ARIA roles
		if (node.attributes.role) {
			if (INTERACTIVE_ROLES.has(node.attributes.role.toLowerCase())) {
				return true;
			}
		}
	}

	// Quaternary check: accessibility tree roles
	if (node.axNode?.role) {
		if (INTERACTIVE_AX_ROLES.has(node.axNode.role.toLowerCase())) {
			return true;
		}
	}

	// ICON AND SMALL ELEMENT CHECK: Elements that might be icons
	if (node.snapshotNode?.bounds) {
		const width = node.snapshotNode.bounds.width;
		const height = node.snapshotNode.bounds.height;
		// Icon-sized elements: 10-50px
		if (width >= 10 && width <= 50 && height >= 10 && height <= 50) {
			// Check if this small element has interactive properties
			if (node.attributes) {
				for (const attr of ICON_ATTRIBUTES) {
					if (attr in node.attributes) {
						return true;
					}
				}
			}
		}
	}

	// Final fallback: cursor style indicates interactivity (for cases Chrome missed)
	if (node.snapshotNode?.cursorStyle === 'pointer') {
		return true;
	}

	return false;
}

/**
 * Legacy function for backwards compatibility.
 * @deprecated Use isInteractive instead
 */
export function isClickable(node: EnhancedDOMTreeNode): boolean {
	return isInteractive(node);
}

/**
 * Check if element is a form input
 */
export function isFormInput(node: EnhancedDOMTreeNode): boolean {
	const tag = node.nodeName?.toLowerCase() || '';
	return ['input', 'select', 'textarea'].includes(tag);
}

/**
 * Check if element is a button
 */
export function isButton(node: EnhancedDOMTreeNode): boolean {
	const tag = node.nodeName?.toLowerCase() || '';

	if (tag === 'button') return true;
	if (tag === 'input') {
		const type = node.attributes?.type?.toLowerCase() || '';
		return ['button', 'submit', 'reset'].includes(type);
	}
	if (node.attributes?.role?.toLowerCase() === 'button') return true;

	return false;
}

/**
 * Check if element is a link
 */
export function isLink(node: EnhancedDOMTreeNode): boolean {
	const tag = node.nodeName?.toLowerCase() || '';
	return tag === 'a' || node.attributes?.role?.toLowerCase() === 'link';
}

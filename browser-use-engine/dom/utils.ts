/**
 * DOM utility functions
 */

/**
 * Cap text length to prevent token overflow
 */
export function capTextLength(text: string, maxLength: number = 500): string {
	if (text.length <= maxLength) {
		return text;
	}
	return text.substring(0, maxLength) + '...';
}

/**
 * Normalize whitespace in text
 */
export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract visible text from HTML
 */
export function extractVisibleText(html: string): string {
	// Remove script and style tags
	let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
	text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

	// Remove HTML tags
	text = text.replace(/<[^>]+>/g, ' ');

	// Decode HTML entities
	text = text
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");

	// Normalize whitespace
	return normalizeWhitespace(text);
}

/**
 * Check if element is likely interactive based on tag name
 */
export function isLikelyInteractive(tagName: string): boolean {
	const interactiveTags = new Set([
		'a',
		'button',
		'input',
		'select',
		'textarea',
		'label',
		'details',
		'summary',
	]);

	return interactiveTags.has(tagName.toLowerCase());
}

/**
 * Check if element is a form control
 */
export function isFormControl(tagName: string): boolean {
	const formTags = new Set(['input', 'select', 'textarea', 'button']);
	return formTags.has(tagName.toLowerCase());
}

/**
 * Sanitize attribute value for display
 */
export function sanitizeAttributeValue(value: string, maxLength: number = 100): string {
	// Remove potentially dangerous content
	let sanitized = value.replace(/javascript:/gi, '');
	sanitized = sanitized.replace(/on\w+=/gi, '');

	return capTextLength(sanitized, maxLength);
}

/**
 * Get element description for logging
 */
export function getElementDescription(
	tagName: string,
	attributes: Record<string, string>
): string {
	const parts: string[] = [tagName];

	if (attributes.id) {
		parts.push(`#${attributes.id}`);
	}

	if (attributes.class) {
		const classes = attributes.class.split(' ').filter(Boolean);
		if (classes.length > 0) {
			parts.push(`.${classes.slice(0, 3).join('.')}`);
		}
	}

	if (attributes['aria-label']) {
		parts.push(`[aria-label="${capTextLength(attributes['aria-label'], 30)}"]`);
	}

	return parts.join('');
}

/**
 * Check if URL is a data URL
 */
export function isDataURL(url: string): boolean {
	return url.startsWith('data:');
}

/**
 * Check if URL is a blob URL
 */
export function isBlobURL(url: string): boolean {
	return url.startsWith('blob:');
}

/**
 * Check if URL is about:blank
 */
export function isAboutBlank(url: string): boolean {
	return url === 'about:blank' || url.startsWith('about:blank');
}

/**
 * Generate CSS selector for an element
 */
export function generateCssSelectorForElement(
	tagName: string,
	attributes: Record<string, string>
): string | null {
	const tag = tagName.toLowerCase().trim();
	if (!tag || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(tag)) {
		return null;
	}

	let cssSelector = tag;

	// Add ID if available (most specific)
	if (attributes.id && attributes.id.trim()) {
		const elementId = attributes.id.trim();
		// Validate ID contains only valid characters for # selector
		if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(elementId)) {
			return `#${elementId}`;
		} else {
			// For IDs with special characters, use attribute selector
			const escapedId = elementId.replace(/"/g, '\\"');
			return `${tag}[id="${escapedId}"]`;
		}
	}

	// Handle class attributes
	if (attributes.class) {
		const validClassNamePattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
		const classes = attributes.class.split(/\s+/);
		for (const className of classes) {
			if (className.trim() && validClassNamePattern.test(className)) {
				cssSelector += `.${className}`;
			}
		}
	}

	// Safe attributes for selection
	const SAFE_ATTRIBUTES = new Set([
		'id',
		'name',
		'type',
		'placeholder',
		'aria-label',
		'aria-labelledby',
		'aria-describedby',
		'role',
		'for',
		'autocomplete',
		'required',
		'readonly',
		'alt',
		'title',
		'src',
		'href',
		'target',
		'data-id',
		'data-qa',
		'data-cy',
		'data-testid',
	]);

	// Handle other attributes
	for (const [attribute, value] of Object.entries(attributes)) {
		if (attribute === 'class' || !attribute.trim()) {
			continue;
		}

		if (!SAFE_ATTRIBUTES.has(attribute)) {
			continue;
		}

		// Escape special characters in attribute names
		const safeAttribute = attribute.replace(/:/g, '\\:');

		// Handle different value cases
		if (value === '') {
			cssSelector += `[${safeAttribute}]`;
		} else if (/["'<>`\n\r\t]/.test(value)) {
			// Use contains for values with special characters
			let processedValue = value;
			if (processedValue.includes('\n')) {
				processedValue = processedValue.split('\n')[0];
			}
			// Collapse whitespace
			processedValue = processedValue.replace(/\s+/g, ' ').trim();
			// Escape quotes
			const safeValue = processedValue.replace(/"/g, '\\"');
			cssSelector += `[${safeAttribute}*="${safeValue}"]`;
		} else {
			cssSelector += `[${safeAttribute}="${value}"]`;
		}
	}

	// Final validation
	if (cssSelector && !/[\n\r\t]/.test(cssSelector)) {
		return cssSelector;
	}

	// Fallback to tag name
	return tag;
}

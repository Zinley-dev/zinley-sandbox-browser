/**
 * Detect reusable variables (emails, names, dates, ...) in agent history.
 * Port of browser_use/agent/variable_detector.py (Python browser-use 0.13.10).
 */

// ============================================================================
// Types
// ============================================================================

/** A detected variable in agent history. */
export interface DetectedVariable {
	name: string;
	originalValue: string;
	type: string;
	format: string | null;
}

/** Metadata about detected variables in history. */
export interface VariableMetadata {
	detectedVariables: Record<string, DetectedVariable>;
}

/** Minimal element shape needed for attribute-based detection. */
export interface ElementLike {
	attributes?: Record<string, string> | null;
}

/** Minimal history shape: steps with actions and the elements they interacted with. */
export interface HistoryLike {
	history: Array<{
		modelOutput?: { action?: Array<Record<string, any>> | null } | null;
		state?: { interactedElement?: Array<ElementLike | null> | null } | null;
	}>;
}

type Detection = [name: string, format: string | null];

const FIELDS_TO_CHECK = ['text', 'query'];

// ============================================================================
// Detection strategies
// ============================================================================

/**
 * Detect variable from element attributes.
 * Priority: `type` attribute (HTML5 input types), then id/name/placeholder/aria-label keywords.
 */
export function detectFromAttributes(attributes: Record<string, string>): Detection | null {
	const inputType = (attributes.type ?? '').toLowerCase();
	switch (inputType) {
		case 'email':
			return ['email', 'email'];
		case 'tel':
			return ['phone', 'phone'];
		case 'date':
			return ['date', 'date'];
		case 'number':
			return ['number', 'number'];
		case 'url':
			return ['url', 'url'];
		default:
			break;
	}

	const combined = [attributes.id ?? '', attributes.name ?? '', attributes.placeholder ?? '', attributes['aria-label'] ?? '']
		.join(' ')
		.toLowerCase();
	const has = (...keywords: string[]) => keywords.some((k) => combined.includes(k));

	if (has('address', 'street', 'addr')) {
		if (combined.includes('billing')) return ['billing_address', null];
		if (combined.includes('shipping')) return ['shipping_address', null];
		return ['address', null];
	}
	if (has('comment', 'note', 'message', 'description')) return ['comment', null];
	if (has('email', 'e-mail')) return ['email', 'email'];
	if (has('phone', 'tel', 'mobile', 'cell')) return ['phone', 'phone'];

	if (combined.includes('first') && combined.includes('name')) return ['first_name', null];
	if (combined.includes('last') && combined.includes('name')) return ['last_name', null];
	if (combined.includes('full') && combined.includes('name')) return ['full_name', null];
	if (combined.includes('name')) return ['name', null];

	if (has('date', 'dob', 'birth')) return ['date', 'date'];
	if (combined.includes('city')) return ['city', null];
	if (has('state', 'province')) return ['state', null];
	if (combined.includes('country')) return ['country', null];
	if (has('zip', 'postal', 'postcode')) return ['zip_code', 'postal_code'];
	if (has('company', 'organization')) return ['company', null];

	return null;
}

/**
 * Detect variable type from the value pattern (fallback without element context).
 */
export function detectFromValuePattern(value: string): Detection | null {
	// Email
	if (value.includes('@') && value.includes('.') && /^[\w.-]+@[\w.-]+\.\w+$/.test(value)) {
		return ['email', 'email'];
	}

	// Phone: digits with separators, 10+ digits
	if (/^[\d\s\-()+]+$/.test(value)) {
		const digitsOnly = value.replace(/[\s\-()+]/g, '');
		if (digitsOnly.length >= 10) {
			return ['phone', 'phone'];
		}
	}

	// Date YYYY-MM-DD
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return ['date', 'date'];
	}

	// Name: capitalized, letters/spaces/hyphens only, 2-30 chars
	const lettersOnly = value.replace(/[ -]/g, '');
	if (
		value &&
		/^\p{Lu}/u.test(value) &&
		lettersOnly.length > 0 &&
		/^\p{L}+$/u.test(lettersOnly) &&
		value.length >= 2 &&
		value.length <= 30
	) {
		const words = value.split(/\s+/).filter(Boolean);
		if (words.length === 1) return ['first_name', null];
		if (words.length === 2) return ['full_name', null];
		return ['name', null];
	}

	// Number: pure digits, not phone length
	if (/^\d{1,9}$/.test(value)) {
		return ['number', 'number'];
	}

	return null;
}

/**
 * Detect whether a value looks like a variable, preferring element attributes.
 */
export function detectVariableType(value: string, element?: ElementLike | null): Detection | null {
	if (element?.attributes) {
		const fromAttributes = detectFromAttributes(element.attributes);
		if (fromAttributes) {
			return fromAttributes;
		}
	}
	return detectFromValuePattern(value);
}

/** Ensure a variable name is unique by appending `_2`, `_3`, ... */
export function ensureUniqueName(baseName: string, existing: Record<string, DetectedVariable>): string {
	if (!(baseName in existing)) {
		return baseName;
	}
	let counter = 2;
	while (`${baseName}_${counter}` in existing) {
		counter++;
	}
	return `${baseName}_${counter}`;
}

function detectInAction(
	actionDict: Record<string, any>,
	element: ElementLike | null,
	detected: Record<string, DetectedVariable>,
	detectedValues: Set<string>
): void {
	for (const params of Object.values(actionDict)) {
		if (!params || typeof params !== 'object' || Array.isArray(params)) {
			continue;
		}
		for (const field of FIELDS_TO_CHECK) {
			const value = (params as Record<string, unknown>)[field];
			if (typeof value !== 'string' || !value.trim()) {
				continue;
			}
			if (detectedValues.has(value)) {
				continue;
			}
			const detection = detectVariableType(value, element);
			if (!detection) {
				continue;
			}
			const [baseName, format] = detection;
			const name = ensureUniqueName(baseName, detected);
			detected[name] = { name, originalValue: value, type: 'string', format };
			detectedValues.add(value);
		}
	}
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Analyze agent history and detect reusable variables.
 * Strategy 1: element attributes (id, name, type, placeholder, aria-label).
 * Strategy 2: value patterns (email, phone, date, name, number).
 */
export function detectVariablesInHistory(history: HistoryLike): Record<string, DetectedVariable> {
	const detected: Record<string, DetectedVariable> = {};
	const detectedValues = new Set<string>();

	for (const item of history.history) {
		const actions = item.modelOutput?.action;
		if (!actions) {
			continue;
		}
		actions.forEach((action, actionIdx) => {
			if (!action || typeof action !== 'object') {
				return;
			}
			const interacted = item.state?.interactedElement;
			const element = interacted && interacted.length > actionIdx ? interacted[actionIdx] : null;
			detectInAction(action, element ?? null, detected, detectedValues);
		});
	}

	return detected;
}

/**
 * Substitute detected variable values inside a history's actions (deep-copied).
 * Returns the modified copy and the number of substitutions made.
 */
export function substituteVariablesInHistory<T extends HistoryLike>(
	history: T,
	variables: Record<string, string>
): { history: T; substitutions: number; missing: string[] } {
	const detected = detectVariablesInHistory(history);
	const replacements: Record<string, string> = {};
	const missing: string[] = [];
	for (const [name, newValue] of Object.entries(variables)) {
		if (name in detected) {
			replacements[detected[name].originalValue] = newValue;
		} else {
			missing.push(name);
		}
	}
	if (Object.keys(replacements).length === 0) {
		return { history, substitutions: 0, missing };
	}

	const copy: T = JSON.parse(JSON.stringify(history));
	let substitutions = 0;
	const substitute = (data: Record<string, any>): void => {
		for (const [key, value] of Object.entries(data)) {
			if (typeof value === 'string') {
				if (value in replacements) {
					data[key] = replacements[value];
					substitutions++;
				}
			} else if (Array.isArray(value)) {
				value.forEach((item, i) => {
					if (typeof item === 'string' && item in replacements) {
						value[i] = replacements[item];
						substitutions++;
					} else if (item && typeof item === 'object') {
						substitute(item);
					}
				});
			} else if (value && typeof value === 'object') {
				substitute(value);
			}
		}
	};
	for (const item of copy.history) {
		for (const action of item.modelOutput?.action ?? []) {
			if (action && typeof action === 'object') {
				substitute(action);
			}
		}
	}
	return { history: copy, substitutions, missing };
}

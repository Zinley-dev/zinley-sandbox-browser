/**
 * Tool registry views and models
 * Port of browser_use/tools/registry/views.py (Python browser-use 0.13.10)
 */

import { z } from 'zod';
import { matchUrlWithDomainPattern } from '../../utils.js';
import type { BaseChatModel } from '../../llm/base.js';
import type { BrowserSession } from '../../browser/session.js';
import type { FileSystem } from '../../filesystem/file_system.js';

// ============================================================================
// Registered Action
// ============================================================================

export interface RegisteredAction {
	name: string;
	description: string;
	function: (...args: any[]) => any | Promise<any>;
	paramModel: z.ZodType<any>;

	/**
	 * If true, this action is known to change the page (e.g. navigate, search, go_back, switch).
	 * multi_act() aborts the remaining queued actions after executing a terminates_sequence action.
	 */
	terminatesSequence?: boolean;

	// filters: provide specific domains to determine whether the action should be available on the given URL or not
	domains?: string[] | null; // e.g. ['*.google.com', 'www.bing.com', 'yahoo.*']
}

/**
 * Get a description of the action for the prompt in unstructured format
 */
export function getPromptDescription(action: RegisteredAction): string {
	// For Zod schemas, we need to extract the shape
	// This is a simplified version - full implementation would parse Zod schema
	const schema = action.paramModel as any;
	const params: string[] = [];

	// Try to get shape from Zod schema
	if (schema._def && schema._def.shape) {
		const shape = schema._def.shape();
		for (const [paramName, paramSchema] of Object.entries(shape)) {
			const paramInfo = paramSchema as any;
			let paramDesc = paramName;

			// Add type information if available
			if (paramInfo._def && paramInfo._def.typeName) {
				const typeName = paramInfo._def.typeName.replace('Zod', '').toLowerCase();
				paramDesc += `=${typeName}`;
			}

			// Add description if available
			if (paramInfo._def && paramInfo._def.description) {
				paramDesc += ` (${paramInfo._def.description})`;
			}

			params.push(paramDesc);
		}
	}

	// Format: action_name: Description. (param1=type, param2=type, ...)
	if (params.length > 0) {
		return `${action.name}: ${action.description}. (${params.join(', ')})`;
	} else {
		return `${action.name}: ${action.description}`;
	}
}

// ============================================================================
// Action Model
// ============================================================================

export interface ActionModel {
	[actionName: string]: any; // Dynamic action parameters
}

/**
 * Get the index of the action
 */
export function getActionIndex(action: ActionModel): number | null {
	// Get all parameter objects
	const params = Object.values(action);
	if (params.length === 0) {
		return null;
	}

	for (const param of params) {
		if (param !== null && typeof param === 'object' && 'index' in param) {
			return param.index;
		}
	}

	return null;
}

/**
 * Set the index of the action
 */
export function setActionIndex(action: ActionModel, index: number): void {
	// Get the action name and params
	const actionName = Object.keys(action)[0];
	const actionParams = action[actionName];

	// Update the index directly on the params
	if (actionParams && typeof actionParams === 'object' && 'index' in actionParams) {
		actionParams.index = index;
	}
}

// ============================================================================
// Action Registry
// ============================================================================

export class ActionRegistry {
	actions: Map<string, RegisteredAction> = new Map();

	/**
	 * Match a list of domain glob patterns against a URL.
	 *
	 * Actions with no domain restriction are always available. A domain-restricted
	 * action must NOT be exposed when the URL is unknown/empty: returning true there
	 * failed open (a fresh about:blank target whose url is '' made every restricted
	 * action match), unlike the `pageUrl == null` path which correctly hides them.
	 */
	public static matchDomains(domains: string[] | null | undefined, url: string | null | undefined): boolean {
		if (domains === null || domains === undefined) {
			return true;
		}
		if (!url) {
			return false;
		}

		// Use the centralized URL matching logic from utils
		for (const domainPattern of domains) {
			if (matchUrlWithDomainPattern(url, domainPattern)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Get a description of all actions for the prompt
	 *
	 * Args:
	 *   pageUrl: If provided, filter actions by URL using domain filters.
	 *
	 * Returns:
	 *   A string description of available actions.
	 *   - If page is None: return only actions with no page_filter and no domains (for system prompt)
	 *   - If page is provided: return only filtered actions that match the current page (excluding unfiltered actions)
	 */
	getPromptDescription(pageUrl?: string | null): string {
		if (pageUrl === undefined || pageUrl === null) {
			// For system prompt (no URL provided), include only actions with no filters
			return Array.from(this.actions.values())
				.filter((action) => !action.domains)
				.map((action) => getPromptDescription(action))
				.join('\n');
		}

		// Only include filtered actions for the current page URL
		const filteredActions: RegisteredAction[] = [];

		for (const action of this.actions.values()) {
			if (!action.domains) {
				// Skip actions with no filters, they are already included in the system prompt
				continue;
			}

			// Check domain filter
			if (ActionRegistry.matchDomains(action.domains, pageUrl)) {
				filteredActions.push(action);
			}
		}

		return filteredActions.map((action) => getPromptDescription(action)).join('\n');
	}

	/**
	 * Register an action
	 */
	register(action: RegisteredAction): void {
		this.actions.set(action.name, action);
	}

	/**
	 * Get an action by name
	 */
	get(name: string): RegisteredAction | undefined {
		return this.actions.get(name);
	}

	/**
	 * Check if an action exists
	 */
	has(name: string): boolean {
		return this.actions.has(name);
	}

	/**
	 * Get all action names
	 */
	getActionNames(): string[] {
		return Array.from(this.actions.keys());
	}
}

// ============================================================================
// Special Action Parameters
// ============================================================================

export interface SpecialActionParameters {
	// Optional user-provided context object passed down from Agent(context=...)
	// e.g. can contain anything, external db connections, file handles, queues, runtime config objects, etc.
	// that you might want to be able to access quickly from within many of your actions
	// browser-use code doesn't use this at all, we just pass it down to your actions for convenience
	context?: any | null;

	// browser-use session object, can be used to create new tabs, navigate, access CDP
	browserSession?: BrowserSession | null;

	// Current page URL for filtering and context
	pageUrl?: string | null;

	// CDP client for direct Chrome DevTools Protocol access
	cdpClient?: any | null; // CDPClient type from cdp_use

	// Extra injected config if the action asks for these arg names
	pageExtractionLlm?: BaseChatModel | null;
	fileSystem?: FileSystem | null;
	availableFilePaths?: string[] | null;
	hasSensitiveData?: boolean;

	/** Agent-injected JSON schema for structured `extract` output */
	extractionSchema?: Record<string, any> | null;
}

/**
 * Get parameter names that require browser_session
 */
export function getBrowserRequiringParams(): Set<string> {
	return new Set(['browserSession', 'cdpClient', 'pageUrl']);
}

/**
 * Action registry for managing browser actions (live agent path).
 * Mirrors browser_use/tools/registry (Python browser-use 0.13.10):
 * domain filtering, sensitive-data placeholder replacement, exclusions,
 * `terminatesSequence` flags and a per-action wall-clock timeout.
 */

import { z } from 'zod';
import { BrowserSession } from '../browser/session.js';
import { ActionResult } from '../types/agent.js';
import { BaseChatModel } from '../llm/base.js';
import { FileSystem } from '../filesystem/file_system.js';
import { BrowserError } from '../browser/views.js';
import { replaceSensitiveData } from '../tools/registry/service.js';
import { ActionTimeoutError, coerceValidActionTimeout, withActionTimeout } from '../tools/utils.js';
import { matchUrlWithDomainPattern } from '../utils.js';

export type ActionFunction<T = any> = (params: T, context: ActionContext) => Promise<ActionResult>;

/**
 * Context passed to action functions during execution.
 * Matches Python's special parameter injection pattern.
 */
export interface ActionContext {
	/** The browser session for page interactions */
	browserSession: BrowserSession;

	/** Page ID for multi-agent support (each agent works on its own tab) */
	pageId?: string;

	/** LLM for page content extraction (defaults to main LLM) */
	pageExtractionLlm?: BaseChatModel;

	/** Main LLM for fallback (when pageExtractionLlm is not set) */
	llm?: BaseChatModel;

	/** File system for file operations */
	fileSystem?: FileSystem;

	/** Sensitive data for filtering (e.g., passwords) */
	sensitiveData?: Record<string, string | Record<string, string>> | null;

	/** Whether the action involves sensitive data */
	hasSensitiveData?: boolean;

	/** Available file paths for upload/processing */
	availableFilePaths?: string[];

	/** Agent-injected JSON schema for structured `extract` output */
	extractionSchema?: Record<string, any> | null;

	/** Allow additional properties for extensibility */
	[key: string]: any;
}

export interface RegisteredAction<T = any> {
	name: string;
	description: string;
	function: ActionFunction<T>;
	/** Zod schema; input type is loose so schemas with defaults/optionals are accepted */
	paramSchema: z.ZodType<T, z.ZodTypeDef, any>;
	domains?: string[] | null;
	/**
	 * If true, this action is known to change the page (navigate, search, go_back, switch, evaluate).
	 * The agent aborts the remaining queued actions of the step after running it.
	 */
	terminatesSequence?: boolean;
}

export interface ExecuteOptions {
	/**
	 * Per-action wall-clock cap in seconds. Prevents actions from hanging indefinitely
	 * when a CDP connection goes silent. Defaults to BROWSER_USE_ACTION_TIMEOUT_S or 180s.
	 */
	actionTimeoutS?: number | null;
}

/**
 * Registry for browser actions
 */
export class ActionRegistry {
	private actions: Map<string, RegisteredAction> = new Map();
	private excludeActions: string[];

	constructor(excludeActions?: string[] | null) {
		this.excludeActions = excludeActions ? [...excludeActions] : [];
	}

	/**
	 * Register an action (ignored when the name is excluded)
	 */
	register<T>(action: RegisteredAction<T>): void {
		if (this.excludeActions.includes(action.name)) {
			return;
		}
		this.actions.set(action.name, action);
	}

	/**
	 * Remove an action (if registered) and prevent it from being registered again.
	 * Used e.g. to drop `screenshot` when vision is disabled.
	 */
	excludeAction(actionName: string): void {
		if (!this.excludeActions.includes(actionName)) {
			this.excludeActions.push(actionName);
		}
		if (this.actions.delete(actionName)) {
			console.debug(`Excluded action "${actionName}" from registry`);
		}
	}

	/**
	 * Remove an action without adding it to the exclusion list (allows re-registration).
	 */
	unregister(actionName: string): boolean {
		return this.actions.delete(actionName);
	}

	getExcludedActions(): string[] {
		return [...this.excludeActions];
	}

	/**
	 * Get all registered actions
	 */
	getActions(): Map<string, RegisteredAction> {
		return this.actions;
	}

	/**
	 * Get an action by name
	 */
	getAction(name: string): RegisteredAction | undefined {
		return this.actions.get(name);
	}

	/**
	 * Whether the action is flagged as ending the current action sequence.
	 */
	terminatesSequence(actionName: string): boolean {
		return Boolean(this.actions.get(actionName)?.terminatesSequence);
	}

	/**
	 * Execute an action
	 */
	async execute(actionName: string, params: any, context: ActionContext, options?: ExecuteOptions): Promise<ActionResult> {
		const action = this.actions.get(actionName);

		if (!action) {
			throw new Error(`Action ${actionName} not found`);
		}

		// Validate params
		let validatedParams = action.paramSchema.parse(params);

		// Replace <secret>placeholder</secret> tags (and bare placeholder names) with real values
		if (context.sensitiveData && Object.keys(context.sensitiveData).length > 0) {
			let currentUrl: string | null = null;
			try {
				currentUrl = await context.browserSession.getCurrentPageUrl();
			} catch {
				currentUrl = null;
			}
			validatedParams = replaceSensitiveData(validatedParams, context.sensitiveData, currentUrl);
		}

		const executionContext: ActionContext = {
			...context,
			hasSensitiveData:
				actionName === 'input' && Boolean(context.sensitiveData && Object.keys(context.sensitiveData).length > 0),
		};

		const timeoutS = coerceValidActionTimeout(options?.actionTimeoutS);

		try {
			return await withActionTimeout(action.function(validatedParams, executionContext), timeoutS, actionName);
		} catch (error: any) {
			if (error instanceof ActionTimeoutError) {
				console.error(`⏱️ ${error.message}`);
				return { error: error.message };
			}
			// BrowserError carries structured memory for the LLM (e.g. dropdown options)
			if (error instanceof BrowserError && error.longTermMemory != null) {
				if (error.shortTermMemory != null) {
					return {
						extractedContent: error.shortTermMemory,
						error: error.longTermMemory,
						includeExtractedContentOnlyOnce: true,
					};
				}
				return { error: error.longTermMemory };
			}
			throw error;
		}
	}

	/**
	 * Get prompt description for all actions
	 */
	getPromptDescription(pageUrl?: string): string {
		const descriptions: string[] = [];

		for (const action of this.actions.values()) {
			if (pageUrl !== undefined) {
				// Page-specific prompt: only domain-filtered actions matching the URL
				if (!action.domains || !ActionRegistry.matchDomains(action.domains, pageUrl)) {
					continue;
				}
			} else if (action.domains) {
				// System prompt: skip filtered actions
				continue;
			}

			descriptions.push(this.formatActionDescription(action));
		}

		return descriptions.join('\n');
	}

	/**
	 * Format action description for prompt
	 */
	private formatActionDescription(action: RegisteredAction): string {
		// Get schema properties
		const schema = action.paramSchema as any;
		const params: string[] = [];

		if (schema._def && schema._def.shape) {
			const shape = schema._def.shape();
			for (const [key, value] of Object.entries(shape)) {
				const zodType = value as any;
				let paramDesc = key;

				// Add type info
				if (zodType._def.typeName) {
					paramDesc += `=${zodType._def.typeName.replace('Zod', '').toLowerCase()}`;
				}

				// Add description
				if (zodType._def.description) {
					paramDesc += ` (${zodType._def.description})`;
				}

				params.push(paramDesc);
			}
		}

		if (params.length > 0) {
			return `${action.name}: ${action.description}. (${params.join(', ')})`;
		}

		return `${action.name}: ${action.description}`;
	}

	/**
	 * Match domain patterns against a URL.
	 * Unrestricted actions always match; restricted actions never match an empty/unknown URL
	 * (fail closed — a fresh about:blank target must not expose every restricted action).
	 */
	static matchDomains(domains: string[] | null | undefined, url: string | null | undefined): boolean {
		if (domains === null || domains === undefined) {
			return true;
		}
		if (!url) {
			return false;
		}
		for (const pattern of domains) {
			if (matchUrlWithDomainPattern(url, pattern)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get JSON schema for all actions
	 */
	getActionsSchema(): Record<string, any> {
		const schema: Record<string, any> = {};

		for (const [name, action] of this.actions.entries()) {
			schema[name] = {
				description: action.description,
				parameters: action.paramSchema,
			};
		}

		return schema;
	}

	/**
	 * Create action model for LLM tool calling
	 * Returns a union of individual action schemas, like Python does
	 * Each action is an object with a single property (the action name)
	 */
	createActionModel(includeActions?: string[], pageUrl?: string): z.ZodType<any> {
		// Filter actions based on page_url
		const availableActions: RegisteredAction[] = [];

		for (const [name, action] of this.actions.entries()) {
			if (includeActions && !includeActions.includes(name)) {
				continue;
			}

			// If no page_url provided, only include actions with no filters
			if (pageUrl === undefined) {
				if (!action.domains) {
					availableActions.push(action);
				}
				continue;
			}

			// Check domain filter if present
			if (ActionRegistry.matchDomains(action.domains, pageUrl)) {
				availableActions.push(action);
			}
		}

		// Create individual action schemas - each action is its own object with a single property
		// This matches Python's approach: Union[ClickActionModel, InputActionModel, ...]
		// where each model has only one property (e.g., {click: {index: 5}})
		const individualActionSchemas: z.ZodType<any>[] = [];

		for (const action of availableActions) {
			const singleActionSchema = z
				.object({
					[action.name]: action.paramSchema,
				})
				.describe(action.description);
			individualActionSchemas.push(singleActionSchema);
		}

		// If no actions available, return empty object schema
		if (individualActionSchemas.length === 0) {
			return z.object({});
		}

		// If only one action, return it directly
		if (individualActionSchemas.length === 1) {
			return individualActionSchemas[0];
		}

		// Create union of all individual action schemas
		// This produces anyOf in JSON schema: [{click: {...}}, {input: {...}}, ...]
		return z.union(individualActionSchemas as [z.ZodType<any>, z.ZodType<any>, ...z.ZodType<any>[]]);
	}
}

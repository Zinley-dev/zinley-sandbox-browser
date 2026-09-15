/**
 * Service for registering and managing actions
 * Port of browser_use/tools/registry/service.py (Python browser-use 0.13.10)
 */

import { z } from 'zod';
import { BrowserSession } from '../../browser/session.js';
import { BrowserError } from '../../browser/views.js';
import { FileSystem } from '../../filesystem/file_system.js';
import { BaseChatModel } from '../../llm/base.js';
import { ActionRegistry, RegisteredAction, SpecialActionParameters } from './views.js';
import { isNewTabPage, matchUrlWithDomainPattern } from '../../utils.js';
import * as OTPAuth from 'otpauth';

export type { SpecialActionParameters } from './views.js';

export type SensitiveData = Record<string, string | Record<string, string>>;

const SECRET_TAG_PATTERN = /<secret>(.*?)<\/secret>/g;

/** Placeholders ending in this suffix hold a TOTP secret; the current code is substituted instead. */
export const TOTP_PLACEHOLDER_SUFFIX = 'bu_2fa_code';

// ============================================================================
// Sensitive data replacement (shared by both action registries)
// ============================================================================

function generateTotp(secret: string, placeholder: string): string {
	try {
		const totp = new OTPAuth.TOTP({ secret, digits: 6 });
		return totp.generate();
	} catch (error) {
		console.error(`Failed to generate TOTP for ${placeholder}:`, error);
		return secret;
	}
}

/**
 * Collect the secrets applicable to the current URL.
 * New format `{domain_pattern: {key: value}}` entries only apply when the URL matches;
 * legacy `{key: value}` entries always apply. Empty values are dropped.
 */
export function collectApplicableSecrets(
	sensitiveData: SensitiveData,
	currentUrl?: string | null
): Record<string, string> {
	const applicable: Record<string, string> = {};

	for (const [domainOrKey, content] of Object.entries(sensitiveData)) {
		if (content && typeof content === 'object') {
			if (currentUrl && !isNewTabPage(currentUrl) && matchUrlWithDomainPattern(currentUrl, domainOrKey)) {
				Object.assign(applicable, content);
			}
		} else if (typeof content === 'string') {
			applicable[domainOrKey] = content;
		}
	}

	return Object.fromEntries(Object.entries(applicable).filter(([, v]) => Boolean(v)));
}

export interface ReplaceSensitiveDataResult<T> {
	params: T;
	replacedPlaceholders: Set<string>;
	missingPlaceholders: Set<string>;
}

/**
 * Replace `<secret>name</secret>` tags — and bare placeholder names used as a whole
 * string value — with the real secret values. Placeholders ending in `bu_2fa_code`
 * are substituted with a freshly generated TOTP code.
 */
export function replaceSensitiveDataInParams<T>(
	params: T,
	sensitiveData: SensitiveData,
	currentUrl?: string | null
): ReplaceSensitiveDataResult<T> {
	const applicableSecrets = collectApplicableSecrets(sensitiveData, currentUrl);
	const replacedPlaceholders = new Set<string>();
	const missingPlaceholders = new Set<string>();

	const resolveValue = (placeholder: string): string => {
		const secret = applicableSecrets[placeholder];
		return placeholder.endsWith(TOTP_PLACEHOLDER_SUFFIX) ? generateTotp(secret, placeholder) : secret;
	};

	const recursivelyReplace = (value: any): any => {
		if (typeof value === 'string') {
			let result = value;

			// 1. Tagged secrets: <secret>label</secret>
			for (const match of value.matchAll(SECRET_TAG_PATTERN)) {
				const placeholder = match[1];
				if (placeholder in applicableSecrets) {
					result = result.split(`<secret>${placeholder}</secret>`).join(resolveValue(placeholder));
					replacedPlaceholders.add(placeholder);
				} else {
					// Keep the tag as is, but remember that it was missing
					missingPlaceholders.add(placeholder);
				}
			}

			// 2. Literal secrets: the whole value equals a placeholder name (LLM forgot the tags)
			if (result in applicableSecrets) {
				const placeholder = result;
				result = resolveValue(placeholder);
				replacedPlaceholders.add(placeholder);
			}

			return result;
		}
		if (Array.isArray(value)) {
			return value.map(recursivelyReplace);
		}
		if (value && typeof value === 'object') {
			const out: Record<string, any> = {};
			for (const [k, v] of Object.entries(value)) {
				out[k] = recursivelyReplace(v);
			}
			return out;
		}
		return value;
	};

	return {
		params: recursivelyReplace(params),
		replacedPlaceholders,
		missingPlaceholders,
	};
}

export function logSensitiveDataUsage(placeholdersUsed: Set<string>, currentUrl?: string | null): void {
	if (placeholdersUsed.size > 0) {
		const urlInfo = currentUrl && !isNewTabPage(currentUrl) ? ` on ${currentUrl}` : '';
		console.info(`🔒 Using sensitive data placeholders: ${Array.from(placeholdersUsed).sort().join(', ')}${urlInfo}`);
	}
}

/** Convenience wrapper: replace and log, returning only the processed params. */
export function replaceSensitiveData<T>(params: T, sensitiveData: SensitiveData, currentUrl?: string | null): T {
	const { params: processed, replacedPlaceholders, missingPlaceholders } = replaceSensitiveDataInParams(
		params,
		sensitiveData,
		currentUrl
	);
	logSensitiveDataUsage(replacedPlaceholders, currentUrl);
	if (missingPlaceholders.size > 0) {
		console.warn(`Missing or empty keys in sensitive_data dictionary: ${Array.from(missingPlaceholders).join(', ')}`);
	}
	return processed;
}

// ============================================================================
// Registry
// ============================================================================

export interface RegistryExecuteOptions {
	browserSession?: BrowserSession;
	pageExtractionLlm?: BaseChatModel;
	fileSystem?: FileSystem;
	sensitiveData?: SensitiveData;
	availableFilePaths?: string[];
	extractionSchema?: Record<string, any> | null;
}

export class Registry<Context = any> {
	public registry: ActionRegistry;
	private excludeActions: string[];

	constructor(excludeActions?: string[] | null) {
		this.registry = new ActionRegistry();
		// Copy so callers cannot mutate our list through their reference
		this.excludeActions = excludeActions ? [...excludeActions] : [];
	}

	private getSpecialParamTypes(): Record<string, any> {
		return {
			context: null,
			browserSession: 'BrowserSession',
			pageUrl: 'String',
			cdpClient: null,
			pageExtractionLlm: 'BaseChatModel',
			availableFilePaths: 'Array',
			hasSensitiveData: 'Boolean',
			fileSystem: 'FileSystem',
			extractionSchema: null, // dict | null, skip type validation
		};
	}

	/**
	 * Register an action (ignored when the action name is excluded)
	 */
	register(action: RegisteredAction): void {
		if (this.excludeActions.includes(action.name)) {
			return;
		}
		this.registry.actions.set(action.name, action);
	}

	/**
	 * Exclude an action from the registry after initialization.
	 * Removes it if already registered and prevents re-registration.
	 */
	excludeAction(actionName: string): void {
		if (!this.excludeActions.includes(actionName)) {
			this.excludeActions.push(actionName);
		}
		if (this.registry.actions.has(actionName)) {
			this.registry.actions.delete(actionName);
			console.debug(`Excluded action "${actionName}" from registry`);
		}
	}

	getExcludedActions(): string[] {
		return [...this.excludeActions];
	}

	/**
	 * Execute a registered action with simplified parameter handling
	 */
	async executeAction(actionName: string, params: Record<string, any>, options?: RegistryExecuteOptions): Promise<any> {
		const action = this.registry.actions.get(actionName);
		if (!action) {
			throw new Error(`Action ${actionName} not found`);
		}

		try {
			// Validate parameters using Zod schema
			let validatedParams: any;
			try {
				validatedParams = action.paramModel.parse(params);
			} catch (error: any) {
				throw new Error(`Invalid parameters for action ${actionName}: ${error.message}`);
			}

			// Replace sensitive data if provided
			if (options?.sensitiveData) {
				const currentUrl = options.browserSession ? await this.getCurrentPageUrl(options.browserSession) : null;
				validatedParams = replaceSensitiveData(validatedParams, options.sensitiveData, currentUrl);
			}

			// Build special context
			const specialContext: SpecialActionParameters = {
				browserSession: options?.browserSession,
				pageExtractionLlm: options?.pageExtractionLlm,
				availableFilePaths: options?.availableFilePaths,
				hasSensitiveData: actionName === 'input' && Boolean(options?.sensitiveData),
				fileSystem: options?.fileSystem,
				extractionSchema: options?.extractionSchema ?? null,
			};

			// Add page URL if browser session is available
			if (options?.browserSession) {
				try {
					specialContext.pageUrl = await this.getCurrentPageUrl(options.browserSession);
				} catch {
					specialContext.pageUrl = undefined;
				}
			}

			// Call the action function
			return await action.function(validatedParams, specialContext);
		} catch (error: any) {
			// BrowserError can carry structured short/long-term memory for the LLM
			// (e.g. available dropdown options) — let the caller format it instead of
			// flattening it into a generic error string.
			if (error instanceof BrowserError && error.longTermMemory != null) {
				throw error;
			}
			const message = error?.message ?? String(error);
			if (message.includes('requires browserSession but none provided')) {
				throw new Error(message);
			}
			throw new Error(`Error executing action ${actionName}: ${message}`);
		}
	}

	private async getCurrentPageUrl(browserSession: BrowserSession): Promise<string | undefined> {
		try {
			return await browserSession.getCurrentPageUrl();
		} catch {
			return undefined;
		}
	}

	/**
	 * Create action model for LLM tool calling
	 * Returns a union of individual action schemas, like Python does
	 * Each action is an object with a single property (the action name)
	 */
	createActionModel(includeActions?: string[], pageUrl?: string): z.ZodType<any> {
		// Filter actions based on page_url
		const availableActions = new Map<string, RegisteredAction>();

		for (const [name, action] of this.registry.actions.entries()) {
			if (includeActions && !includeActions.includes(name)) {
				continue;
			}

			// If no page_url provided, only include actions with no filters
			if (pageUrl === undefined || pageUrl === null) {
				if (!action.domains) {
					availableActions.set(name, action);
				}
				continue;
			}

			// Check domain filter if present
			if (ActionRegistry.matchDomains(action.domains, pageUrl)) {
				availableActions.set(name, action);
			}
		}

		// Create individual action schemas - each action is its own object with a single property
		// This matches Python's approach: Union[ClickActionModel, InputActionModel, ...]
		// where each model has only one property (e.g., {click: {index: 5}})
		const individualActionSchemas: z.ZodType<any>[] = [];

		for (const [name, action] of availableActions.entries()) {
			const singleActionSchema = z
				.object({
					[name]: action.paramModel,
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

	/**
	 * Get prompt description of all actions
	 */
	getPromptDescription(pageUrl?: string | null): string {
		return this.registry.getPromptDescription(pageUrl);
	}
}

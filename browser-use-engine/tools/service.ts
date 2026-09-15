/**
 * Tools service — Python-parity façade over the action registry.
 * Port of browser_use/tools/service.py (Python browser-use 0.13.10).
 *
 * The built-in actions themselves live in `actions/builtin.ts` (shared with the
 * live Agent). This class mirrors the Python `Tools` API on top of them:
 * `act()`, `exclude_action()`, `set_coordinate_clicking()`,
 * `use_structured_output_action()`, plus a registry that custom integrations
 * (e.g. Gmail) can register additional actions into.
 */

import { z } from 'zod';
import type { ActionResult } from '../types/agent.js';
import { BrowserError } from '../browser/views.js';
import type { BrowserSession } from '../browser/session.js';
import type { BaseChatModel } from '../llm/base.js';
import type { FileSystem } from '../filesystem/file_system.js';
import { ActionRegistry as LiveActionRegistry, type ActionContext } from '../actions/registry.js';
import { registerBuiltinActions, setCoordinateClicking, collectDoneAttachments } from '../actions/builtin.js';
import { ActionRegistry, type RegisteredAction, type SpecialActionParameters } from './registry/views.js';
import { replaceSensitiveData, type SensitiveData } from './registry/service.js';
import { ACTION_DESCRIPTIONS, createStructuredOutputActionSchema } from './views.js';
import { coerceValidActionTimeout, withActionTimeout, ActionTimeoutError } from './utils.js';

// Re-export the parameter schemas for callers that imported them from here
export * from './views.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Turn a BrowserError carrying structured memory into an ActionResult;
 * re-throws when no long-term memory was provided (Python handle_browser_error).
 */
export function handleBrowserError(e: BrowserError): ActionResult {
	if (e.longTermMemory !== null && e.longTermMemory !== undefined) {
		if (e.shortTermMemory !== null && e.shortTermMemory !== undefined) {
			return {
				extractedContent: e.shortTermMemory,
				error: e.longTermMemory,
				includeExtractedContentOnlyOnce: true,
			};
		}
		return { error: e.longTermMemory };
	}

	console.warn(
		'⚠️ A BrowserError was raised without longTermMemory - always set longTermMemory when raising BrowserError to propagate right messages to LLM.'
	);
	throw e;
}

// ============================================================================
// Tools Class
// ============================================================================

export interface ToolsOptions<Context = any> {
	excludeActions?: string[] | null;
	/** Structured output model for `done` (zod schema for the `data` payload) */
	outputModel?: z.ZodTypeAny | null;
	displayFilesInDoneText?: boolean;
	/** Register `click` with coordinate support from the start */
	coordinateClicking?: boolean;
	/** Unused; kept for API parity with Python's generic Context */
	context?: Context;
}

export interface ActOptions {
	browserSession: BrowserSession;
	pageId?: string;
	pageExtractionLlm?: BaseChatModel | null;
	llm?: BaseChatModel | null;
	sensitiveData?: SensitiveData | null;
	availableFilePaths?: string[] | null;
	fileSystem?: FileSystem | null;
	/** JSON schema injected into `extract` for structured output */
	extractionSchema?: Record<string, any> | null;
	/** Per-action wall-clock cap in seconds (default BROWSER_USE_ACTION_TIMEOUT_S or 180) */
	actionTimeout?: number | null;
}

export class Tools<Context = any> {
	/** Registry of all actions (built-in + custom) — Python `tools.registry.registry` */
	registry: ActionRegistry;
	/** Live registry executing the built-in actions */
	readonly actions: LiveActionRegistry;
	displayFilesInDoneText: boolean;
	protected excludeActions: string[];
	private outputModel: z.ZodTypeAny | null;
	private coordinateClickingEnabled: boolean;

	constructor(options: ToolsOptions<Context> = {}) {
		this.displayFilesInDoneText = options.displayFilesInDoneText ?? true;
		this.excludeActions = options.excludeActions ? [...options.excludeActions] : [];
		this.outputModel = options.outputModel ?? null;
		this.coordinateClickingEnabled = options.coordinateClicking ?? false;

		this.actions = new LiveActionRegistry(this.excludeActions);
		registerBuiltinActions(this.actions, { coordinateClicking: this.coordinateClickingEnabled });

		this.registry = new ActionRegistry();
		this.syncRegistry();

		if (this.outputModel) {
			this.registerDoneAction(this.outputModel);
		}
	}

	/** Names mirrored from the live registry (so custom registrations are never dropped). */
	private builtinNames = new Set<string>();

	/** Mirror the live registry into the Python-style registry view. */
	private syncRegistry(): void {
		for (const name of this.builtinNames) {
			if (this.actions.getAction(name) === undefined) {
				this.registry.actions.delete(name);
				this.builtinNames.delete(name);
			}
		}
		for (const [name, action] of this.actions.getActions().entries()) {
			const mirrored: RegisteredAction = {
				name,
				description: action.description,
				function: action.function,
				paramModel: action.paramSchema,
				domains: action.domains ?? null,
				terminatesSequence: action.terminatesSequence,
			};
			this.registry.actions.set(name, mirrored);
			this.builtinNames.add(name);
		}
	}

	/** Helper to check if an action should be registered (not excluded) */
	protected shouldRegister(actionName: string): boolean {
		return !this.excludeActions.includes(actionName);
	}

	private registerDoneAction(outputModel: z.ZodTypeAny): void {
		const displayFiles = this.displayFilesInDoneText;
		const schema = createStructuredOutputActionSchema(outputModel);
		this.actions.unregister('done');
		this.actions.register({
			name: 'done',
			description: ACTION_DESCRIPTIONS.done_structured,
			paramSchema: schema,
			function: async (params: z.infer<typeof schema>, context: ActionContext): Promise<ActionResult> => {
				const attachments = displayFiles
					? collectDoneAttachments(params.files_to_display, context.fileSystem, context.browserSession?.downloadedFiles)
					: collectDoneAttachments(null, null, context.browserSession?.downloadedFiles);
				return {
					isDone: true,
					success: params.success ?? true,
					extractedContent: JSON.stringify(params.data),
					longTermMemory: `Task completed. Success Status: ${params.success ?? true}`,
					attachments,
				};
			},
		});
		this.syncRegistry();
	}

	/** Switch `done` to a structured output model (Python use_structured_output_action). */
	useStructuredOutputAction(outputModel: z.ZodTypeAny): void {
		this.outputModel = outputModel;
		this.registerDoneAction(outputModel);
	}

	/** Get the output model if structured output is configured. */
	getOutputModel(): z.ZodTypeAny | null {
		return this.outputModel;
	}

	/** Register a custom action (decorator equivalent). */
	action(
		description: string,
		options: {
			name: string;
			paramModel: z.ZodTypeAny;
			domains?: string[] | null;
			terminatesSequence?: boolean;
			function: (params: any, context: SpecialActionParameters) => Promise<ActionResult> | ActionResult;
		}
	): void {
		if (!this.shouldRegister(options.name)) {
			return;
		}
		this.registry.register({
			name: options.name,
			description,
			function: options.function,
			paramModel: options.paramModel,
			domains: options.domains ?? null,
			terminatesSequence: options.terminatesSequence ?? false,
		});
	}

	/**
	 * Exclude an action from the registry after initialization
	 * (e.g. drop `screenshot` when vision is disabled).
	 */
	excludeAction(actionName: string): void {
		if (!this.excludeActions.includes(actionName)) {
			this.excludeActions.push(actionName);
		}
		this.actions.excludeAction(actionName);
		this.registry.actions.delete(actionName);
	}

	/**
	 * Enable or disable coordinate-based clicking.
	 * When enabled, `click` accepts both index and coordinate parameters.
	 */
	setCoordinateClicking(enabled: boolean): void {
		if (enabled === this.coordinateClickingEnabled) {
			return;
		}
		this.coordinateClickingEnabled = enabled;
		if (this.shouldRegister('click')) {
			setCoordinateClicking(this.actions, enabled);
			this.syncRegistry();
		}
	}

	isCoordinateClickingEnabled(): boolean {
		return this.coordinateClickingEnabled;
	}

	/**
	 * Execute an action model (`{ action_name: params }`) — Python `Tools.act`.
	 */
	async act(action: Record<string, any>, options: ActOptions): Promise<ActionResult> {
		for (const [actionName, params] of Object.entries(action)) {
			if (params === null || params === undefined) {
				continue;
			}
			return this.executeAction(actionName, params, options);
		}
		return {};
	}

	/**
	 * Execute an action by name.
	 */
	async executeAction(actionName: string, params: any, options: ActOptions): Promise<ActionResult> {
		const timeoutS = coerceValidActionTimeout(options.actionTimeout);

		const context: ActionContext = {
			browserSession: options.browserSession,
			pageId: options.pageId,
			pageExtractionLlm: options.pageExtractionLlm ?? undefined,
			llm: options.llm ?? undefined,
			fileSystem: options.fileSystem ?? undefined,
			sensitiveData: options.sensitiveData ?? undefined,
			availableFilePaths: options.availableFilePaths ?? undefined,
			extractionSchema: options.extractionSchema ?? null,
		};

		try {
			// Built-in actions run through the live registry (validation, secrets, timeout)
			if (this.actions.getAction(actionName)) {
				return await this.actions.execute(actionName, params, context, { actionTimeoutS: timeoutS });
			}

			// Custom actions registered directly into `registry`
			const custom = this.registry.get(actionName);
			if (!custom) {
				return { error: `Unknown action: ${actionName}` };
			}

			let validatedParams = custom.paramModel.parse(params);
			if (options.sensitiveData && Object.keys(options.sensitiveData).length > 0) {
				let currentUrl: string | null = null;
				try {
					currentUrl = await options.browserSession.getCurrentPageUrl();
				} catch {
					currentUrl = null;
				}
				validatedParams = replaceSensitiveData(validatedParams, options.sensitiveData, currentUrl);
			}

			const special: SpecialActionParameters = {
				browserSession: options.browserSession,
				pageExtractionLlm: options.pageExtractionLlm ?? null,
				fileSystem: options.fileSystem ?? null,
				availableFilePaths: options.availableFilePaths ?? null,
				hasSensitiveData: actionName === 'input' && Boolean(options.sensitiveData),
				extractionSchema: options.extractionSchema ?? null,
			};

			const result = await withActionTimeout(Promise.resolve(custom.function(validatedParams, special)), timeoutS, actionName);
			return result ?? {};
		} catch (error: any) {
			if (error instanceof ActionTimeoutError) {
				return { error: error.message };
			}
			if (error instanceof BrowserError && error.longTermMemory != null) {
				return handleBrowserError(error);
			}
			console.error(`Error executing action ${actionName}:`, error);
			return { error: `Failed to execute ${actionName}: ${error?.message ?? String(error)}` };
		}
	}

	/** Prompt description of the available actions (delegates to the registry). */
	getPromptDescription(pageUrl?: string | null): string {
		return this.registry.getPromptDescription(pageUrl);
	}
}

// ============================================================================
// CodeAgentTools - Specialized tools for CodeAgent (code-based automation)
// ============================================================================

/**
 * Tools for the code agent: everything except LLM extraction and web search,
 * which the code agent replaces with `evaluate()` and direct navigation.
 */
export class CodeAgentTools<Context = any> extends Tools<Context> {
	static readonly DEFAULT_EXCLUSIONS = ['extract', 'search'];

	constructor(options: ToolsOptions<Context> = {}) {
		super({
			...options,
			excludeActions: [...CodeAgentTools.DEFAULT_EXCLUSIONS, ...(options.excludeActions || [])],
		});
	}
}

/**
 * AI Agent orchestration - main agent loop
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseChatModel } from '../llm/base.js';
import { BrowserSession } from '../browser/session.js';
import { loadStorageState, hasImportedProfile } from '../browser/profile-import.js';
import { BrowserStateSummary } from '../browser/views.js';
import { ActionRegistry, ActionContext } from '../actions/registry.js';
import { registerBuiltinActions, setCoordinateClicking } from '../actions/builtin.js';
import {
	AgentSettings,
	DEFAULT_AGENT_SETTINGS,
	AgentOutput,
	ActionResult,
	StepMetadata,
	getInteractedElement,
	AgentHistory,
	isLastStep,
	filterSensitiveDataFromString,
	AgentError,
	MessageCompactionSettings,
	resolveMessageCompactionSettings,
	getModelLlmTimeout,
	supportsCoordinateClicking,
	defaultLlmScreenshotSize,
	renderPlan,
	formatAgentSteps,
} from './views.js';
import type { PlanItem } from './views.js';
import { constructJudgeMessages, JudgementResultSchema, parseJudgementResult, type JudgementResult } from './judge.js';
import { detectVariablesInHistory, type DetectedVariable } from './variable_detector.js';
import { ModelOutputTruncatedError, ModelProviderError, ModelRateLimitError } from '../llm/exceptions.js';
import { hasUrlNegation, isPlaceholderUrl, sanitizeUrlCandidate } from '../utils.js';
import { BrowserStateHistory } from '../browser/views.js';
import {
	AgentState,
	AgentHistory as AgentHistoryType,
	AgentHistoryList,
	AgentStepInfo,
	createAgentState,
	createAgentHistoryList,
	AgentOutputSchema,
	createAgentOutputSchema,
	getFinalResult as getFinalResultText,
} from '../types/agent.js';
import { BaseMessage, createSystemMessage, createUserMessage, UserMessage } from '../llm/messages.js';
import { MessageManager } from './message_manager/service.js';
import { SystemPrompt } from './prompts.js';
import { FileSystem } from '../filesystem/file_system.js';
import { PageState } from '../dom/service.js';
import { ScreenshotService } from '../screenshots/service.js';
import { z } from 'zod';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createHistoryGif } from './gif.js';

// Callback type definitions
export type AgentStepCallback = (
	browserState: BrowserStateSummary,
	modelOutput: AgentOutput,
	stepNumber: number
) => void | Promise<void>;

export type AgentDoneCallback = (history: AgentHistoryList) => void | Promise<void>;

export type AgentShouldStopCallback = () => boolean | Promise<boolean>;

export interface AgentOptions {
	/** The task to accomplish */
	task: string;

	/** LLM to use */
	llm: BaseChatModel;

	/** Browser session (will create if not provided) */
	browserSession?: BrowserSession;

	/**
	 * Specific page/tab ID to use for this agent (for multi-agent parallel execution)
	 * If provided, agent works on this specific tab without interfering with other agents
	 * If not provided, uses current page (single-agent mode)
	 */
	pageId?: string;

	/** Action registry (will create with defaults if not provided) */
	actionRegistry?: ActionRegistry;

	/** Agent settings */
	settings?: Partial<AgentSettings>;

	/** Maximum steps before stopping */
	maxSteps?: number;

	/** Sensitive data to filter from logs */
	sensitiveData?: Record<string, string>;

	/** Output schema for structured output */
	outputSchema?: z.ZodType<any>;

	/** Callback called after each step with browser state and model output */
	registerNewStepCallback?: AgentStepCallback;

	/** Callback called when agent task is done */
	registerDoneCallback?: AgentDoneCallback;

	/** Callback to check if agent should stop */
	registerShouldStopCallback?: AgentShouldStopCallback;

	/** Callback to check external agent status */
	registerExternalAgentStatusRaiseErrorCallback?: () => Promise<boolean>;
}

/**
 * Main AI Agent class
 */
export class Agent {
	public readonly id: string;
	public task: string;
	public llm: BaseChatModel;
	public readonly browserSession: BrowserSession;
	public readonly actionRegistry: ActionRegistry;
	public readonly settings: AgentSettings;
	public readonly maxSteps: number;

	/**
	 * Specific page/tab ID for this agent (multi-agent mode)
	 * When set, agent works on this tab without interfering with other agents
	 */
	public readonly pageId?: string;

	private state: AgentState;
	private history: AgentHistoryList;
	private outputSchema?: z.ZodType<any>;
	private dynamicAgentOutputSchema?: z.ZodType<any>; // Dynamic schema with proper action types
	private doneAgentOutputSchema?: z.ZodType<any>; // Schema for done-only mode (last step/failure)
	private ownsBrowserSession: boolean = false;
	private messageManager!: MessageManager;
	private fileSystem!: FileSystem;
	private screenshotService!: ScreenshotService;
	private sensitiveData?: Record<string, string>;
	private agentDirectory: string;

	// Callbacks
	private registerNewStepCallback?: AgentStepCallback;
	private registerDoneCallback?: AgentDoneCallback;
	private registerShouldStopCallback?: AgentShouldStopCallback;
	private registerExternalAgentStatusRaiseErrorCallback?: () => Promise<boolean>;

	// Initial actions extracted from task URL
	private initialUrl: string | null = null;
	private initialActions: Array<Record<string, any>> | null = null;

	// Message compaction (resolved from settings.messageCompaction)
	private compactionSettings: MessageCompactionSettings | null = null;

	// Fallback LLM (switched to once after rate-limit / provider errors)
	private readonly originalLlm: BaseChatModel;
	private usingFallbackLlm: boolean = false;

	// Actions never counted for loop detection: wait hashes identically, done is terminal, go_back is recovery
	private static readonly LOOP_EXEMPT_ACTIONS = new Set(['wait', 'done', 'go_back']);

	// Prompt-cache stats accumulator — emitted as `cache_stats` JSON logs.
	// Schema aligned with snowx-api-v2: camelCase fields, source:"orion-electron",
	// so a shared aggregator can grep tag and normalize step/iteration via jq.
	private cacheStats = {
		requests: 0,
		input: 0,
		cacheRead: 0,
		cacheCreate: 0,
	};

	// Pause event mechanism (like Python's asyncio.Event)
	private pauseResolve: (() => void) | null = null;
	private pausePromise: Promise<void> | null = null;

	constructor(options: AgentOptions) {
		this.id = uuidv4();
		this.task = options.task;
		this.llm = options.llm;
		this.maxSteps = options.maxSteps || 100;
		this.outputSchema = options.outputSchema;

		// Settings with defaults
		this.settings = {
			...DEFAULT_AGENT_SETTINGS,
			...options.settings,
		};
		// Flash mode strips plan fields from the output schema, so planning is structurally impossible
		if (this.settings.flashMode) {
			this.settings.enablePlanning = false;
		}
		// LLM timeout depends on the model unless the caller set one explicitly
		if (options.settings?.llmTimeout === undefined) {
			this.settings.llmTimeout = getModelLlmTimeout(this.llm.model);
		}
		// Auto-configure screenshot resizing for Claude Sonnet (1400x850) unless the caller set it
		if (options.settings?.llmScreenshotSize === undefined) {
			this.settings.llmScreenshotSize = defaultLlmScreenshotSize(this.llm.model);
		}
		this.compactionSettings = resolveMessageCompactionSettings(this.settings.messageCompaction ?? true);
		this.originalLlm = this.llm;

		// Browser session
		if (options.browserSession) {
			this.browserSession = options.browserSession;
			this.ownsBrowserSession = false;
		} else {
			// Create browser session with auto-loaded profile if available
			const sessionOptions: any = {
				headless: false,
			};

			// Auto-load imported profile (cookies, localStorage)
			if (hasImportedProfile()) {
				try {
					const storageState = loadStorageState();
					if (storageState && storageState.cookies && storageState.cookies.length > 0) {
						sessionOptions.storageState = storageState;
						console.log(`🍪 [Agent] Auto-loaded profile with ${storageState.cookies.length} cookies`);
					}
				} catch (error: any) {
					console.warn(`⚠️ [Agent] Failed to load profile: ${error.message}`);
				}
			}

			this.browserSession = new BrowserSession(sessionOptions);
			this.ownsBrowserSession = true;
		}

		// Multi-agent mode: specific page/tab for this agent
		this.pageId = options.pageId;
		if (this.pageId) {
			console.log(`🔀 [Agent] Multi-agent mode: Agent ${this.id.substring(0, 8)} assigned to tab ${this.pageId}`);
		}

		// Action registry
		if (options.actionRegistry) {
			this.actionRegistry = options.actionRegistry;
		} else {
			this.actionRegistry = new ActionRegistry();
			registerBuiltinActions(this.actionRegistry);
		}

		// The screenshot action only makes sense when vision is 'auto' (Python: exclude_action('screenshot'))
		if (this.settings.useVision !== 'auto') {
			this.actionRegistry.excludeAction('screenshot');
		}

		// Coordinate clicking for models that support it (Python: set_coordinate_clicking)
		const coordinateClicking =
			this.settings.coordinateClicking === 'auto'
				? supportsCoordinateClicking(this.llm.model)
				: Boolean(this.settings.coordinateClicking);
		if (coordinateClicking && this.actionRegistry.getAction('click')) {
			setCoordinateClicking(this.actionRegistry, true);
		}

		// Store the LLM screenshot size so coordinate clicks can be converted back to viewport space
		this.browserSession.llmScreenshotSize = this.settings.llmScreenshotSize ?? null;

		this._setupActionModels();

		// Initialize state and history
		this.state = createAgentState();
		this.history = createAgentHistoryList(this.id, this.task);

		// Initialize file system and screenshot service with temp directory
		const tmpDir = os.tmpdir();
		this.agentDirectory = path.join(tmpDir, `browser_use_agent_${this.id}`);
		this.fileSystem = new FileSystem(this.agentDirectory);
		this.screenshotService = new ScreenshotService(this.agentDirectory);

		// Extract URL from task and set up initial navigation (like Python's directly_open_url)
		if (this.settings.directlyOpenUrl) {
			this.initialUrl = this._extractStartUrl(this.task);
			if (this.initialUrl) {
				console.log(`🔗 Found URL in task: ${this.initialUrl}, adding as initial action...`);
				this.initialActions = [{ navigate: { url: this.initialUrl, new_tab: false } }];
			}
		}

		// Initialize message manager with system prompt
		const modelNameLower = (this.llm.model ?? '').toLowerCase();
		const systemPromptGenerator = new SystemPrompt({
			maxActionsPerStep: this.settings.maxActionsPerStep,
			overrideSystemMessage: this.settings.overrideSystemMessage,
			extendSystemMessage: this.settings.extendSystemMessage,
			useThinking: this.settings.useThinking,
			flashMode: this.settings.flashMode,
			isAnthropic: this.llm.provider === 'anthropic',
			isBrowserUseModel: modelNameLower.includes('browser-use/'),
			modelName: this.llm.model,
		});
		const systemMessage = systemPromptGenerator.getSystemMessage();

		this.messageManager = new MessageManager({
			task: this.task,
			systemMessage: systemMessage,
			fileSystem: this.fileSystem,
			useThinking: this.settings.useThinking,
			includeAttributes: this.settings.includeAttributes ?? undefined,
			sensitiveData: this.sensitiveData,
			maxHistoryItems: this.settings.maxHistoryItems ?? undefined,
			visionDetailLevel: this.settings.visionDetailLevel,
			includeToolCallExamples: this.settings.includeToolCallExamples,
			includeRecentEvents: this.settings.includeRecentEvents,
			sampleImages: this.settings.sampleImages ?? undefined,
			llmScreenshotSize: this.settings.llmScreenshotSize ?? null,
			maxClickableElementsLength: this.settings.maxClickableElementsLength,
		});

		// Loop detector window from settings
		this.state.loopDetector.windowSize = this.settings.loopDetectionWindow ?? 20;

		// Initialize callbacks
		this.registerNewStepCallback = options.registerNewStepCallback;
		this.registerDoneCallback = options.registerDoneCallback;
		this.registerShouldStopCallback = options.registerShouldStopCallback;
		this.registerExternalAgentStatusRaiseErrorCallback = options.registerExternalAgentStatusRaiseErrorCallback;

		// Store sensitive data for filtering
		this.sensitiveData = options.sensitiveData;
	}

	/**
	 * Run the agent to completion
	 * Main entry point for executing a task with max_steps limit
	 */
	async run(maxSteps: number = this.maxSteps): Promise<AgentHistoryList> {
		let agentRunError: string | null = null;

		try {
			console.log(`🤖 Starting agent ${this.id.substring(0, 8)} with task: ${this.task}`);
			console.log(
				`🔧 Agent setup: Session ID ${this.id.substring(this.id.length - 4)}, max_steps: ${maxSteps}`
			);

			// Initialize timing for session and task
			const sessionStartTime = Date.now();

			// Initialize screenshot service directory
			await this.screenshotService.initialize();

			// Start browser session
			await this.browserSession.start();

			// Execute initial actions if provided. Wrapped with step_timeout so a single URL navigate
			// can't hang indefinitely on an unresponsive browser (Python 0.13).
			let initialTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					this._executeInitialActions(),
					new Promise<never>((_, reject) => {
						initialTimer = setTimeout(
							() => reject(new Error(`Initial actions timed out after ${this.settings.stepTimeout}s`)),
							this.settings.stepTimeout * 1000
						);
					}),
				]);
			} catch (error) {
				if (error instanceof Error && error.message === 'Interrupted') {
					// Allow interruption during initial actions
				} else if (error instanceof Error && error.message.includes('Initial actions timed out')) {
					const initialTimeoutMsg = `Initial actions timed out after ${this.settings.stepTimeout}s (browser may be unresponsive). Proceeding to main execution loop.`;
					console.error(`⏰ ${initialTimeoutMsg}`);
					this.state.lastResult = [{ error: initialTimeoutMsg }];
					this.state.consecutiveFailures++;
				} else {
					throw error;
				}
			} finally {
				if (initialTimer) clearTimeout(initialTimer);
			}

			console.log(`🔄 Starting main execution loop with max ${maxSteps} steps...`);

			// Main execution loop
			for (let step = 0; step < maxSteps; step++) {
				// Check if we should stop due to too many failures
				if (
					this.state.consecutiveFailures >=
					this.settings.maxFailures + (this.settings.finalResponseAfterFailure ? 1 : 0)
				) {
					console.error(
						`❌ Stopping due to ${this.settings.maxFailures} consecutive failures`
					);
					agentRunError = `Stopped due to ${this.settings.maxFailures} consecutive failures`;
					break;
				}

				// Check control flags before each step
				if (this.state.stopped) {
					console.log('🛑 Agent stopped');
					agentRunError = 'Agent stopped programmatically';
					break;
				}

				// Wait while paused (like Python's asyncio.Event.wait())
				if (this.state.paused) {
					console.log('⏸️ Agent paused, waiting for resume...');
					while (this.state.paused) {
						if (this.pausePromise) {
							await this.pausePromise;
						} else {
							// Fallback: wait a bit and check again
							await new Promise((resolve) => setTimeout(resolve, 100));
						}
					}
					console.log('▶️ Agent resumed, continuing...');
				}

				const stepInfo: AgentStepInfo = {
					stepNumber: step,
					maxSteps: maxSteps,
				};

				const isDone = await this._executeStep(step, maxSteps, stepInfo);

				if (isDone) {
					// Task completed successfully
					console.log('✅ Task completed successfully');

					// Run the judge before the done callback if enabled
					if (this.settings.useJudge) {
						await this._judgeAndLog();
					}

					// Call done callback if registered
					if (this.registerDoneCallback) {
						await this.registerDoneCallback(this.history);
					}
					break;
				}
			}

			// Check if we hit max steps without completing (like Python for-else)
			if (this.state.nSteps >= maxSteps && !this.state.stopped) {
				agentRunError = 'Failed to complete task in maximum steps';
				console.log(`❌ ${agentRunError}`);

				// Add final history item with error (like Python lines 1697-1710)
				this.history.history.push({
					modelOutput: null,
					result: [{ error: agentRunError, includeInMemory: true }],
					state: {
						url: '',
						title: '',
						tabs: [],
					},
				});
			}

			return this.history;
		} catch (error) {
			console.error('Agent run failed with exception:', error);
			agentRunError = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			// Cleanup
			console.log('🧹 Cleaning up agent resources...');

			// Emit session-level cache_stats for aggregation alongside snowx-api-v2.
			this._emitSessionCacheStats(agentRunError ? 'error' : 'completed');

			// Generate GIF if needed
			if (this.settings.generateGif) {
				try {
					const outputPath = typeof this.settings.generateGif === 'string'
						? this.settings.generateGif
						: path.join(this.agentDirectory, 'agent_history.gif');

					console.log('📹 Generating GIF...');
					await createHistoryGif({
						task: this.task,
						history: this.history as any,
						outputPath,
						duration: 3000,
						showGoals: true,
						showTask: true,
					});
					console.log(`📹 GIF saved to ${outputPath}`);
				} catch (error: any) {
					console.error(`📹 GIF generation failed: ${error.message}`);
				}
			}

			// Close browser session if we own it
			if (this.ownsBrowserSession) {
				await this.browserSession.stop();
			}
		}
	}

	/**
	 * Execute a single agent step with 4-phase approach:
	 * Phase 1: Prepare context (browser state, action models, page actions)
	 * Phase 2: Get model output and execute actions
	 * Phase 3: Post-processing (download tracking, result logging)
	 * Phase 4: Finalize (history, logging, events)
	 */
	async step(stepInfo: AgentStepInfo | null = null): Promise<void> {
		// Initialize timing first, before any exceptions can occur
		const stepStartTime = Date.now();
		let browserStateSummary: BrowserStateSummary | null = null;

		try {
			// Phase 1: Prepare context and timing
			browserStateSummary = await this._prepareContext(stepInfo);

			// Clear previous step state after context preparation (which needs it for the
			// "previous action result" prompt) but before the LLM call, so a timeout during
			// _getNextAction/_executeActions won't leave stale data from the previous step.
			this.state.lastModelOutput = null;
			this.state.lastResult = null;

			// Phase 2: Get model output and execute actions
			await this._getNextAction(browserStateSummary);
			await this._executeActions();

			// Phase 3: Post-processing
			await this._postProcess();
		} catch (error) {
			// Handle ALL exceptions in one place
			await this._handleStepError(error);
		} finally {
			await this._finalize(browserStateSummary, stepStartTime);
		}
	}

	/**
	 * Get current browser state
	 * In multi-agent mode, gets state for this agent's specific tab
	 */
	private async getBrowserState(): Promise<PageState> {
		// Get page from browser session
		// Multi-agent mode: use specific page if assigned
		const state = this.pageId
			? await this.browserSession.getStateForPage(this.pageId)
			: await this.browserSession.getState();

		// For now, return a simplified state
		// TODO: integrate full DOM extraction
		return {
			url: state.url,
			title: state.title,
			domTree: [],
			selectorMap: new Map(),
			screenshot: state.screenshot ?? undefined,
		};
	}

	/**
	 * Build messages for LLM
	 */
	private async buildMessages(
		browserState: PageState,
		stepInfo: AgentStepInfo
	): Promise<BaseMessage[]> {
		const messages: BaseMessage[] = [];

		// System message
		const systemPrompt = this.buildSystemPrompt(stepInfo);
		messages.push(createSystemMessage(systemPrompt));

		// Add history
		for (const item of this.history.history) {
			// Add user message with browser state
			const stateDescription = this.formatBrowserState(item.state);
			messages.push(createUserMessage(stateDescription));

			// Add assistant response
			if (item.modelOutput) {
				const response = JSON.stringify(item.modelOutput);
				messages.push({
					role: 'assistant',
					content: response,
				});
			}
		}

		// Current state
		const currentStateDescription = this.formatCurrentState(browserState, stepInfo);
		messages.push(createUserMessage(currentStateDescription));

		return messages;
	}

	/**
	 * Build system prompt
	 */
	private buildSystemPrompt(stepInfo: AgentStepInfo): string {
		const actionDescriptions = this.actionRegistry.getPromptDescription();

		return `You are an AI agent designed to operate in an iterative loop to automate browser tasks.

Your ultimate goal is accomplishing the task: ${this.task}

You are currently on step ${stepInfo.stepNumber} of ${stepInfo.maxSteps}.

You can execute up to ${this.settings.maxActionsPerStep} actions per step.

Available actions:
${actionDescriptions}

You must respond with a valid JSON in this format:
{
  ${this.settings.useThinking ? '"thinking": "Your reasoning about the current state and next steps",' : ''}
  "evaluationPreviousGoal": "Assessment of the previous action (success/failure/uncertain)",
  "memory": "Key information to remember for future steps",
  "nextGoal": "What you plan to do next",
  "action": [
    { "action_name": { "param": "value" } }
  ]
}

Action list must have at least 1 action and at most ${this.settings.maxActionsPerStep} actions.`;
	}

	/**
	 * Format browser state for message
	 */
	private formatBrowserState(state: any): string {
		return `Current URL: ${state.url}
Title: ${state.title}
Tabs: ${state.tabs.length} open`;
	}

	/**
	 * Format current state
	 */
	private formatCurrentState(browserState: PageState, stepInfo: AgentStepInfo): string {
		return `Step ${stepInfo.stepNumber}/${stepInfo.maxSteps}

Current URL: ${browserState.url}
Title: ${browserState.title}

What is your next action?`;
	}

	/**
	 * Call LLM
	 */
	private async callLLM(messages: BaseMessage[]): Promise<AgentOutput> {
		// User-provided output schema takes precedence
		if (this.outputSchema) {
			const result = await this.llm.ainvoke(messages, this.outputSchema);
			return result.completion as AgentOutput;
		}

		// Use dynamic schema with proper action types (like Python's type_with_custom_actions)
		// This produces a proper anyOf schema for strict mode compatibility
		const schema = this.dynamicAgentOutputSchema || AgentOutputSchema;
		const result = await this.llm.ainvoke(messages, schema);
		return result.completion as AgentOutput;
	}

	/**
	 * Execute actions from model output
	 */
	private async executeActions(actions: any[]): Promise<ActionResult[]> {
		const results: ActionResult[] = [];

		for (let i = 0; i < Math.min(actions.length, this.settings.maxActionsPerStep); i++) {
			const action = actions[i];
			const actionName = Object.keys(action)[0];
			const params = action[actionName];

			console.log(`  ⚡ Executing action ${i + 1}/${actions.length}: ${actionName}`);

			try {
				const context = this._createActionContext();

				const result = await this.actionRegistry.execute(actionName, params, context);
				results.push(result);

				// Stop if action completes task
				if (result.isDone) {
					break;
				}

				// Stop on error
				if (result.error) {
					console.error(`    ❌ Error: ${result.error}`);
					break;
				}
			} catch (error: any) {
				console.error(`    ❌ Failed to execute ${actionName}:`, error.message);
				results.push({
					error: `Failed to execute ${actionName}: ${error.message}`,
				});
				break;
			}
		}

		return results;
	}

	/**
	 * Log model output
	 */
	private logModelOutput(output: AgentOutput) {
		if (output.thinking && this.settings.useThinking) {
			console.log(`  💡 Thinking: ${output.thinking.substring(0, 100)}...`);
		}

		if (output.evaluationPreviousGoal) {
			const evaluation = output.evaluationPreviousGoal;
			if (evaluation.toLowerCase().includes('success')) {
				console.log(`  ✅ Eval: ${evaluation}`);
			} else if (evaluation.toLowerCase().includes('failure')) {
				console.log(`  ❌ Eval: ${evaluation}`);
			} else {
				console.log(`  ❔ Eval: ${evaluation}`);
			}
		}

		if (output.memory) {
			console.log(`  🧠 Memory: ${output.memory}`);
		}

		if (output.nextGoal) {
			console.log(`  🎯 Next goal: ${output.nextGoal}`);
		}
	}

	/**
	 * Convert browser state to history format
	 */
	private browserStateToHistory(state: PageState): any {
		return {
			url: state.url,
			title: state.title,
			tabs: [],
			screenshot: state.screenshot,
		};
	}

	/**
	 * Attempt final recovery after failures
	 */
	private async attemptFinalRecovery(): Promise<ActionResult> {
		console.log('🔄 Attempting final recovery...');

		try {
			const messages: BaseMessage[] = [];
			messages.push(
				createSystemMessage(
					`You have exceeded the maximum number of failures. Provide a final summary of what was accomplished and what could not be completed.`
				)
			);

			const result = await this.llm.ainvoke(messages);
			const content = typeof result.completion === 'string' ? result.completion : JSON.stringify(result.completion);

			return {
				isDone: true,
				success: false,
				longTermMemory: content,
			};
		} catch {
			return {
				isDone: true,
				success: false,
				error: 'Failed to generate final recovery response',
			};
		}
	}

	/**
	 * Save conversation to file (per-step, like Python)
	 * Port from browser_use/agent/service.py (lines 964-974)
	 */
	private async saveConversationStep(inputMessages: BaseMessage[]): Promise<void> {
		if (!this.settings.saveConversationPath || !this.state.lastModelOutput) {
			return;
		}

		try {
			// Treat saveConversationPath as a directory (consistent with other recording paths)
			const conversationDir = path.resolve(this.settings.saveConversationPath);
			const conversationFilename = `conversation_${this.id}_${this.state.nSteps}.txt`;
			const targetPath = path.join(conversationDir, conversationFilename);

			// Create directory if it doesn't exist
			await fs.mkdir(conversationDir, { recursive: true });

			// Format conversation
			const formattedConversation = this._formatConversation(
				inputMessages,
				this.state.lastModelOutput
			);

			// Write to file
			const encoding = this.settings.saveConversationPathEncoding || 'utf-8';
			await fs.writeFile(targetPath, formattedConversation, encoding as BufferEncoding);
			console.log(`💾 Saved conversation step ${this.state.nSteps} to ${targetPath}`);
		} catch (error) {
			console.error('Failed to save conversation:', error);
		}
	}

	/**
	 * Format conversation including messages and response
	 * Port from browser_use/agent/message_manager/utils.py _format_conversation
	 */
	private _formatConversation(messages: BaseMessage[], response: any): string {
		const lines: string[] = [];

		// Format messages
		for (const message of messages) {
			lines.push(` ${message.role} `);
			lines.push(message.text || '');
			lines.push(''); // Empty line after each message
		}

		// Format response
		lines.push(' RESPONSE');
		try {
			lines.push(JSON.stringify(response, null, 2));
		} catch {
			lines.push(String(response));
		}

		return lines.join('\n');
	}

	/**
	 * Get agent history
	 */
	getHistory(): AgentHistoryList {
		return this.history;
	}

	/**
	 * Get agent state
	 */
	getState(): AgentState {
		return this.state;
	}

	// ==================== Public Control Methods ====================

	/**
	 * Add a new task to the agent, keeping the same task_id as tasks are continuous
	 * Port from browser_use/agent/service.py add_new_task (lines 621-635)
	 */
	addNewTask(newTask: string): void {
		// Simply delegate to message manager - no need for new task_id or events
		// The task continues with new instructions, it doesn't end and start a new one
		this.task = newTask;
		this.messageManager.addNewTask(newTask);
		// Mark as follow-up task - this affects initial_actions and directly_open_url behavior
		this.state.followUpTask = true;
		// Reset control flags so agent can continue
		this.state.stopped = false;
		this.state.paused = false;
		// TODO: Recreate event bus when implemented
	}

	/**
	 * Pause the agent execution.
	 * Creates a promise that will block until resume() is called.
	 * This mimics Python's asyncio.Event behavior.
	 */
	pause(): void {
		console.log('⏸️  Pausing agent...');
		this.state.paused = true;
		// Create a promise that will be resolved when resume() is called
		// This allows await pausePromise to block until resume
		if (!this.pausePromise) {
			this.pausePromise = new Promise<void>((resolve) => {
				this.pauseResolve = resolve;
			});
		}
	}

	/**
	 * Resume the agent execution.
	 * Resolves the pause promise to unblock the waiting agent.
	 */
	resume(): void {
		console.log('▶️  Resuming agent...');
		this.state.paused = false;
		// Resolve the pause promise to unblock the agent
		if (this.pauseResolve) {
			this.pauseResolve();
			this.pauseResolve = null;
			this.pausePromise = null;
		}
	}

	/**
	 * Stop the agent execution
	 */
	stop(): void {
		console.log('🛑 Stopping agent...');
		this.state.stopped = true;
	}

	// ==================== Action Execution ====================

	/**
	 * Execute multiple actions sequentially
	 * Port from browser_use/agent/service.py multi_act (lines 1786-1854)
	 */
	async multiAct(actions: any[]): Promise<any[]> {
		const results: any[] = [];
		let timeElapsed = 0;
		const totalActions = actions.length;

		if (!this.browserSession) {
			throw new Error('BrowserSession is not set up');
		}

		// Get cached selector map for element tracking (like Python multi_act lines 1792-1806)
		// Note: Hash-based page change detection is not implemented (neither in Python nor here)
		// Instead, we use URL comparison for page navigation detection (see below)

		// Get current page URL for page change detection
		let previousUrl = '';
		try {
			previousUrl = await this.browserSession.getCurrentPageUrl();
		} catch {
			// Ignore URL fetch errors
		}

		// Execute actions sequentially
		for (let i = 0; i < actions.length; i++) {
			const action = actions[i];

			// Only allow 'done' action as a single action
			if (i > 0) {
				const actionData = action;
				if (actionData.done !== undefined) {
					const msg = `Done action is allowed only as a single action - stopped after action ${i} / ${totalActions}.`;
					console.log(msg);
					break;
				}
			}

			// Wait between actions (only after first action)
			// Python uses: self.browser_profile.wait_between_actions
			if (i > 0) {
				const waitTime = this.settings.waitBetweenActions;
				await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
			}

			try {
				await this._checkStopOrPause();

				// Get action name from the action model
				const actionData = action;
				const actionName = Object.keys(actionData)[0] || 'unknown';

				// Log action before execution
				this._logAction(action, actionName, i + 1, totalActions);

				const timeStart = Date.now();

				// Execute the action using action registry
				const params = actionData[actionName] || {};
				const context = this._createActionContext();
				const result = await this.actionRegistry.execute(actionName, params, context);

				const timeEnd = Date.now();
				timeElapsed = (timeEnd - timeStart) / 1000;

				results.push(result);

				// Actions flagged terminates_sequence (navigate, search, go_back, switch, evaluate) are
				// known to change the page: abort the remaining queued actions (Python multi_act).
				if (
					!result.error &&
					!result.isDone &&
					i < totalActions - 1 &&
					this.actionRegistry.terminatesSequence(actionName)
				) {
					const skippedCount = totalActions - i - 1;
					console.log(`🔄 Action '${actionName}' terminates the sequence, skipping ${skippedCount} remaining action(s)`);
					this.browserSession.clearCachedState();
					results.push({
						extractedContent: `Action '${actionName}' changed the page. Skipped ${skippedCount} remaining action(s) because element indices are now stale.`,
					});
					break;
				}

				// OPTIMIZED: Only check for page navigation after actions that might cause it
				// Actions like click, navigate, send_keys (with Enter), go_back, go_forward
				// framenavigated/domcontentloaded events now auto-clear cache, but we still
				// need to detect navigation to stop remaining actions
				const navigationActions = ['click', 'navigate', 'send_keys', 'go_back', 'go_forward', 'evaluate'];
				const mightNavigate = navigationActions.includes(actionName) ||
					(actionName === 'send_keys' && (params.keys?.toLowerCase().includes('enter') || params.keys?.toLowerCase().includes('return')));

				if (mightNavigate && i < totalActions - 1) {
					try {
						const currentUrl = await this.browserSession.getCurrentPageUrl();

						if (currentUrl !== previousUrl && currentUrl !== '' && previousUrl !== '') {
							const skippedCount = totalActions - i - 1;
							console.log(`🔄 Page navigation detected: ${previousUrl} → ${currentUrl}`);
							console.log(`📍 Interrupting remaining ${skippedCount} actions (element indices now stale)`);

							// Cache is already cleared by framenavigated event, but ensure it's done
							this.browserSession.clearCachedState();

							// Add info result so agent knows what happened (not an error, just info)
							if (skippedCount > 0) {
								results.push({
									extractedContent: `Page navigated to ${currentUrl}. Skipped ${skippedCount} remaining action(s) because element indices are now stale.`,
								});
							}

							// Stop executing remaining actions - they reference elements from old page
							break;
						}
						previousUrl = currentUrl;
					} catch {
						// Ignore URL check errors, continue with remaining actions
					}
				}

				// Break if done, error, or last action
				if (results[results.length - 1].isDone || results[results.length - 1].error || i === totalActions - 1) {
					break;
				}
			} catch (error: any) {
				// Match Python's behavior: catch exceptions and return ActionResult with error
				// instead of re-throwing (like Python's act() function lines 1253-1262)
				const errorMsg = error.message || String(error);
				console.error(`❌ Executing action ${i + 1} failed: ${errorMsg}`);

				// Return error as ActionResult like Python does
				results.push({
					error: `Action failed: ${errorMsg}`,
				});
				break; // Stop executing remaining actions
			}
		}

		return results;
	}

	/**
	 * Log the action before execution with colored formatting
	 * Port from browser_use/agent/service.py _log_action (lines 1856-1893)
	 */
	private _logAction(action: any, actionName: string, actionNum: number, totalActions: number): void {
		// ANSI color codes
		const blue = '\x1b[34m'; // Action name
		const magenta = '\x1b[35m'; // Parameter names
		const reset = '\x1b[0m';

		// Format action number and name
		let actionHeader: string;
		if (totalActions > 1) {
			actionHeader = `▶️  [${actionNum}/${totalActions}] ${blue}${actionName}${reset}:`;
		} else {
			actionHeader = `▶️   ${blue}${actionName}${reset}:`;
		}

		// Get action parameters
		const actionData = action;
		const params = actionData[actionName];

		// Build parameter parts with colored formatting
		const paramParts: string[] = [];

		if (params && typeof params === 'object') {
			for (const [paramName, value] of Object.entries(params)) {
				// Truncate long values for readability
				let displayValue: any = value;
				if (typeof value === 'string' && value.length > 150) {
					displayValue = value.substring(0, 150) + '...';
				} else if (Array.isArray(value) && JSON.stringify(value).length > 200) {
					displayValue = JSON.stringify(value).substring(0, 200) + '...';
				}

				// Filter sensitive data from display value
				if (typeof displayValue === 'string' && this.sensitiveData) {
					displayValue = filterSensitiveDataFromString(displayValue, this.sensitiveData);
				}

				paramParts.push(`${magenta}${paramName}${reset}: ${displayValue}`);
			}
		}

		// Join all parts
		if (paramParts.length > 0) {
			const paramsString = paramParts.join(', ');
			console.log(`  ${actionHeader} ${paramsString}`);
		} else {
			console.log(`  ${actionHeader}`);
		}
	}

	/**
	 * Log step context information
	 * Port from browser_use/agent/service.py _log_step_context (lines 1234-1242)
	 */
	private _logStepContext(browserStateSummary: BrowserStateSummary): void {
		const url = browserStateSummary?.url || '';
		const urlShort = url.length > 50 ? url.substring(0, 50) + '...' : url;
		const interactiveCount = browserStateSummary?.domState?.selectorMap?.size || 0;

		console.log('\n');
		console.log(`📍 Step ${this.state.nSteps}:`);
		console.log(`Evaluating page with ${interactiveCount} interactive elements on: ${urlShort}`);
	}

	/**
	 * Log step completion summary with action count, timing, and success/failure stats
	 * Port from browser_use/agent/service.py _log_step_completion_summary (lines 1277-1297)
	 */
	private _logStepCompletionSummary(stepStartTime: number, result: any[]): void {
		if (!result || result.length === 0) {
			return;
		}

		const stepDuration = (Date.now() - stepStartTime) / 1000;
		const actionCount = result.length;

		// Count success and failures
		const successCount = result.filter(r => !r.error).length;
		const failureCount = actionCount - successCount;

		// Format success/failure indicators
		const successIndicator = successCount > 0 ? `✅ ${successCount}` : '';
		const failureIndicator = failureCount > 0 ? `❌ ${failureCount}` : '';
		const statusParts = [successIndicator, failureIndicator].filter(part => part);
		const statusStr = statusParts.length > 0 ? statusParts.join(' | ') : '✅ 0';

		console.log(
			`📍 Step ${this.state.nSteps}: Ran ${actionCount} action${actionCount === 1 ? '' : 's'} in ${stepDuration.toFixed(2)}s: ${statusStr}`
		);
	}

	// ==================== Private helper methods for run() and step() ====================

	/**
	 * (Re)build the dynamic output schemas from the current action registry
	 * (Python _setup_action_models: AgentOutput / DoneAgentOutput variants).
	 */
	private _setupActionModels(): void {
		const schemaOptions = {
			flashMode: this.settings.flashMode,
			useThinking: this.settings.useThinking,
			enablePlanning: this.settings.enablePlanning,
		};
		// Dynamic schema with proper action types (like Python's type_with_custom_actions)
		const actionModel = this.actionRegistry.createActionModel();
		this.dynamicAgentOutputSchema = createAgentOutputSchema(actionModel, schemaOptions);

		// Done-only schema for last step / failure scenarios (like Python's DoneAgentOutput)
		const doneActionModel = this.actionRegistry.createActionModel(['done']);
		this.doneAgentOutputSchema = createAgentOutputSchema(doneActionModel, schemaOptions);
	}

	/** Optionally compact message history to keep prompts small. */
	private async _maybeCompactMessages(stepInfo: AgentStepInfo | null): Promise<void> {
		const settings = this.compactionSettings;
		if (!settings || !settings.enabled) {
			return;
		}
		const compactionLlm = settings.compactionLlm ?? this.settings.pageExtractionLlm ?? this.llm;
		await this.messageManager.maybeCompactMessages(compactionLlm, settings, stepInfo);
	}

	// ==================== Planning ====================

	/** Update the plan state from model output fields (currentPlanItem, planUpdate). */
	private _updatePlanFromModelOutput(modelOutput: AgentOutput): void {
		if (!this.settings.enablePlanning) {
			return;
		}

		// A new plan replaces the current one
		if (modelOutput.planUpdate) {
			this.state.plan = modelOutput.planUpdate.map((text): PlanItem => ({ text, status: 'pending' }));
			this.state.currentPlanItemIndex = 0;
			const isUpdate = this.state.planGenerationStep !== null;
			this.state.planGenerationStep = this.state.nSteps;
			if (this.state.plan.length > 0) {
				this.state.plan[0].status = 'current';
			}
			console.log(`📋 Plan ${isUpdate ? 'updated' : 'created'} with ${this.state.plan.length} steps`);
			return;
		}

		// A step index update advances the plan
		if (modelOutput.currentPlanItem !== null && modelOutput.currentPlanItem !== undefined && this.state.plan) {
			const plan = this.state.plan;
			const newIdx = Math.max(0, Math.min(modelOutput.currentPlanItem, plan.length - 1));
			const oldIdx = this.state.currentPlanItemIndex;
			for (let i = oldIdx; i < newIdx; i++) {
				if (i < plan.length && (plan[i].status === 'current' || plan[i].status === 'pending')) {
					plan[i].status = 'done';
				}
			}
			if (newIdx < plan.length) {
				plan[newIdx].status = 'current';
			}
			this.state.currentPlanItemIndex = newIdx;
		}
	}

	/** Render the current plan for injection into the agent context. */
	private _renderPlanDescription(): string | null {
		if (!this.settings.enablePlanning) {
			return null;
		}
		return renderPlan(this.state.plan);
	}

	/** Inject a replan nudge when the stall threshold is met. */
	private _injectReplanNudge(): void {
		if (!this.settings.enablePlanning || !this.state.plan) {
			return;
		}
		const threshold = this.settings.planningReplanOnStall ?? 0;
		if (threshold <= 0) {
			return;
		}
		if (this.state.consecutiveFailures >= threshold) {
			const msg =
				`REPLAN SUGGESTED: You have failed ${this.state.consecutiveFailures} consecutive times. ` +
				'Your current plan may need revision. ' +
				'Output a new `planUpdate` with revised steps to recover.';
			console.log(`📋 Replan nudge injected after ${this.state.consecutiveFailures} consecutive failures`);
			this.messageManager.addContextMessage(createUserMessage(msg));
		}
	}

	/** Nudge the agent to create a plan (or call done) after exploring without one. */
	private _injectExplorationNudge(): void {
		if (!this.settings.enablePlanning || this.state.plan) {
			return;
		}
		const limit = this.settings.planningExplorationLimit ?? 0;
		if (limit <= 0) {
			return;
		}
		if (this.state.nSteps >= limit) {
			const msg =
				`PLANNING NUDGE: You have taken ${this.state.nSteps} steps without creating a plan. ` +
				'If the task is complex, output a `planUpdate` with clear todo items now. ' +
				'If the task is already done or nearly done, call `done` instead.';
			console.log(`📋 Exploration nudge injected after ${this.state.nSteps} steps without a plan`);
			this.messageManager.addContextMessage(createUserMessage(msg));
		}
	}

	// ==================== Loop detection ====================

	/** Inject an escalating nudge when behavioral loops are detected. */
	private _injectLoopDetectionNudge(): void {
		if (!this.settings.loopDetectionEnabled) {
			return;
		}
		const nudge = this.state.loopDetector.getNudgeMessage();
		if (nudge) {
			console.log(
				`🔁 Loop detection nudge injected (repetition=${this.state.loopDetector.maxRepetitionCount}, stagnation=${this.state.loopDetector.consecutiveStagnantPages})`
			);
			this.messageManager.addContextMessage(createUserMessage(nudge));
		}
	}

	/** Record the actions from the latest step into the loop detector. */
	private _updateLoopDetectorActions(): void {
		if (!this.settings.loopDetectionEnabled || !this.state.lastModelOutput) {
			return;
		}
		for (const action of this.state.lastModelOutput.action) {
			if (!action || typeof action !== 'object') continue;
			const actionName = Object.keys(action)[0] ?? 'unknown';
			if (Agent.LOOP_EXEMPT_ACTIONS.has(actionName)) continue;
			const params = action[actionName];
			this.state.loopDetector.recordAction(actionName, params && typeof params === 'object' ? params : {});
		}
	}

	/** Record the current page state for stagnation detection. */
	private _updateLoopDetectorPageState(browserStateSummary: BrowserStateSummary): void {
		if (!this.settings.loopDetectionEnabled) {
			return;
		}
		const url = browserStateSummary.url || '';
		const selectorMap = browserStateSummary.domState?.selectorMap;
		const elementCount = selectorMap instanceof Map ? selectorMap.size : selectorMap ? Object.keys(selectorMap).length : 0;
		let domText = '';
		try {
			domText = browserStateSummary.domState?.llmRepresentation?.([]) ?? '';
		} catch {
			domText = '';
		}
		this.state.loopDetector.recordPageState(url, domText, elementCount);
	}

	// ==================== Judge ====================

	/** Judge the trace of the agent with the judge LLM (null on failure). */
	private async _judgeTrace(): Promise<JudgementResult | null> {
		const judgeLlm = this.settings.judgeLlm ?? this.llm;
		const screenshotPaths = this.history.history
			.map((h) => (h.state as any)?.screenshotPath as string | null | undefined)
			.filter((p): p is string => Boolean(p));

		const inputMessages = constructJudgeMessages({
			task: this.task,
			finalResult: this.history.finalResult?.extractedContent ?? getFinalResultText(this.history) ?? '',
			agentSteps: formatAgentSteps(this.history.history as any),
			screenshotPaths,
			maxImages: 10,
			groundTruth: this.settings.groundTruth ?? null,
			useVision: this.settings.useVision,
		});

		try {
			const response = await judgeLlm.ainvoke(inputMessages, JudgementResultSchema, { requestType: 'judge' });
			return parseJudgementResult(response.completion);
		} catch (error: any) {
			console.error(`Judge trace failed: ${error?.message ?? error}`);
			return null;
		}
	}

	/**
	 * Run judge evaluation and log the verdict. The verdict is attached to the final action result
	 * but does NOT override `success` (the agent's self-report).
	 */
	private async _judgeAndLog(): Promise<void> {
		const lastStep = this.history.history[this.history.history.length - 1];
		const lastResult = lastStep?.result?.[lastStep.result.length - 1];
		if (!lastResult?.isDone) {
			return;
		}
		const judgement = await this._judgeTrace();
		lastResult.judgement = judgement;
		if (this.history.finalResult) {
			this.history.finalResult.judgement = judgement;
		}
		if (!judgement) {
			return;
		}
		const selfReportedSuccess = lastResult.success;
		if (selfReportedSuccess === true && judgement.verdict === true) {
			return;
		}
		let judgeLog = '\n';
		if (selfReportedSuccess === true && judgement.verdict === false) {
			judgeLog += '⚠️  Agent reported success but judge thinks task failed\n';
		}
		judgeLog += `⚖️  Judge Verdict: ${judgement.verdict ? '✅ PASS' : '❌ FAIL'}\n`;
		if (judgement.failureReason) {
			judgeLog += `   Failure Reason: ${judgement.failureReason}\n`;
		}
		if (judgement.reachedCaptcha) {
			console.warn('Agent was blocked by a captcha.');
		}
		judgeLog += `   ${judgement.reasoning ?? ''}\n`;
		console.log(judgeLog);
	}

	// ==================== Fallback LLM ====================

	/** Invoke the agent LLM, switching to the fallback LLM once after rate-limit / provider errors. */
	private async _invokeAgentLlm(inputMessages: BaseMessage[], schema: z.ZodType<any>) {
		try {
			return await this.llm.ainvoke(inputMessages, schema);
		} catch (error) {
			if ((error instanceof ModelRateLimitError || error instanceof ModelProviderError) && this._trySwitchToFallbackLlm(error)) {
				return await this.llm.ainvoke(inputMessages, schema);
			}
			throw error;
		}
	}

	/** Whether the agent is currently using the fallback LLM. */
	get isUsingFallbackLlm(): boolean {
		return this.usingFallbackLlm;
	}

	/**
	 * Attempt to switch to the fallback LLM after a rate limit or provider error.
	 * Returns true if switched; once switched the fallback is used for the rest of the run.
	 */
	private _trySwitchToFallbackLlm(error: ModelRateLimitError | ModelProviderError): boolean {
		if (this.usingFallbackLlm) {
			console.warn(`⚠️ Fallback LLM also failed (${error.name}: ${error.message}), no more fallbacks available`);
			return false;
		}
		// 401/402 auth or credit problems, 429 rate limits, 5xx server errors, or a truncated output
		const retryableStatusCodes = new Set([401, 402, 429, 500, 502, 503, 504]);
		const statusCode = (error as any).statusCode as number | undefined;
		const isRetryable =
			error instanceof ModelRateLimitError ||
			error instanceof ModelOutputTruncatedError ||
			(statusCode !== undefined && retryableStatusCodes.has(statusCode));
		if (!isRetryable) {
			return false;
		}
		const fallback = this.settings.fallbackLlm;
		if (!fallback) {
			console.warn(`⚠️ LLM error (${error.name}: ${error.message}) but no fallbackLlm configured`);
			return false;
		}
		console.warn(
			`⚠️ Primary LLM (${this.originalLlm.model}) failed with ${error.name} (status=${statusCode ?? 'N/A'}), switching to fallback LLM (${fallback.model})`
		);
		this.llm = fallback;
		this.usingFallbackLlm = true;
		return true;
	}

	// ==================== Connection errors ====================

	/** Whether the error looks like a CDP / WebSocket / browser-closed failure. */
	private _isConnectionLikeError(error: unknown): boolean {
		const errorStr = (error instanceof Error ? error.message : String(error)).toLowerCase();
		return (
			errorStr.includes('websocket connection closed') ||
			errorStr.includes('connection closed') ||
			errorStr.includes('browser has been closed') ||
			errorStr.includes('browser closed') ||
			errorStr.includes('target closed') ||
			errorStr.includes('no browser')
		);
	}

	/** Best-effort check that the browser session still has an open page. */
	private _isBrowserAvailable(): boolean {
		try {
			return this.browserSession.getTabCount() > 0;
		} catch {
			return false;
		}
	}

	// ==================== Variables ====================

	/** Detect reusable variables (emails, names, dates, ...) in the agent history. */
	detectVariables(): Record<string, DetectedVariable> {
		return detectVariablesInHistory(this.history as any);
	}

	/**
	 * Create action context with all necessary fields for action execution
	 * Port from browser_use/agent/service.py multi_act method context creation
	 */
	private _createActionContext(): ActionContext {
		// Fallback to main LLM if pageExtractionLlm not configured (like Python)
		const extractionLlm = this.settings.pageExtractionLlm ?? this.llm;

		return {
			browserSession: this.browserSession,
			pageId: this.pageId,  // Pass pageId for multi-agent tab isolation
			fileSystem: this.fileSystem,
			sensitiveData: this.sensitiveData,
			availableFilePaths: this.settings.availableFilePaths ?? undefined,
			pageExtractionLlm: extractionLlm,
			llm: this.llm, // Also pass main LLM for fallback in actions
			extractionSchema: this.settings.extractionSchema ?? null,
		};
	}

	/**
	 * Execute initial actions if provided
	 * Initial actions are pre-specified actions to run before the agent starts (e.g., navigating to a URL)
	 */
	private async _executeInitialActions(): Promise<void> {
		// Skip initial actions on follow-up tasks (like Python does)
		if (this.state.followUpTask) {
			return;
		}

		if (!this.initialActions || this.initialActions.length === 0) {
			return;
		}

		console.log(`🚀 Executing ${this.initialActions.length} initial action(s)...`);

		const stepStartTime = Date.now();

		// Execute initial actions using multiAct like Python does
		const result = await this.multiAct(this.initialActions);

		// Update result to mention that URL was automatically loaded
		if (result && this.initialUrl && result[0]?.longTermMemory) {
			result[0].longTermMemory = `Found initial url and automatically loaded it. ${result[0].longTermMemory}`;
		}

		this.state.lastResult = result;

		// Save initial actions to history as step 0 for rerun capability
		// Create model output similar to Python's flash_mode/normal mode handling
		const modelOutput: AgentOutput = this.settings.flashMode
			? {
					evaluationPreviousGoal: null,
					memory: 'Initial navigation',
					nextGoal: null,
					action: this.initialActions,
			  }
			: {
					evaluationPreviousGoal: 'Start',
					memory: null,
					nextGoal: 'Initial navigation',
					action: this.initialActions,
			  };

		const stepEndTime = Date.now();
		const metadata: StepMetadata = {
			stepNumber: 0,
			stepStartTime,
			stepEndTime,
		};

		// Create minimal browser state history for initial actions
		const stateHistory: BrowserStateHistory = {
			url: this.initialUrl || '',
			title: 'Initial Actions',
			tabs: [],
			screenshot: undefined,
		};

		// Create history item and add to history
		const historyItem: AgentHistoryType = {
			modelOutput,
			result,
			state: stateHistory,
			metadata,
		};

		this.history.history.push(historyItem);
		console.log('📝 Saved initial actions to history as step 0');
		console.log('Initial actions completed');
	}

	/**
	 * Extract URL from task string using naive pattern matching.
	 * Based on Python's _extract_start_url method.
	 */
	private _extractStartUrl(task: string): string | null {
		// Remove email addresses from task before looking for URLs. Lookbehind
		// instead of \b — \b before a dot-containing class is O(n²) on dotted
		// runs; see code_use/utils.ts.
		const taskWithoutEmails = task.replace(
			/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
			''
		);

		// File extensions that should be excluded from URL detection
		const excludedExtensions = new Set([
			// Documents
			'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
			// Text files
			'txt', 'md', 'rtf', 'csv', 'json', 'xml', 'yaml', 'yml',
			// Images
			'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff',
			// Audio/Video
			'mp3', 'wav', 'ogg', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv',
			// Archives
			'zip', 'rar', 'tar', 'gz', '7z', 'bz2',
			// Code files
			'py', 'js', 'ts', 'jsx', 'tsx', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rb', 'php', 'swift', 'kt',
			// Config/data
			'ini', 'cfg', 'conf', 'log', 'sql', 'env',
			// Executables / packages
			'exe', 'dmg', 'pkg', 'deb', 'rpm', 'iso',
			// GitHub/Project paths
			'polynomial',
		]);

		// Look for common URL patterns
		const patterns = [
			/(?:https?|file):\/\/[^\s<>"']+/g, // Full URLs
			// Domain names. Lookbehind keeps match attempts at run boundaries —
			// the unguarded pattern was O(n²) on pasted tokens (~6s per 100KB,
			// in the main process). Same matches; see code_use/utils.ts.
			/(?<![a-zA-Z0-9.-])(?:www\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}(?:\/[^\s<>"']*)?/g,
		];

		const foundUrls: string[] = [];
		const matchedSpans: Array<[number, number]> = [];

		for (const pattern of patterns) {
			for (const match of taskWithoutEmails.matchAll(pattern)) {
				const rawUrl = match[0];
				const originalPosition = match.index ?? 0;
				const matchEnd = originalPosition + rawUrl.length;

				// Skip fragments of URLs already matched by an earlier pattern
				if (matchedSpans.some(([start, end]) => originalPosition < end && matchEnd > start)) {
					continue;
				}
				matchedSpans.push([originalPosition, matchEnd]);

				// Normalize trailing prose punctuation (keeps balanced brackets)
				let url = sanitizeUrlCandidate(rawUrl);
				if (!url) continue;

				if (isPlaceholderUrl(url)) {
					console.debug(`Excluding placeholder URL from auto-navigation: ${url}`);
					continue;
				}

				const urlLower = url.toLowerCase();
				const hasScheme = urlLower.startsWith('http://') || urlLower.startsWith('https://') || urlLower.startsWith('file://');

				// Exclude URLs pointing at files
				let shouldExclude = false;
				if (!urlLower.startsWith('file://')) {
					for (const ext of excludedExtensions) {
						if (urlLower.includes(`.${ext}`)) {
							shouldExclude = true;
							break;
						}
					}
					if (!hasScheme && urlLower.includes('.htm')) {
						shouldExclude = true;
					}
				}
				if (shouldExclude) {
					console.debug(`Excluding URL with file extension from auto-navigation: ${url}`);
					continue;
				}

				// Skip URLs explicitly negated by nearby prose, such as "Never go to this URL"
				const contextText = taskWithoutEmails.slice(Math.max(0, originalPosition - 20), originalPosition);
				if (hasUrlNegation(contextText)) {
					console.debug(`Excluding negated URL from auto-navigation: ${url} (context: "${contextText.trim()}")`);
					continue;
				}

				// Add https:// after the negation check to preserve source positions
				if (!hasScheme) {
					url = 'https://' + url;
				}

				foundUrls.push(url);
			}
		}

		// If multiple URLs found, skip to avoid ambiguity
		if (foundUrls.length > 1) {
			console.log(`Multiple URLs found (${foundUrls.length}), skipping directlyOpenUrl to avoid ambiguity`);
			return null;
		}

		return foundUrls.length === 1 ? foundUrls[0] : null;
	}

	/**
	 * Execute a single step and return whether task is done
	 * Wraps step execution with timeout protection (like Python)
	 */
	private async _executeStep(
		step: number,
		maxSteps: number,
		stepInfo: AgentStepInfo
	): Promise<boolean> {
		// Step-level timeout (default 180 seconds like Python)
		const stepTimeoutMs = (this.settings.stepTimeout ?? 180) * 1000;
		let stepTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

		try {
			await Promise.race([
				this.step(stepInfo),
				new Promise<never>((_, reject) => {
					stepTimeoutHandle = setTimeout(
						() => reject(new Error(`Step ${step} timed out after ${this.settings.stepTimeout ?? 180}s`)),
						stepTimeoutMs
					);
				}),
			]);

			// Check if task is done
			if (this.state.lastResult && this.state.lastResult.length > 0) {
				const lastResult = this.state.lastResult[this.state.lastResult.length - 1];
				if (lastResult.isDone) {
					const success = lastResult.success ?? false;
					if (success) {
						console.log(`\n📄 \x1b[32m Final Result:\x1b[0m \n${lastResult.extractedContent}\n\n`);
					} else {
						console.log(`\n📄 \x1b[31m Final Result:\x1b[0m \n${lastResult.extractedContent}\n\n`);
					}
					return true;
				}
			}

			return false;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (errorMessage.includes('timed out')) {
				console.error(`⏰ Step ${step} timed out - step took too long (${this.settings.stepTimeout ?? 180}s limit)`);
				this.state.lastResult = [{ error: errorMessage }];
				// Ensure the step counter advances on timeout — _finalize() may not have run
				if (this.state.nSteps === step + 1) {
					this.state.nSteps++;
				}
			} else {
				console.error(`Error in step ${step}:`, error);
			}
			this.state.consecutiveFailures++;
			return false;
		} finally {
			// Clear the watchdog so the step-timeout timer doesn't linger after the
			// step resolves — otherwise one pending timer leaks per step.
			if (stepTimeoutHandle) clearTimeout(stepTimeoutHandle);
		}
	}

	/**
	 * Phase 1: Prepare the context for the step - browser state, action models, page actions
	 */
	private async _prepareContext(stepInfo: AgentStepInfo | null = null): Promise<BrowserStateSummary> {
		console.log(`🌐 Step ${this.state.nSteps}: Getting browser state...`);
		console.log('📸 Requesting browser state with screenshot');

		// Multi-agent mode: use specific page if assigned
		const browserStateSummary = this.pageId
			? await this.browserSession.getStateForPage(this.pageId)
			: await this.browserSession.getState();

		if (browserStateSummary.screenshot) {
			console.log(
				`📸 Got browser state WITH screenshot, length: ${browserStateSummary.screenshot.length}`
			);
		} else {
			console.log('📸 Got browser state WITHOUT screenshot');
		}

		// Check for new downloads after getting browser state (like Python)
		await this._checkAndUpdateDownloads(`Step ${this.state.nSteps}: after getting browser state`);

		// Log step context
		this._logStepContext(browserStateSummary);

		// Check for pause/stop
		await this._checkStopOrPause();

		// Update action models with page-specific actions
		console.log(`📝 Step ${this.state.nSteps}: Updating action models...`);
		// TODO: Implement page-specific action filtering

		// Get page-specific filtered actions
		const pageFilteredActions = this.actionRegistry.getPromptDescription(
			browserStateSummary.url
		);

		// Create state messages for context
		console.log(`💬 Step ${this.state.nSteps}: Creating state messages for context...`);

		// Remember the real viewport for coordinate-click conversion
		if (browserStateSummary.pageInfo) {
			this.browserSession.originalViewportSize = [
				browserStateSummary.pageInfo.viewportWidth,
				browserStateSummary.pageInfo.viewportHeight,
			];
		}

		this.messageManager.prepareStepState(browserStateSummary as any, {
			modelOutput: (this.state.lastModelOutput as any) ?? undefined,
			result: (this.state.lastResult as any) ?? undefined,
			stepInfo: stepInfo ?? undefined,
			sensitiveData: this.sensitiveData,
		});

		await this._maybeCompactMessages(stepInfo);

		await this.messageManager.createStateMessages(browserStateSummary as any, {
			modelOutput: (this.state.lastModelOutput as any) ?? undefined,
			result: (this.state.lastResult as any) ?? undefined,
			stepInfo: stepInfo ?? undefined,
			useVision: this.settings.useVision,
			pageFilteredActions: pageFilteredActions,
			sensitiveData: this.sensitiveData,
			availableFilePaths: this.availableFilePaths.length > 0 ? this.availableFilePaths : (this.settings.availableFilePaths ?? undefined),
			planDescription: this._renderPlanDescription(),
			skipStateUpdate: true,
		});

		// Inject budget warning at 75% step usage (like Python)
		await this._injectBudgetWarning(stepInfo);
		this._injectReplanNudge();
		this._injectExplorationNudge();
		this._updateLoopDetectorPageState(browserStateSummary);
		this._injectLoopDetectionNudge();

		// Force done after last step if needed
		await this._forceDoneAfterLastStep(stepInfo);
		await this._forceDoneAfterFailure();

		return browserStateSummary;
	}

	/**
	 * Phase 2: Execute LLM interaction with retry logic and handle callbacks
	 */
	private async _getNextAction(browserStateSummary: BrowserStateSummary): Promise<void> {
		// Get input messages from MessageManager with sensitive data filtered (like Python)
		const inputMessages = this.messageManager.getFilteredMessages();

		console.log(
			`🤖 Step ${this.state.nSteps}: Calling LLM with ${inputMessages.length} messages (model: ${this.llm.model})...`
		);

		// Hoisted so the race timer is always cleared — leaving it pending kept a
		// Node timer + rejection closure alive for the full llmTimeout after every
		// (fast) step, stacking timers on long runs and delaying clean shutdown.
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		try {
			// Call LLM with timeout
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(
					() => reject(new Error(`LLM call timed out after ${this.settings.llmTimeout} seconds`)),
					this.settings.llmTimeout * 1000
				);
			});

			const modelOutput = await Promise.race([
				this._getModelOutputWithRetry(inputMessages),
				timeoutPromise,
			]);

			this.state.lastModelOutput = modelOutput;

			// Check again for paused/stopped state after getting model output
			await this._checkStopOrPause();

			// Handle callbacks and conversation saving
			await this._handlePostLLMProcessing(browserStateSummary, inputMessages);

			// Check again if Ctrl+C was pressed before we commit the output to history
			await this._checkStopOrPause();
		} catch (error) {
			if (error instanceof Error && error.message.includes('timeout')) {
				throw new Error(
					`LLM call timed out after ${this.settings.llmTimeout} seconds. Keep your thinking and output short.`
				);
			}
			throw error;
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	}

	/**
	 * Phase 3: Execute the actions from model output
	 */
	private async _executeActions(): Promise<void> {
		if (!this.state.lastModelOutput) {
			throw new Error('No model output to execute actions from');
		}

		const result = await this.multiAct(this.state.lastModelOutput.action);
		this.state.lastResult = result;
	}

	/**
	 * Phase 4: Handle post-action processing like download tracking and result logging
	 */
	private async _postProcess(): Promise<void> {
		// Check for new downloads after executing actions (like Python)
		await this._checkAndUpdateDownloads('after executing actions');

		// Update plan state from model output
		if (this.state.lastModelOutput) {
			this._updatePlanFromModelOutput(this.state.lastModelOutput);
		}

		// Record executed actions for loop detection
		this._updateLoopDetectorActions();

		// Consecutive failures: only single-action steps that errored count (Python 0.13);
		// multi-action steps with partial errors are handled by loop detection and replan nudges.
		if (this.state.lastResult && this.state.lastResult.length > 0) {
			const errorResults = this.state.lastResult.filter((r) => r.error);
			const lastResult = this.state.lastResult[this.state.lastResult.length - 1];
			const stepCompletedSuccessfully = Boolean(lastResult.isDone) && !lastResult.error;

			if (this.state.lastResult.length === 1 && lastResult.error) {
				this.state.consecutiveFailures++;
				console.log(`🔄 Step ${this.state.nSteps}: Consecutive failures: ${this.state.consecutiveFailures}`);
				return;
			}
			if ((errorResults.length === 0 || stepCompletedSuccessfully) && this.state.consecutiveFailures > 0) {
				this.state.consecutiveFailures = 0;
				console.log(`🔄 Step ${this.state.nSteps}: Consecutive failures reset to: ${this.state.consecutiveFailures}`);
			}
		}

		// Log completion results
		if (
			this.state.lastResult &&
			this.state.lastResult.length > 0 &&
			this.state.lastResult[this.state.lastResult.length - 1].isDone
		) {
			const lastResult = this.state.lastResult[this.state.lastResult.length - 1];
			const success = lastResult.success ?? false;
			if (success) {
				console.log(`\n📄 \x1b[32m Final Result:\x1b[0m \n${lastResult.extractedContent}\n\n`);
			} else {
				console.log(`\n📄 \x1b[31m Final Result:\x1b[0m \n${lastResult.extractedContent}\n\n`);
			}

			// Log attachments (like Python _post_process lines 804-807)
			if (lastResult.attachments && lastResult.attachments.length > 0) {
				for (let i = 0; i < lastResult.attachments.length; i++) {
					console.log(`👉 Attachment ${i + 1}: ${lastResult.attachments[i]}`);
				}
			}
		}
	}

	// Exponential backoff retry configuration (like Python)
	private readonly BASE_RETRY_DELAY = 5.0; // 5 seconds base delay
	private readonly MAX_RETRY_DELAY = 30.0; // 30 seconds max delay

	/**
	 * Handle all types of errors that can occur during a step
	 * Includes exponential backoff retry delay (like Python service.py lines 2852-2905)
	 */
	private async _handleStepError(error: any): Promise<void> {
		// Handle InterruptedError specially
		if (error instanceof Error && error.message === 'Interrupted') {
			const errorMsg = 'The agent was interrupted mid-step';
			console.error(`${errorMsg}`);
			return;
		}

		// Browser closed / disconnected: stop the agent instead of retrying against a dead browser
		if (this._isConnectionLikeError(error) && !this._isBrowserAvailable()) {
			console.warn(`🛑 Browser closed or disconnected: ${error instanceof Error ? error.message : String(error)}`);
			this.state.stopped = true;
			this.state.lastResult = [{ error: `Browser closed or disconnected: ${error instanceof Error ? error.message : String(error)}` }];
			return;
		}

		// Handle all other exceptions
		const errorMsg = error instanceof Error ? AgentError.formatError(error, false) : String(error);
		const maxTotalFailures = this.settings.maxFailures + (this.settings.finalResponseAfterFailure ? 1 : 0);
		const prefix = `❌ Result failed ${this.state.consecutiveFailures + 1}/${maxTotalFailures} times: `;
		this.state.consecutiveFailures++;

		if (this.state.consecutiveFailures >= maxTotalFailures) {
			console.error(`${prefix}${errorMsg}`);
		} else {
			console.warn(`${prefix}${errorMsg}`);
		}
		this.state.lastResult = [{ error: errorMsg }];

		// Exponential backoff delay before next retry (like Python)
		// Formula: min(base * 2^(retryCount-1), maxDelay)
		if (this.state.consecutiveFailures < this.settings.maxFailures) {
			const retryDelay = Math.min(
				this.BASE_RETRY_DELAY * Math.pow(2, this.state.consecutiveFailures - 1),
				this.MAX_RETRY_DELAY
			);
			console.log(`⏳ Waiting ${retryDelay.toFixed(1)}s before retry (exponential backoff)`);
			await new Promise(resolve => setTimeout(resolve, retryDelay * 1000));
		}
	}

	/**
	 * Create and store history item
	 */
	private async _makeHistoryItem(
		modelOutput: AgentOutput | null,
		browserStateSummary: BrowserStateSummary,
		result: ActionResult[],
		metadata: StepMetadata | null = null,
		stateMessage: string | null = null
	): Promise<void> {
		let interactedElements: (any | null)[] = [];

		if (modelOutput) {
			// Use actual selector map from browser state (like Python)
			const selectorMap = browserStateSummary.domState?.selectorMap || new Map<number, any>();
			interactedElements = getInteractedElement(modelOutput as any, selectorMap);
		} else {
			interactedElements = [null];
		}

		// Store screenshot and get path
		let screenshotPath: string | null = null;
		if (browserStateSummary.screenshot) {
			console.log(
				`📸 Storing screenshot for step ${this.state.nSteps}, screenshot length: ${browserStateSummary.screenshot.length}`
			);
			screenshotPath = await this.screenshotService.storeScreenshot(
				browserStateSummary.screenshot,
				this.state.nSteps
			);
			console.log(`📸 Screenshot stored at: ${screenshotPath}`);
		} else {
			console.log(`📸 No screenshot in browser_state_summary for step ${this.state.nSteps}`);
		}

		const stateHistory: BrowserStateHistory = {
			url: browserStateSummary.url,
			title: browserStateSummary.title,
			tabs: browserStateSummary.tabs,
			interactedElement: interactedElements,
			screenshotPath: screenshotPath,
		};

		const historyItem: AgentHistory = {
			modelOutput: modelOutput as any,
			result: result as any,
			state: stateHistory,
			metadata: metadata ?? null,
			stateMessage: stateMessage ?? null,
		};

		// Push to history (casting because types/agent.AgentHistory is different from agent/views.AgentHistory)
		(this.history.history as any).push(historyItem);
	}

	/**
	 * Finalize the step with history, logging, and events
	 */
	private async _finalize(
		browserStateSummary: BrowserStateSummary | null,
		stepStartTime: number
	): Promise<void> {
		const stepEndTime = Date.now();

		if (!this.state.lastResult) {
			return;
		}

		if (browserStateSummary && this.state.lastModelOutput) {
			// Duration of the previous step (paces history reruns)
			let stepInterval: number | null = null;
			const previous = this.history.history[this.history.history.length - 1];
			if (previous?.metadata) {
				stepInterval = Math.max(0, previous.metadata.stepEndTime - previous.metadata.stepStartTime);
			}

			// Create history item with metadata
			const metadata: StepMetadata = {
				stepStartTime: stepStartTime,
				stepEndTime: stepEndTime,
				stepNumber: this.state.nSteps,
				stepInterval,
			};

			await this._makeHistoryItem(
				this.state.lastModelOutput as any,
				browserStateSummary,
				this.state.lastResult as any,
				metadata,
				null
			);

			// Log step completion summary
			this._logStepCompletionSummary(stepStartTime, this.state.lastResult || []);
		}

		// Increment step counter after step is fully completed
		this.state.nSteps++;
	}

	/**
	 * Handle special processing for the last step
	 */
	private async _forceDoneAfterLastStep(stepInfo: AgentStepInfo | null = null): Promise<void> {
		if (stepInfo && isLastStep(stepInfo)) {
			const msg =
				'You reached max_steps - this is your last step. Your only tool available is the "done" tool. No other tool is available. All other tools which you see in history or examples are not available.\n' +
				'If the task is not yet fully finished as requested by the user, set success in "done" to false! E.g. if not all steps are fully completed. Else success to true.\n' +
				'Include everything you found out for the ultimate task in the done text.';
			console.log('Last step finishing up');
			this.messageManager.addContextMessage(createUserMessage(msg));
			// Switch to DoneAgentOutput model (like Python's self.AgentOutput = self.DoneAgentOutput)
			if (this.doneAgentOutputSchema) {
				this.dynamicAgentOutputSchema = this.doneAgentOutputSchema;
			}
		}
	}

	/**
	 * Force done after failure
	 */
	private async _forceDoneAfterFailure(): Promise<void> {
		if (
			this.state.consecutiveFailures >= this.settings.maxFailures &&
			this.settings.finalResponseAfterFailure
		) {
			const msg =
				`You failed ${this.settings.maxFailures} times. Therefore we terminate the agent.\n` +
				'Your only tool available is the "done" tool. No other tool is available. All other tools which you see in history or examples are not available.\n' +
				'If the task is not yet fully finished as requested by the user, set success in "done" to false! E.g. if not all steps are fully completed. Else success to true.\n' +
				'Include everything you found out for the ultimate task in the done text.';
			console.log('Force done action, because we reached max_failures.');
			this.messageManager.addContextMessage(createUserMessage(msg));
			// Switch to DoneAgentOutput model (like Python's self.AgentOutput = self.DoneAgentOutput)
			if (this.doneAgentOutputSchema) {
				this.dynamicAgentOutputSchema = this.doneAgentOutputSchema;
			}
		}
	}

	/**
	 * Inject a prominent budget warning when the agent has used >= 75% of its step budget.
	 * This gives the LLM advance notice to wrap up, save partial results, and call done
	 * rather than exhausting all steps with nothing saved.
	 * Port from Python browser_use/agent/service.py _inject_budget_warning
	 */
	private async _injectBudgetWarning(stepInfo: AgentStepInfo | null = null): Promise<void> {
		if (!stepInfo) {
			return;
		}

		const stepsUsed = stepInfo.stepNumber + 1; // Convert 0-indexed to 1-indexed
		const budgetRatio = stepsUsed / stepInfo.maxSteps;

		if (budgetRatio >= 0.75 && !isLastStep(stepInfo)) {
			const stepsRemaining = stepInfo.maxSteps - stepsUsed;
			const pct = Math.floor(budgetRatio * 100);
			const msg =
				`BUDGET WARNING: You have used ${stepsUsed}/${stepInfo.maxSteps} steps ` +
				`(${pct}%). ${stepsRemaining} steps remaining. ` +
				`If the task cannot be completed in the remaining steps, prioritize: ` +
				`(1) consolidate your results (save to files if the file system is in use), ` +
				`(2) call done with what you have. ` +
				`Partial results are far more valuable than exhausting all steps with nothing saved.`;
			console.log(`Step budget warning: ${stepsUsed}/${stepInfo.maxSteps} (${pct}%)`);
			this.messageManager.addContextMessage(createUserMessage(msg));
		}
	}

	/**
	 * Emit a `cache_stats` JSON log for one LLM request and fold the numbers
	 * into the session accumulator. Schema is aligned with snowx-api-v2 so a
	 * shared aggregator can grep `tag:"cache_stats"` across both systems.
	 *
	 * `promptTokens` on ChatInvokeUsage = input + cacheRead (anthropic.ts
	 * convention). So uncached input = promptTokens - cacheRead.
	 */
	private _emitCacheStats(usage: any): void {
		if (!usage) return;
		const promptTokens = usage.promptTokens ?? 0;
		const cacheRead = usage.promptCachedTokens ?? 0;
		const cacheCreate = usage.promptCacheCreationTokens ?? 0;
		const input = Math.max(0, promptTokens - cacheRead);
		const total = input + cacheRead + cacheCreate;
		const hitRatio = total > 0 ? cacheRead / total : 0;

		this.cacheStats.requests += 1;
		this.cacheStats.input += input;
		this.cacheStats.cacheRead += cacheRead;
		this.cacheStats.cacheCreate += cacheCreate;

		console.log(
			JSON.stringify({
				tag: 'cache_stats',
				scope: 'request',
				source: 'orion-electron',
				provider: this.llm.provider ?? 'unknown',
				model: this.llm.model,
				agentId: this.id,
				step: this.state.nSteps,
				input,
				cacheRead,
				cacheCreate,
				totalPromptTokens: total,
				hitRatio: Number(hitRatio.toFixed(4)),
			})
		);
	}

	private _emitSessionCacheStats(endReason: string): void {
		if (this.cacheStats.requests === 0) return;
		const { input, cacheRead, cacheCreate, requests } = this.cacheStats;
		const total = input + cacheRead + cacheCreate;
		const hitRatio = total > 0 ? cacheRead / total : 0;

		console.log(
			JSON.stringify({
				tag: 'cache_stats',
				scope: 'session',
				source: 'orion-electron',
				provider: this.llm.provider ?? 'unknown',
				model: this.llm.model,
				agentId: this.id,
				steps: this.state.nSteps,
				requests,
				input,
				cacheRead,
				cacheCreate,
				totalPromptTokens: total,
				hitRatio: Number(hitRatio.toFixed(4)),
				endReason,
			})
		);
	}

	/**
	 * Get model output with retry logic for empty actions
	 * Matches Python's _get_model_output_with_retry implementation
	 */
	private async _getModelOutputWithRetry(inputMessages: BaseMessage[]): Promise<AgentOutput> {
		// Use dynamic schema with proper action types for strict mode compatibility
		const schema = this.dynamicAgentOutputSchema || AgentOutputSchema;

		// Replace long URLs with shortened versions (like Python get_model_output line 1186)
		const urlsReplaced = this._processMessagesAndReplaceLongUrls(inputMessages);

		// Call LLM with structured output (switching to the fallback LLM once on provider errors)
		const response = await this._invokeAgentLlm(inputMessages, schema);
		this._emitCacheStats(response.usage);
		let modelOutput = response.completion as AgentOutput;

		// Restore shortened URLs back to originals in the response (like Python lines 1196-1198)
		if (Object.keys(urlsReplaced).length > 0) {
			this._restoreShortenedUrlsInAgentOutput(modelOutput, urlsReplaced);
		}

		console.log(
			`✅ Step ${this.state.nSteps}: Got LLM response with ${modelOutput.action?.length ?? 0} actions`
		);

		// Check if model returned empty actions (matching Python's comprehensive check)
		// Python checks: all(action.model_dump() == {} for action in model_output.action)
		const isEmptyActions = (actions: any[]): boolean => {
			if (!actions || !Array.isArray(actions) || actions.length === 0) {
				return true;
			}
			// Check if all actions are empty objects (like Python's model_dump() == {})
			return actions.every((action) => {
				if (!action || typeof action !== 'object') return true;
				const keys = Object.keys(action);
				return keys.length === 0;
			});
		};

		if (isEmptyActions(modelOutput.action)) {
			console.warn('Model returned empty action. Retrying...');

			const clarificationMessage = createUserMessage(
				'You forgot to return an action. Please respond with a valid JSON action according to the expected schema with your assessment and next actions.'
			);

			const retryMessages = [...inputMessages, clarificationMessage];
			const retryResponse = await this.llm.ainvoke(retryMessages, schema);
			this._emitCacheStats(retryResponse.usage);
			modelOutput = retryResponse.completion as AgentOutput;

			if (isEmptyActions(modelOutput.action)) {
				console.warn('Model still returned empty after retry. Inserting safe done action.');
				// Create a safe done action to prevent infinite loop (like Python's noop action)
				modelOutput = {
					...modelOutput,
					action: [
						{
							done: {
								success: false,
								text: 'No next action returned by LLM!',
							},
						} as any,
					],
				};
			}
		}

		// Cut the number of actions to max_actions_per_step if needed (like Python)
		if (modelOutput.action && modelOutput.action.length > this.settings.maxActionsPerStep) {
			console.log(`✂️ Limiting actions from ${modelOutput.action.length} to ${this.settings.maxActionsPerStep}`);
			modelOutput.action = modelOutput.action.slice(0, this.settings.maxActionsPerStep);
		}

		return modelOutput;
	}

	/**
	 * Handle callbacks and conversation saving after LLM interaction
	 */
	private async _handlePostLLMProcessing(
		browserStateSummary: BrowserStateSummary,
		inputMessages: BaseMessage[]
	): Promise<void> {
		// Call new step callback if registered
		if (this.registerNewStepCallback && this.state.lastModelOutput) {
			await this.registerNewStepCallback(
				browserStateSummary,
				this.state.lastModelOutput as any,
				this.state.nSteps
			);
		}

		// Save conversation if path is set
		if (this.settings.saveConversationPath && this.state.lastModelOutput) {
			await this.saveConversationStep(inputMessages);
		}
	}

	/**
	 * Check if the agent should stop or pause
	 */
	private async _checkStopOrPause(): Promise<void> {
		// Check should_stop_callback - sets stopped state cleanly without raising
		if (this.registerShouldStopCallback) {
			const shouldStop = await this.registerShouldStopCallback();
			if (shouldStop) {
				console.log('External callback requested stop');
				this.state.stopped = true;
				throw new Error('Interrupted');
			}
		}

		// Check external agent status callback
		if (this.registerExternalAgentStatusRaiseErrorCallback) {
			const shouldRaiseError = await this.registerExternalAgentStatusRaiseErrorCallback();
			if (shouldRaiseError) {
				throw new Error('Interrupted');
			}
		}

		if (this.state.stopped) {
			throw new Error('Interrupted');
		}

		if (this.state.paused) {
			throw new Error('Interrupted');
		}
	}

	// ============================================================================
	// History Persistence Methods
	// ============================================================================

	/**
	 * Save the history to a file with sensitive data filtering
	 * @param filePath Path to save to (defaults to 'AgentHistory.json')
	 */
	async saveHistory(filePath: string = 'AgentHistory.json'): Promise<void> {
		const { saveHistoryToFile } = await import('../types/agent.js');
		await saveHistoryToFile(this.history, filePath, this.sensitiveData);
		console.log(`📝 Saved agent history to ${filePath}`);
	}

	/**
	 * Load history from file and rerun it
	 * @param historyFile Path to the history file (defaults to 'AgentHistory.json')
	 * @param options Rerun options
	 */
	async loadAndRerun(
		historyFile: string = 'AgentHistory.json',
		options?: {
			maxRetries?: number;
			skipFailures?: boolean;
			delayBetweenActions?: number;
		}
	): Promise<ActionResult[]> {
		const { loadHistoryFromFile } = await import('../types/agent.js');
		const history = await loadHistoryFromFile(historyFile);
		return this.rerunHistory(history, options);
	}

	/**
	 * Rerun a saved history of actions with error handling and retry logic
	 * @param history The history to replay
	 * @param options Rerun options
	 */
	async rerunHistory(
		history: AgentHistoryList,
		options: {
			maxRetries?: number;
			skipFailures?: boolean;
			delayBetweenActions?: number;
		} = {}
	): Promise<ActionResult[]> {
		const {
			maxRetries = 3,
			skipFailures = true,
			delayBetweenActions = 2.0,
		} = options;

		// Initialize browser session
		await this.browserSession.start();

		const results: ActionResult[] = [];

		for (let i = 0; i < history.history.length; i++) {
			const historyItem = history.history[i] as AgentHistoryType;
			const goal = historyItem.modelOutput?.nextGoal || '';
			const stepNum = historyItem.metadata?.stepNumber ?? i;
			const stepName = stepNum === 0 ? 'Initial actions' : `Step ${stepNum}`;

			console.log(`Replaying ${stepName} (${i + 1}/${history.history.length}): ${goal}`);

			if (!historyItem.modelOutput?.action || historyItem.modelOutput.action.length === 0) {
				console.warn(`${stepName}: No action to replay, skipping`);
				results.push({ error: 'No action to replay' });
				continue;
			}

			let retryCount = 0;
			while (retryCount < maxRetries) {
				try {
					const result = await this._executeHistoryStep(historyItem, delayBetweenActions);
					results.push(...result);
					break;
				} catch (error: any) {
					retryCount++;
					if (retryCount === maxRetries) {
						const errorMsg = `${stepName} failed after ${maxRetries} attempts: ${error.message}`;
						console.error(errorMsg);
						if (!skipFailures) {
							results.push({ error: errorMsg });
							throw new Error(errorMsg);
						}
					} else {
						console.warn(`${stepName} failed (attempt ${retryCount}/${maxRetries}), retrying...`);
						await this._sleep(delayBetweenActions * 1000);
					}
				}
			}
		}

		if (this.ownsBrowserSession) {
			await this.browserSession.stop();
		}
		return results;
	}

	/**
	 * Execute a single step from history
	 */
	private async _executeHistoryStep(
		historyItem: AgentHistoryType,
		delay: number
	): Promise<ActionResult[]> {
		if (!historyItem.modelOutput?.action) {
			throw new Error('Invalid model output');
		}

		// Execute the actions using multiAct
		const results = await this.multiAct(historyItem.modelOutput.action);

		await this._sleep(delay * 1000);
		return results;
	}

	/**
	 * Sleep helper
	 */
	private _sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	// ============================================================================
	// URL Shortening (token optimization)
	// ============================================================================

	/** URL shortening limit for query/fragment part (like Python _url_shortening_limit = 25) */
	private readonly URL_SHORTENING_LIMIT = 25;

	/**
	 * Replace long URLs in text with shortened versions to reduce token usage.
	 * Matches Python's _replace_urls_in_text implementation.
	 * Returns the modified text and a mapping of shortened to original URLs.
	 */
	private _replaceUrlsInText(text: string): { text: string; urlMap: Record<string, string> } {
		const urlMap: Record<string, string> = {};

		// URL regex pattern (matches Python's URL_PATTERN)
		const urlPattern = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/gi;

		const replacedText = text.replace(urlPattern, (originalUrl: string) => {
			// Find where the query/fragment starts (matches Python logic)
			const queryStart = originalUrl.indexOf('?');
			const fragmentStart = originalUrl.indexOf('#');

			// Find the earliest position of query or fragment
			let afterPathStart = originalUrl.length; // Default: no query/fragment
			if (queryStart !== -1) {
				afterPathStart = Math.min(afterPathStart, queryStart);
			}
			if (fragmentStart !== -1) {
				afterPathStart = Math.min(afterPathStart, fragmentStart);
			}

			// Split URL into base (up to path) and afterPath (query + fragment)
			const baseUrl = originalUrl.substring(0, afterPathStart);
			const afterPath = originalUrl.substring(afterPathStart);

			// If afterPath is within the limit, don't shorten (matches Python)
			if (afterPath.length <= this.URL_SHORTENING_LIMIT) {
				return originalUrl;
			}

			// If afterPath is too long, truncate and add hash (matches Python)
			if (afterPath) {
				const truncatedAfterPath = afterPath.substring(0, this.URL_SHORTENING_LIMIT);
				// Create a short hash of the full afterPath content (7 chars like Python)
				const shortHash = crypto.createHash('md5').update(afterPath).digest('hex').substring(0, 7);
				// Create shortened URL (matches Python format: base + truncated + ... + hash)
				const shortened = `${baseUrl}${truncatedAfterPath}...${shortHash}`;
				// Only use shortened URL if it's actually shorter than the original (matches Python)
				if (shortened.length < originalUrl.length) {
					urlMap[shortened] = originalUrl;
					return shortened;
				}
			}

			return originalUrl;
		});

		return { text: replacedText, urlMap };
	}

	/**
	 * Process messages and replace long URLs with shortened ones.
	 * Returns a map of shortened to original URLs.
	 */
	private _processMessagesAndReplaceLongUrls(messages: BaseMessage[]): Record<string, string> {
		const allUrlMappings: Record<string, string> = {};

		for (const message of messages) {
			if (typeof message.content === 'string') {
				const { text, urlMap } = this._replaceUrlsInText(message.content);
				message.content = text;
				Object.assign(allUrlMappings, urlMap);
			} else if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if ((part as any).type === 'text' && (part as any).text) {
						const { text, urlMap } = this._replaceUrlsInText((part as any).text);
						(part as any).text = text;
						Object.assign(allUrlMappings, urlMap);
					}
				}
			}
		}

		return allUrlMappings;
	}

	/**
	 * Replace shortened URLs back to their original versions in text.
	 */
	private _replaceShortenedUrlsInString(text: string, urlReplacements: Record<string, string>): string {
		let result = text;
		for (const [shortenedUrl, originalUrl] of Object.entries(urlReplacements)) {
			result = result.split(shortenedUrl).join(originalUrl);
		}
		return result;
	}

	/**
	 * Recursively restore shortened URLs in AgentOutput (like Python _recursive_process_all_strings_inside_pydantic_model)
	 * Processes all string fields in the agent output, replacing shortened URLs with originals.
	 */
	private _restoreShortenedUrlsInAgentOutput(output: AgentOutput, urlReplacements: Record<string, string>): void {
		// Helper function to recursively process objects
		const processValue = (value: any): any => {
			if (typeof value === 'string') {
				return this._replaceShortenedUrlsInString(value, urlReplacements);
			}
			if (Array.isArray(value)) {
				return value.map(item => processValue(item));
			}
			if (value !== null && typeof value === 'object') {
				for (const key of Object.keys(value)) {
					value[key] = processValue(value[key]);
				}
			}
			return value;
		};

		// Process current_state.evaluation if exists
		if (output.current_state?.evaluation) {
			output.current_state.evaluation = this._replaceShortenedUrlsInString(
				output.current_state.evaluation,
				urlReplacements
			);
		}

		// Process current_state.memory if exists
		if (output.current_state?.memory) {
			output.current_state.memory = this._replaceShortenedUrlsInString(
				output.current_state.memory,
				urlReplacements
			);
		}

		// Process next_goal if exists
		if (output.current_state?.next_goal) {
			output.current_state.next_goal = this._replaceShortenedUrlsInString(
				output.current_state.next_goal,
				urlReplacements
			);
		}

		// Process each action
		if (output.action && Array.isArray(output.action)) {
			for (const action of output.action) {
				// Process all properties in the action recursively
				for (const key of Object.keys(action)) {
					action[key] = processValue(action[key]);
				}
			}
		}
	}

	// ============================================================================
	// Download Tracking
	// ============================================================================

	private lastKnownDownloads: string[] = [];
	private availableFilePaths: string[] = [];

	/**
	 * Check for new downloads and update available file paths.
	 */
	private async _checkAndUpdateDownloads(context: string = ''): Promise<void> {
		if (!this.browserSession) {
			return;
		}

		try {
			// Get current downloads from browser session
			const currentDownloads = (this.browserSession as any).downloadedFiles || [];

			if (JSON.stringify(currentDownloads) !== JSON.stringify(this.lastKnownDownloads)) {
				this._updateAvailableFilePaths(currentDownloads);
				this.lastKnownDownloads = [...currentDownloads];
				if (context) {
					console.debug(`📁 ${context}: Updated available files`);
				}
			}
		} catch (error: any) {
			const errorContext = context ? ` ${context}` : '';
			console.debug(`📁 Failed to check for downloads${errorContext}: ${error.message}`);
		}
	}

	/**
	 * Update available file paths with downloaded files.
	 */
	private _updateAvailableFilePaths(downloads: string[]): void {
		const currentFiles = new Set(this.availableFilePaths);
		const newFiles = downloads.filter(f => !currentFiles.has(f));

		if (newFiles.length > 0) {
			this.availableFilePaths = [...currentFiles, ...newFiles];
			console.info(
				`📁 Added ${newFiles.length} downloaded files to available_file_paths (total: ${this.availableFilePaths.length} files)`
			);
			for (const filePath of newFiles) {
				console.info(`📄 New file available: ${filePath}`);
			}
		}
	}

	// ============================================================================
	// File System State
	// ============================================================================

	/**
	 * Save current file system state to agent state.
	 */
	saveFileSystemState(): void {
		if (this.fileSystem) {
			(this.state as any).fileSystemState = this.fileSystem.getState();
		} else {
			console.error('💾 File system is not set up. Cannot save state.');
			throw new Error('File system is not set up. Cannot save state.');
		}
	}

	// ============================================================================
	// Text Processing
	// ============================================================================

	/**
	 * Remove <think> tags from LLM output text.
	 * Handles both well-formed and stray closing tags.
	 */
	private _removeThinkTags(text: string): string {
		// Step 1: Remove well-formed <think>...</think>
		let result = text.replace(/<think>[\s\S]*?<\/think>/g, '');
		// Step 2: If there's an unmatched closing tag </think>, remove everything up to it
		result = result.replace(/[\s\S]*?<\/think>/g, '');
		return result.trim();
	}

	/**
	 * Enhance task description with output schema information if provided.
	 */
	private _enhanceTaskWithSchema(task: string, outputSchema: z.ZodType<any> | null): string {
		if (!outputSchema) {
			return task;
		}

		try {
			// Get JSON schema from Zod schema
			// zodToJsonSchema is imported at top of file
			const schema = zodToJsonSchema(outputSchema);
			const schemaJson = JSON.stringify(schema, null, 2);

			const enhancement = `\nExpected output format:\n${schemaJson}`;
			return task + enhancement;
		} catch (error: any) {
			console.debug(`Could not parse output schema: ${error.message}`);
		}

		return task;
	}

	/**
	 * Convert dictionary-based actions to validated action objects.
	 */
	private _convertInitialActions(actions: Array<Record<string, any>>): any[] {
		const convertedActions: any[] = [];

		for (const actionDict of actions) {
			// Each action_dict should have a single key-value pair
			const actionName = Object.keys(actionDict)[0];
			const params = actionDict[actionName];

			// Get the action info from registry if available
			const actionInfo = this.actionRegistry.getAction(actionName);
			if (actionInfo && actionInfo.paramSchema) {
				try {
					// Validate params using the schema
					const validatedParams = actionInfo.paramSchema.parse(params);
					convertedActions.push({ [actionName]: validatedParams });
				} catch {
					// If validation fails, use raw params
					convertedActions.push(actionDict);
				}
			} else {
				convertedActions.push(actionDict);
			}
		}

		return convertedActions;
	}

	// ============================================================================
	// History Utilities
	// ============================================================================

	/**
	 * Get complete history without screenshots (for logging/debugging).
	 */
	private _getCompleteHistoryWithoutScreenshots(): string {
		const historyData = JSON.parse(JSON.stringify(this.history));

		if (historyData.history) {
			for (const item of historyData.history) {
				if (item.state && item.state.screenshot) {
					item.state.screenshot = null;
				}
			}
		}

		return JSON.stringify(historyData);
	}

	/**
	 * Extract website URL from task text.
	 */
	static extractTaskWebsite(taskText: string): string | null {
		const urlPattern = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[^\s<>"']+\.[a-z]{2,}(?:\/[^\s<>"']*)?/i;
		const match = taskText.match(urlPattern);
		return match ? match[0] : null;
	}

	// ============================================================================
	// Cloud Sync
	// ============================================================================

	/**
	 * Authenticate with cloud service for future runs.
	 * Note: Cloud sync is currently not available.
	 */
	async authenticateCloudSync(showInstructions: boolean = true): Promise<boolean> {
		console.warn('Cloud sync has been removed and is no longer available');
		return false;
	}

	// ============================================================================
	// Logging Methods
	// ============================================================================

	/**
	 * Log agent run start.
	 */
	private _logAgentRun(): void {
		const browserSessionId = this.browserSession?.id?.slice(-4) || '----';
		console.log(`🤖 Agent ${this.id.slice(-4)} started with browser session ${browserSessionId}`);
	}

	/**
	 * Log first step startup information.
	 */
	private _logFirstStepStartup(): void {
		console.log(`📋 Task: ${this.task}`);
		console.log(`🔧 Settings: maxSteps=${this.maxSteps}, useVision=${this.settings.useVision}`);
	}

	/**
	 * Log final outcome messages.
	 */
	private _logFinalOutcomeMessages(): void {
		const finalResult = this.history.finalResult;
		if (finalResult) {
			if (finalResult.success) {
				console.log('✅ Task completed successfully');
			} else {
				console.log('❌ Task failed');
			}
			if (finalResult.extractedContent) {
				console.log(`📄 Result: ${finalResult.extractedContent.slice(0, 200)}...`);
			}
		}
	}

	/**
	 * Log next action summary.
	 */
	private _logNextActionSummary(parsed: AgentOutput): void {
		if (parsed.nextGoal) {
			console.log(`🎯 Next goal: ${parsed.nextGoal}`);
		}
		if (parsed.action && parsed.action.length > 0) {
			const actionNames = parsed.action.map(a => Object.keys(a)[0]).join(', ');
			console.log(`⚡ Actions: ${actionNames}`);
		}
	}

	/**
	 * Log agent telemetry event.
	 */
	private _logAgentEvent(maxSteps: number, agentRunError: string | null = null): void {
		// Emit telemetry event
		const event = {
			type: 'agent_run',
			agentId: this.id,
			task: this.task,
			maxSteps,
			stepsCompleted: this.state.nSteps,
			success: this.history.finalResult?.success ?? false,
			error: agentRunError,
			timestamp: new Date().toISOString(),
		};
		console.debug('📊 Agent event:', JSON.stringify(event));
	}
}

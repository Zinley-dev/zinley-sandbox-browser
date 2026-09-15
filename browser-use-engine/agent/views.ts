/**
 * Agent views and state models
 * Port from browser_use/agent/views.py (Python browser-use 0.13.10)
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DOMInteractedElement, DOMSelectorMap, DEFAULT_INCLUDE_ATTRIBUTES, createDOMInteractedElement } from '../dom/views.js';
import { BrowserStateHistory } from '../browser/views.js';
import type { BaseChatModel } from '../llm/base.js';
import { collectSensitiveDataValues, redactSensitiveString } from '../utils.js';
import type { JudgementResult } from './judge.js';
import { createMessageManagerState, type MessageManagerState } from './message_manager/views.js';

export type { JudgementResult } from './judge.js';
export type { DetectedVariable, VariableMetadata } from './variable_detector.js';

// ============================================================================
// Message compaction settings
// ============================================================================

/** Summarizes older history into a compact memory block to reduce prompt size. */
export interface MessageCompactionSettings {
	enabled: boolean;
	compactEveryNSteps: number;
	/** Min char floor; derived from triggerTokenCount when that is set */
	triggerCharCount: number;
	/** Alternative to triggerCharCount (~4 chars/token) */
	triggerTokenCount?: number | null;
	charsPerToken: number;
	keepLastItems: number;
	summaryMaxChars: number;
	includeReadState: boolean;
	compactionLlm?: BaseChatModel | null;
}

export type MessageCompactionInput = Partial<Omit<MessageCompactionSettings, 'triggerCharCount'>> & {
	triggerCharCount?: number | null;
};

/**
 * Resolve user-supplied compaction settings to a complete object (Python model_validator).
 * `true` enables defaults, `false`/`null`/`undefined` disables.
 */
export function resolveMessageCompactionSettings(
	input: MessageCompactionInput | boolean | null | undefined
): MessageCompactionSettings | null {
	if (input === false || input === null || input === undefined) {
		return null;
	}
	const raw: MessageCompactionInput = input === true ? {} : input;
	if (raw.triggerCharCount != null && raw.triggerTokenCount != null) {
		throw new Error('Set triggerCharCount or triggerTokenCount, not both.');
	}
	const charsPerToken = raw.charsPerToken ?? 4.0;
	let triggerCharCount: number;
	if (raw.triggerTokenCount != null) {
		triggerCharCount = Math.trunc(raw.triggerTokenCount * charsPerToken);
	} else if (raw.triggerCharCount != null) {
		triggerCharCount = raw.triggerCharCount;
	} else {
		triggerCharCount = 40000; // ~10k tokens
	}
	return {
		enabled: raw.enabled ?? true,
		compactEveryNSteps: raw.compactEveryNSteps ?? 25,
		triggerCharCount,
		triggerTokenCount: raw.triggerTokenCount ?? null,
		charsPerToken,
		keepLastItems: raw.keepLastItems ?? 6,
		summaryMaxChars: raw.summaryMaxChars ?? 6000,
		includeReadState: raw.includeReadState ?? false,
		compactionLlm: raw.compactionLlm ?? null,
	};
}

// ============================================================================
// Agent Settings
// ============================================================================

export interface AgentSettings {
	useVision: boolean | 'auto';
	visionDetailLevel: 'auto' | 'low' | 'high';
	saveConversationPath: string | null;
	saveConversationPathEncoding: string | null;
	maxFailures: number;
	generateGif: boolean | string;
	overrideSystemMessage: string | null;
	extendSystemMessage: string | null;
	includeAttributes: string[] | null;
	maxActionsPerStep: number;
	useThinking: boolean;
	flashMode: boolean; // If enabled, disables evaluation_previous_goal and next_goal, and sets use_thinking = false
	/** Run an LLM judge over the trace when the agent finishes (extra LLM call) */
	useJudge: boolean;
	/** Ground truth answer or criteria for judge validation */
	groundTruth: string | null;
	/** LLM used for the judge (defaults to the agent LLM) */
	judgeLlm: BaseChatModel | null;
	maxHistoryItems: number | null;
	/** Summarize older history into a compact memory block; null disables */
	messageCompaction: MessageCompactionSettings | null;
	enablePlanning: boolean;
	/** Consecutive failures before a replan nudge; 0 = disabled */
	planningReplanOnStall: number;
	/** Steps without a plan before a planning nudge; 0 = disabled */
	planningExplorationLimit: number;

	pageExtractionLlm: BaseChatModel | null;
	/** LLM to switch to after rate limit / provider errors on the primary LLM */
	fallbackLlm: BaseChatModel | null;
	/** JSON schema injected into the extract action for structured output */
	extractionSchema: Record<string, any> | null;
	calculateCost: boolean;
	includeToolCallExamples: boolean;
	llmTimeout: number; // Timeout in seconds for LLM calls
	stepTimeout: number; // Timeout in seconds for each step
	finalResponseAfterFailure: boolean; // If True, attempt one final recovery call after max_failures
	directlyOpenUrl: boolean; // If True, extract URL from task and navigate directly at start
	includeRecentEvents: boolean; // If True, include recent browser events in state
	sampleImages: any[] | null; // Sample images to show to the LLM
	availableFilePaths: string[] | null; // File paths available for the agent
	waitBetweenActions: number; // Wait time between actions in seconds (Python: browser_profile.wait_between_actions)

	// Loop detection settings
	loopDetectionWindow: number; // Rolling window size for action similarity tracking
	loopDetectionEnabled: boolean; // Whether to enable loop detection nudges
	maxClickableElementsLength: number; // Max characters for clickable elements in prompt
	/** Resize screenshots to this size before sending them to the LLM (width, height) */
	llmScreenshotSize: [number, number] | null;
	/** Enable click-by-coordinates for the click action (auto for supported models) */
	coordinateClicking: boolean | 'auto';
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
	useVision: true,
	visionDetailLevel: 'auto',
	saveConversationPath: null,
	saveConversationPathEncoding: 'utf-8',
	maxFailures: 5,
	generateGif: false,
	overrideSystemMessage: null,
	extendSystemMessage: null,
	includeAttributes: DEFAULT_INCLUDE_ATTRIBUTES,
	maxActionsPerStep: 5,
	useThinking: true,
	flashMode: false,
	useJudge: true,
	groundTruth: null,
	judgeLlm: null,
	maxHistoryItems: null,
	messageCompaction: resolveMessageCompactionSettings(true),
	enablePlanning: true,
	planningReplanOnStall: 3,
	planningExplorationLimit: 5,
	pageExtractionLlm: null,
	fallbackLlm: null,
	extractionSchema: null,
	calculateCost: false,
	includeToolCallExamples: false,
	llmTimeout: 75,
	stepTimeout: 180,
	finalResponseAfterFailure: true,
	directlyOpenUrl: true, // Navigate to URL found in task at start
	includeRecentEvents: false,
	sampleImages: null,
	availableFilePaths: null,
	waitBetweenActions: 0.1, // Python default from browser_profile.wait_between_actions
	loopDetectionWindow: 20,
	loopDetectionEnabled: true,
	maxClickableElementsLength: 40000,
	llmScreenshotSize: null,
	coordinateClicking: 'auto',
};

/** Python `_get_model_timeout`: LLM timeout in seconds based on the model name. */
export function getModelLlmTimeout(model: string | null | undefined): number {
	const name = (model ?? '').toLowerCase();
	if (name.includes('gemini')) {
		return name.includes('3-pro') ? 90 : 75;
	}
	if (name.includes('groq')) {
		return 30;
	}
	if (name.includes('o3') || name.includes('claude') || name.includes('sonnet') || name.includes('deepseek')) {
		return 90;
	}
	return 75;
}

/** Models that click reliably by viewport coordinates (Python Agent.__init__). */
export const COORDINATE_CLICKING_MODEL_PATTERNS = ['claude-sonnet-4', 'claude-opus-4', 'claude-fable-5', 'gemini-3-pro', 'browser-use/'];

export function supportsCoordinateClicking(model: string | null | undefined): boolean {
	const name = (model ?? '').toLowerCase();
	return COORDINATE_CLICKING_MODEL_PATTERNS.some((pattern) => name.includes(pattern));
}

/** Auto screenshot size for Claude Sonnet (gateway ids like 'anthropic/claude-sonnet-4-6' included). */
export function defaultLlmScreenshotSize(model: string | null | undefined): [number, number] | null {
	const name = (model ?? '').split('/').pop() ?? '';
	return name.startsWith('claude-sonnet') ? [1400, 850] : null;
}

// ============================================================================
// Loop detection
// ============================================================================

/** Lightweight fingerprint of the browser page state. */
export interface PageFingerprint {
	url: string;
	elementCount: number;
	/** First 16 chars of SHA-256 of the DOM text representation */
	textHash: string;
}

export function pageFingerprintFromBrowserState(url: string, domText: string, elementCount: number): PageFingerprint {
	const textHash = crypto.createHash('sha256').update(domText, 'utf8').digest('hex').slice(0, 16);
	return { url, elementCount, textHash };
}

function samePageFingerprint(a: PageFingerprint, b: PageFingerprint): boolean {
	return a.url === b.url && a.elementCount === b.elementCount && a.textHash === b.textHash;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value ?? null);
	}
	if (Array.isArray(value)) {
		return '[' + value.map(stableStringify).join(',') + ']';
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

/**
 * Normalize action parameters for similarity hashing.
 * search: sorted query tokens; click/input: element index (+ text); navigate: full URL;
 * scroll: direction + index; default: sorted non-null params.
 */
export function normalizeActionForHash(actionName: string, params: Record<string, any>): string {
	if (actionName === 'search') {
		const query = String(params.query ?? '');
		const tokens = Array.from(new Set(query.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean))).sort();
		const engine = params.engine ?? 'google';
		return `search|${engine}|${tokens.join('|')}`;
	}
	if (actionName === 'click' || actionName === 'input') {
		const index = params.index;
		if (actionName === 'input') {
			const text = String(params.text ?? '');
			return `input|${index}|${text.trim().toLowerCase()}`;
		}
		return `click|${index}`;
	}
	if (actionName === 'navigate') {
		return `navigate|${String(params.url ?? '')}`;
	}
	if (actionName === 'scroll') {
		const direction = params.down === false ? 'up' : 'down';
		return `scroll|${direction}|${params.index ?? null}`;
	}
	const filtered: Record<string, unknown> = {};
	for (const key of Object.keys(params).sort()) {
		if (params[key] !== null && params[key] !== undefined) {
			filtered[key] = params[key];
		}
	}
	return `${actionName}|${stableStringify(filtered)}`;
}

/** Stable 12-char hash for an action based on type + normalized parameters. */
export function computeActionHash(actionName: string, params: Record<string, any>): string {
	return crypto.createHash('sha256').update(normalizeActionForHash(actionName, params), 'utf8').digest('hex').slice(0, 12);
}

/**
 * Tracks action repetition and page stagnation to detect behavioral loops.
 * Soft detection: it only produces nudge messages for the LLM, never blocks actions.
 */
export class ActionLoopDetector {
	windowSize: number;
	recentActionHashes: string[] = [];
	recentPageFingerprints: PageFingerprint[] = [];
	/** Highest count of any single hash in the window */
	maxRepetitionCount = 0;
	mostRepeatedHash: string | null = null;
	/** How many consecutive steps had the same page fingerprint */
	consecutiveStagnantPages = 0;

	constructor(windowSize = 20) {
		this.windowSize = windowSize;
	}

	recordAction(actionName: string, params: Record<string, any>): void {
		this.recentActionHashes.push(computeActionHash(actionName, params));
		if (this.recentActionHashes.length > this.windowSize) {
			this.recentActionHashes = this.recentActionHashes.slice(-this.windowSize);
		}
		this.updateRepetitionStats();
	}

	recordPageState(url: string, domText: string, elementCount: number): void {
		const fp = pageFingerprintFromBrowserState(url, domText, elementCount);
		const last = this.recentPageFingerprints[this.recentPageFingerprints.length - 1];
		if (last && samePageFingerprint(last, fp)) {
			this.consecutiveStagnantPages += 1;
		} else {
			this.consecutiveStagnantPages = 0;
		}
		this.recentPageFingerprints.push(fp);
		if (this.recentPageFingerprints.length > 5) {
			this.recentPageFingerprints = this.recentPageFingerprints.slice(-5);
		}
	}

	private updateRepetitionStats(): void {
		if (this.recentActionHashes.length === 0) {
			this.maxRepetitionCount = 0;
			this.mostRepeatedHash = null;
			return;
		}
		const counts = new Map<string, number>();
		for (const h of this.recentActionHashes) {
			counts.set(h, (counts.get(h) ?? 0) + 1);
		}
		let best: string | null = null;
		let bestCount = 0;
		for (const [h, count] of counts) {
			if (count > bestCount) {
				best = h;
				bestCount = count;
			}
		}
		this.mostRepeatedHash = best;
		this.maxRepetitionCount = bestCount;
	}

	/** Escalating awareness nudge (5 / 8 / 12 repetitions, 5 stagnant pages) or null. */
	getNudgeMessage(): string | null {
		const messages: string[] = [];
		const n = this.maxRepetitionCount;
		const window = this.recentActionHashes.length;
		if (n >= 12) {
			messages.push(
				`Heads up: you have repeated a similar action ${n} times in the last ${window} actions. ` +
					'If you are making progress with each repetition, keep going. ' +
					'If not, a different approach might get you there faster.'
			);
		} else if (n >= 8) {
			messages.push(
				`Heads up: you have repeated a similar action ${n} times in the last ${window} actions. ` +
					'Are you still making progress with each attempt? ' +
					'If so, carry on. Otherwise, it might be worth trying a different approach.'
			);
		} else if (n >= 5) {
			messages.push(
				`Heads up: you have repeated a similar action ${n} times in the last ${window} actions. ` +
					'If this is intentional and making progress, carry on. ' +
					'If not, it might be worth reconsidering your approach.'
			);
		}
		if (this.consecutiveStagnantPages >= 5) {
			messages.push(
				`The page content has not changed across ${this.consecutiveStagnantPages} consecutive actions. ` +
					'Your actions might not be having the intended effect. ' +
					'It could be worth trying a different element or approach.'
			);
		}
		return messages.length > 0 ? messages.join('\n\n') : null;
	}
}

// ============================================================================
// Planning
// ============================================================================

export type PlanItemStatus = 'pending' | 'current' | 'done' | 'skipped';

export interface PlanItem {
	text: string;
	status: PlanItemStatus;
}

export const PLAN_STATUS_MARKERS: Record<PlanItemStatus, string> = {
	done: '[x]',
	current: '[>]',
	pending: '[ ]',
	skipped: '[-]',
};

/** Render a plan as `[marker] index: text` lines. */
export function renderPlan(plan: PlanItem[] | null | undefined): string | null {
	if (!plan) {
		return null;
	}
	return plan.map((item, i) => `${PLAN_STATUS_MARKERS[item.status] ?? '[ ]'} ${i}: ${item.text}`).join('\n');
}

// ============================================================================
// File System State (placeholder for now)
// ============================================================================

export interface FileSystemState {
	basePath: string | null;
	files: Record<string, any>;
}

// ============================================================================
// Agent State
// ============================================================================

export interface AgentState {
	agentId: string;
	nSteps: number;
	consecutiveFailures: number;
	lastResult: ActionResult[] | null;
	plan: PlanItem[] | null;
	currentPlanItemIndex: number;
	planGenerationStep: number | null;
	lastModelOutput: AgentOutput | null;

	// Pause/resume state
	paused: boolean;
	stopped: boolean;
	sessionInitialized: boolean; // Track if session events have been dispatched
	followUpTask: boolean; // Track if the agent is a follow-up task

	messageManagerState: MessageManagerState;
	fileSystemState: FileSystemState | null;

	// Loop detection state
	loopDetector: ActionLoopDetector;
}

export function createDefaultAgentState(): AgentState {
	return {
		agentId: uuidv4(),
		nSteps: 1,
		consecutiveFailures: 0,
		lastResult: null,
		plan: null,
		currentPlanItemIndex: 0,
		planGenerationStep: null,
		lastModelOutput: null,
		paused: false,
		stopped: false,
		sessionInitialized: false,
		followUpTask: false,
		messageManagerState: createMessageManagerState(),
		fileSystemState: null,
		loopDetector: new ActionLoopDetector(),
	};
}

export const DEFAULT_AGENT_STATE: AgentState = createDefaultAgentState();

// ============================================================================
// Agent Step Info
// ============================================================================

export interface AgentStepInfo {
	stepNumber: number;
	maxSteps: number;
}

export function isLastStep(stepInfo: AgentStepInfo): boolean {
	return stepInfo.stepNumber >= stepInfo.maxSteps - 1;
}

// ============================================================================
// Action Result
// ============================================================================

/** Base64 image attached to an action result: `[{ name: "file.jpg", data: "<base64>" }]` */
export interface ActionResultImage {
	name: string;
	data: string;
}

export interface ActionResult {
	// For done action
	isDone?: boolean | null;
	success?: boolean | null;

	// For trace judgement
	judgement?: JudgementResult | null;

	// Error handling - always include in long term memory
	error?: string | null;

	// Files
	attachments?: string[] | null; // Files to display in the done message

	// Images (base64 encoded) - separate from text content for efficient handling
	images?: ActionResultImage[] | null;

	// Always include in long term memory
	longTermMemory?: string | null; // Memory of this action

	// if include_extracted_content_only_once is True we add the extracted_content to the agent context only once for the next step
	// if include_extracted_content_only_once is False we add the extracted_content to the agent long term memory if no long_term_memory is provided
	extractedContent?: string | null;
	includeExtractedContentOnlyOnce?: boolean; // Whether the extracted content should be used to update the read_state

	// Metadata for observability (e.g., click coordinates)
	metadata?: Record<string, any> | null;

	// Deprecated
	includeInMemory?: boolean; // whether to include extracted_content inside long_term_memory
}

export const ActionResultSchema = z.object({
	isDone: z.boolean().nullable().optional(),
	success: z.boolean().nullable().optional(),
	judgement: z.any().nullable().optional(),
	error: z.string().nullable().optional(),
	attachments: z.array(z.string()).nullable().optional(),
	images: z.array(z.object({ name: z.string(), data: z.string() })).nullable().optional(),
	longTermMemory: z.string().nullable().optional(),
	extractedContent: z.string().nullable().optional(),
	includeExtractedContentOnlyOnce: z.boolean().optional(),
	metadata: z.record(z.any()).nullable().optional(),
	includeInMemory: z.boolean().optional(),
}).refine(
	(data) => {
		// Ensure success=True can only be set when isDone=True
		if (data.success === true && data.isDone !== true) {
			return false;
		}
		return true;
	},
	{
		message:
			'success=True can only be set when isDone=True. For regular actions that succeed, leave success as None. Use success=False only for actions that fail.',
	}
);

// ============================================================================
// Step Metadata
// ============================================================================

export interface StepMetadata {
	stepStartTime: number;
	stepEndTime: number;
	stepNumber: number;
	/** Duration of the previous step (used to pace history reruns) */
	stepInterval?: number | null;
}

export function calculateDurationSeconds(metadata: StepMetadata): number {
	return metadata.stepEndTime - metadata.stepStartTime;
}

// ============================================================================
// Agent Brain
// ============================================================================

export interface AgentBrain {
	thinking?: string | null;
	evaluationPreviousGoal: string;
	memory: string;
	nextGoal: string;
}

// ============================================================================
// Action Model
// ============================================================================

export interface ActionModel {
	[actionName: string]: any;
}

/** Index of the element an action targets (first `index` param found), or null. */
export function getActionIndex(action: ActionModel | null | undefined): number | null {
	if (!action || typeof action !== 'object') {
		return null;
	}
	for (const params of Object.values(action)) {
		if (params && typeof params === 'object' && 'index' in params && typeof params.index === 'number') {
			return params.index;
		}
	}
	return null;
}

// ============================================================================
// Agent Output
// ============================================================================

export interface AgentOutput {
	thinking?: string | null;
	evaluationPreviousGoal?: string | null;
	memory?: string | null;
	nextGoal?: string | null;
	/** 0-indexed plan item the model is working on */
	currentPlanItem?: number | null;
	/** Replacement plan (todo items) */
	planUpdate?: string[] | null;
	action: ActionModel[]; // At least one action is required
}

export const AgentOutputSchema = z.object({
	thinking: z.string().nullable().optional(),
	evaluationPreviousGoal: z.string().nullable().optional(),
	memory: z.string().nullable().optional(),
	nextGoal: z.string().nullable().optional(),
	currentPlanItem: z.number().int().nullable().optional(),
	planUpdate: z.array(z.string()).nullable().optional(),
	action: z.array(z.any()).min(1), // Ensure at least one action
});

/**
 * Get current state as AgentBrain
 */
export function getCurrentState(output: AgentOutput): AgentBrain {
	return {
		thinking: output.thinking,
		evaluationPreviousGoal: output.evaluationPreviousGoal || '',
		memory: output.memory || '',
		nextGoal: output.nextGoal || '',
	};
}

// ============================================================================
// Agent History
// ============================================================================

export interface AgentHistory {
	modelOutput: AgentOutput | null;
	result: ActionResult[];
	state: BrowserStateHistory;
	metadata: StepMetadata | null;
	stateMessage: string | null;
}

/**
 * Get interacted element from model output
 */
export function getInteractedElement(
	modelOutput: AgentOutput,
	selectorMap: DOMSelectorMap
): (DOMInteractedElement | null)[] {
	const elements: (DOMInteractedElement | null)[] = [];

	for (const action of modelOutput.action) {
		const index = getActionIndex(action);
		if (index !== null && selectorMap.has(index)) {
			const el = selectorMap.get(index)!;
			elements.push(createDOMInteractedElement(el));
		} else {
			elements.push(null);
		}
	}

	return elements;
}

/**
 * Filter sensitive data from string (longest secrets first, single pass)
 */
export function filterSensitiveDataFromString(
	value: string,
	sensitiveData: Record<string, string | Record<string, string>> | null
): string {
	if (!sensitiveData) {
		return value;
	}
	const sensitiveValues = collectSensitiveDataValues(sensitiveData);
	if (Object.keys(sensitiveValues).length === 0) {
		return value;
	}
	return redactSensitiveString(value, sensitiveValues);
}

/**
 * Recursively filter sensitive data from a dictionary
 */
export function filterSensitiveDataFromDict(
	data: Record<string, any>,
	sensitiveData: Record<string, string | Record<string, string>> | null
): Record<string, any> {
	if (!sensitiveData) {
		return data;
	}

	const filtered: Record<string, any> = {};

	for (const [key, value] of Object.entries(data)) {
		if (typeof value === 'string') {
			filtered[key] = filterSensitiveDataFromString(value, sensitiveData);
		} else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			filtered[key] = filterSensitiveDataFromDict(value, sensitiveData);
		} else if (Array.isArray(value)) {
			filtered[key] = value.map((item) => {
				if (typeof item === 'string') {
					return filterSensitiveDataFromString(item, sensitiveData);
				} else if (typeof item === 'object' && item !== null) {
					return filterSensitiveDataFromDict(item, sensitiveData);
				}
				return item;
			});
		} else {
			filtered[key] = value;
		}
	}

	return filtered;
}

// ============================================================================
// Usage Summary (placeholder - will be properly typed when tokens are ported)
// ============================================================================

export interface UsageSummary {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	totalCost: number;
}

// ============================================================================
// Agent History List
// ============================================================================

export class AgentHistoryList<T = any> {
	history: AgentHistory[];
	usage: UsageSummary | null;
	private _outputModelSchema: any | null = null;

	constructor(history: AgentHistory[] = [], usage: UsageSummary | null = null) {
		this.history = history;
		this.usage = usage;
	}

	/**
	 * Get total duration of all steps in seconds
	 */
	totalDurationSeconds(): number {
		let total = 0;
		for (const h of this.history) {
			if (h.metadata) {
				total += calculateDurationSeconds(h.metadata);
			}
		}
		return total;
	}

	/**
	 * Return the number of history items
	 */
	get length(): number {
		return this.history.length;
	}

	/**
	 * Add a history item to the list
	 */
	addItem(historyItem: AgentHistory): void {
		this.history.push(historyItem);
	}

	/**
	 * Save history to JSON file with proper serialization and optional sensitive data filtering
	 */
	saveToFile(
		filepath: string,
		sensitiveData: Record<string, string | Record<string, string>> | null = null
	): void {
		const dir = path.dirname(filepath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const data = this.toJSON(sensitiveData);
		fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
	}

	/**
	 * Convert to JSON with optional sensitive data filtering
	 */
	toJSON(sensitiveData: Record<string, string | Record<string, string>> | null = null): any {
		return {
			history: this.history.map((h) => this.serializeHistoryItem(h, sensitiveData)),
		};
	}

	private serializeHistoryItem(
		h: AgentHistory,
		sensitiveData: Record<string, string | Record<string, string>> | null
	): any {
		let modelOutputDump: any = null;

		if (h.modelOutput) {
			let actionDump: any[] = h.modelOutput.action.map((action) => {
				const { getIndex, ...rest } = action;
				return rest;
			});

			// Filter sensitive data from input action parameters if provided
			if (sensitiveData) {
				actionDump = actionDump.map((action) => {
					if ('input' in action) {
						return filterSensitiveDataFromDict(action, sensitiveData);
					}
					return action;
				});
			}

			modelOutputDump = {
				evaluationPreviousGoal: h.modelOutput.evaluationPreviousGoal,
				memory: h.modelOutput.memory,
				nextGoal: h.modelOutput.nextGoal,
				action: actionDump,
			};

			if (h.modelOutput.thinking !== undefined && h.modelOutput.thinking !== null) {
				modelOutputDump.thinking = h.modelOutput.thinking;
			}
			if (h.modelOutput.currentPlanItem !== undefined && h.modelOutput.currentPlanItem !== null) {
				modelOutputDump.currentPlanItem = h.modelOutput.currentPlanItem;
			}
			if (h.modelOutput.planUpdate !== undefined && h.modelOutput.planUpdate !== null) {
				modelOutputDump.planUpdate = h.modelOutput.planUpdate;
			}
		}

		const resultDump = h.result.map((r) => {
			const result: any = {};
			if (r.isDone !== undefined) result.isDone = r.isDone;
			if (r.success !== undefined) result.success = r.success;
			if (r.judgement) result.judgement = r.judgement;
			if (r.error) result.error = r.error;
			if (r.attachments) result.attachments = r.attachments;
			if (r.images) result.images = r.images;
			if (r.longTermMemory) result.longTermMemory = r.longTermMemory;
			if (r.extractedContent) result.extractedContent = r.extractedContent;
			if (r.metadata) result.metadata = r.metadata;
			return result;
		});

		return {
			modelOutput: modelOutputDump,
			result: resultDump,
			state: h.state,
			metadata: h.metadata,
			stateMessage: h.stateMessage,
		};
	}

	/**
	 * Build a history list from parsed JSON data, tolerating incomplete/legacy entries.
	 */
	static loadFromDict(data: any): AgentHistoryList {
		const history = new AgentHistoryList();
		const items: any[] = Array.isArray(data?.history) ? data.history : [];
		history.history = items.map((h) => {
			const state = h?.state ?? {};
			if (!('interactedElement' in state)) {
				state.interactedElement = null;
			}
			return {
				modelOutput: h?.modelOutput && typeof h.modelOutput === 'object' ? h.modelOutput : null,
				result: Array.isArray(h?.result) ? h.result : [],
				state,
				metadata: h?.metadata ?? null,
				stateMessage: h?.stateMessage ?? null,
			};
		});
		return history;
	}

	/**
	 * Load history from JSON file
	 */
	static loadFromFile(filepath: string): AgentHistoryList {
		const content = fs.readFileSync(filepath, 'utf-8');
		return AgentHistoryList.loadFromDict(JSON.parse(content));
	}

	/**
	 * Last action in history
	 */
	lastAction(): Record<string, any> | null {
		const last = this.history[this.history.length - 1];
		if (last?.modelOutput && last.modelOutput.action.length > 0) {
			const lastAction = last.modelOutput.action[last.modelOutput.action.length - 1];
			const { getIndex, ...rest } = lastAction;
			return rest;
		}
		return null;
	}

	/**
	 * Get all errors from history, with null for steps without errors
	 */
	errors(): (string | null)[] {
		const errors: (string | null)[] = [];
		for (const h of this.history) {
			const stepErrors = h.result.filter((r) => r.error).map((r) => r.error!);
			errors.push(stepErrors.length > 0 ? stepErrors[0] : null);
		}
		return errors;
	}

	private lastResult(): ActionResult | null {
		const last = this.history[this.history.length - 1];
		if (last && last.result.length > 0) {
			return last.result[last.result.length - 1];
		}
		return null;
	}

	/**
	 * Final result from history
	 */
	finalResult(): string | null {
		return this.lastResult()?.extractedContent || null;
	}

	/**
	 * Check if the agent is done
	 */
	isDone(): boolean {
		return this.lastResult()?.isDone === true;
	}

	/**
	 * Check if the agent completed successfully
	 */
	isSuccessful(): boolean | null {
		const last = this.lastResult();
		if (last && last.isDone === true) {
			return last.success ?? null;
		}
		return null;
	}

	/**
	 * Check if the agent has any non-null errors
	 */
	hasErrors(): boolean {
		return this.errors().some((error) => error !== null);
	}

	/** Judge result of the final step, if the trace was judged */
	judgement(): JudgementResult | null {
		return this.lastResult()?.judgement ?? null;
	}

	/** Whether the agent trace has been judged */
	isJudged(): boolean {
		return this.lastResult()?.judgement != null;
	}

	/** Judge verdict (true/false), or null if not judged yet */
	isValidated(): boolean | null {
		const judgement = this.lastResult()?.judgement;
		return judgement ? judgement.verdict : null;
	}

	/**
	 * Get all unique URLs from history
	 */
	urls(): (string | null)[] {
		return this.history.map((h) => h.state.url || null);
	}

	/**
	 * Get all screenshot paths from history
	 */
	screenshotPaths(nLast: number | null = null, returnNoneIfNotScreenshot: boolean = true): (string | null)[] {
		if (nLast === 0) return [];

		const items = nLast === null ? this.history : this.history.slice(-nLast);

		if (returnNoneIfNotScreenshot) {
			return items.map((h) => h.state.screenshotPath || null);
		} else {
			return items.filter((h) => h.state.screenshotPath).map((h) => h.state.screenshotPath!);
		}
	}

	/**
	 * Get all action names from history
	 */
	actionNames(): string[] {
		const actionNames: string[] = [];
		for (const action of this.modelActions()) {
			const actions = Object.keys(action);
			if (actions.length > 0) {
				actionNames.push(actions[0]);
			}
		}
		return actionNames;
	}

	/**
	 * Get all thoughts from history
	 */
	modelThoughts(): AgentBrain[] {
		return this.history
			.filter((h) => h.modelOutput)
			.map((h) => getCurrentState(h.modelOutput!));
	}

	/**
	 * Get all model outputs from history
	 */
	modelOutputs(): AgentOutput[] {
		return this.history.filter((h) => h.modelOutput).map((h) => h.modelOutput!);
	}

	/**
	 * Get all actions from history
	 */
	modelActions(): Record<string, any>[] {
		const outputs: Record<string, any>[] = [];

		for (const h of this.history) {
			if (h.modelOutput) {
				const interactedElements = h.state.interactedElement ||
					new Array(h.modelOutput.action.length).fill(null);

				for (let i = 0; i < h.modelOutput.action.length; i++) {
					const action = h.modelOutput.action[i];
					const { getIndex, ...output } = action;
					(output as any).interactedElement = interactedElements[i];
					outputs.push(output);
				}
			}
		}
		return outputs;
	}

	/**
	 * Get truncated action history with only essential fields
	 */
	actionHistory(): Record<string, any>[][] {
		const stepOutputs: Record<string, any>[][] = [];

		for (const h of this.history) {
			const stepActions: Record<string, any>[] = [];
			if (h.modelOutput) {
				const interactedElements = h.state.interactedElement ||
					new Array(h.modelOutput.action.length).fill(null);

				for (let i = 0; i < h.modelOutput.action.length; i++) {
					const action = h.modelOutput.action[i];
					const result = h.result[i];
					const { getIndex, ...actionOutput } = action;
					(actionOutput as any).interactedElement = interactedElements[i];
					(actionOutput as any).result = result?.longTermMemory || null;
					stepActions.push(actionOutput);
				}
			}
			stepOutputs.push(stepActions);
		}

		return stepOutputs;
	}

	/**
	 * Get all results from history
	 */
	actionResults(): ActionResult[] {
		const results: ActionResult[] = [];
		for (const h of this.history) {
			results.push(...h.result.filter((r) => r));
		}
		return results;
	}

	/**
	 * Get all extracted content from history
	 */
	extractedContent(): string[] {
		const content: string[] = [];
		for (const h of this.history) {
			content.push(
				...h.result.filter((r) => r.extractedContent).map((r) => r.extractedContent!)
			);
		}
		return content;
	}

	/**
	 * Get all model actions from history filtered by action names
	 */
	modelActionsFiltered(include: string[] = []): Record<string, any>[] {
		const outputs = this.modelActions();
		return outputs.filter((o) => {
			const keys = Object.keys(o);
			return keys.length > 0 && include.includes(keys[0]);
		});
	}

	/**
	 * Get the number of steps in the history
	 */
	numberOfSteps(): number {
		return this.history.length;
	}

	/**
	 * Format agent history as readable step descriptions for judge evaluation.
	 */
	agentSteps(): string[] {
		return formatAgentSteps(this.history);
	}

	/**
	 * Get the structured output from the history
	 */
	get structuredOutput(): T | null {
		const finalResult = this.finalResult();
		if (finalResult !== null && this._outputModelSchema !== null) {
			try {
				return JSON.parse(finalResult) as T;
			} catch {
				return null;
			}
		}
		return null;
	}

	/**
	 * Parse the final result with an explicit schema (for histories restored without a schema).
	 */
	getStructuredOutput<O>(outputModel: z.ZodType<O>): O | null {
		const finalResult = this.finalResult();
		if (finalResult === null) {
			return null;
		}
		return outputModel.parse(JSON.parse(finalResult));
	}

	/**
	 * Set the output model schema
	 */
	setOutputModelSchema(schema: any): void {
		this._outputModelSchema = schema;
	}

	toString(): string {
		return `AgentHistoryList(allResults=${JSON.stringify(this.actionResults())}, allModelOutputs=${JSON.stringify(this.modelActions())})`;
	}
}

/**
 * Format history steps as `Step N:` blocks with actions, results and errors (judge input).
 */
export function formatAgentSteps(
	history: Array<{ modelOutput?: { action?: ActionModel[] } | null; result?: ActionResult[] | null }>
): string[] {
	const steps: string[] = [];
	history.forEach((h, i) => {
		let stepText = `Step ${i + 1}:\n`;
		if (h.modelOutput?.action && h.modelOutput.action.length > 0) {
			const actionsList = h.modelOutput.action.map((action) => {
				const { getIndex, ...rest } = action;
				return rest;
			});
			stepText += `Actions: ${JSON.stringify(actionsList, null, 1)}\n`;
		}
		if (h.result) {
			h.result.forEach((result, j) => {
				if (result.extractedContent) {
					stepText += `Result ${j + 1}: ${String(result.extractedContent)}\n`;
				}
				if (result.error) {
					stepText += `Error ${j + 1}: ${String(result.error)}\n`;
				}
			});
		}
		steps.push(stepText);
	});
	return steps;
}

// ============================================================================
// Agent Error
// ============================================================================

export class AgentError {
	static readonly VALIDATION_ERROR = 'Invalid model output format. Please follow the correct schema.';
	static readonly RATE_LIMIT_ERROR = 'Rate limit reached. Waiting before retry.';
	static readonly NO_VALID_ACTION = 'No valid action found';

	/**
	 * Format error message based on error type and optionally include trace
	 */
	static formatError(error: Error, includeTrace: boolean = false): string {
		// Check for ValidationError (from zod)
		if (error.name === 'ZodError') {
			return `${AgentError.VALIDATION_ERROR}\nDetails: ${error.message}`;
		}

		// Check for RateLimitError
		if (error.name === 'ModelRateLimitError' || error.message.toLowerCase().includes('rate limit')) {
			return AgentError.RATE_LIMIT_ERROR;
		}

		// LLM response validation errors: keep the first line, add a format hint
		const errorStr = String(error.message ?? error);
		if (errorStr.includes('LLM response missing required fields') || errorStr.includes('Expected format: AgentOutput')) {
			const mainError = errorStr.split('\n')[0] || errorStr;
			let helpful = `${mainError}\n\nThe previous response had an invalid output structure. Please stick to the required output format. \n\n`;
			if (includeTrace) {
				helpful += `\n\nFull stacktrace:\n${error.stack || ''}`;
			}
			return helpful;
		}

		if (includeTrace) {
			return `${error.message}\nStacktrace:\n${error.stack || ''}`;
		}

		return error.message;
	}
}

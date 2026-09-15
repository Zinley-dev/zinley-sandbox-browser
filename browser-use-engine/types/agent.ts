/**
 * Agent-related types and data models
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseChatModel } from '../llm/base.js';
import { z } from 'zod';
import { ActionLoopDetector, type PlanItem } from '../agent/views.js';
import type { JudgementResult } from '../agent/judge.js';

export type { PlanItem, PlanItemStatus } from '../agent/views.js';
export { ActionLoopDetector } from '../agent/views.js';

// ============================================================================
// Agent Settings
// ============================================================================

export interface AgentSettings {
	/** Whether to use vision (screenshots) */
	useVision?: boolean | 'auto';

	/** Detail level for vision */
	visionDetailLevel?: 'auto' | 'low' | 'high';

	/** Path to save conversation history */
	saveConversationPath?: string | null;

	/** Encoding for saved conversations */
	saveConversationPathEncoding?: string | null;

	/** Maximum consecutive failures before stopping */
	maxFailures?: number;

	/** Override the system prompt */
	overrideSystemMessage?: string | null;

	/** Extend the system prompt */
	extendSystemMessage?: string | null;

	/** HTML attributes to include in DOM extraction */
	includeAttributes?: string[] | null;

	/** Maximum actions per step */
	maxActionsPerStep?: number;

	/** Whether to use thinking mode */
	useThinking?: boolean;

	/** Flash mode - simplified output */
	flashMode?: boolean;

	/** Maximum history items to keep */
	maxHistoryItems?: number | null;

	/** LLM for page extraction */
	pageExtractionLlm?: BaseChatModel | null;

	/** Calculate token costs */
	calculateCost?: boolean;

	/** Include tool call examples in prompt */
	includeToolCallExamples?: boolean;

	/** Timeout for LLM calls (seconds) */
	llmTimeout?: number;

	/** Timeout for each step (seconds) */
	stepTimeout?: number;

	/** Attempt final response after max failures */
	finalResponseAfterFailure?: boolean;

	/** Run an LLM judge over the trace when the agent finishes (extra LLM call) */
	useJudge?: boolean;

	/** Ground truth answer or criteria for judge validation */
	groundTruth?: string | null;

	/** LLM used for the judge (defaults to the agent LLM) */
	judgeLlm?: BaseChatModel | null;

	/** Summarize older history into a compact memory block (true = defaults, false/null = off) */
	messageCompaction?: import('../agent/views.js').MessageCompactionInput | boolean | null;

	/** Enable plan tracking (currentPlanItem / planUpdate output fields) */
	enablePlanning?: boolean;

	/** Consecutive failures before a replan nudge; 0 = disabled */
	planningReplanOnStall?: number;

	/** Steps without a plan before a planning nudge; 0 = disabled */
	planningExplorationLimit?: number;

	/** Rolling window size for action similarity tracking */
	loopDetectionWindow?: number;

	/** Whether to inject loop detection nudges */
	loopDetectionEnabled?: boolean;

	/** Max characters for clickable elements in the prompt */
	maxClickableElementsLength?: number;

	/** Resize screenshots to (width, height) before sending them to the LLM */
	llmScreenshotSize?: [number, number] | null;

	/** Enable click-by-coordinates for the click action ('auto' = supported models only) */
	coordinateClicking?: boolean | 'auto';

	/** LLM to switch to after rate-limit / provider errors on the primary LLM */
	fallbackLlm?: BaseChatModel | null;

	/** JSON schema injected into the extract action for structured output */
	extractionSchema?: Record<string, any> | null;
}

export const DEFAULT_AGENT_SETTINGS: Required<Omit<AgentSettings, 'overrideSystemMessage' | 'extendSystemMessage' | 'includeAttributes' | 'maxHistoryItems' | 'pageExtractionLlm'>> & { saveConversationPath: string | null; saveConversationPathEncoding: string } = {
	saveConversationPath: null,
	saveConversationPathEncoding: 'utf-8',
	useVision: true,
	visionDetailLevel: 'auto',
	maxFailures: 5,
	maxActionsPerStep: 5,
	useThinking: true,
	flashMode: false,
	calculateCost: false,
	includeToolCallExamples: false,
	llmTimeout: 75,
	stepTimeout: 180,
	finalResponseAfterFailure: true,
	useJudge: true,
	groundTruth: null,
	judgeLlm: null,
	messageCompaction: true,
	enablePlanning: true,
	planningReplanOnStall: 3,
	planningExplorationLimit: 5,
	loopDetectionWindow: 20,
	loopDetectionEnabled: true,
	maxClickableElementsLength: 40000,
	llmScreenshotSize: null,
	coordinateClicking: 'auto',
	fallbackLlm: null,
	extractionSchema: null,
};

// ============================================================================
// Agent State
// ============================================================================

export interface AgentState {
	agentId: string;
	nSteps: number;
	consecutiveFailures: number;
	lastResult?: ActionResult[] | null;
	/** @deprecated use `plan` */
	lastPlan?: string | null;
	lastModelOutput?: AgentOutput | null;

	// Planning state
	plan: PlanItem[] | null;
	currentPlanItemIndex: number;
	planGenerationStep: number | null;

	// Loop detection state
	loopDetector: ActionLoopDetector;

	// Pause/resume
	paused: boolean;
	stopped: boolean;
	sessionInitialized: boolean;
	followUpTask: boolean;
}

export function createAgentState(): AgentState {
	return {
		agentId: uuidv4(),
		nSteps: 1,
		consecutiveFailures: 0,
		lastResult: null,
		lastPlan: null,
		lastModelOutput: null,
		plan: null,
		currentPlanItemIndex: 0,
		planGenerationStep: null,
		loopDetector: new ActionLoopDetector(),
		paused: false,
		stopped: false,
		sessionInitialized: false,
		followUpTask: false,
	};
}

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

/** Base64 image attached to an action result: `{ name: "file.jpg", data: "<base64>" }` */
export interface ActionResultImage {
	name: string;
	data: string;
}

export interface ActionResult {
	/** For done action */
	isDone?: boolean;
	success?: boolean | null;

	/** LLM judge verdict attached to the final result (when the judge ran) */
	judgement?: JudgementResult | null;

	/** Error message if action failed */
	error?: string | null;

	/** File attachments to display */
	attachments?: string[] | null;

	/** Long-term memory from this action */
	longTermMemory?: string | null;

	/** Extracted content (may be temporary) */
	extractedContent?: string | null;

	/** Whether extracted content should only be included once */
	includeExtractedContentOnlyOnce?: boolean;

	/** Metadata for observability */
	metadata?: Record<string, any> | null;

	/** Base64 images (e.g. from read_file on an image) to attach to the next observation */
	images?: ActionResultImage[] | null;

	/** @deprecated */
	includeInMemory?: boolean;
}

export function validateActionResult(result: ActionResult): void {
	if (result.success === true && result.isDone !== true) {
		throw new Error(
			'success=true can only be set when isDone=true. ' +
			'For regular actions that succeed, leave success as undefined/null. ' +
			'Use success=false only for actions that fail.'
		);
	}
}

// ============================================================================
// Step Metadata
// ============================================================================

export interface StepMetadata {
	stepStartTime: number;
	stepEndTime: number;
	stepNumber: number;
	/** Duration of the previous step (milliseconds), used to pace history reruns */
	stepInterval?: number | null;
}

export function getDurationSeconds(metadata: StepMetadata): number {
	return (metadata.stepEndTime - metadata.stepStartTime) / 1000;
}

// ============================================================================
// Agent Brain & Output
// ============================================================================

export interface AgentBrain {
	thinking?: string | null;
	evaluationPreviousGoal: string;
	memory: string;
	nextGoal: string;
}

export interface ActionModel {
	[actionName: string]: any;
}

export interface AgentOutput {
	thinking?: string | null;
	evaluationPreviousGoal?: string | null;
	memory?: string | null;
	nextGoal?: string | null;
	/** 0-indexed plan item the model is working on */
	currentPlanItem?: number | null;
	/** Replacement plan (todo items) */
	planUpdate?: string[] | null;
	action: ActionModel[];
}

export function getAgentBrain(output: AgentOutput): AgentBrain {
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

export interface BrowserStateHistory {
	url: string;
	title: string;
	tabs: Array<{ targetId: string; url: string; title: string }>;
	screenshot?: string;
}

export interface AgentHistory {
	modelOutput?: AgentOutput | null;
	result: ActionResult[];
	state: BrowserStateHistory;
	metadata?: StepMetadata;
}

export interface AgentHistoryList {
	history: AgentHistory[];
	agentId: string;
	task: string;
	createdAt: number;
	finalResult?: ActionResult | null;
	/** Output model schema for structured output extraction */
	outputModelSchema?: any;
}

export function createAgentHistoryList(
	agentId: string,
	task: string
): AgentHistoryList {
	return {
		history: [],
		agentId,
		task,
		createdAt: Date.now(),
		finalResult: null,
	};
}

/**
 * Check if the agent completed successfully
 * Port from Python's is_successful() - checks last step's result
 */
export function isSuccessful(historyList: AgentHistoryList): boolean | null {
	// Python: checks if last_result.is_done is True and returns last_result.success
	if (historyList.history && historyList.history.length > 0) {
		const lastStep = historyList.history[historyList.history.length - 1];
		if (lastStep.result && lastStep.result.length > 0) {
			const lastResult = lastStep.result[lastStep.result.length - 1];
			if (lastResult.isDone === true) {
				return lastResult.success ?? null;
			}
		}
	}
	// Also check finalResult if set directly
	if (historyList.finalResult?.success !== undefined) {
		return historyList.finalResult.success;
	}
	return null;
}

/**
 * Get the final result from history
 * Port from Python's final_result() - extracts extracted_content from last step
 * Python returns: history[-1].result[-1].extracted_content (string or None)
 */
export function getFinalResult(historyList: AgentHistoryList): string | null {
	// Python: returns history[-1].result[-1].extracted_content
	if (historyList.history && historyList.history.length > 0) {
		const lastStep = historyList.history[historyList.history.length - 1];
		if (lastStep.result && lastStep.result.length > 0) {
			const lastResult = lastStep.result[lastStep.result.length - 1];
			// Return just the extracted_content string like Python does
			if (lastResult.extractedContent) {
				return lastResult.extractedContent;
			}
		}
	}
	// Fallback to finalResult.extractedContent if set directly
	return historyList.finalResult?.extractedContent || null;
}

/**
 * Save history list to a JSON file
 * @param historyList The history to save
 * @param filePath Path to save to (defaults to 'AgentHistory.json')
 * @param sensitiveData Optional sensitive data to filter from the output
 */
export async function saveHistoryToFile(
	historyList: AgentHistoryList,
	filePath: string = 'AgentHistory.json',
	sensitiveData?: Record<string, string>
): Promise<void> {
	const fs = await import('fs/promises');

	// Deep clone to avoid modifying original
	let dataToSave = JSON.parse(JSON.stringify(historyList));

	// Filter sensitive data if provided
	if (sensitiveData) {
		const filterSensitive = (obj: any): any => {
			if (typeof obj === 'string') {
				let filtered = obj;
				for (const [key, value] of Object.entries(sensitiveData)) {
					if (value) {
						filtered = filtered.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `[FILTERED:${key}]`);
					}
				}
				return filtered;
			}
			if (Array.isArray(obj)) {
				return obj.map(filterSensitive);
			}
			if (obj && typeof obj === 'object') {
				const result: Record<string, any> = {};
				for (const [k, v] of Object.entries(obj)) {
					result[k] = filterSensitive(v);
				}
				return result;
			}
			return obj;
		};
		dataToSave = filterSensitive(dataToSave);
	}

	await fs.writeFile(filePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
}

/**
 * Load history list from a JSON file
 * @param filePath Path to load from (defaults to 'AgentHistory.json')
 * @returns The loaded history list
 */
export async function loadHistoryFromFile(filePath: string = 'AgentHistory.json'): Promise<AgentHistoryList> {
	const fs = await import('fs/promises');
	const content = await fs.readFile(filePath, 'utf-8');
	return JSON.parse(content) as AgentHistoryList;
}

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

export const ActionResultSchema = z.object({
	isDone: z.boolean().optional(),
	success: z.boolean().nullable().optional(),
	error: z.string().nullable().optional(),
	attachments: z.array(z.string()).nullable().optional(),
	longTermMemory: z.string().nullable().optional(),
	extractedContent: z.string().nullable().optional(),
	includeExtractedContentOnlyOnce: z.boolean().optional(),
	metadata: z.record(z.any()).nullable().optional(),
	includeInMemory: z.boolean().optional(),
}).refine(
	(data) => !(data.success === true && data.isDone !== true),
	{
		message: 'success=true can only be set when isDone=true',
	}
);

// Static AgentOutputSchema with z.any() for backwards compatibility
export const AgentOutputSchema = z.object({
	thinking: z.string().nullable().optional(),
	evaluationPreviousGoal: z.string().nullable().optional(),
	memory: z.string().nullable().optional(),
	nextGoal: z.string().nullable().optional(),
	currentPlanItem: z.number().int().nullable().optional(),
	planUpdate: z.array(z.string()).nullable().optional(),
	action: z.array(z.any()).min(1),
});

export interface AgentOutputSchemaOptions {
	/** Flash mode: only `memory` + `action` (no thinking/evaluation/next goal/plan) */
	flashMode?: boolean;
	/** Omit the `thinking` field (use_thinking=False) */
	useThinking?: boolean;
	/** Include `currentPlanItem` / `planUpdate` (disabled in flash mode) */
	enablePlanning?: boolean;
}

/**
 * Create a dynamic AgentOutputSchema with properly typed action union
 * This matches Python's type_with_custom_actions / _no_thinking / _flash_mode variants.
 * @param actionModel - The action model union from registry.createActionModel()
 */
export function createAgentOutputSchema(actionModel: z.ZodType<any>, options: AgentOutputSchemaOptions = {}): z.ZodType<any> {
	const flashMode = options.flashMode ?? false;
	const useThinking = options.useThinking ?? true;
	const enablePlanning = (options.enablePlanning ?? true) && !flashMode;

	const shape: Record<string, z.ZodTypeAny> = {};
	if (!flashMode && useThinking) {
		shape.thinking = z.string().nullable().optional();
	}
	if (!flashMode) {
		shape.evaluationPreviousGoal = z.string().nullable().optional();
	}
	shape.memory = z.string().nullable().optional();
	if (!flashMode) {
		shape.nextGoal = z.string().nullable().optional();
	}
	if (enablePlanning) {
		shape.currentPlanItem = z.number().int().nullable().optional();
		shape.planUpdate = z.array(z.string()).nullable().optional();
	}
	shape.action = z.array(actionModel).min(1);
	return z.object(shape);
}

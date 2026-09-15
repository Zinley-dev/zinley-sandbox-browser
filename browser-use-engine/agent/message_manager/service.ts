/**
 * Message manager service for agent communication
 * Port from browser_use/agent/message_manager/service.py (Python browser-use 0.13.10)
 */

import {
	HistoryItem,
	MessageManagerState,
	ReadStateImage,
	historyItemToString,
	getMessages as getMessagesFromHistory,
	createMessageManagerState,
} from './views.js';
import { AgentMessagePrompt } from '../prompts.js';
import {
	ActionResult,
	AgentOutput,
	AgentStepInfo,
	MessageCompactionSettings,
} from '../views.js';
import { BrowserStateSummary } from '../../browser/views.js';
import { FileSystem } from '../../filesystem/file_system.js';
import type { BaseChatModel } from '../../llm/base.js';
import {
	BaseMessage,
	SystemMessage,
	ContentPartImageParam,
	ContentPartTextParam,
	createSystemMessage,
	createUserMessage,
	getMessageText,
} from '../../llm/messages.js';
import { collectSensitiveDataValues, matchUrlWithDomainPattern, redactSensitiveString } from '../../utils.js';

// ============================================================================
// Constants
// ============================================================================

/** 60k character limit for read_state_description and action results */
const MAX_CONTENT_SIZE = 60000;

const COMPACTION_SYSTEM_PROMPT =
	'You are summarizing an agent run for prompt compaction.\n' +
	'Capture task requirements, key facts, decisions, partial progress, errors, and next steps.\n' +
	'Preserve important entities, values, URLs, and file paths.\n' +
	'CRITICAL: Only mark a step as completed if you see explicit success confirmation in the history. ' +
	'If a step was started but not explicitly confirmed complete, mark it as "IN-PROGRESS". ' +
	'Never infer completion from context — only report what was confirmed.\n' +
	'Return plain text only. Do not include tool calls or JSON.';

// ============================================================================
// Message Manager
// ============================================================================

export type VisionDetailLevel = 'auto' | 'low' | 'high';

export interface MessageManagerOptions {
	task: string;
	systemMessage: SystemMessage;
	fileSystem: FileSystem;
	state?: MessageManagerState;
	useThinking?: boolean;
	includeAttributes?: string[];
	sensitiveData?: Record<string, string | Record<string, string>>;
	maxHistoryItems?: number;
	visionDetailLevel?: VisionDetailLevel;
	includeToolCallExamples?: boolean;
	includeRecentEvents?: boolean;
	sampleImages?: Array<ContentPartTextParam | ContentPartImageParam>;
	/** Resize screenshots to (width, height) before sending them to the LLM */
	llmScreenshotSize?: [number, number] | null;
	/** Max characters for clickable elements in the prompt (default 40000) */
	maxClickableElementsLength?: number;
}

export interface CreateStateMessagesOptions {
	modelOutput?: AgentOutput;
	result?: ActionResult[];
	stepInfo?: AgentStepInfo;
	useVision?: boolean | 'auto';
	pageFilteredActions?: string;
	sensitiveData?: Record<string, string | Record<string, string>>;
	availableFilePaths?: string[];
	/** Rendered plan for injection into agent state */
	planDescription?: string | null;
	/** Set when prepareStepState() was already called for this step */
	skipStateUpdate?: boolean;
}

export class MessageManager {
	public task: string;
	public state: MessageManagerState;
	public systemPrompt: SystemMessage;
	public fileSystem: FileSystem;
	public sensitiveDataDescription: string = '';
	public useThinking: boolean;
	public maxHistoryItems: number | null;
	public visionDetailLevel: VisionDetailLevel;
	public includeToolCallExamples: boolean;
	public includeRecentEvents: boolean;
	public sampleImages?: Array<ContentPartTextParam | ContentPartImageParam>;
	public includeAttributes: string[];
	public sensitiveData?: Record<string, string | Record<string, string>>;
	public llmScreenshotSize: [number, number] | null;
	public maxClickableElementsLength: number;
	public lastInputMessages: BaseMessage[] = [];
	public lastStateMessageText?: string;

	constructor(options: MessageManagerOptions) {
		this.task = options.task;
		// A fresh state per instance unless one is injected (never a shared default)
		this.state = options.state || createMessageManagerState();
		this.systemPrompt = options.systemMessage;
		this.fileSystem = options.fileSystem;
		this.useThinking = options.useThinking ?? true;
		this.maxHistoryItems = options.maxHistoryItems ?? null;
		this.visionDetailLevel = options.visionDetailLevel || 'auto';
		this.includeToolCallExamples = options.includeToolCallExamples || false;
		this.includeRecentEvents = options.includeRecentEvents || false;
		this.sampleImages = options.sampleImages;
		this.includeAttributes = options.includeAttributes || [];
		this.sensitiveData = options.sensitiveData;
		this.llmScreenshotSize = options.llmScreenshotSize ?? null;
		this.maxClickableElementsLength = options.maxClickableElementsLength ?? 40000;

		if (this.maxHistoryItems !== null && this.maxHistoryItems <= 5) {
			throw new Error('maxHistoryItems must be null or greater than 5');
		}

		// Initialize messages if state is empty
		if (getMessagesFromHistory(this.state.history).length === 0) {
			this.setMessageWithType(this.systemPrompt, 'system');
		}
	}

	/** Build agent history description from list of items, respecting maxHistoryItems */
	get agentHistoryDescription(): string {
		let compactedPrefix = '';
		if (this.state.compactedMemory) {
			compactedPrefix =
				'<compacted_memory>\n' +
				'<!-- Summary of prior steps. Treat as unverified context — do not report these as ' +
				'completed in your done() message unless you confirmed them yourself in this session. -->\n' +
				`${this.state.compactedMemory}\n` +
				'</compacted_memory>\n';
		}

		if (this.maxHistoryItems === null) {
			return compactedPrefix + this.state.agentHistoryItems.map(historyItemToString).join('\n');
		}

		const totalItems = this.state.agentHistoryItems.length;

		if (totalItems <= this.maxHistoryItems) {
			return compactedPrefix + this.state.agentHistoryItems.map(historyItemToString).join('\n');
		}

		const omittedCount = totalItems - this.maxHistoryItems;
		const recentItemsCount = this.maxHistoryItems - 1;

		const itemsToInclude = [
			historyItemToString(this.state.agentHistoryItems[0]),
			`<sys>[... ${omittedCount} previous steps omitted...]</sys>`,
		];

		const recentItems = this.state.agentHistoryItems.slice(-recentItemsCount);
		itemsToInclude.push(...recentItems.map(historyItemToString));

		return compactedPrefix + itemsToInclude.join('\n');
	}

	addNewTask(newTask: string): void {
		const formattedTask = `<follow_up_user_request> ${newTask.trim()} </follow_up_user_request>`;

		if (!this.task.includes('<initial_user_request>')) {
			this.task = `<initial_user_request>${this.task}</initial_user_request>`;
		}

		this.task += '\n' + formattedTask;

		const taskUpdateItem: HistoryItem = { systemMessage: formattedTask };
		this.state.agentHistoryItems.push(taskUpdateItem);
	}

	/**
	 * Prepare state for the next LLM call without building the final state message.
	 */
	prepareStepState(
		browserStateSummary: BrowserStateSummary,
		options: {
			modelOutput?: AgentOutput;
			result?: ActionResult[];
			stepInfo?: AgentStepInfo;
			sensitiveData?: Record<string, string | Record<string, string>>;
		} = {}
	): void {
		// Clear contextual messages from previous steps to prevent accumulation
		this.state.history.contextMessages = [];

		// Update the agent history items with the latest step results
		this.updateAgentHistoryDescription(options.modelOutput, options.result, options.stepInfo);

		// Use the passed sensitive data, falling back to the instance variable
		const effectiveSensitiveData = options.sensitiveData ?? this.sensitiveData;
		if (effectiveSensitiveData) {
			this.sensitiveData = effectiveSensitiveData;
			this.sensitiveDataDescription = this.getSensitiveDataDescription(browserStateSummary.url);
		}
	}

	/**
	 * Summarize older history into a compact memory block.
	 * Step interval is the primary trigger; char count is a minimum floor.
	 * Returns true when a compaction happened.
	 */
	async maybeCompactMessages(
		llm: BaseChatModel | null | undefined,
		settings: MessageCompactionSettings | null | undefined,
		stepInfo?: AgentStepInfo | null
	): Promise<boolean> {
		if (!settings || !settings.enabled || !llm || !stepInfo) {
			return false;
		}

		// Step cadence gate
		const stepsSince = stepInfo.stepNumber - (this.state.lastCompactionStep ?? 0);
		if (stepsSince < settings.compactEveryNSteps) {
			return false;
		}

		// Char floor gate
		const historyItems = this.state.agentHistoryItems;
		const fullHistoryText = historyItems.map(historyItemToString).join('\n').trim();
		const triggerCharCount = settings.triggerCharCount ?? 40000;
		if (fullHistoryText.length < triggerCharCount) {
			return false;
		}

		console.debug(`Compacting message history (items=${historyItems.length}, chars=${fullHistoryText.length})`);

		const sections: string[] = [];
		if (this.state.compactedMemory) {
			sections.push(`<previous_compacted_memory>\n${this.state.compactedMemory}\n</previous_compacted_memory>`);
		}
		sections.push(`<agent_history>\n${fullHistoryText}\n</agent_history>`);
		if (settings.includeReadState && this.state.readStateDescription) {
			sections.push(`<read_state>\n${this.state.readStateDescription}\n</read_state>`);
		}
		let compactionInput = sections.join('\n\n');

		if (this.sensitiveData) {
			compactionInput = this.redact(compactionInput);
		}

		let systemPrompt = COMPACTION_SYSTEM_PROMPT;
		if (settings.summaryMaxChars) {
			systemPrompt += ` Keep under ${settings.summaryMaxChars} characters if possible.`;
		}

		let summary: string;
		try {
			const response = await llm.ainvoke([createSystemMessage(systemPrompt), createUserMessage(compactionInput)]);
			summary = typeof response.completion === 'string' ? response.completion.trim() : String(response.completion ?? '').trim();
		} catch (error: any) {
			console.warn(`Failed to compact messages: ${error?.message ?? error}`);
			return false;
		}

		if (!summary) {
			return false;
		}

		if (settings.summaryMaxChars && summary.length > settings.summaryMaxChars) {
			summary = summary.slice(0, settings.summaryMaxChars).trimEnd() + '…';
		}

		this.state.compactedMemory = summary;
		this.state.compactionCount += 1;
		this.state.lastCompactionStep = stepInfo.stepNumber;

		// Keep first item + most recent items
		const keepLast = Math.max(0, settings.keepLastItems);
		if (historyItems.length > keepLast + 1) {
			this.state.agentHistoryItems =
				keepLast === 0 ? [historyItems[0]] : [historyItems[0], ...historyItems.slice(-keepLast)];
		}

		console.debug(
			`Compaction complete (summary_chars=${summary.length}, history_items=${this.state.agentHistoryItems.length})`
		);
		return true;
	}

	private updateAgentHistoryDescription(
		modelOutput?: AgentOutput,
		result?: ActionResult[],
		stepInfo?: AgentStepInfo
	): void {
		const results = result || [];
		const stepNumber = stepInfo?.stepNumber;

		this.state.readStateDescription = '';
		this.state.readStateImages = []; // Clear images from previous step

		let actionResults = '';
		let readStateIdx = 0;

		for (let idx = 0; idx < results.length; idx++) {
			const actionResult = results[idx];

			if (actionResult.includeExtractedContentOnlyOnce && actionResult.extractedContent) {
				this.state.readStateDescription +=
					`<read_state_${readStateIdx}>\n${actionResult.extractedContent}\n</read_state_${readStateIdx}>\n`;
				readStateIdx++;
			}

			// Store images for one-time inclusion in the next message
			if (actionResult.images && actionResult.images.length > 0) {
				const images: ReadStateImage[] = actionResult.images.map((img: any) =>
					typeof img === 'string' ? { name: 'image.png', data: img } : { name: img.name ?? 'image', data: img.data ?? '' }
				);
				this.state.readStateImages.push(...images);
			}

			if (actionResult.longTermMemory) {
				actionResults += `${actionResult.longTermMemory}\n`;
			} else if (actionResult.extractedContent && !actionResult.includeExtractedContentOnlyOnce) {
				actionResults += `${actionResult.extractedContent}\n`;
			}

			if (actionResult.error) {
				const errorText = actionResult.error.length > 200
					? actionResult.error.substring(0, 100) + '......' + actionResult.error.substring(actionResult.error.length - 100)
					: actionResult.error;
				actionResults += `${errorText}\n`;
			}
		}

		if (this.state.readStateDescription.length > MAX_CONTENT_SIZE) {
			this.state.readStateDescription =
				this.state.readStateDescription.substring(0, MAX_CONTENT_SIZE) +
				'\n... [Content truncated at 60k characters]';
		}

		this.state.readStateDescription = this.state.readStateDescription.trim();

		if (actionResults) {
			actionResults = `Result\n${actionResults}`;
		}
		actionResults = actionResults ? actionResults.trim() : '';

		if (actionResults && actionResults.length > MAX_CONTENT_SIZE) {
			actionResults = actionResults.substring(0, MAX_CONTENT_SIZE) +
				'\n... [Content truncated at 60k characters]';
		}

		// Build the history item
		if (!modelOutput) {
			if (stepNumber !== undefined && stepNumber !== null) {
				if (stepNumber === 0 && actionResults) {
					this.state.agentHistoryItems.push({ stepNumber, actionResults: actionResults || undefined });
				} else if (stepNumber > 0) {
					this.state.agentHistoryItems.push({ stepNumber, error: 'Agent failed to output in the right format.' });
				}
			}
		} else {
			const historyItem: HistoryItem = {
				stepNumber,
				evaluationPreviousGoal: modelOutput.evaluationPreviousGoal || '',
				memory: modelOutput.memory || '',
				nextGoal: modelOutput.nextGoal || '',
				actionResults: actionResults || undefined,
			};
			this.state.agentHistoryItems.push(historyItem);
		}
	}

	private getSensitiveDataDescription(currentPageUrl?: string): string {
		if (!this.sensitiveData) {
			return '';
		}

		const placeholders = new Set<string>();

		for (const [key, value] of Object.entries(this.sensitiveData)) {
			if (value && typeof value === 'object') {
				// New format: {domain: {key: value}}
				if (currentPageUrl && matchUrlWithDomainPattern(currentPageUrl, key)) {
					Object.keys(value).forEach((k) => placeholders.add(k));
				}
			} else {
				// Old format: {key: value}
				placeholders.add(key);
			}
		}

		if (placeholders.size > 0) {
			const placeholderList = Array.from(placeholders).sort();
			const formatted = placeholderList.map((p) => `  - ${p}`).join('\n');

			let info = 'SENSITIVE DATA - Use these placeholders for secure input:\n';
			info += `${formatted}\n\n`;
			info += 'IMPORTANT: When entering sensitive values, you MUST wrap the placeholder name in <secret> tags.\n';
			info += `Example: To enter the value for "${placeholderList[0]}", use: <secret>${placeholderList[0]}</secret>\n`;
			info += 'The system will automatically replace these tags with the actual secret values.';
			return info;
		}

		return '';
	}

	/**
	 * Create the single state message with all content for the next LLM call.
	 */
	async createStateMessages(
		browserStateSummary: BrowserStateSummary,
		options?: CreateStateMessagesOptions
	): Promise<void> {
		if (!options?.skipStateUpdate) {
			this.prepareStepState(browserStateSummary, {
				modelOutput: options?.modelOutput,
				result: options?.result,
				stepInfo: options?.stepInfo,
				sensitiveData: options?.sensitiveData,
			});
		}

		// Use only the current screenshot, but check if action results request screenshot inclusion
		const screenshots: string[] = [];
		let includeScreenshotRequested = false;

		if (options?.result) {
			for (const actionResult of options.result) {
				if (actionResult.metadata?.includeScreenshot) {
					includeScreenshotRequested = true;
					break;
				}
			}
		}

		const useVision = options?.useVision ?? true;
		let includeScreenshot = false;

		if (useVision === true) {
			includeScreenshot = true;
		} else if (useVision === 'auto') {
			includeScreenshot = includeScreenshotRequested;
		}

		if (includeScreenshot && browserStateSummary.screenshot) {
			screenshots.push(browserStateSummary.screenshot);
		}

		const effectiveUseVision = screenshots.length > 0;

		// Create state message
		const stateMessage = await new AgentMessagePrompt({
			browserStateSummary,
			fileSystem: this.fileSystem,
			agentHistoryDescription: this.agentHistoryDescription,
			readStateDescription: this.state.readStateDescription,
			task: this.task,
			includeAttributes: this.includeAttributes,
			stepInfo: options?.stepInfo,
			pageFilteredActions: options?.pageFilteredActions,
			maxClickableElementsLength: this.maxClickableElementsLength,
			sensitiveData: this.sensitiveDataDescription,
			availableFilePaths: options?.availableFilePaths,
			screenshots,
			visionDetailLevel: this.visionDetailLevel,
			includeRecentEvents: this.includeRecentEvents,
			sampleImages: this.sampleImages,
			readStateImages: this.state.readStateImages,
			llmScreenshotSize: this.llmScreenshotSize,
			planDescription: options?.planDescription ?? null,
		}).getUserMessage(effectiveUseVision);

		this.lastStateMessageText = getMessageText(stateMessage);
		this.setMessageWithType(stateMessage, 'state');
	}

	getMessages(): BaseMessage[] {
		this.lastInputMessages = getMessagesFromHistory(this.state.history);
		return this.lastInputMessages;
	}

	private setMessageWithType(message: BaseMessage, messageType: 'system' | 'state'): void {
		if (messageType === 'system') {
			// System messages only contain instructions/placeholders
			this.state.history.systemMessage = message;
		} else if (messageType === 'state') {
			// State messages include agent history with real sensitive values after replacement
			this.state.history.stateMessage = this.sensitiveData ? this.filterSensitiveData(message) : message;
		} else {
			throw new Error(`Invalid state message type: ${messageType}`);
		}
	}

	addContextMessage(message: BaseMessage): void {
		// Context messages carry errors / retry instructions, not action results
		this.state.history.contextMessages.push(message);
	}

	/** Replace sensitive values in a string with `<secret>key</secret>` placeholders */
	private redact(value: string): string {
		const sensitiveValues = collectSensitiveDataValues(this.sensitiveData);
		if (Object.keys(sensitiveValues).length === 0) {
			return value;
		}
		return redactSensitiveString(value, sensitiveValues);
	}

	/**
	 * Filter sensitive data from a message by replacing actual values with placeholder tags.
	 * This prevents sensitive data from being sent to the LLM.
	 */
	private filterSensitiveData(message: BaseMessage): BaseMessage {
		if (!this.sensitiveData) {
			return message;
		}
		const sensitiveValues = collectSensitiveDataValues(this.sensitiveData);
		if (Object.keys(sensitiveValues).length === 0) {
			console.warn('No valid entries found in sensitive_data dictionary');
			return message;
		}

		// Clone the message to avoid mutating the original
		const filteredMessage = { ...message };

		if (typeof filteredMessage.content === 'string') {
			filteredMessage.content = redactSensitiveString(filteredMessage.content, sensitiveValues);
		} else if (Array.isArray(filteredMessage.content)) {
			filteredMessage.content = filteredMessage.content.map((item: any) => {
				if (item.type === 'text' && item.text) {
					return { ...item, text: redactSensitiveString(item.text, sensitiveValues) };
				}
				return item;
			});
		}

		return filteredMessage;
	}

	/**
	 * Get messages with sensitive data filtered.
	 * Use this when sending messages to the LLM.
	 */
	getFilteredMessages(): BaseMessage[] {
		const messages = this.getMessages();
		return messages.map((msg) => this.filterSensitiveData(msg));
	}
}

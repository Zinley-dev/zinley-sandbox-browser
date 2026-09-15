/**
 * Message manager views and models
 * Port from browser_use/agent/message_manager/views.py (Python browser-use 0.13.10)
 */

import { z } from 'zod';
import { BaseMessage } from '../../llm/messages.js';

// ============================================================================
// History Item
// ============================================================================

export interface HistoryItem {
	stepNumber?: number | null;
	evaluationPreviousGoal?: string | null;
	memory?: string | null;
	nextGoal?: string | null;
	actionResults?: string | null;
	error?: string | null;
	systemMessage?: string | null;
}

export const HistoryItemSchema = z.object({
	stepNumber: z.number().nullable().optional(),
	evaluationPreviousGoal: z.string().nullable().optional(),
	memory: z.string().nullable().optional(),
	nextGoal: z.string().nullable().optional(),
	actionResults: z.string().nullable().optional(),
	error: z.string().nullable().optional(),
	systemMessage: z.string().nullable().optional(),
}).refine(
	(data) => !(data.error && data.systemMessage),
	{ message: 'Cannot have both error and systemMessage at the same time' }
);

export function historyItemToString(item: HistoryItem): string {
	const stepStr = item.stepNumber !== null && item.stepNumber !== undefined
		? `step_${item.stepNumber}`
		: 'step_unknown';

	if (item.error) {
		return `<${stepStr}>\n${item.error}\n</${stepStr}>`;
	} else if (item.systemMessage) {
		return `<sys>\n${item.systemMessage}\n</sys>`;
	} else {
		const contentParts: string[] = [];

		if (item.evaluationPreviousGoal) {
			contentParts.push(`Evaluation of Previous Step: ${item.evaluationPreviousGoal}`);
		}

		if (item.memory) {
			contentParts.push(`Memory: ${item.memory}`);
		}

		if (item.nextGoal) {
			contentParts.push(`Next Goal: ${item.nextGoal}`);
		}

		if (item.actionResults) {
			contentParts.push(item.actionResults);
		}

		const content = contentParts.join('\n');
		return `<${stepStr}>\n${content}\n</${stepStr}>`;
	}
}

// ============================================================================
// Message History
// ============================================================================

export interface MessageHistory {
	systemMessage?: BaseMessage | null;
	stateMessage?: BaseMessage | null;
	contextMessages: BaseMessage[];
}

export const MessageHistorySchema = z.object({
	systemMessage: z.any().nullable().optional(),
	stateMessage: z.any().nullable().optional(),
	contextMessages: z.array(z.any()).default([]),
});

export function getMessages(history: MessageHistory): BaseMessage[] {
	const messages: BaseMessage[] = [];

	if (history.systemMessage) {
		messages.push(history.systemMessage);
	}

	if (history.stateMessage) {
		messages.push(history.stateMessage);
	}

	messages.push(...history.contextMessages);

	return messages;
}

// ============================================================================
// Message Manager State
// ============================================================================

/** Base64 image attached to an action result (e.g. read_file on an image). */
export interface ReadStateImage {
	name: string;
	data: string;
}

export interface MessageManagerState {
	history: MessageHistory;
	toolId: number;
	agentHistoryItems: HistoryItem[];
	readStateDescription: string;
	/** Images to include in the next state message (cleared after each step) */
	readStateImages: ReadStateImage[];
	/** Summary of older history produced by message compaction */
	compactedMemory: string | null;
	compactionCount: number;
	lastCompactionStep: number | null;
}

export const MessageManagerStateSchema = z.object({
	history: MessageHistorySchema,
	toolId: z.number().default(1),
	agentHistoryItems: z.array(HistoryItemSchema).default([
		{ stepNumber: 0, systemMessage: 'Agent initialized' }
	]),
	readStateDescription: z.string().default(''),
	readStateImages: z.array(z.object({ name: z.string(), data: z.string() })).default([]),
	compactedMemory: z.string().nullable().default(null),
	compactionCount: z.number().default(0),
	lastCompactionStep: z.number().nullable().default(null),
});

export function createMessageManagerState(): MessageManagerState {
	return {
		history: {
			systemMessage: null,
			stateMessage: null,
			contextMessages: [],
		},
		toolId: 1,
		agentHistoryItems: [
			{ stepNumber: 0, systemMessage: 'Agent initialized' }
		],
		readStateDescription: '',
		readStateImages: [],
		compactedMemory: null,
		compactionCount: 0,
		lastCompactionStep: null,
	};
}

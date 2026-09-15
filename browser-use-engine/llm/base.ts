/**
 * Base interface for LLM chat models
 * Port from browser_use/llm/base.py (synced with 0.13.10)
 */

import { BaseMessage } from './messages.js';
import { ChatInvokeCompletion } from './views.js';
import { z } from 'zod';

/**
 * Per-call options (Python passes these as `**kwargs`).
 */
export interface ChatInvokeOptions {
	/** Abort the request */
	signal?: AbortSignal;
	/** Type of request, e.g. 'browser_agent' or 'judge' (used by gateway providers) */
	requestType?: string;
	/** Session id for sticky routing on gateway providers */
	sessionId?: string;
	[key: string]: unknown;
}

/**
 * Return whether a model matches a non-empty reasoning-model pattern.
 * Port of `is_reasoning_model`.
 */
export function isReasoningModel(model: unknown, reasoningModels: Iterable<unknown> | null | undefined): boolean {
	if (!reasoningModels) {
		return false;
	}

	const modelName = String(model).toLowerCase();
	for (const pattern of reasoningModels) {
		const patternName = String(pattern).toLowerCase();
		if (patternName.trim() && modelName.includes(patternName)) {
			return true;
		}
	}

	return false;
}

export interface BaseChatModel {
	/** The model identifier (e.g., 'gpt-4o', 'claude-3-5-sonnet-20241022') */
	model: string;

	/** The provider name (e.g., 'openai', 'anthropic') */
	readonly provider: string;

	/** The full model name for display */
	readonly name: string;

	/**
	 * Invoke the LLM with messages
	 * @param messages - Array of conversation messages
	 * @param outputFormat - Optional Zod schema for structured output
	 * @param options - Optional per-call options (request type, session id, abort signal)
	 */
	ainvoke<T = string>(
		messages: BaseMessage[],
		outputFormat?: z.ZodType<T>,
		options?: ChatInvokeOptions
	): Promise<ChatInvokeCompletion<T>>;
}

/**
 * Check if an object implements the BaseChatModel interface
 */
export function isBaseChatModel(obj: unknown): obj is BaseChatModel {
	return (
		typeof obj === 'object' &&
		obj !== null &&
		'model' in obj &&
		'provider' in obj &&
		'name' in obj &&
		'ainvoke' in obj &&
		typeof (obj as BaseChatModel).ainvoke === 'function'
	);
}

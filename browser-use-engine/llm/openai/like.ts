/**
 * OpenAI-compatible chat model for any provider using the OpenAI API schema.
 * Port from browser_use/llm/openai/like.py
 */

import { ChatOpenAI, type ChatOpenAIOptions } from '../openai.js';

export interface ChatOpenAILikeOptions extends ChatOpenAIOptions {
	/** Model name - required for like providers */
	model: string;
}

/**
 * A class to interact with any provider using the OpenAI API schema.
 *
 * This can be used with providers like:
 * - LM Studio
 * - LocalAI
 * - vLLM
 * - Ollama (with OpenAI compatibility)
 * - Azure OpenAI
 * - Any OpenAI-compatible API
 *
 * @example
 * ```typescript
 * const llm = new ChatOpenAILike({
 *   model: 'local-model',
 *   baseURL: 'http://localhost:8080/v1',
 *   apiKey: 'not-needed', // Some providers don't require an API key
 * });
 * ```
 */
export class ChatOpenAILike extends ChatOpenAI {
	constructor(options: ChatOpenAILikeOptions) {
		super({
			...options,
			model: options.model,
		});
	}

	override get provider(): string {
		return 'openai_like';
	}
}

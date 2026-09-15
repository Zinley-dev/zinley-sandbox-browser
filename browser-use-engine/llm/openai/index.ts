/**
 * OpenAI LLM exports
 */

export { OpenAIMessageSerializer } from './serializer.js';
export type {
	ChatCompletionContentPartTextParam,
	ChatCompletionContentPartImageParam,
	ChatCompletionContentPartRefusalParam,
	ChatCompletionMessageFunctionToolCallParam,
	ChatCompletionUserMessageParam,
	ChatCompletionSystemMessageParam,
	ChatCompletionAssistantMessageParam,
	ChatCompletionMessageParam,
} from './serializer.js';

export { ChatOpenAILike, type ChatOpenAILikeOptions } from './like.js';

// Re-export the main chat class from parent
export { ChatOpenAI, type ChatOpenAIOptions } from '../openai.js';

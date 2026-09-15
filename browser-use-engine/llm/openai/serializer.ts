/**
 * OpenAI message serializer.
 * Port from browser_use/llm/openai/serializer.py
 */

import type {
	BaseMessage,
	UserMessage,
	SystemMessage,
	AssistantMessage,
	ContentPartTextParam,
	ContentPartImageParam,
	ContentPartRefusalParam,
	ToolCall,
} from '../messages.js';

// OpenAI SDK types (simplified for our use case)
export interface ChatCompletionContentPartTextParam {
	text: string;
	type: 'text';
}

export interface ImageURL {
	url: string;
	detail?: 'auto' | 'low' | 'high';
}

export interface ChatCompletionContentPartImageParam {
	image_url: ImageURL;
	type: 'image_url';
}

export interface ChatCompletionContentPartRefusalParam {
	refusal: string;
	type: 'refusal';
}

export interface FunctionParam {
	name: string;
	arguments: string;
}

export interface ChatCompletionMessageFunctionToolCallParam {
	id: string;
	function: FunctionParam;
	type: 'function';
}

export interface ChatCompletionUserMessageParam {
	role: 'user';
	content: string | (ChatCompletionContentPartTextParam | ChatCompletionContentPartImageParam)[];
	name?: string;
}

export interface ChatCompletionSystemMessageParam {
	role: 'system';
	content: string | ChatCompletionContentPartTextParam[];
	name?: string;
}

export interface ChatCompletionAssistantMessageParam {
	role: 'assistant';
	content?: string | (ChatCompletionContentPartTextParam | ChatCompletionContentPartRefusalParam)[] | null;
	name?: string;
	refusal?: string | null;
	tool_calls?: ChatCompletionMessageFunctionToolCallParam[];
}

export type ChatCompletionMessageParam =
	| ChatCompletionUserMessageParam
	| ChatCompletionSystemMessageParam
	| ChatCompletionAssistantMessageParam;

/**
 * Serializer for converting between custom message types and OpenAI message param types.
 */
export class OpenAIMessageSerializer {
	/**
	 * Convert a text content part to OpenAI format.
	 */
	static serializeContentPartText(part: ContentPartTextParam): ChatCompletionContentPartTextParam {
		return { text: part.text, type: 'text' };
	}

	/**
	 * Convert an image content part to OpenAI format.
	 */
	static serializeContentPartImage(part: ContentPartImageParam): ChatCompletionContentPartImageParam {
		return {
			image_url: {
				url: part.imageUrl.url,
				detail: part.imageUrl.detail,
			},
			type: 'image_url',
		};
	}

	/**
	 * Convert a refusal content part to OpenAI format.
	 */
	static serializeContentPartRefusal(part: ContentPartRefusalParam): ChatCompletionContentPartRefusalParam {
		return { refusal: part.refusal, type: 'refusal' };
	}

	/**
	 * Serialize content for user messages (text and images allowed).
	 */
	static serializeUserContent(
		content: string | (ContentPartTextParam | ContentPartImageParam)[]
	): string | (ChatCompletionContentPartTextParam | ChatCompletionContentPartImageParam)[] {
		if (typeof content === 'string') {
			return content;
		}

		const serializedParts: (ChatCompletionContentPartTextParam | ChatCompletionContentPartImageParam)[] = [];
		for (const part of content) {
			if (part.type === 'text') {
				serializedParts.push(OpenAIMessageSerializer.serializeContentPartText(part));
			} else if (part.type === 'image_url') {
				serializedParts.push(OpenAIMessageSerializer.serializeContentPartImage(part));
			}
		}
		return serializedParts;
	}

	/**
	 * Serialize content for system messages (text only).
	 */
	static serializeSystemContent(
		content: string | ContentPartTextParam[]
	): string | ChatCompletionContentPartTextParam[] {
		if (typeof content === 'string') {
			return content;
		}

		const serializedParts: ChatCompletionContentPartTextParam[] = [];
		for (const part of content) {
			if (part.type === 'text') {
				serializedParts.push(OpenAIMessageSerializer.serializeContentPartText(part));
			}
		}
		return serializedParts;
	}

	/**
	 * Serialize content for assistant messages (text and refusal allowed).
	 */
	static serializeAssistantContent(
		content: string | (ContentPartTextParam | ContentPartRefusalParam)[] | null | undefined
	): string | (ChatCompletionContentPartTextParam | ChatCompletionContentPartRefusalParam)[] | null {
		if (content === null || content === undefined) {
			return null;
		}
		if (typeof content === 'string') {
			return content;
		}

		const serializedParts: (ChatCompletionContentPartTextParam | ChatCompletionContentPartRefusalParam)[] = [];
		for (const part of content) {
			if (part.type === 'text') {
				serializedParts.push(OpenAIMessageSerializer.serializeContentPartText(part));
			} else if (part.type === 'refusal') {
				serializedParts.push(OpenAIMessageSerializer.serializeContentPartRefusal(part));
			}
		}
		return serializedParts;
	}

	/**
	 * Convert a tool call to OpenAI format.
	 */
	static serializeToolCall(toolCall: ToolCall): ChatCompletionMessageFunctionToolCallParam {
		return {
			id: toolCall.id,
			function: {
				name: toolCall.function.name,
				arguments: toolCall.function.arguments,
			},
			type: 'function',
		};
	}

	/**
	 * Serialize a custom message to an OpenAI message param.
	 */
	static serialize(message: BaseMessage): ChatCompletionMessageParam {
		if (message.role === 'user') {
			const userMsg = message as UserMessage;
			const result: ChatCompletionUserMessageParam = {
				role: 'user',
				content: OpenAIMessageSerializer.serializeUserContent(
					userMsg.content as string | (ContentPartTextParam | ContentPartImageParam)[]
				),
			};
			if (userMsg.name !== undefined) {
				result.name = userMsg.name;
			}
			return result;
		} else if (message.role === 'system') {
			const systemMsg = message as SystemMessage;
			const result: ChatCompletionSystemMessageParam = {
				role: 'system',
				content: OpenAIMessageSerializer.serializeSystemContent(systemMsg.content),
			};
			if (systemMsg.name !== undefined) {
				result.name = systemMsg.name;
			}
			return result;
		} else if (message.role === 'assistant') {
			const assistantMsg = message as AssistantMessage;

			// Handle content serialization
			const content = OpenAIMessageSerializer.serializeAssistantContent(assistantMsg.content);

			const result: ChatCompletionAssistantMessageParam = { role: 'assistant' };

			// Only add content if it's not null
			if (content !== null) {
				result.content = content;
			}

			if (assistantMsg.name !== undefined) {
				result.name = assistantMsg.name;
			}
			if (assistantMsg.refusal !== undefined && assistantMsg.refusal !== null) {
				result.refusal = assistantMsg.refusal;
			}
			if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
				result.tool_calls = assistantMsg.toolCalls.map((tc) =>
					OpenAIMessageSerializer.serializeToolCall(tc)
				);
			}

			return result;
		} else {
			throw new Error(`Unknown message type: ${(message as BaseMessage).role}`);
		}
	}

	/**
	 * Serialize a list of messages to OpenAI format.
	 */
	static serializeMessages(messages: BaseMessage[]): ChatCompletionMessageParam[] {
		return messages.map((m) => OpenAIMessageSerializer.serialize(m));
	}
}

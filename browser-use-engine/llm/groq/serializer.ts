/**
 * Groq message serializer
 * Port from browser_use/llm/groq/serializer.py
 */
import Groq from 'groq-sdk';
import {
	BaseMessage,
	SystemMessage,
	UserMessage,
	AssistantMessage,
	ContentPartTextParam,
	ContentPartImageParam,
	ContentPartRefusalParam,
	ToolCall,
} from '../messages.js';

export class GroqMessageSerializer {
	static serializeContentPartText(
		part: ContentPartTextParam
	): Groq.Chat.Completions.ChatCompletionContentPartText {
		return {
			type: 'text',
			text: part.text,
		};
	}

	static serializeContentPartImage(
		part: ContentPartImageParam
	): Groq.Chat.Completions.ChatCompletionContentPartImage {
		return {
			type: 'image_url',
			image_url: {
				url: part.imageUrl.url,
				detail: part.imageUrl.detail,
			},
		};
	}

	static serializeUserContent(
		content: string | Array<ContentPartTextParam | ContentPartImageParam>
	): string | Array<Groq.Chat.Completions.ChatCompletionContentPartText | Groq.Chat.Completions.ChatCompletionContentPartImage> {
		if (typeof content === 'string') {
			return content;
		}

		const serializedParts: Array<
			Groq.Chat.Completions.ChatCompletionContentPartText | Groq.Chat.Completions.ChatCompletionContentPartImage
		> = [];

		for (const part of content) {
			if (part.type === 'text') {
				serializedParts.push(this.serializeContentPartText(part));
			} else if (part.type === 'image_url') {
				serializedParts.push(this.serializeContentPartImage(part));
			}
		}

		return serializedParts;
	}

	static serializeSystemContent(content: string | Array<ContentPartTextParam>): string {
		if (typeof content === 'string') {
			return content;
		}

		const serializedParts: string[] = [];
		for (const part of content) {
			if (part.type === 'text') {
				serializedParts.push(this.serializeContentPartText(part).text);
			}
		}

		return serializedParts.join('\n');
	}

	static serializeAssistantContent(
		content: string | Array<ContentPartTextParam | ContentPartRefusalParam> | null
	): string | null {
		if (content === null) {
			return null;
		}
		if (typeof content === 'string') {
			return content;
		}

		const serializedParts: string[] = [];
		for (const part of content) {
			if (part.type === 'text') {
				serializedParts.push(this.serializeContentPartText(part).text);
			}
		}

		return serializedParts.join('\n');
	}

	static serializeToolCall(toolCall: ToolCall): Groq.Chat.Completions.ChatCompletionMessageToolCall {
		return {
			id: toolCall.id,
			type: 'function',
			function: {
				name: toolCall.function.name,
				arguments: toolCall.function.arguments,
			},
		};
	}

	static serialize(message: BaseMessage): Groq.Chat.Completions.ChatCompletionMessageParam {
		if (message.role === 'user') {
			const userMsg = message as UserMessage;
			const result: Groq.Chat.Completions.ChatCompletionUserMessageParam = {
				role: 'user',
				content: this.serializeUserContent(userMsg.content as string | Array<ContentPartTextParam | ContentPartImageParam>),
			};
			if (userMsg.name) {
				result.name = userMsg.name;
			}
			return result;
		} else if (message.role === 'system') {
			const systemMsg = message as SystemMessage;
			const result: Groq.Chat.Completions.ChatCompletionSystemMessageParam = {
				role: 'system',
				content: this.serializeSystemContent(systemMsg.content),
			};
			if (systemMsg.name) {
				result.name = systemMsg.name;
			}
			return result;
		} else if (message.role === 'assistant') {
			const assistantMsg = message as AssistantMessage;
			const content = this.serializeAssistantContent(assistantMsg.content || null);

			const result: Groq.Chat.Completions.ChatCompletionAssistantMessageParam = {
				role: 'assistant',
			};

			// Only add content if it's not null
			if (content !== null) {
				result.content = content;
			}

			if (assistantMsg.name) {
				result.name = assistantMsg.name;
			}

			if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
				result.tool_calls = assistantMsg.toolCalls.map((tc: ToolCall) => this.serializeToolCall(tc));
			}

			return result;
		} else {
			throw new Error(`Unknown message type: ${(message as any).role}`);
		}
	}

	static serializeMessages(messages: BaseMessage[]): Groq.Chat.Completions.ChatCompletionMessageParam[] {
		return messages.map((m) => this.serialize(m));
	}
}

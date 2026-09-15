/**
 * Ollama message serializer
 * Port from browser_use/llm/ollama/serializer.py (133 lines)
 */
import { Message } from 'ollama';
import {
	BaseMessage,
	SystemMessage,
	UserMessage,
	AssistantMessage,
	ContentPart,
	ToolCall,
} from '../messages.js';

export class OllamaMessageSerializer {
	private static extractTextContent(content: any): string {
		if (content === null || content === undefined) {
			return '';
		}
		if (typeof content === 'string') {
			return content;
		}

		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === 'text') {
				textParts.push(part.text);
			} else if (part.type === 'refusal') {
				textParts.push(`[Refusal] ${part.refusal}`);
			}
			// Skip image parts as they're handled separately
		}

		return textParts.join('\n');
	}

	private static extractImages(content: any): string[] {
		if (content === null || content === undefined || typeof content === 'string') {
			return [];
		}

		const images: string[] = [];
		for (const part of content) {
			if (part.type === 'image_url') {
				const url = part.imageUrl.url;
				if (url.startsWith('data:')) {
					// Handle base64 encoded images
					// Format: data:image/jpeg;base64,<data>
					const [, data] = url.split(',', 2);
					// For Ollama, we pass the base64 data directly
					images.push(data);
				} else {
					// Handle URL images
					images.push(url);
				}
			}
		}

		return images;
	}

	private static serializeToolCalls(toolCalls: ToolCall[]): any[] {
		const ollamaToolCalls: any[] = [];

		for (const toolCall of toolCalls) {
			// Parse arguments from JSON string to object for Ollama
			let argumentsDict: any;
			try {
				argumentsDict = JSON.parse(toolCall.function.arguments);
			} catch (error) {
				// If parsing fails, wrap in a dict
				argumentsDict = { arguments: toolCall.function.arguments };
			}

			ollamaToolCalls.push({
				function: {
					name: toolCall.function.name,
					arguments: argumentsDict,
				},
			});
		}

		return ollamaToolCalls;
	}

	static serialize(message: BaseMessage): Message {
		if (message.role === 'user') {
			const userMsg = message as UserMessage;
			const textContent = this.extractTextContent(userMsg.content);
			const images = this.extractImages(userMsg.content);

			const ollamaMessage: any = {
				role: 'user',
			};

			if (textContent) {
				ollamaMessage.content = textContent;
			}

			if (images.length > 0) {
				ollamaMessage.images = images;
			}

			return ollamaMessage;
		} else if (message.role === 'system') {
			const systemMsg = message as SystemMessage;
			const textContent = this.extractTextContent(systemMsg.content);

			const ollamaMessage: any = {
				role: 'system',
			};

			if (textContent) {
				ollamaMessage.content = textContent;
			}

			return ollamaMessage;
		} else if (message.role === 'assistant') {
			const assistantMsg = message as AssistantMessage;
			const textContent = assistantMsg.content ? this.extractTextContent(assistantMsg.content) : null;

			const ollamaMessage: any = {
				role: 'assistant',
			};

			if (textContent) {
				ollamaMessage.content = textContent;
			}

			// Handle tool calls
			if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
				ollamaMessage.tool_calls = this.serializeToolCalls(assistantMsg.toolCalls);
			}

			return ollamaMessage;
		} else {
			throw new Error(`Unknown message type: ${(message as any).role}`);
		}
	}

	static serializeMessages(messages: BaseMessage[]): Message[] {
		return messages.map((m) => this.serialize(m));
	}
}

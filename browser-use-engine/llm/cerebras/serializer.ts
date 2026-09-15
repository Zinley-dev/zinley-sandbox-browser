/**
 * Cerebras message serializer (OpenAI-compatible)
 * Port from browser_use/llm/cerebras/serializer.py
 */
import { BaseMessage, SystemMessage, UserMessage, AssistantMessage } from '../messages.js';

type MessageDict = Record<string, any>;

export class CerebrasMessageSerializer {
	static serialize(message: BaseMessage): MessageDict {
		// Cerebras uses standard OpenAI message format
		if (message.role === 'user') {
			const userMsg = message as UserMessage;
			return {
				role: 'user',
				content: typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content),
			};
		}

		if (message.role === 'system') {
			const systemMsg = message as SystemMessage;
			return {
				role: 'system',
				content: typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content),
			};
		}

		if (message.role === 'assistant') {
			const assistantMsg = message as AssistantMessage;
			return {
				role: 'assistant',
				content: typeof assistantMsg.content === 'string' ? assistantMsg.content : JSON.stringify(assistantMsg.content),
			};
		}

		throw new Error(`Unknown message type: ${(message as any).role}`);
	}

	static serializeMessages(messages: BaseMessage[]): MessageDict[] {
		return messages.map((m) => this.serialize(m));
	}
}

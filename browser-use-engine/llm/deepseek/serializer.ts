/**
 * DeepSeek message serializer
 * Port from browser_use/llm/deepseek/serializer.py (121 lines)
 */
import {
	BaseMessage,
	SystemMessage,
	UserMessage,
	AssistantMessage,
	ContentPartTextParam,
	ContentPartImageParam,
	ToolCall,
} from '../messages.js';

type MessageDict = Record<string, any>;

export class DeepSeekMessageSerializer {
	private static serializeTextPart(part: ContentPartTextParam): string {
		return part.text;
	}

	private static serializeImagePart(part: ContentPartImageParam): Record<string, any> {
		const url = part.imageUrl.url;
		return {
			type: 'image_url',
			image_url: { url },
		};
	}

	private static serializeContent(content: any): string | Array<Record<string, any>> {
		if (content === null || content === undefined) {
			return '';
		}
		if (typeof content === 'string') {
			return content;
		}

		const serialized: Array<Record<string, any>> = [];
		for (const part of content) {
			if (part.type === 'text') {
				serialized.push({
					type: 'text',
					text: this.serializeTextPart(part),
				});
			} else if (part.type === 'image_url') {
				serialized.push(this.serializeImagePart(part));
			} else if (part.type === 'refusal') {
				serialized.push({
					type: 'text',
					text: `[Refusal] ${part.refusal}`,
				});
			}
		}

		return serialized;
	}

	private static serializeToolCalls(toolCalls: ToolCall[]): Array<Record<string, any>> {
		const deepseekToolCalls: Array<Record<string, any>> = [];

		for (const tc of toolCalls) {
			let argsDict: any;
			try {
				argsDict = JSON.parse(tc.function.arguments);
			} catch (error) {
				argsDict = { arguments: tc.function.arguments };
			}

			deepseekToolCalls.push({
				id: tc.id,
				type: 'function',
				function: {
					name: tc.function.name,
					arguments: argsDict,
				},
			});
		}

		return deepseekToolCalls;
	}

	static serialize(message: BaseMessage): MessageDict {
		if (message.role === 'user') {
			const userMsg = message as UserMessage;
			return {
				role: 'user',
				content: this.serializeContent(userMsg.content),
			};
		}

		if (message.role === 'system') {
			const systemMsg = message as SystemMessage;
			return {
				role: 'system',
				content: this.serializeContent(systemMsg.content),
			};
		}

		if (message.role === 'assistant') {
			const assistantMsg = message as AssistantMessage;
			const msg: MessageDict = {
				role: 'assistant',
				content: this.serializeContent(assistantMsg.content),
			};

			if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
				msg.tool_calls = this.serializeToolCalls(assistantMsg.toolCalls);
			}

			return msg;
		}

		throw new Error(`Unknown message type: ${(message as any).role}`);
	}

	static serializeMessages(messages: BaseMessage[]): MessageDict[] {
		return messages.map((m) => this.serialize(m));
	}
}

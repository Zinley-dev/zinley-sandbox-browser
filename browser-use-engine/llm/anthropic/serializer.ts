/**
 * Anthropic message serializer with prompt caching support.
 * Port from browser_use/llm/anthropic/serializer.py
 */

import type {
	BaseMessage,
	UserMessage,
	SystemMessage,
	AssistantMessage,
	ContentPartTextParam,
	ContentPartImageParam,
	ContentPartRefusalParam,
	SupportedImageMediaType,
	ToolCall,
} from '../messages.js';

// Custom types that extend Anthropic SDK types with cache_control support
// The Anthropic SDK TypeScript types don't include cache_control yet, but the API supports it
interface CacheControlEphemeralParam {
	type: 'ephemeral';
}

interface TextBlockParam {
	text: string;
	type: 'text';
	cache_control?: CacheControlEphemeralParam;
}

interface ImageBlockParam {
	source:
		| {
				data: string;
				media_type: SupportedImageMediaType;
				type: 'base64';
		  }
		| {
				url: string;
				type: 'url';
		  };
	type: 'image';
	cache_control?: CacheControlEphemeralParam;
}

interface ToolUseBlockParam {
	id: string;
	input: Record<string, unknown>;
	name: string;
	type: 'tool_use';
	cache_control?: CacheControlEphemeralParam;
}

interface MessageParam {
	role: 'user' | 'assistant';
	content: string | (TextBlockParam | ImageBlockParam | ToolUseBlockParam)[];
}

type NonSystemMessage = UserMessage | AssistantMessage;

/**
 * Serializer for converting between custom message types and Anthropic message param types.
 */
export class AnthropicMessageSerializer {
	/**
	 * Check if the URL is a base64 encoded image.
	 */
	static isBase64Image(url: string): boolean {
		return url.startsWith('data:image/');
	}

	/**
	 * Parse a base64 data URL to extract media type and data.
	 */
	static parseBase64Url(url: string): [SupportedImageMediaType, string] {
		if (!url.startsWith('data:')) {
			throw new Error(`Invalid base64 URL: ${url}`);
		}

		const [header, data] = url.split(',', 2);
		const mediaType = header.split(';')[0].replace('data:', '');

		// Ensure it's a supported media type
		const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
		const validatedType = supportedTypes.includes(mediaType) ? mediaType : 'image/jpeg';

		return [validatedType as SupportedImageMediaType, data];
	}

	/**
	 * Serialize cache control.
	 */
	static serializeCacheControl(useCache: boolean): CacheControlEphemeralParam | undefined {
		if (useCache) {
			return { type: 'ephemeral' };
		}
		return undefined;
	}

	/**
	 * Convert a text content part to Anthropic's TextBlockParam.
	 */
	static serializeContentPartText(part: ContentPartTextParam, useCache: boolean): TextBlockParam {
		return {
			text: part.text,
			type: 'text',
			cache_control: AnthropicMessageSerializer.serializeCacheControl(useCache),
		};
	}

	/**
	 * Convert an image content part to Anthropic's ImageBlockParam.
	 */
	static serializeContentPartImage(part: ContentPartImageParam): ImageBlockParam {
		const url = part.imageUrl.url;

		if (AnthropicMessageSerializer.isBase64Image(url)) {
			// Handle base64 encoded images
			const [mediaType, data] = AnthropicMessageSerializer.parseBase64Url(url);
			return {
				source: {
					data,
					media_type: mediaType,
					type: 'base64',
				},
				type: 'image',
			};
		} else {
			// Handle URL images
			return {
				source: {
					url,
					type: 'url',
				},
				type: 'image',
			} as ImageBlockParam;
		}
	}

	/**
	 * Serialize content to a string.
	 */
	static serializeContentToStr(
		content: string | ContentPartTextParam[],
		useCache: boolean = false
	): TextBlockParam[] | string {
		const cacheControl = AnthropicMessageSerializer.serializeCacheControl(useCache);

		if (typeof content === 'string') {
			if (cacheControl) {
				return [{ text: content, type: 'text', cache_control: cacheControl }];
			} else {
				return content;
			}
		}

		const serializedBlocks: TextBlockParam[] = [];
		content.forEach((part, i) => {
			// Only the last block carries the cache breakpoint
			const isLast = i === content.length - 1;
			if (part.type === 'text') {
				serializedBlocks.push(AnthropicMessageSerializer.serializeContentPartText(part, useCache && isLast));
			}
		});

		return serializedBlocks;
	}

	/**
	 * Serialize content to Anthropic format.
	 */
	static serializeContent(
		content: string | (ContentPartTextParam | ContentPartImageParam)[],
		useCache: boolean = false
	): string | (TextBlockParam | ImageBlockParam)[] {
		if (typeof content === 'string') {
			if (useCache) {
				return [
					{
						text: content,
						type: 'text',
						cache_control: { type: 'ephemeral' } as CacheControlEphemeralParam,
					},
				];
			} else {
				return content;
			}
		}

		const serializedBlocks: (TextBlockParam | ImageBlockParam)[] = [];
		content.forEach((part, i) => {
			// Only the last block carries the cache breakpoint
			const isLast = i === content.length - 1;
			if (part.type === 'text') {
				serializedBlocks.push(
					AnthropicMessageSerializer.serializeContentPartText(part, useCache && isLast)
				);
			} else if (part.type === 'image_url') {
				serializedBlocks.push(AnthropicMessageSerializer.serializeContentPartImage(part));
			}
		});

		return serializedBlocks;
	}

	/**
	 * Convert tool calls to Anthropic's ToolUseBlockParam format.
	 */
	static serializeToolCallsToContent(
		toolCalls: ToolCall[],
		useCache: boolean = false
	): ToolUseBlockParam[] {
		const blocks: ToolUseBlockParam[] = [];
		toolCalls.forEach((toolCall, i) => {
			// Parse the arguments JSON string to object
			let inputObj: Record<string, unknown>;
			try {
				inputObj = JSON.parse(toolCall.function.arguments);
			} catch {
				// If arguments aren't valid JSON, use as string
				inputObj = { arguments: toolCall.function.arguments };
			}

			// Only the last tool call carries the cache breakpoint
			const isLast = i === toolCalls.length - 1;
			blocks.push({
				id: toolCall.id,
				input: inputObj,
				name: toolCall.function.name,
				type: 'tool_use',
				cache_control: AnthropicMessageSerializer.serializeCacheControl(useCache && isLast),
			});
		});
		return blocks;
	}

	/**
	 * Serialize a custom message to an Anthropic MessageParam.
	 *
	 * Note: Anthropic doesn't have a 'system' role. System messages should be
	 * handled separately as the system parameter in the API call, not as a message.
	 * If a SystemMessage is passed here, it will be returned as-is.
	 */
	static serialize(message: BaseMessage): MessageParam | SystemMessage {
		if (message.role === 'user') {
			const userMsg = message as UserMessage;
			const content = AnthropicMessageSerializer.serializeContent(
				userMsg.content as string | (ContentPartTextParam | ContentPartImageParam)[],
				userMsg.cache
			);
			return { role: 'user', content };
		} else if (message.role === 'system') {
			// Anthropic doesn't have system messages in the messages array
			// System prompts are passed separately. Return as-is.
			return message as SystemMessage;
		} else if (message.role === 'assistant') {
			const assistantMsg = message as AssistantMessage;
			// Handle content and tool calls
			const blocks: (TextBlockParam | ToolUseBlockParam)[] = [];

			// Add content blocks if present
			const hasToolCalls = !!(assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0);
			if (assistantMsg.content !== null && assistantMsg.content !== undefined) {
				if (typeof assistantMsg.content === 'string') {
					// String content: only cache if it's the only/last block (no tool calls)
					blocks.push({
						text: assistantMsg.content,
						type: 'text',
						cache_control: AnthropicMessageSerializer.serializeCacheControl(
							(assistantMsg.cache ?? false) && !hasToolCalls
						),
					});
				} else {
					// Process content parts (text and refusal)
					const parts = assistantMsg.content;
					parts.forEach((part, i) => {
						// Only the last content block gets the cache breakpoint, and only if there are no tool calls
						const isLastContent = i === parts.length - 1 && !hasToolCalls;
						if (part.type === 'text') {
							blocks.push(
								AnthropicMessageSerializer.serializeContentPartText(
									part,
									(assistantMsg.cache ?? false) && isLastContent
								)
							);
						}
						// Note: Anthropic doesn't have a specific refusal block type,
						// refusals are skipped in Python implementation
					});
				}
			}

			// Add tool use blocks if present
			if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
				const toolBlocks = AnthropicMessageSerializer.serializeToolCallsToContent(
					assistantMsg.toolCalls,
					assistantMsg.cache ?? false
				);
				blocks.push(...toolBlocks);
			}

			// If no content or tool calls, add empty text block
			// (Anthropic requires at least one content block)
			if (blocks.length === 0) {
				blocks.push({
					text: '',
					type: 'text',
					cache_control: AnthropicMessageSerializer.serializeCacheControl(assistantMsg.cache ?? false),
				});
			}

			// If caching is enabled or we have multiple blocks, return blocks as-is
			// Otherwise, simplify single text blocks to plain string
			let content: string | (TextBlockParam | ToolUseBlockParam)[];
			if (assistantMsg.cache || blocks.length > 1) {
				content = blocks;
			} else {
				// Only simplify when no caching and single block
				const singleBlock = blocks[0];
				if (singleBlock.type === 'text' && !singleBlock.cache_control) {
					content = singleBlock.text;
				} else {
					content = blocks;
				}
			}

			return {
				role: 'assistant',
				content,
			};
		}
		// Exhaustive check - should never reach here
		throw new Error(`Unknown message type: ${(message as BaseMessage).role}`);
	}

	/**
	 * Clean cache settings so only the last cache=True message remains cached.
	 *
	 * Because of how Claude caching works, only the last cache message matters.
	 * This method automatically removes cache=True from all messages except the last one.
	 */
	static cleanCacheMessages(messages: NonSystemMessage[]): NonSystemMessage[] {
		if (messages.length === 0) {
			return messages;
		}

		// Create a deep copy to avoid modifying the original
		const cleanedMessages = messages.map((msg) => ({ ...msg }));

		// Find the last message with cache=true
		let lastCacheIndex = -1;
		for (let i = cleanedMessages.length - 1; i >= 0; i--) {
			if (cleanedMessages[i].cache) {
				lastCacheIndex = i;
				break;
			}
		}

		// If we found a cached message, disable cache for all others
		if (lastCacheIndex !== -1) {
			for (let i = 0; i < cleanedMessages.length; i++) {
				if (i !== lastCacheIndex && cleanedMessages[i].cache) {
					// Set cache to false for all messages except the last cached one
					cleanedMessages[i].cache = false;
				}
			}
		}

		return cleanedMessages;
	}

	/**
	 * Serialize a list of messages, extracting any system message.
	 *
	 * @returns A tuple of [messages, systemMessage] where systemMessage is extracted
	 * from any SystemMessage in the list.
	 */
	static serializeMessages(
		messages: BaseMessage[]
	): [MessageParam[], TextBlockParam[] | string | null] {
		// Deep copy messages
		const messagesCopy = messages.map((m) => ({ ...m }));

		// Separate system messages from normal messages
		const normalMessages: NonSystemMessage[] = [];
		let systemMessage: SystemMessage | null = null;

		for (const message of messagesCopy) {
			if (message.role === 'system') {
				systemMessage = message as SystemMessage;
			} else {
				normalMessages.push(message as NonSystemMessage);
			}
		}

		// Clean cache messages so only the last cache=True message remains cached
		const cleanedMessages = AnthropicMessageSerializer.cleanCacheMessages(normalMessages);

		// Serialize normal messages
		const serializedMessages: MessageParam[] = [];
		for (const message of cleanedMessages) {
			const serialized = AnthropicMessageSerializer.serialize(message);
			if ('role' in serialized && serialized.role !== 'system') {
				serializedMessages.push(serialized as MessageParam);
			}
		}

		// Serialize system message
		let serializedSystemMessage: TextBlockParam[] | string | null = null;
		if (systemMessage) {
			serializedSystemMessage = AnthropicMessageSerializer.serializeContentToStr(
				systemMessage.content,
				systemMessage.cache ?? false
			);
		}

		return [serializedMessages, serializedSystemMessage];
	}
}

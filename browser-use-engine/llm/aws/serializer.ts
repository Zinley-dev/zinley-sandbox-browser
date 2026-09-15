/**
 * AWS Bedrock message serializer.
 * Port from browser_use/llm/aws/serializer.py
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

// AWS Bedrock format types
export interface BedrockTextContent {
	text: string;
}

export interface BedrockImageContent {
	image: {
		format: 'jpeg' | 'png' | 'gif' | 'webp';
		source: {
			bytes: Buffer;
		};
	};
}

export interface BedrockToolUseContent {
	toolUse: {
		toolUseId: string;
		name: string;
		input: Record<string, unknown>;
	};
}

export type BedrockContentBlock = BedrockTextContent | BedrockImageContent | BedrockToolUseContent;

export interface BedrockMessage {
	role: 'user' | 'assistant';
	content: BedrockContentBlock[];
}

/**
 * Serializer for converting between custom message types and AWS Bedrock message format.
 */
export class AWSBedrockMessageSerializer {
	/**
	 * Check if the URL is a base64 encoded image.
	 */
	static isBase64Image(url: string): boolean {
		return url.startsWith('data:image/');
	}

	/**
	 * Check if the URL is a regular HTTP/HTTPS image URL.
	 */
	static isUrlImage(url: string): boolean {
		const lowerUrl = url.toLowerCase();
		return (
			(url.startsWith('http://') || url.startsWith('https://')) &&
			(lowerUrl.endsWith('.jpg') ||
				lowerUrl.endsWith('.jpeg') ||
				lowerUrl.endsWith('.png') ||
				lowerUrl.endsWith('.gif') ||
				lowerUrl.endsWith('.webp') ||
				lowerUrl.endsWith('.bmp'))
		);
	}

	/**
	 * Parse a base64 data URL to extract format and raw bytes.
	 */
	static parseBase64Url(url: string): [string, Buffer] {
		if (!url.startsWith('data:')) {
			throw new Error(`Invalid base64 URL: ${url}`);
		}

		const [header, data] = url.split(',', 2);

		// Extract format from mime type
		const mimeMatch = header.match(/image\/(\w+)/);
		let imageFormat: string;
		if (mimeMatch) {
			const formatName = mimeMatch[1].toLowerCase();
			// Map common formats
			const formatMapping: Record<string, string> = {
				jpg: 'jpeg',
				jpeg: 'jpeg',
				png: 'png',
				gif: 'gif',
				webp: 'webp',
			};
			imageFormat = formatMapping[formatName] || 'jpeg';
		} else {
			imageFormat = 'jpeg'; // Default format
		}

		// Decode base64 data
		let imageBytes: Buffer;
		try {
			imageBytes = Buffer.from(data, 'base64');
		} catch (error) {
			throw new Error(`Failed to decode base64 image data: ${error}`);
		}

		return [imageFormat, imageBytes];
	}

	/**
	 * Download an image from URL and convert to bytes.
	 * Note: This is a synchronous-style implementation. In practice, you'd want to make this async.
	 */
	static async downloadAndConvertImage(url: string): Promise<[string, Buffer]> {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(30000) });

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const contentType = response.headers.get('content-type')?.toLowerCase() || '';
			const lowerUrl = url.toLowerCase();

			let imageFormat: string;
			if (contentType.includes('jpeg') || lowerUrl.endsWith('.jpg') || lowerUrl.endsWith('.jpeg')) {
				imageFormat = 'jpeg';
			} else if (contentType.includes('png') || lowerUrl.endsWith('.png')) {
				imageFormat = 'png';
			} else if (contentType.includes('gif') || lowerUrl.endsWith('.gif')) {
				imageFormat = 'gif';
			} else if (contentType.includes('webp') || lowerUrl.endsWith('.webp')) {
				imageFormat = 'webp';
			} else {
				imageFormat = 'jpeg'; // Default format
			}

			const arrayBuffer = await response.arrayBuffer();
			return [imageFormat, Buffer.from(arrayBuffer)];
		} catch (error) {
			throw new Error(`Failed to download image from ${url}: ${error}`);
		}
	}

	/**
	 * Convert a text content part to AWS Bedrock format.
	 */
	static serializeContentPartText(part: ContentPartTextParam): BedrockTextContent {
		return { text: part.text };
	}

	/**
	 * Convert an image content part to AWS Bedrock format (sync version for base64).
	 */
	static serializeContentPartImageSync(part: ContentPartImageParam): BedrockImageContent {
		const url = part.imageUrl.url;

		if (AWSBedrockMessageSerializer.isBase64Image(url)) {
			// Handle base64 encoded images
			const [imageFormat, imageBytes] = AWSBedrockMessageSerializer.parseBase64Url(url);
			return {
				image: {
					format: imageFormat as 'jpeg' | 'png' | 'gif' | 'webp',
					source: {
						bytes: imageBytes,
					},
				},
			};
		} else {
			throw new Error(
				`URL images require async handling. Use serializeContentPartImageAsync for URL: ${url}`
			);
		}
	}

	/**
	 * Convert an image content part to AWS Bedrock format (async version).
	 */
	static async serializeContentPartImageAsync(
		part: ContentPartImageParam
	): Promise<BedrockImageContent> {
		const url = part.imageUrl.url;

		if (AWSBedrockMessageSerializer.isBase64Image(url)) {
			// Handle base64 encoded images
			const [imageFormat, imageBytes] = AWSBedrockMessageSerializer.parseBase64Url(url);
			return {
				image: {
					format: imageFormat as 'jpeg' | 'png' | 'gif' | 'webp',
					source: {
						bytes: imageBytes,
					},
				},
			};
		} else if (AWSBedrockMessageSerializer.isUrlImage(url)) {
			// Download and convert URL images
			const [imageFormat, imageBytes] = await AWSBedrockMessageSerializer.downloadAndConvertImage(url);
			return {
				image: {
					format: imageFormat as 'jpeg' | 'png' | 'gif' | 'webp',
					source: {
						bytes: imageBytes,
					},
				},
			};
		} else {
			throw new Error(`Unsupported image URL format: ${url}`);
		}
	}

	/**
	 * Serialize content for user messages.
	 */
	static serializeUserContent(
		content: string | (ContentPartTextParam | ContentPartImageParam)[]
	): BedrockContentBlock[] {
		if (typeof content === 'string') {
			return [{ text: content }];
		}

		const contentBlocks: BedrockContentBlock[] = [];
		for (const part of content) {
			if (part.type === 'text') {
				contentBlocks.push(AWSBedrockMessageSerializer.serializeContentPartText(part));
			} else if (part.type === 'image_url') {
				// Only handle base64 images synchronously
				contentBlocks.push(AWSBedrockMessageSerializer.serializeContentPartImageSync(part));
			}
		}

		return contentBlocks;
	}

	/**
	 * Serialize content for user messages (async version that handles URL images).
	 */
	static async serializeUserContentAsync(
		content: string | (ContentPartTextParam | ContentPartImageParam)[]
	): Promise<BedrockContentBlock[]> {
		if (typeof content === 'string') {
			return [{ text: content }];
		}

		const contentBlocks: BedrockContentBlock[] = [];
		for (const part of content) {
			if (part.type === 'text') {
				contentBlocks.push(AWSBedrockMessageSerializer.serializeContentPartText(part));
			} else if (part.type === 'image_url') {
				contentBlocks.push(await AWSBedrockMessageSerializer.serializeContentPartImageAsync(part));
			}
		}

		return contentBlocks;
	}

	/**
	 * Serialize content for system messages.
	 */
	static serializeSystemContent(content: string | ContentPartTextParam[]): BedrockContentBlock[] {
		if (typeof content === 'string') {
			return [{ text: content }];
		}

		const contentBlocks: BedrockContentBlock[] = [];
		for (const part of content) {
			if (part.type === 'text') {
				contentBlocks.push(AWSBedrockMessageSerializer.serializeContentPartText(part));
			}
		}

		return contentBlocks;
	}

	/**
	 * Serialize content for assistant messages.
	 */
	static serializeAssistantContent(
		content: string | (ContentPartTextParam | ContentPartRefusalParam)[] | null | undefined
	): BedrockContentBlock[] {
		if (content === null || content === undefined) {
			return [];
		}
		if (typeof content === 'string') {
			return [{ text: content }];
		}

		const contentBlocks: BedrockContentBlock[] = [];
		for (const part of content) {
			if (part.type === 'text') {
				contentBlocks.push(AWSBedrockMessageSerializer.serializeContentPartText(part));
			}
			// Skip refusal content parts - AWS Bedrock doesn't need them
		}

		return contentBlocks;
	}

	/**
	 * Convert a tool call to AWS Bedrock format.
	 */
	static serializeToolCall(toolCall: ToolCall): BedrockToolUseContent {
		let args: Record<string, unknown>;
		try {
			args = JSON.parse(toolCall.function.arguments);
		} catch {
			// If arguments aren't valid JSON, wrap them
			args = { arguments: toolCall.function.arguments };
		}

		return {
			toolUse: {
				toolUseId: toolCall.id,
				name: toolCall.function.name,
				input: args,
			},
		};
	}

	/**
	 * Serialize a custom message to AWS Bedrock format.
	 */
	static serialize(message: BaseMessage): BedrockMessage | SystemMessage {
		if (message.role === 'user') {
			const userMsg = message as UserMessage;
			return {
				role: 'user',
				content: AWSBedrockMessageSerializer.serializeUserContent(
					userMsg.content as string | (ContentPartTextParam | ContentPartImageParam)[]
				),
			};
		} else if (message.role === 'system') {
			// System messages are handled separately in AWS Bedrock
			return message as SystemMessage;
		} else if (message.role === 'assistant') {
			const assistantMsg = message as AssistantMessage;
			const contentBlocks: BedrockContentBlock[] = [];

			// Add content blocks if present
			if (assistantMsg.content !== null && assistantMsg.content !== undefined) {
				contentBlocks.push(
					...AWSBedrockMessageSerializer.serializeAssistantContent(assistantMsg.content)
				);
			}

			// Add tool use blocks if present
			if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
				for (const toolCall of assistantMsg.toolCalls) {
					contentBlocks.push(AWSBedrockMessageSerializer.serializeToolCall(toolCall));
				}
			}

			// AWS Bedrock requires at least one content block
			if (contentBlocks.length === 0) {
				contentBlocks.push({ text: '' });
			}

			return {
				role: 'assistant',
				content: contentBlocks,
			};
		} else {
			throw new Error(`Unknown message type: ${(message as BaseMessage).role}`);
		}
	}

	/**
	 * Serialize a list of messages, extracting any system message.
	 *
	 * @returns Tuple of [bedrockMessages, systemMessage] where systemMessage is extracted
	 * from any SystemMessage in the list.
	 */
	static serializeMessages(
		messages: BaseMessage[]
	): [BedrockMessage[], BedrockContentBlock[] | null] {
		const bedrockMessages: BedrockMessage[] = [];
		let systemMessage: BedrockContentBlock[] | null = null;

		for (const message of messages) {
			if (message.role === 'system') {
				const sysMsg = message as SystemMessage;
				// Extract system message content
				systemMessage = AWSBedrockMessageSerializer.serializeSystemContent(sysMsg.content);
			} else {
				// Serialize and add to regular messages
				const serialized = AWSBedrockMessageSerializer.serialize(message);
				if ('role' in serialized && serialized.role !== undefined) {
					bedrockMessages.push(serialized as BedrockMessage);
				}
			}
		}

		return [bedrockMessages, systemMessage];
	}
}

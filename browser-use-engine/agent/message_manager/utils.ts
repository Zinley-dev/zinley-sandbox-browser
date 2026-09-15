/**
 * Message manager utilities
 * Port from browser_use/agent/message_manager/utils.py
 *
 * Updated to use token-based counting for accurate LLM context management.
 */

import fs from 'fs/promises';
import path from 'path';
import {
	encode,
	decode,
	isWithinTokenLimit,
	countTokens,
} from 'gpt-tokenizer/encoding/cl100k_base';

// Maximum content size in tokens before truncation (~17k tokens ≈ 60k characters)
const MAX_CONTENT_TOKENS = 17000;

// Legacy character-based constant for backwards compatibility
const MAX_CONTENT_SIZE = 60000;

/**
 * Truncate content if it exceeds maximum token limit
 * @param content The content to potentially truncate
 * @param maxTokens Maximum allowed tokens (default: 17000)
 * @returns Truncated content with indicator if truncated
 */
export function truncateContent(content: string, maxTokens: number = MAX_CONTENT_TOKENS): string {
	if (!content) return content;

	const withinLimit = isWithinTokenLimit(content, maxTokens);
	if (withinLimit !== false) {
		return content;
	}

	// Need to truncate - encode and slice tokens
	const tokens = encode(content);
	const truncatedTokens = tokens.slice(0, maxTokens);
	const truncatedText = decode(truncatedTokens);

	return truncatedText + `\n... [Content truncated at ${maxTokens.toLocaleString()} tokens]`;
}

/**
 * Legacy character-based truncation for backwards compatibility
 * @deprecated Use truncateContent with token-based limits instead
 */
export function truncateContentByChars(content: string, maxSize: number = MAX_CONTENT_SIZE): string {
	if (content.length <= maxSize) {
		return content;
	}
	return content.substring(0, maxSize) + '\n... [Content truncated at 60k characters]';
}

/**
 * Count tokens in a message's content
 */
function countMessageTokens(msg: any): number {
	const content = getMessageContent(msg);
	if (!content) return 0;
	return countTokens(content);
}

/**
 * Truncate messages array based on token count
 * Uses actual token counting for accurate LLM context management
 * @param messages Array of messages to truncate
 * @param maxTokens Maximum total tokens (default: 17000)
 * @returns Truncated messages array
 */
export function truncateMessages(messages: any[], maxTokens: number = MAX_CONTENT_TOKENS): any[] {
	if (!messages || messages.length === 0) {
		return messages;
	}

	// Calculate total token count
	let totalTokens = 0;
	for (const msg of messages) {
		totalTokens += countMessageTokens(msg);
	}

	// If under limit, return as-is
	if (totalTokens <= maxTokens) {
		return messages;
	}

	// Truncate messages from oldest (except first system message)
	const result: any[] = [];
	let currentTokens = 0;

	// Always keep first message (usually system prompt)
	if (messages.length > 0) {
		result.push(messages[0]);
		currentTokens += countMessageTokens(messages[0]);
	}

	// Process remaining messages from newest to oldest
	const remaining = messages.slice(1).reverse();
	const toAdd: any[] = [];

	for (const msg of remaining) {
		const msgTokens = countMessageTokens(msg);
		if (currentTokens + msgTokens <= maxTokens) {
			toAdd.push(msg);
			currentTokens += msgTokens;
		} else {
			// Truncate this message's content if it's too long
			const remainingBudget = maxTokens - currentTokens;
			const truncatedMsg = truncateMessageContent(msg, remainingBudget);
			if (truncatedMsg) {
				toAdd.push(truncatedMsg);
			}
			break;
		}
	}

	// Add messages back in correct order
	result.push(...toAdd.reverse());

	return result;
}

/**
 * Get content from a message object
 */
function getMessageContent(msg: any): string {
	if (typeof msg === 'string') {
		return msg;
	}
	if (msg.content) {
		if (typeof msg.content === 'string') {
			return msg.content;
		}
		if (Array.isArray(msg.content)) {
			// Handle content parts (text + images)
			return msg.content
				.filter((part: any) => part.type === 'text')
				.map((part: any) => part.text || '')
				.join('\n');
		}
	}
	if (msg.text) {
		return msg.text;
	}
	return '';
}

/**
 * Truncate a message's content to fit within token limit
 * @param msg The message to truncate
 * @param maxTokens Maximum allowed tokens
 */
function truncateMessageContent(msg: any, maxTokens: number): any | null {
	if (maxTokens <= 0) {
		return null;
	}

	const cloned = { ...msg };

	if (typeof cloned.content === 'string') {
		cloned.content = truncateContent(cloned.content, maxTokens);
	} else if (Array.isArray(cloned.content)) {
		// Truncate text parts, keep image parts as-is
		cloned.content = cloned.content.map((part: any) => {
			if (part.type === 'text' && part.text) {
				return {
					...part,
					text: truncateContent(part.text, Math.max(100, maxTokens)),
				};
			}
			return part;
		});
	}

	return cloned;
}

/**
 * Truncate error message to reasonable size
 * Shows first 100 chars + last 100 chars for long errors
 */
export function truncateError(error: string, maxLength: number = 200): string {
	if (error.length <= maxLength) {
		return error;
	}

	const halfLength = Math.floor(maxLength / 2);
	const firstPart = error.substring(0, halfLength);
	const lastPart = error.substring(error.length - halfLength);

	return `${firstPart}...${lastPart}`;
}

/**
 * Save conversation history to file
 * Port from browser_use/agent/message_manager/utils.py
 */
export async function saveConversation(
	inputMessages: any[],
	response: any,
	target: string,
	encoding: BufferEncoding = 'utf-8'
): Promise<void> {
	// Create directories if they don't exist
	const targetDir = path.dirname(target);
	if (targetDir) {
		await fs.mkdir(targetDir, { recursive: true });
	}

	const formatted = formatConversation(inputMessages, response);
	await fs.writeFile(target, formatted, encoding);
}

/**
 * Format conversation for saving
 */
function formatConversation(messages: any[], response: any): string {
	const lines: string[] = [];

	// Format messages
	for (const message of messages) {
		const role = message.role || 'unknown';
		lines.push(` ${role.toUpperCase()} `);

		const content = getMessageContent(message);
		lines.push(content);
		lines.push(''); // Empty line after each message
	}

	// Format response
	try {
		if (typeof response === 'object') {
			lines.push(JSON.stringify(response, null, 2));
		} else {
			lines.push(String(response));
		}
	} catch {
		lines.push(String(response));
	}

	return lines.join('\n');
}

// ============================================================================
// Token Counting Exports
// ============================================================================

/**
 * Count tokens in text using cl100k_base encoding
 * @param text Text to count tokens for
 * @returns Number of tokens
 */
export function countTextTokens(text: string): number {
	if (!text) return 0;
	return countTokens(text);
}

/**
 * Check if text is within token limit
 * @param text Text to check
 * @param limit Maximum allowed tokens
 * @returns Token count if within limit, false otherwise
 */
export function isTextWithinTokenLimit(text: string, limit: number): number | false {
	if (!text) return 0;
	return isWithinTokenLimit(text, limit);
}

/**
 * Encode text to tokens
 * @param text Text to encode
 * @returns Array of token IDs
 */
export function encodeText(text: string): number[] {
	if (!text) return [];
	return encode(text);
}

/**
 * Decode tokens back to text
 * @param tokens Array of token IDs
 * @returns Decoded text
 */
export function decodeTokens(tokens: number[]): string {
	if (!tokens || tokens.length === 0) return '';
	return decode(tokens);
}

// Export constants
export { MAX_CONTENT_TOKENS, MAX_CONTENT_SIZE };

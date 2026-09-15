/**
 * Google Gemini message serializer
 * Port from browser_use/llm/google/serializer.py (120 lines)
 */

import { Content, Part } from '@google/generative-ai';
import {
	BaseMessage,
	SystemMessage,
	UserMessage,
	AssistantMessage,
} from '../messages.js';

export class GoogleMessageSerializer {
	/**
	 * Convert a list of BaseMessages to Google format, extracting system message.
	 *
	 * Google handles system instructions separately from the conversation, so we need to:
	 * 1. Extract any system messages and return them separately as a string (or include in first user message if flag is set)
	 * 2. Convert the remaining messages to Content objects
	 *
	 * Args:
	 *   messages: List of messages to convert
	 *   includeSystemInUser: If True, system/developer messages are prepended to the first user message
	 *
	 * Returns:
	 *   A tuple of [formatted_messages, system_message] where:
	 *   - formatted_messages: List of Content objects for the conversation
	 *   - system_message: System instruction string or null
	 */
	static serializeMessages(
		messages: BaseMessage[],
		includeSystemInUser: boolean = false
	): [Content[], string | null] {
		const formattedMessages: Content[] = [];
		let systemMessage: string | null = null;
		const systemParts: string[] = [];

		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];
			let role = message.role;

			// Handle system/developer messages
			if (message.role === 'system') {
				// Extract system message content as string
				if (typeof message.content === 'string') {
					if (includeSystemInUser) {
						systemParts.push(message.content);
					} else {
						systemMessage = message.content;
					}
				} else if (message.content !== null) {
					// Handle array of content parts
					const parts: string[] = [];
					for (const part of message.content) {
						if (part.type === 'text') {
							parts.push(part.text);
						}
					}
					const combinedText = parts.join('\n');
					if (includeSystemInUser) {
						systemParts.push(combinedText);
					} else {
						systemMessage = combinedText;
					}
				}
				continue;
			}

			// Determine the role for non-system messages
			let geminiRole: 'user' | 'model';
			if (message.role === 'user') {
				geminiRole = 'user';
			} else if (message.role === 'assistant') {
				geminiRole = 'model';
			} else {
				// Default to user for any unknown message types
				geminiRole = 'user';
			}

			// Initialize message parts
			const messageParts: Part[] = [];

			// If this is the first user message and we have system parts, prepend them
			if (includeSystemInUser && systemParts.length > 0 && geminiRole === 'user' && formattedMessages.length === 0) {
				const systemText = systemParts.join('\n\n');
				if (typeof message.content === 'string') {
					messageParts.push({
						text: `${systemText}\n\n${message.content}`
					});
				} else {
					// Add system text as the first part
					messageParts.push({ text: systemText });
				}
				systemParts.length = 0; // Clear after using
			} else {
				// Extract content and create parts normally
				if (typeof message.content === 'string') {
					// Regular text content
					messageParts.push({ text: message.content });
				} else if (message.content !== null && message.content !== undefined) {
					// Handle array of content parts
					for (const part of message.content) {
						if (part.type === 'text') {
							messageParts.push({ text: part.text });
						} else if (part.type === 'refusal') {
							messageParts.push({ text: `[Refusal] ${part.refusal}` });
						} else if (part.type === 'image_url') {
							// Handle images
							const url = part.imageUrl.url;

							// Format: data:image/jpeg;base64,<data>
							const [header, data] = url.split(',', 2);

							// For Gemini, we need to provide inline data
							messageParts.push({
								inlineData: {
									mimeType: 'image/jpeg',
									data: data
								}
							});
						}
					}
				}
			}

			// Create the Content object
			if (messageParts.length > 0) {
				const finalMessage: Content = {
					role: geminiRole,
					parts: messageParts
				};
				formattedMessages.push(finalMessage);
			}
		}

		return [formattedMessages, systemMessage];
	}
}

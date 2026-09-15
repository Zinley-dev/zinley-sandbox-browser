/**
 * Groq failed generation parser
 * Port from browser_use/llm/groq/parser.py
 */
import { z } from 'zod';

export class ParseFailedGenerationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ParseFailedGenerationError';
	}
}

export function tryParseGroqFailedGeneration<T extends z.ZodType>(error: any, outputFormat: T): z.infer<T> {
	try {
		// Extract content from error body
		let content = error.body?.error?.failed_generation;
		if (!content) {
			throw new ParseFailedGenerationError('No failed_generation in error body');
		}

		// If content is wrapped in code blocks, extract just the JSON part
		if (content.includes('```')) {
			// Find the JSON content between code blocks
			const parts = content.split('```');
			if (parts.length >= 2) {
				content = parts[1];
				// Remove language identifier if present (e.g., 'json\n')
				if (content.includes('\n')) {
					const lines = content.split('\n');
					content = lines.slice(1).join('\n');
				}
			}
		}

		// Remove html-like tags before the first { and after the last }
		// This handles cases like <|header_start|>assistant<|header_end|> and <function=AgentOutput>
		// Only remove content before { if content doesn't already start with {
		if (!content.trim().startsWith('{')) {
			content = content.replace(/^.*?(?=\{)/s, '');
		}

		// Remove common HTML-like tags and patterns at the end
		content = content.replace(/\}(\s*<[^>]*>.*?$)/s, '}');
		content = content.replace(/\}(\s*<\|[^|]*\|>.*?$)/s, '}');

		// Handle extra characters after the JSON, including stray braces
		content = content.trim();

		if (content.endsWith('}')) {
			// Try to parse and see if we get valid JSON
			try {
				JSON.parse(content);
			} catch (jsonError) {
				// If parsing fails, try to find the correct end of the JSON
				// by counting braces and removing anything after the balanced JSON
				let braceCount = 0;
				let lastValidPos = -1;
				for (let i = 0; i < content.length; i++) {
					const char = content[i];
					if (char === '{') {
						braceCount++;
					} else if (char === '}') {
						braceCount--;
						if (braceCount === 0) {
							lastValidPos = i + 1;
							break;
						}
					}
				}

				if (lastValidPos > 0) {
					content = content.substring(0, lastValidPos);
				}
			}
		}

		// Fix control characters in JSON strings before parsing
		content = fixControlCharactersInJson(content);

		// Parse the cleaned content
		let resultDict = JSON.parse(content);

		// Some models occasionally respond with a list containing one dict
		if (Array.isArray(resultDict) && resultDict.length === 1 && typeof resultDict[0] === 'object') {
			resultDict = resultDict[0];
		}

		console.debug('Successfully parsed model output:', resultDict);
		return outputFormat.parse(resultDict);
	} catch (error: any) {
		if (error instanceof z.ZodError) {
			throw new ParseFailedGenerationError(`Validation failed: ${error.message}`);
		}
		if (error instanceof SyntaxError) {
			throw new ParseFailedGenerationError(`JSON parse failed: ${error.message}`);
		}
		throw new ParseFailedGenerationError(error.message || 'Unknown parse error');
	}
}

function fixControlCharactersInJson(content: string): string {
	try {
		// First try to parse as-is to see if it's already valid
		JSON.parse(content);
		return content;
	} catch (jsonError) {
		// More sophisticated approach: only escape control characters inside string values
		// while preserving JSON structure formatting

		const result: string[] = [];
		let i = 0;
		let inString = false;
		let escaped = false;

		while (i < content.length) {
			const char = content[i];

			if (!inString) {
				// Outside of string - check if we're entering a string
				if (char === '"') {
					inString = true;
				}
				result.push(char);
			} else {
				// Inside string - handle escaping and control characters
				if (escaped) {
					// Previous character was backslash, so this character is escaped
					result.push(char);
					escaped = false;
				} else if (char === '\\') {
					// This is an escape character
					result.push(char);
					escaped = true;
				} else if (char === '"') {
					// End of string
					result.push(char);
					inString = false;
				} else if (char === '\n') {
					// Literal newline inside string - escape it
					result.push('\\n');
				} else if (char === '\r') {
					// Literal carriage return inside string - escape it
					result.push('\\r');
				} else if (char === '\t') {
					// Literal tab inside string - escape it
					result.push('\\t');
				} else if (char === '\b') {
					// Literal backspace inside string - escape it
					result.push('\\b');
				} else if (char === '\f') {
					// Literal form feed inside string - escape it
					result.push('\\f');
				} else if (char.charCodeAt(0) < 32) {
					// Other control characters inside string - convert to unicode escape
					const code = char.charCodeAt(0);
					result.push(`\\u${code.toString(16).padStart(4, '0')}`);
				} else {
					// Normal character inside string
					result.push(char);
				}
			}

			i++;
		}

		return result.join('');
	}
}

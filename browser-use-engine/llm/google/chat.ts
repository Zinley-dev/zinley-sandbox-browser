/**
 * Google Gemini chat model implementation
 * Port from browser_use/llm/google/chat.py (527 lines)
 */

import {
	GoogleGenerativeAI,
	GenerativeModel,
	GenerateContentRequest,
	GenerateContentResult,
	GenerationConfig,
	Content,
} from '@google/generative-ai';
import { z } from 'zod';
import { BaseChatModel } from '../base.js';
import { ModelProviderError } from '../exceptions.js';
import { GoogleMessageSerializer } from './serializer.js';
import { BaseMessage } from '../messages.js';
import { SchemaOptimizer } from '../schema.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';

export type VerifiedGeminiModel =
	| 'gemini-2.0-flash'
	| 'gemini-2.0-flash-exp'
	| 'gemini-2.0-flash-lite-preview-02-05'
	| 'Gemini-2.0-exp'
	| 'gemini-2.5-flash'
	| 'gemini-2.5-flash-lite'
	| 'gemini-flash-latest'
	| 'gemini-flash-lite-latest'
	| 'gemini-2.5-pro'
	| 'gemma-3-27b-it'
	| 'gemma-3-4b'
	| 'gemma-3-12b'
	| 'gemma-3n-e2b'
	| 'gemma-3n-e4b';

export interface ChatGoogleOptions {
	// Model configuration
	model: VerifiedGeminiModel | string;
	temperature?: number | null;
	topP?: number | null;
	topK?: number | null;
	maxOutputTokens?: number | null;
	includeSystemInUser?: boolean;
	supportsStructuredOutput?: boolean;

	// API configuration
	apiKey?: string;
}

export class ChatGoogle implements BaseChatModel {
	model: string;
	temperature: number | null;
	topP: number | null;
	topK: number | null;
	maxOutputTokens: number | null;
	includeSystemInUser: boolean;
	supportsStructuredOutput: boolean;

	private apiKey?: string;
	private client?: GoogleGenerativeAI;
	private generativeModel?: GenerativeModel;

	constructor(options: ChatGoogleOptions) {
		this.model = options.model;
		this.temperature = options.temperature ?? 0.5;
		this.topP = options.topP ?? null;
		this.topK = options.topK ?? null;
		this.maxOutputTokens = options.maxOutputTokens ?? 8096;
		this.includeSystemInUser = options.includeSystemInUser ?? false;
		this.supportsStructuredOutput = options.supportsStructuredOutput ?? true;
		this.apiKey = options.apiKey;
	}

	get provider(): string {
		return 'google';
	}

	get name(): string {
		return this.model;
	}

	private getClient(): GoogleGenerativeAI {
		if (!this.client) {
			if (!this.apiKey) {
				throw new Error('Google API key is required');
			}
			this.client = new GoogleGenerativeAI(this.apiKey);
		}
		return this.client;
	}

	private getGenerativeModel(): GenerativeModel {
		if (!this.generativeModel) {
			this.generativeModel = this.getClient().getGenerativeModel({
				model: this.model
			});
		}
		return this.generativeModel;
	}

	private getStopReason(result: GenerateContentResult): string | null {
		if (result.response?.candidates && result.response.candidates.length > 0) {
			const candidate = result.response.candidates[0];
			return candidate.finishReason ? String(candidate.finishReason) : null;
		}
		return null;
	}

	private getUsage(result: GenerateContentResult): ChatInvokeUsage | null {
		const usageMetadata = result.response?.usageMetadata;
		if (!usageMetadata) {
			return null;
		}

		// Calculate image tokens from prompt token details
		let imageTokens = 0;
		// Note: Google SDK may not expose detailed token breakdown in all versions
		// This is a placeholder for when the API provides it

		return {
			promptTokens: usageMetadata.promptTokenCount || 0,
			completionTokens: (usageMetadata.candidatesTokenCount || 0),
			totalTokens: usageMetadata.totalTokenCount || 0,
			promptCachedTokens: usageMetadata.cachedContentTokenCount || undefined,
			promptCacheCreationTokens: undefined,
			promptImageTokens: imageTokens || undefined,
		};
	}

	async ainvoke<T extends z.ZodType>(
		messages: BaseMessage[],
		outputFormat?: T
	): Promise<ChatInvokeCompletion<T extends z.ZodType ? z.infer<T> : string>> {
		// Serialize messages to Google format
		const [contents, systemInstruction] = GoogleMessageSerializer.serializeMessages(
			messages,
			this.includeSystemInUser
		);

		// Build generation config
		const generationConfig: GenerationConfig = {};

		if (this.temperature !== null) {
			generationConfig.temperature = this.temperature;
		}

		if (this.topP !== null) {
			generationConfig.topP = this.topP;
		}

		if (this.topK !== null) {
			generationConfig.topK = this.topK;
		}

		if (this.maxOutputTokens !== null) {
			generationConfig.maxOutputTokens = this.maxOutputTokens;
		}

		// Build request
		const request: GenerateContentRequest = {
			contents,
			generationConfig,
		};

		// Add system instruction if present
		if (systemInstruction && !this.includeSystemInUser) {
			request.systemInstruction = systemInstruction;
		}

		const startTime = Date.now();

		try {
			if (!outputFormat) {
				// Return string response
				console.debug(`🚀 Starting API call to ${this.model} (text response)`);

				const result = await this.getGenerativeModel().generateContent(request);
				const elapsed = (Date.now() - startTime) / 1000;
				console.debug(`✅ Got text response in ${elapsed.toFixed(2)}s`);

				const text = result.response.text() || '';
				if (!text) {
					console.warn('⚠️ Empty text response received');
				}

				const usage = this.getUsage(result);

				return {
					completion: text,
					usage,
					stopReason: this.getStopReason(result),
				} as ChatInvokeCompletion<T extends z.ZodType ? z.infer<T> : string>;
			} else {
				// Handle structured output
				if (this.supportsStructuredOutput) {
					// Use native JSON mode
					console.debug(`🔧 Requesting structured output for ${this.model}`);

					// Convert Zod schema to Gemini-compatible schema
					const optimizedSchema = SchemaOptimizer.createGeminiOptimizedSchema(outputFormat);
					const geminiSchema = this.fixGeminiSchema(optimizedSchema);

					generationConfig.responseMimeType = 'application/json';
					generationConfig.responseSchema = geminiSchema as any;

					const result = await this.getGenerativeModel().generateContent(request);
					const elapsed = (Date.now() - startTime) / 1000;
					console.debug(`✅ Got structured response in ${elapsed.toFixed(2)}s`);

					const usage = this.getUsage(result);

					// Parse JSON from text response
					const text = result.response.text();
					if (!text) {
						throw new ModelProviderError({
							message: 'No response from model',
							statusCode: 500,
							model: this.model,
						});
					}

					try {
						// Handle JSON wrapped in markdown code blocks
						let cleanedText = text.trim();
						if (cleanedText.startsWith('```json') && cleanedText.endsWith('```')) {
							cleanedText = cleanedText.slice(7, -3).trim();
							console.debug('🔧 Stripped ```json``` wrapper from response');
						} else if (cleanedText.startsWith('```') && cleanedText.endsWith('```')) {
							cleanedText = cleanedText.slice(3, -3).trim();
							console.debug('🔧 Stripped ``` wrapper from response');
						}

						// Parse and validate with Zod
						const parsedData = JSON.parse(cleanedText);
						const validated = outputFormat.parse(parsedData);

						return {
							completion: validated,
							usage,
							stopReason: this.getStopReason(result),
						} as ChatInvokeCompletion<T extends z.ZodType ? z.infer<T> : string>;
					} catch (error: any) {
						console.error(`❌ Failed to parse JSON response: ${error.message}`);
						console.debug(`Raw response text: ${text.substring(0, 200)}...`);
						throw new ModelProviderError({
							message: `Failed to parse or validate response: ${error.message}`,
							statusCode: 500,
							model: this.model,
						});
					}
				} else {
					// Fallback: Request JSON in the prompt
					console.debug(`🔄 Using fallback JSON mode for ${this.model}`);

					// Create a copy of messages to modify
					const modifiedMessages = [...messages];

					// Add JSON instruction to the last message
					if (modifiedMessages.length > 0) {
						const lastMessage = modifiedMessages[modifiedMessages.length - 1];
						if (typeof lastMessage.content === 'string') {
							const jsonInstruction = `\n\nPlease respond with a valid JSON object that matches this schema: ${JSON.stringify(SchemaOptimizer.createOptimizedJsonSchema(outputFormat))}`;
							lastMessage.content += jsonInstruction;
						}
					}

					// Re-serialize with modified messages
					const [fallbackContents, fallbackSystem] = GoogleMessageSerializer.serializeMessages(
						modifiedMessages,
						this.includeSystemInUser
					);

					// Update request
					const fallbackRequest: GenerateContentRequest = {
						contents: fallbackContents,
						generationConfig,
					};

					if (fallbackSystem && !this.includeSystemInUser) {
						fallbackRequest.systemInstruction = fallbackSystem;
					}

					const result = await this.getGenerativeModel().generateContent(fallbackRequest);
					const elapsed = (Date.now() - startTime) / 1000;
					console.debug(`✅ Got fallback response in ${elapsed.toFixed(2)}s`);

					const usage = this.getUsage(result);

					// Try to extract JSON from the text response
					const text = result.response.text();
					if (!text) {
						throw new ModelProviderError({
							message: 'No response from model',
							statusCode: 500,
							model: this.model,
						});
					}

					try {
						// Try to find JSON in the response
						let cleanedText = text.trim();

						// Common patterns: JSON wrapped in markdown code blocks
						if (cleanedText.startsWith('```json') && cleanedText.endsWith('```')) {
							cleanedText = cleanedText.slice(7, -3).trim();
						} else if (cleanedText.startsWith('```') && cleanedText.endsWith('```')) {
							cleanedText = cleanedText.slice(3, -3).trim();
						}

						// Parse and validate
						const parsedData = JSON.parse(cleanedText);
						const validated = outputFormat.parse(parsedData);

						return {
							completion: validated,
							usage,
							stopReason: this.getStopReason(result),
						} as ChatInvokeCompletion<T extends z.ZodType ? z.infer<T> : string>;
					} catch (error: any) {
						console.error(`❌ Failed to parse fallback JSON: ${error.message}`);
						console.debug(`Raw response text: ${text.substring(0, 200)}...`);
						throw new ModelProviderError({
							message: `Model does not support JSON mode and failed to parse JSON from text response: ${error.message}`,
							statusCode: 500,
							model: this.model,
						});
					}
				}
			}
		} catch (error: any) {
			const elapsed = (Date.now() - startTime) / 1000;
			console.error(`💥 API call failed after ${elapsed.toFixed(2)}s: ${error.constructor.name}: ${error.message}`);

			// Handle specific Google API errors
			let errorMessage = error.message || String(error);
			let statusCode: number | null = null;

			// Enhanced timeout error handling
			if (errorMessage.toLowerCase().includes('timeout') || errorMessage.toLowerCase().includes('cancelled')) {
				statusCode = 504; // Gateway timeout
				console.error(`🕐 Timeout for model: ${this.model}`);
			}
			// Rate limit errors
			else if (
				errorMessage.toLowerCase().includes('rate limit') ||
				errorMessage.toLowerCase().includes('resource exhausted') ||
				errorMessage.toLowerCase().includes('quota exceeded') ||
				errorMessage.toLowerCase().includes('too many requests') ||
				errorMessage.includes('429')
			) {
				statusCode = 429;
			}
			// Service errors
			else if (
				errorMessage.toLowerCase().includes('service unavailable') ||
				errorMessage.toLowerCase().includes('internal server error') ||
				errorMessage.toLowerCase().includes('bad gateway') ||
				errorMessage.includes('503') ||
				errorMessage.includes('502') ||
				errorMessage.includes('500')
			) {
				statusCode = 503;
			}

			// Try to extract status code from error object
			if (error.status) {
				statusCode = error.status;
			} else if (error.statusCode) {
				statusCode = error.statusCode;
			}

			throw new ModelProviderError({
				message: errorMessage,
				statusCode: statusCode || 502,
				model: this.name,
			});
		}
	}

	private fixGeminiSchema(schema: Record<string, any>): Record<string, any> {
		/**
		 * Convert a JSON schema to a Gemini-compatible schema.
		 *
		 * This function removes unsupported properties like 'additionalProperties' and resolves
		 * $ref references that Gemini doesn't support.
		 */

		// Handle $defs and $ref resolution
		let workingSchema = { ...schema };

		if ('$defs' in workingSchema) {
			const defs = workingSchema['$defs'];
			delete workingSchema['$defs'];

			const resolveRefs = (obj: any): any => {
				if (typeof obj === 'object' && obj !== null) {
					if ('$ref' in obj) {
						const ref = obj['$ref'];
						delete obj['$ref'];
						const refName = ref.split('/').pop();
						if (refName && defs && refName in defs) {
							// Replace the reference with the actual definition
							const resolved = { ...defs[refName] };
							// Merge any additional properties from the reference
							for (const [key, value] of Object.entries(obj)) {
								if (key !== '$ref') {
									resolved[key] = value;
								}
							}
							return resolveRefs(resolved);
						}
						return obj;
					} else if (Array.isArray(obj)) {
						return obj.map(resolveRefs);
					} else {
						// Recursively process all object properties
						const result: Record<string, any> = {};
						for (const [key, value] of Object.entries(obj)) {
							result[key] = resolveRefs(value);
						}
						return result;
					}
				}
				return obj;
			};

			workingSchema = resolveRefs(workingSchema);
		}

		// Remove unsupported properties
		const cleanSchema = (obj: any): any => {
			if (typeof obj === 'object' && obj !== null) {
				if (Array.isArray(obj)) {
					return obj.map(cleanSchema);
				}

				// Remove unsupported properties
				const cleaned: Record<string, any> = {};
				for (const [key, value] of Object.entries(obj)) {
					if (!['additionalProperties', 'title', 'default'].includes(key)) {
						const cleanedValue = cleanSchema(value);

						// Handle empty object properties - Gemini doesn't allow empty OBJECT types
						if (
							key === 'properties' &&
							typeof cleanedValue === 'object' &&
							!Array.isArray(cleanedValue) &&
							Object.keys(cleanedValue).length === 0 &&
							obj.type === 'OBJECT'
						) {
							// Convert empty object to have at least one property
							cleaned['properties'] = { _placeholder: { type: 'string' } };
						} else {
							cleaned[key] = cleanedValue;
						}
					}
				}

				// If this is an object type with empty properties, add a placeholder
				if (
					cleaned.type === 'OBJECT' &&
					'properties' in cleaned &&
					typeof cleaned.properties === 'object' &&
					!Array.isArray(cleaned.properties) &&
					Object.keys(cleaned.properties).length === 0
				) {
					cleaned.properties = { _placeholder: { type: 'string' } };
				}

				// Remove 'title' from the required list if it exists
				if ('required' in cleaned && Array.isArray(cleaned.required)) {
					cleaned.required = cleaned.required.filter((p: string) => p !== 'title');
				}

				return cleaned;
			}
			return obj;
		};

		return cleanSchema(workingSchema);
	}
}

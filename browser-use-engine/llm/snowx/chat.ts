/**
 * ChatSnowX - Client for SnowX AI API proxy
 *
 * Uses OpenAI SDK with Firebase ID token authentication (like Python ChatOpenAI).
 * This matches how Python's LangChain ChatOpenAI works with SnowX.
 */

import OpenAI from 'openai';
import { z } from 'zod';
import { BaseChatModel } from '../base.js';
import { BaseMessage, ImageUrlPart } from '../messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { getLogger } from '../../logging_config.js';

const logger = getLogger('browser-use.llm.snowx');

export interface ChatSnowXOptions {
	/** Model name to use (e.g., 'o3', 'gpt-4o') */
	model: string;
	/** Firebase ID token for authentication */
	firebaseToken: string;
	/** Base URL for the SnowX API */
	baseURL?: string;
	/** Request timeout in milliseconds */
	timeout?: number;
	/** Temperature for sampling (not used for reasoning models like o3) */
	temperature?: number;
	/** Max completion tokens */
	maxCompletionTokens?: number;
	/** Reasoning effort for o3/o1 models */
	reasoningEffort?: 'low' | 'medium' | 'high';
}

// Reasoning models that don't support temperature (from Python)
const REASONING_MODELS = ['o4-mini', 'o3', 'o3-mini', 'o1', 'o1-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'];

// Gemini models that use the generic browser-use endpoint
const GEMINI_MODELS = ['snowx-g1', 'snowx-g2', 'snowx-g3', 'snowx-g4', 'snowx-g5', 'snowx-g6'];

/**
 * Client for SnowX AI API proxy using OpenAI SDK.
 *
 * This is implemented to match Python's ChatOpenAI behavior exactly:
 * - Uses OpenAI SDK for API calls (handles streaming, retries, etc.)
 * - Firebase token passed as api_key (sent as Authorization: Bearer header)
 * - Custom base_url for SnowX proxy
 * - Reasoning models get reasoning_effort instead of temperature
 */
export class ChatSnowX implements BaseChatModel {
	model: string;
	private client: OpenAI;
	private temperature: number;
	private maxCompletionTokens: number;
	private reasoningEffort: 'low' | 'medium' | 'high';
	private isReasoningModel: boolean;

	constructor(options: ChatSnowXOptions) {
		this.model = options.model;
		this.temperature = options.temperature ?? 0.2;
		// Don't set default - let backend handle token limits
		this.maxCompletionTokens = options.maxCompletionTokens as number;
		this.reasoningEffort = options.reasoningEffort ?? 'low';

		// Check if this is a reasoning model (o3, o1, etc.) - matches Python
		const modelLower = options.model.toLowerCase();
		this.isReasoningModel = REASONING_MODELS.some(m => modelLower.includes(m.toLowerCase()));

		// Check if this is a Gemini model
		const isGeminiModel = GEMINI_MODELS.some(m => modelLower === m.toLowerCase());

		// Determine base URL based on model
		// - Gemini models use the generic /browser-use/v1 endpoint (model passed in request body)
		// - Other models use model-specific paths for backwards compatibility
		const snowxApiBase = process.env.SNOWX_API_URL || 'https://snowx.ai/api-beta/api';
		let baseURL: string;
		if (options.baseURL) {
			baseURL = options.baseURL;
		} else if (isGeminiModel) {
			// Gemini models use generic endpoint - model is passed in request body
			baseURL = `${snowxApiBase}/browser-use/v1`;
		} else {
			// Legacy: o3 and gpt-4o use model-specific paths
			const modelPath = modelLower.includes('o3') ? 'o3' : 'gpt-4o';
			baseURL = `${snowxApiBase}/browser-use/${modelPath}/v1`;
		}

		if (!options.firebaseToken) {
			throw new Error('Firebase token is required for SnowX API authentication');
		}

		logger.debug(`ChatSnowX initialized with model: ${this.model}, baseURL: ${baseURL}, isReasoningModel: ${this.isReasoningModel}`);

		// Create OpenAI client with Firebase token as api_key (like Python)
		// The token is sent as "Authorization: Bearer {token}" header
		this.client = new OpenAI({
			apiKey: options.firebaseToken,
			baseURL: baseURL,
			timeout: options.timeout ?? 120000,
			maxRetries: 3,
		});
	}

	get provider(): string {
		return 'snowx';
	}

	get name(): string {
		return this.model;
	}

	/**
	 * Get usage info from response (matches Python's _get_usage)
	 */
	private getUsage(response: OpenAI.Chat.ChatCompletion): ChatInvokeUsage | null {
		if (!response.usage) {
			return null;
		}

		let completionTokens = response.usage.completion_tokens;

		// Add reasoning tokens if present (for o3/o1 models) - matches Python
		if (response.usage.completion_tokens_details?.reasoning_tokens) {
			completionTokens += response.usage.completion_tokens_details.reasoning_tokens;
		}

		return {
			promptTokens: response.usage.prompt_tokens,
			promptCachedTokens: response.usage.prompt_tokens_details?.cached_tokens ?? null,
			promptCacheCreationTokens: null,
			promptImageTokens: null,
			completionTokens,
			totalTokens: response.usage.total_tokens,
		};
	}

	/**
	 * Serialize messages to OpenAI format
	 */
	private serializeMessages(messages: BaseMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
		return messages.map((msg) => {
			if (msg.role === 'system') {
				return {
					role: 'system' as const,
					content: typeof msg.content === 'string' ? msg.content : '',
				};
			}

			if (msg.role === 'user') {
				if (typeof msg.content === 'string') {
					return {
						role: 'user' as const,
						content: msg.content,
					};
				}

				// Handle content parts (text + images)
				const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
				for (const part of msg.content || []) {
					if (part.type === 'text') {
						parts.push({
							type: 'text' as const,
							text: part.text,
						});
					} else if (part.type === 'image_url') {
						parts.push({
							type: 'image_url' as const,
							image_url: {
								url: (part as ImageUrlPart).imageUrl.url,
							},
						});
					}
				}
				return {
					role: 'user' as const,
					content: parts,
				};
			}

			if (msg.role === 'assistant') {
				const content = typeof msg.content === 'string'
					? msg.content
					: msg.content
						? msg.content.map((p) => p.type === 'text' ? p.text : '').join('\n')
						: null;

				return {
					role: 'assistant' as const,
					content,
				};
			}

			throw new Error(`Unknown message role: ${(msg as any).role}`);
		});
	}

	/**
	 * Send request to SnowX API using OpenAI SDK.
	 * Matches Python's ChatOpenAI.ainvoke() behavior exactly.
	 */
	async ainvoke<T extends z.ZodType>(
		messages: BaseMessage[],
		outputFormat?: T
	): Promise<ChatInvokeCompletion<T extends z.ZodType<infer U> ? U : string>> {
		const openaiMessages = this.serializeMessages(messages);

		// Build model params - let backend handle token limits
		const modelParams: Record<string, any> = {
			model: this.model,
			messages: openaiMessages,
		};

		// Don't send max_completion_tokens - let backend handle token limits

		// For reasoning models (o3, o1, etc.), use reasoning_effort instead of temperature
		// Matches Python: del model_params['temperature'], model_params['reasoning_effort'] = ...
		if (this.isReasoningModel) {
			modelParams.reasoning_effort = this.reasoningEffort;
			logger.debug(`Using reasoning_effort: ${this.reasoningEffort} for model ${this.model}`);
			// Note: Don't set temperature for reasoning models
		} else {
			modelParams.temperature = this.temperature;
		}

		// Add response format for structured output (matches Python)
		if (outputFormat) {
			const { SchemaOptimizer } = await import('../schema.js');
			modelParams.response_format = {
				type: 'json_schema',
				json_schema: {
					name: 'agent_output',
					strict: true,
					schema: SchemaOptimizer.createOptimizedJsonSchema(outputFormat),
				},
			};

		}

		try {
			logger.debug(`Calling SnowX API with model ${this.model}`);

			// Use OpenAI SDK - this handles all the complexity properly (like Python)
			const response = await this.client.chat.completions.create(modelParams as OpenAI.Chat.ChatCompletionCreateParams);

			logger.debug(`Got response from SnowX API`);

			// Parse response (OpenAI-compatible format)
			let completion: any;
			const content = response.choices?.[0]?.message?.content || '';

			if (outputFormat) {
				// Parse JSON and validate with Zod schema
				const parsed = JSON.parse(content);
				completion = outputFormat.parse(parsed);
			} else {
				completion = content;
			}

			// Get usage info
			const usage = this.getUsage(response);

			return {
				completion,
				usage: usage ?? undefined,
				stopReason: response.choices?.[0]?.finish_reason ?? null,
			} as ChatInvokeCompletion<T extends z.ZodType<infer U> ? U : string>;
		} catch (error: any) {
			// Handle OpenAI SDK errors
			if (error.status === 401) {
				logger.error(`SnowX API authentication failed: ${error.message}`);
				throw new Error(`Authentication failed: ${error.message}`);
			}

			if (error.status === 402) {
				logger.error(`SnowX API insufficient credits: ${error.message}`);
				throw new Error(`Insufficient credits: ${error.message}`);
			}

			if (error.status === 429) {
				logger.error(`SnowX API rate limit: ${error.message}`);
				throw new Error(`Rate limit exceeded: ${error.message}`);
			}

			if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
				logger.error(`SnowX API timeout: ${error.message}`);
				throw new Error(`Request timed out: ${error.message}`);
			}

			logger.error(`SnowX API error: ${error.message}`);
			throw new Error(`SnowX API error: ${error.message}`);
		}
	}
}

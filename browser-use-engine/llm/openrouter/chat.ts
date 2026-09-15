/**
 * OpenRouter chat model (multi-provider gateway)
 * Port from browser_use/llm/openrouter/chat.py (215 lines)
 */
import OpenAI from 'openai';
import { z } from 'zod';
import { BaseChatModel } from '../base.js';
import { BaseMessage } from '../messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { ModelProviderError, ModelRateLimitError } from '../exceptions.js';
import { SchemaOptimizer } from '../schema.js';
import { OpenRouterMessageSerializer } from './serializer.js';

export interface ChatOpenRouterOptions {
	model: string;
	temperature?: number;
	topP?: number;
	seed?: number;
	apiKey?: string;
	httpReferer?: string; // OpenRouter-specific tracking parameter
	baseURL?: string;
	timeout?: number;
	maxRetries?: number;
	defaultHeaders?: Record<string, string>;
}

export class ChatOpenRouter implements BaseChatModel {
	model: string;
	private temperature?: number;
	private topP?: number;
	private seed?: number;
	private apiKey?: string;
	private httpReferer?: string;
	private baseURL: string;
	private timeout?: number;
	private maxRetries: number;
	private defaultHeaders?: Record<string, string>;
	private client?: OpenAI;

	constructor(options: ChatOpenRouterOptions) {
		this.model = options.model;
		this.temperature = options.temperature;
		this.topP = options.topP;
		this.seed = options.seed;
		this.apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
		this.httpReferer = options.httpReferer;
		this.baseURL = options.baseURL || 'https://openrouter.ai/api/v1';
		this.timeout = options.timeout;
		this.maxRetries = options.maxRetries ?? 10;
		this.defaultHeaders = options.defaultHeaders;
	}

	get provider(): string {
		return 'openrouter';
	}

	get name(): string {
		return this.model;
	}

	private getClient(): OpenAI {
		if (!this.client) {
			this.client = new OpenAI({
				apiKey: this.apiKey,
				baseURL: this.baseURL,
				timeout: this.timeout,
				maxRetries: this.maxRetries,
				defaultHeaders: this.defaultHeaders,
			});
		}
		return this.client;
	}

	private getUsage(response: OpenAI.Chat.Completions.ChatCompletion): ChatInvokeUsage | null {
		if (!response.usage) return null;

		const promptDetails = (response.usage as any).prompt_tokens_details;
		const cachedTokens = promptDetails?.cached_tokens || null;

		return {
			promptTokens: response.usage.prompt_tokens,
			promptCachedTokens: cachedTokens,
			promptCacheCreationTokens: null,
			promptImageTokens: null,
			completionTokens: response.usage.completion_tokens,
			totalTokens: response.usage.total_tokens,
		};
	}

	async ainvoke<T extends z.ZodType>(
		messages: BaseMessage[],
		outputFormat?: T
	): Promise<ChatInvokeCompletion<T extends z.ZodType ? z.infer<T> : string>> {
		const openrouterMessages = OpenRouterMessageSerializer.serializeMessages(messages);

		// Set up extra headers for OpenRouter
		const extraHeaders: Record<string, string> = {};
		if (this.httpReferer) {
			extraHeaders['HTTP-Referer'] = this.httpReferer;
		}

		try {
			if (!outputFormat) {
				// Regular text completion
				const response = await this.getClient().chat.completions.create({
					model: this.model,
					messages: openrouterMessages as any,
					temperature: this.temperature,
					top_p: this.topP,
					seed: this.seed,
					...(Object.keys(extraHeaders).length > 0 && { extra_headers: extraHeaders }),
				} as any);

				return {
					completion: response.choices[0]?.message?.content || '',
					usage: this.getUsage(response),
				} as any;
			}

			// Structured output with JSON schema
			const schema = SchemaOptimizer.createOptimizedJsonSchema(outputFormat);

			const responseFormatSchema = {
				name: 'agent_output',
				strict: true,
				schema: schema,
			};

			const response = await this.getClient().chat.completions.create({
				model: this.model,
				messages: openrouterMessages as any,
				temperature: this.temperature,
				top_p: this.topP,
				seed: this.seed,
				response_format: {
					type: 'json_schema',
					json_schema: responseFormatSchema,
				} as any,
				...(Object.keys(extraHeaders).length > 0 && { extra_headers: extraHeaders }),
			} as any);

			const content = response.choices[0]?.message?.content;
			if (!content) {
				throw new ModelProviderError({
					message: 'Failed to parse structured output from model response',
					statusCode: 500,
					model: this.name,
				});
			}

			const parsed = outputFormat.parse(JSON.parse(content));

			return {
				completion: parsed,
				usage: this.getUsage(response),
			} as any;
		} catch (error: any) {
			if (error.status === 429 || error.code === 'rate_limit_exceeded') {
				throw new ModelRateLimitError({
					message: error.message || 'Rate limit exceeded',
					model: this.name,
				});
			}

			if (error.status) {
				throw new ModelProviderError({
					message: error.message || 'OpenRouter request failed',
					statusCode: error.status,
					model: this.name,
				});
			}

			throw new ModelProviderError({
				message: error.message || 'OpenRouter request failed',
				model: this.name,
			});
		}
	}
}

/**
 * DeepSeek chat model (OpenAI-compatible)
 * Port from browser_use/llm/deepseek/chat.py (221 lines)
 */
import OpenAI from 'openai';
import { z } from 'zod';
import { BaseChatModel } from '../base.js';
import { BaseMessage } from '../messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { ModelProviderError, ModelRateLimitError } from '../exceptions.js';
import { SchemaOptimizer } from '../schema.js';
import { DeepSeekMessageSerializer } from './serializer.js';

export interface ChatDeepSeekOptions {
	model?: string;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	seed?: number;
	apiKey?: string;
	baseURL?: string;
	timeout?: number;
	clientParams?: Record<string, any>;
}

export class ChatDeepSeek implements BaseChatModel {
	model: string;
	private maxTokens?: number;
	private temperature?: number;
	private topP?: number;
	private seed?: number;
	private apiKey?: string;
	private baseURL: string;
	private timeout?: number;
	private clientParams?: Record<string, any>;

	constructor(options: ChatDeepSeekOptions = {}) {
		this.model = options.model || 'deepseek-chat';
		this.maxTokens = options.maxTokens;
		this.temperature = options.temperature;
		this.topP = options.topP;
		this.seed = options.seed;
		this.apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY;
		this.baseURL = options.baseURL || 'https://api.deepseek.com/v1';
		this.timeout = options.timeout;
		this.clientParams = options.clientParams;
	}

	get provider(): string {
		return 'deepseek';
	}

	get name(): string {
		return this.model;
	}

	private client?: OpenAI;

	private getClient(): OpenAI {
		// Memoize the client (like the google/openrouter providers) so we don't
		// build a fresh OpenAI instance — with its own retry/keep-alive state —
		// on every step.
		if (!this.client) {
			this.client = new OpenAI({
				apiKey: this.apiKey,
				baseURL: this.baseURL,
				timeout: this.timeout,
				...this.clientParams,
			});
		}
		return this.client;
	}

	async ainvoke<T extends z.ZodType>(
		messages: BaseMessage[],
		outputFormat?: T
	): Promise<ChatInvokeCompletion<T extends z.ZodType ? z.infer<T> : string>> {
		const client = this.getClient();
		const dsMessages = DeepSeekMessageSerializer.serializeMessages(messages);

		const common: Record<string, any> = {};
		if (this.temperature !== undefined) common.temperature = this.temperature;
		if (this.maxTokens !== undefined) common.max_tokens = this.maxTokens;
		if (this.topP !== undefined) common.top_p = this.topP;
		if (this.seed !== undefined) common.seed = this.seed;

		try {
			// Regular text completion
			if (!outputFormat) {
				const response = await client.chat.completions.create({
					model: this.model,
					messages: dsMessages as any,
					...common,
				});

				return {
					completion: response.choices[0]?.message?.content || '',
					usage: this.extractUsage(response),
				} as any;
			}

			// Structured output via function calling
			const toolName = (outputFormat as any)._def?.typeName || 'extract_data';
			const schema = SchemaOptimizer.createOptimizedJsonSchema(outputFormat);
			delete schema.title;

			const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
				{
					type: 'function',
					function: {
						name: toolName,
						description: `Return a JSON object of type ${toolName}`,
						parameters: schema,
					},
				},
			];

			const response = await client.chat.completions.create({
				model: this.model,
				messages: dsMessages as any,
				tools,
				tool_choice: { type: 'function', function: { name: toolName } },
				...common,
			});

			const message = response.choices[0]?.message;
			if (!message?.tool_calls || message.tool_calls.length === 0) {
				throw new ModelProviderError({
					message: 'Expected tool_calls in response but got none',
					model: this.name,
				});
			}

			const rawArgs = message.tool_calls[0].function.arguments;
			const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
			const validated = outputFormat.parse(parsed);

			return {
				completion: validated,
				usage: this.extractUsage(response),
			} as any;
		} catch (error: any) {
			if (error.status === 429 || error.code === 'rate_limit_exceeded') {
				throw new ModelRateLimitError({
					message: error.message || 'Rate limit exceeded',
					statusCode: error.status || 429,
					model: this.name,
				});
			}

			throw new ModelProviderError({
				message: error.message || 'DeepSeek request failed',
				statusCode: error.status,
				model: this.name,
			});
		}
	}

	private extractUsage(response: OpenAI.Chat.Completions.ChatCompletion): ChatInvokeUsage | null {
		if (!response.usage) return null;

		return {
			promptTokens: response.usage.prompt_tokens,
			completionTokens: response.usage.completion_tokens,
			totalTokens: response.usage.total_tokens,
			promptCachedTokens: null,
			promptCacheCreationTokens: null,
			promptImageTokens: null,
		};
	}
}

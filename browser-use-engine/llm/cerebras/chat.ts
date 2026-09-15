/**
 * Cerebras chat model (fast inference, OpenAI-compatible)
 * Port from browser_use/llm/cerebras/chat.py (157 lines)
 */
import OpenAI from 'openai';
import { z } from 'zod';
import { BaseChatModel } from '../base.js';
import { BaseMessage } from '../messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { ModelProviderError, ModelRateLimitError } from '../exceptions.js';
import { CerebrasMessageSerializer } from './serializer.js';

export interface ChatCerebrasOptions {
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

export class ChatCerebras implements BaseChatModel {
	model: string;
	private maxTokens?: number;
	private temperature?: number;
	private topP?: number;
	private seed?: number;
	private apiKey?: string;
	private baseURL: string;
	private timeout?: number;
	private clientParams?: Record<string, any>;

	constructor(options: ChatCerebrasOptions = {}) {
		this.model = options.model || 'llama3.1-8b';
		// Don't set default - let backend handle token limits
		this.maxTokens = options.maxTokens;
		this.temperature = options.temperature ?? 0.2;
		this.topP = options.topP;
		this.seed = options.seed;
		this.apiKey = options.apiKey || process.env.CEREBRAS_API_KEY;
		this.baseURL = options.baseURL || 'https://api.cerebras.ai/v1';
		this.timeout = options.timeout;
		this.clientParams = options.clientParams;
	}

	get provider(): string {
		return 'cerebras';
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

	private getUsage(response: OpenAI.Chat.Completions.ChatCompletion): ChatInvokeUsage | null {
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

	async ainvoke<T extends z.ZodType>(
		messages: BaseMessage[],
		outputFormat?: T
	): Promise<ChatInvokeCompletion<T extends z.ZodType ? z.infer<T> : string>> {
		const client = this.getClient();
		const cerebrasMessages = CerebrasMessageSerializer.serializeMessages(messages);

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
					messages: cerebrasMessages as any,
					...common,
				});

				return {
					completion: response.choices[0]?.message?.content || '',
					usage: this.getUsage(response),
				} as any;
			}

			// JSON output - Cerebras doesn't have native JSON mode, so we use prompt engineering
			const schema = outputFormat._def as any;
			const schemaStr = JSON.stringify(schema, null, 2);

			const jsonPrompt = `

Please respond with a JSON object that follows this exact schema:
${schemaStr}

Your response must be valid JSON only, no other text.
`;

			// Add JSON prompt to last user message
			const modifiedMessages = [...cerebrasMessages];
			if (modifiedMessages.length > 0 && modifiedMessages[modifiedMessages.length - 1].role === 'user') {
				const lastMsg = modifiedMessages[modifiedMessages.length - 1];
				if (typeof lastMsg.content === 'string') {
					lastMsg.content += jsonPrompt;
				} else if (Array.isArray(lastMsg.content)) {
					lastMsg.content.push({ type: 'text', text: jsonPrompt });
				}
			} else {
				modifiedMessages.push({ role: 'user', content: jsonPrompt } as any);
			}

			const response = await client.chat.completions.create({
				model: this.model,
				messages: modifiedMessages as any,
				...common,
			});

			const content = response.choices[0]?.message?.content;
			if (!content) {
				throw new ModelProviderError({
					message: 'Empty JSON content in Cerebras response',
					model: this.name,
				});
			}

			// Extract JSON from response (might have extra text)
			const jsonMatch = content.match(/\{.*\}/s);
			const jsonStr = jsonMatch ? jsonMatch[0] : content;

			const parsed = outputFormat.parse(JSON.parse(jsonStr));

			return {
				completion: parsed,
				usage: this.getUsage(response),
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
				message: error.message || 'Cerebras request failed',
				statusCode: error.status,
				model: this.name,
			});
		}
	}
}

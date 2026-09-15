/**
 * Groq chat model (fast inference)
 * Port from browser_use/llm/groq/chat.py (229 lines)
 */
import Groq from 'groq-sdk';
import { z } from 'zod';
import { BaseChatModel } from '../base.js';
import { BaseMessage } from '../messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { ModelProviderError, ModelRateLimitError } from '../exceptions.js';
import { SchemaOptimizer } from '../schema.js';
import { GroqMessageSerializer } from './serializer.js';
import { tryParseGroqFailedGeneration } from './parser.js';

export type GroqVerifiedModels =
	| 'meta-llama/llama-4-maverick-17b-128e-instruct'
	| 'meta-llama/llama-4-scout-17b-16e-instruct'
	| 'qwen/qwen3-32b'
	| 'moonshotai/kimi-k2-instruct'
	| 'openai/gpt-oss-20b'
	| 'openai/gpt-oss-120b';

const JSON_SCHEMA_MODELS = [
	'meta-llama/llama-4-maverick-17b-128e-instruct',
	'meta-llama/llama-4-scout-17b-16e-instruct',
	'openai/gpt-oss-20b',
	'openai/gpt-oss-120b',
];

const TOOL_CALLING_MODELS = ['moonshotai/kimi-k2-instruct'];

export interface ChatGroqOptions {
	model: GroqVerifiedModels | string;
	apiKey?: string;
	baseURL?: string;
	temperature?: number;
	serviceTier?: 'auto' | 'on_demand' | 'flex';
	topP?: number;
	seed?: number;
	timeout?: number;
	maxRetries?: number;
}

export class ChatGroq implements BaseChatModel {
	model: string;
	private client: Groq;
	private temperature?: number;
	private serviceTier?: 'auto' | 'on_demand' | 'flex';
	private topP?: number;
	private seed?: number;

	constructor(options: ChatGroqOptions) {
		this.model = options.model;
		this.temperature = options.temperature;
		this.serviceTier = options.serviceTier;
		this.topP = options.topP;
		this.seed = options.seed;

		const apiKey = options.apiKey || process.env.GROQ_API_KEY;
		this.client = new Groq({
			apiKey,
			baseURL: options.baseURL,
			timeout: options.timeout,
			maxRetries: options.maxRetries ?? 10, // Increase default retries for automation reliability
		});
	}

	get provider(): string {
		return 'groq';
	}

	get name(): string {
		return this.model;
	}

	private getUsage(response: Groq.Chat.Completions.ChatCompletion): ChatInvokeUsage | null {
		if (!response.usage) {
			return null;
		}

		return {
			promptTokens: response.usage.prompt_tokens,
			completionTokens: response.usage.completion_tokens,
			totalTokens: response.usage.total_tokens,
			promptCachedTokens: null, // Groq doesn't support cached tokens
			promptCacheCreationTokens: null,
			promptImageTokens: null,
		};
	}

	async ainvoke<T extends z.ZodType>(
		messages: BaseMessage[],
		outputFormat?: T
	): Promise<ChatInvokeCompletion<T extends z.ZodType ? z.infer<T> : string>> {
		const groqMessages = GroqMessageSerializer.serializeMessages(messages);

		try {
			if (!outputFormat) {
				return (await this.invokeRegularCompletion(groqMessages)) as any;
			} else {
				return (await this.invokeStructuredOutput(groqMessages, outputFormat)) as any;
			}
		} catch (error: any) {
			// Handle rate limit errors
			if (error.status === 429 || error.code === 'rate_limit_exceeded') {
				throw new ModelRateLimitError({
					message: error.message || 'Rate limit exceeded',
					statusCode: error.status || 429,
					model: this.name,
				});
			}

			// Handle API validation errors
			if (error.status && error.message) {
				if (outputFormat && error.status >= 400) {
					// Try to parse failed generation for structured output
					try {
						console.debug('Groq failed generation; fallback to manual parsing');
						const parsed = tryParseGroqFailedGeneration(error, outputFormat);
						console.debug('Manual error parsing successful ✅');

						return {
							completion: parsed,
							usage: null, // No usage data for failed generations
						} as any;
					} catch (parseError) {
						// If parsing also fails, throw the original error
						throw new ModelProviderError({
							message: error.message,
							statusCode: error.status,
							model: this.name,
						});
					}
				}

				throw new ModelProviderError({
					message: error.message,
					statusCode: error.status,
					model: this.name,
				});
			}

			// Handle generic errors
			throw new ModelProviderError({
				message: error.message || 'Unknown error',
				model: this.name,
			});
		}
	}

	private async invokeRegularCompletion(
		groqMessages: Groq.Chat.Completions.ChatCompletionMessageParam[]
	): Promise<ChatInvokeCompletion<string>> {
		const response = await this.client.chat.completions.create({
			messages: groqMessages,
			model: this.model,
			temperature: this.temperature,
			top_p: this.topP,
			seed: this.seed,
			// @ts-ignore - serviceTier may not be in SDK types yet
			service_tier: this.serviceTier,
		});

		const usage = this.getUsage(response);
		const content = response.choices[0]?.message?.content || '';

		return {
			completion: content,
			usage,
		};
	}

	private async invokeStructuredOutput<T extends z.ZodType>(
		groqMessages: Groq.Chat.Completions.ChatCompletionMessageParam[],
		outputFormat: T
	): Promise<ChatInvokeCompletion<z.infer<T>>> {
		const schema = SchemaOptimizer.createOptimizedJsonSchema(outputFormat);

		let response: Groq.Chat.Completions.ChatCompletion;

		if (TOOL_CALLING_MODELS.includes(this.model)) {
			response = await this.invokeWithToolCalling(groqMessages, outputFormat, schema);
		} else {
			response = await this.invokeWithJsonSchema(groqMessages, outputFormat, schema);
		}

		const content = response.choices[0]?.message?.content;
		if (!content) {
			throw new ModelProviderError({
				message: 'No content in response',
				statusCode: 500,
				model: this.name,
			});
		}

		// Parse and validate the JSON response
		const parsed = JSON.parse(content);
		const validated = outputFormat.parse(parsed);
		const usage = this.getUsage(response);

		return {
			completion: validated,
			usage,
		};
	}

	private async invokeWithToolCalling<T extends z.ZodType>(
		groqMessages: Groq.Chat.Completions.ChatCompletionMessageParam[],
		outputFormat: T,
		schema: Record<string, any>
	): Promise<Groq.Chat.Completions.ChatCompletion> {
		const typeName = (outputFormat as any)._def?.typeName || 'extract_data';
		const tool: Groq.Chat.Completions.ChatCompletionTool = {
			type: 'function',
			function: {
				name: typeName,
				description: `Extract information in the format of ${typeName}`,
				parameters: schema,
			},
		};

		return await this.client.chat.completions.create({
			model: this.model,
			messages: groqMessages,
			temperature: this.temperature,
			top_p: this.topP,
			seed: this.seed,
			tools: [tool],
			tool_choice: 'required',
			// @ts-ignore - serviceTier may not be in SDK types yet
			service_tier: this.serviceTier,
		});
	}

	private async invokeWithJsonSchema<T extends z.ZodType>(
		groqMessages: Groq.Chat.Completions.ChatCompletionMessageParam[],
		outputFormat: T,
		schema: Record<string, any>
	): Promise<Groq.Chat.Completions.ChatCompletion> {
		const typeName = (outputFormat as any)._def?.typeName || 'output_schema';
		return await this.client.chat.completions.create({
			model: this.model,
			messages: groqMessages,
			temperature: this.temperature,
			top_p: this.topP,
			seed: this.seed,
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: typeName,
					description: 'Model output schema',
					schema: schema,
					strict: false,
				},
			} as any,
			// @ts-ignore - serviceTier may not be in SDK types yet
			service_tier: this.serviceTier,
		});
	}
}

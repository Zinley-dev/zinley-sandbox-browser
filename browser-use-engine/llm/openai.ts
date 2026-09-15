/**
 * OpenAI chat model implementation
 * Port from browser_use/llm/openai/chat.py (synced with 0.13.10)
 */

import OpenAI from 'openai';
import { z } from 'zod';
import { BaseChatModel, ChatInvokeOptions, isReasoningModel } from './base.js';
import { BaseMessage } from './messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from './views.js';
import { ModelOutputTruncatedError, ModelProviderError, ModelRateLimitError } from './exceptions.js';
import { SchemaOptimizer } from './schema.js';

// Reasoning models that don't support temperature/frequency_penalty (matches Python)
export const REASONING_MODELS = ['o4-mini', 'o3', 'o3-mini', 'o1', 'o1-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'];

export interface ChatOpenAIOptions {
	/** Model identifier (e.g., 'gpt-4o', 'gpt-4-turbo') */
	model: string;

	/** Temperature for sampling (0-2) */
	temperature?: number;

	/** Frequency penalty (-2 to 2) */
	frequencyPenalty?: number;

	/** Max completion tokens */
	maxCompletionTokens?: number;

	/** Top-p sampling */
	topP?: number;

	/** Random seed for deterministic outputs */
	seed?: number;

	/** Service tier */
	serviceTier?: 'auto' | 'default' | 'flex' | 'priority' | 'scale';

	/** OpenAI API key */
	apiKey?: string;

	/** Organization ID */
	organization?: string;

	/** Project ID */
	project?: string;

	/** Base URL for API */
	baseURL?: string;

	/** Timeout in milliseconds */
	timeout?: number;

	/** Max retries */
	maxRetries?: number;

	/** Default headers */
	defaultHeaders?: Record<string, string>;

	/** Allow the SDK to run in a browser-like environment (tests, renderer) */
	dangerouslyAllowBrowser?: boolean;

	/** Reasoning effort for reasoning models */
	reasoningEffort?: 'low' | 'medium' | 'high';

	/** Model name patterns treated as reasoning models (default: REASONING_MODELS) */
	reasoningModels?: string[];

	/** Add the JSON schema to the system prompt instead of relying only on response_format */
	addSchemaToSystemPrompt?: boolean;

	/** If true, the model is not forced to output structured output (no response_format) */
	dontForceStructuredOutput?: boolean;

	/** If true, remove minItems from the JSON schema (for compatibility with some providers) */
	removeMinItemsFromSchema?: boolean;

	/** If true, remove default values from the JSON schema (for compatibility with some providers) */
	removeDefaultsFromSchema?: boolean;
}

/**
 * Message serializer for OpenAI format
 */
class OpenAIMessageSerializer {
	static serializeMessages(
		messages: BaseMessage[]
	): OpenAI.Chat.ChatCompletionMessageParam[] {
		return messages.map((msg) => {
			if (msg.role === 'user') {
				if (typeof msg.content === 'string') {
					return {
						role: 'user',
						content: msg.content,
						...(msg.name && { name: msg.name }),
					};
				}
				// Handle content parts (text + images)
				const parts = msg.content.map((part) => {
					if (part.type === 'text') {
						return {
							type: 'text' as const,
							text: part.text,
						};
					} else if (part.type === 'image_url') {
						return {
							type: 'image_url' as const,
							image_url: {
								url: part.imageUrl.url,
								detail: part.imageUrl.detail || 'auto',
							},
						};
					}
					throw new Error(`Unsupported content part type: ${(part as any).type}`);
				});

				return {
					role: 'user',
					content: parts,
					...(msg.name && { name: msg.name }),
				};
			} else if (msg.role === 'system') {
				return {
					role: 'system',
					content: typeof msg.content === 'string' ? msg.content : msg.content.map((p) => p.text).join('\n'),
					...(msg.name && { name: msg.name }),
				};
			} else if (msg.role === 'assistant') {
				const content = typeof msg.content === 'string'
					? msg.content
					: msg.content
						? msg.content.map((p) => p.type === 'text' ? p.text : '').join('\n')
						: null;

				return {
					role: 'assistant',
					content,
					...(msg.toolCalls && {
						tool_calls: msg.toolCalls.map((tc) => ({
							id: tc.id,
							type: 'function' as const,
							function: {
								name: tc.function.name,
								arguments: tc.function.arguments,
							},
						})),
					}),
					...(msg.name && { name: msg.name }),
				};
			}

			throw new Error(`Unknown message role: ${(msg as any).role}`);
		});
	}
}

/** Strip a ``` fence so a plain-text JSON answer can be parsed. */
function stripJsonFence(text: string): string {
	const trimmed = text.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return fence ? fence[1] : trimmed;
}

export class ChatOpenAI implements BaseChatModel {
	model: string;
	private client: OpenAI;
	private temperature: number;
	private frequencyPenalty: number;
	private maxCompletionTokens?: number;
	private topP?: number;
	private seed?: number;
	private serviceTier?: 'auto' | 'default' | 'flex' | 'priority' | 'scale';
	private maxRetries: number;
	private reasoningEffort: 'low' | 'medium' | 'high';
	private reasoningModels: string[];
	private addSchemaToSystemPrompt: boolean;
	private dontForceStructuredOutput: boolean;
	private removeMinItemsFromSchema: boolean;
	private removeDefaultsFromSchema: boolean;
	/** Base URL the client talks to (kept for diagnostics, e.g. proxy errors) */
	readonly baseURL?: string;

	constructor(options: ChatOpenAIOptions) {
		this.model = options.model;
		this.temperature = options.temperature ?? 0.2;
		this.frequencyPenalty = options.frequencyPenalty ?? 0.3;
		// Don't set default - let backend handle token limits
		this.maxCompletionTokens = options.maxCompletionTokens;
		this.topP = options.topP;
		this.seed = options.seed;
		this.serviceTier = options.serviceTier;
		this.maxRetries = options.maxRetries ?? 5;
		this.reasoningEffort = options.reasoningEffort ?? 'low';
		this.reasoningModels = options.reasoningModels ?? REASONING_MODELS;
		this.addSchemaToSystemPrompt = options.addSchemaToSystemPrompt ?? false;
		this.dontForceStructuredOutput = options.dontForceStructuredOutput ?? false;
		this.removeMinItemsFromSchema = options.removeMinItemsFromSchema ?? false;
		this.removeDefaultsFromSchema = options.removeDefaultsFromSchema ?? false;
		this.baseURL = options.baseURL;

		this.client = new OpenAI({
			apiKey: options.apiKey,
			organization: options.organization,
			project: options.project,
			baseURL: options.baseURL,
			timeout: options.timeout,
			maxRetries: this.maxRetries,
			defaultHeaders: options.defaultHeaders,
			...(options.dangerouslyAllowBrowser !== undefined && {
				dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
			}),
		});
	}

	get provider(): string {
		return 'openai';
	}

	get name(): string {
		return this.model;
	}

	/** Whether the configured model is treated as a reasoning model */
	get isReasoningModel(): boolean {
		return isReasoningModel(this.model, this.reasoningModels);
	}

	private getUsage(response: OpenAI.Chat.ChatCompletion): ChatInvokeUsage | null {
		if (!response.usage) {
			return null;
		}

		// Note: completion_tokens already includes reasoning_tokens per OpenAI API docs.
		// Unlike Google Gemini where thinking_tokens are reported separately,
		// OpenAI's reasoning_tokens are a subset of completion_tokens.
		return {
			promptTokens: response.usage.prompt_tokens,
			promptCachedTokens: response.usage.prompt_tokens_details?.cached_tokens ?? null,
			promptCacheCreationTokens: null,
			promptImageTokens: null,
			completionTokens: response.usage.completion_tokens,
			totalTokens: response.usage.total_tokens,
		};
	}

	/**
	 * A proxy speaking a different schema (or an upstream outage) can answer 200 with no
	 * `choices`; surface that as a provider error with a hint instead of a TypeError.
	 */
	private firstChoice(response: OpenAI.Chat.ChatCompletion): OpenAI.Chat.ChatCompletion.Choice {
		const choice = response.choices?.[0];
		if (!choice) {
			const hint = this.baseURL ? ` (base_url=${this.baseURL})` : '';
			throw new ModelProviderError({
				message:
					'Invalid OpenAI chat completion response: missing or empty `choices`.' +
					' If you are using a proxy via `base_url`, ensure it implements the OpenAI' +
					' `/v1/chat/completions` schema and returns `choices` as a non-empty list.' +
					hint,
				statusCode: 502,
				model: this.name,
			});
		}
		return choice;
	}

	async ainvoke<T = string>(
		messages: BaseMessage[],
		outputFormat?: z.ZodType<T>,
		_options?: ChatInvokeOptions
	): Promise<ChatInvokeCompletion<T>> {
		const openaiMessages = OpenAIMessageSerializer.serializeMessages(messages);

		// Build model params - matches Python
		const modelParams: Record<string, any> = {
			model: this.model,
			messages: openaiMessages,
		};

		// For reasoning models (o3, o1, etc.), use reasoning_effort instead of temperature/frequency_penalty
		if (this.isReasoningModel) {
			modelParams.reasoning_effort = this.reasoningEffort;
		} else {
			modelParams.temperature = this.temperature;
			modelParams.frequency_penalty = this.frequencyPenalty;
		}

		// Don't send max_completion_tokens unless explicitly configured - let backend handle token limits
		if (this.maxCompletionTokens !== undefined) {
			modelParams.max_completion_tokens = this.maxCompletionTokens;
		}

		if (this.topP !== undefined) {
			modelParams.top_p = this.topP;
		}

		if (this.seed !== undefined) {
			modelParams.seed = this.seed;
		}

		if (this.serviceTier !== undefined) {
			modelParams.service_tier = this.serviceTier;
		}

		try {
			if (!outputFormat) {
				// String response
				const response = await this.client.chat.completions.create(modelParams as any);
				const choice = this.firstChoice(response as OpenAI.Chat.ChatCompletion);

				const usage = this.getUsage(response as OpenAI.Chat.ChatCompletion);

				return {
					completion: (choice.message?.content || '') as T,
					usage,
					stopReason: choice.finish_reason ?? null,
				};
			}

			// Structured output using optimized Zod schema (matches Python)
			// SchemaOptimizer ensures all properties are required for OpenAI strict mode
			const jsonSchema = SchemaOptimizer.createOptimizedJsonSchema(outputFormat, {
				removeMinItems: this.removeMinItemsFromSchema,
				removeDefaults: this.removeDefaultsFromSchema,
			});

			// Add JSON schema to system prompt if requested
			if (this.addSchemaToSystemPrompt) {
				const schemaText = `\n<json_schema>\n${JSON.stringify(jsonSchema)}\n</json_schema>`;
				const systemMessage = openaiMessages.find((m) => m.role === 'system') as
					| OpenAI.Chat.ChatCompletionSystemMessageParam
					| undefined;
				if (systemMessage) {
					if (typeof systemMessage.content === 'string') {
						systemMessage.content += schemaText;
					} else if (Array.isArray(systemMessage.content)) {
						systemMessage.content.push({ type: 'text', text: schemaText });
					}
				} else {
					openaiMessages.unshift({ role: 'system', content: schemaText.trim() });
				}
			}

			const response = this.dontForceStructuredOutput
				? await this.client.chat.completions.create(modelParams as any)
				: await this.client.chat.completions.create({
						...modelParams,
						response_format: {
							type: 'json_schema',
							json_schema: {
								name: 'agent_output',
								strict: true,
								schema: jsonSchema,
							},
						},
					} as any);

			const choice = this.firstChoice(response as OpenAI.Chat.ChatCompletion);

			// Before the content-null guard: reasoning models can burn the whole budget
			// on hidden reasoning, leaving finish_reason='length' with content=null
			if (choice.finish_reason === 'length') {
				const cap =
					this.maxCompletionTokens !== undefined
						? `max_completion_tokens=${this.maxCompletionTokens}`
						: "the model's output token limit";
				throw new ModelOutputTruncatedError({
					message:
						`Model output was truncated at ${cap};` +
						' the structured output is incomplete. Increase max_completion_tokens or request' +
						' shorter output.',
					model: this.name,
				});
			}

			if (choice.message?.content === null || choice.message?.content === undefined) {
				throw new ModelProviderError({
					message: 'Failed to parse structured output from model response',
					statusCode: 500,
					model: this.name,
				});
			}

			const usage = this.getUsage(response as OpenAI.Chat.ChatCompletion);

			// Parse and validate with Zod
			const parsed = JSON.parse(stripJsonFence(choice.message.content));
			const validated = outputFormat.parse(parsed);

			return {
				completion: validated as T,
				usage,
				stopReason: choice.finish_reason ?? null,
			};
		} catch (error: any) {
			if (error instanceof ModelProviderError) {
				// Preserve status code and message from validation errors
				throw error;
			}

			if (error?.status === 429) {
				throw new ModelRateLimitError({
					message: `Rate limit exceeded for model ${this.model}. Error: ${error.message}`,
					model: this.name,
				});
			}

			if (error?.status) {
				throw new ModelProviderError({
					message: `OpenAI API error (${error.status}): ${error.message}`,
					statusCode: error.status,
					model: this.name,
				});
			}

			throw new ModelProviderError({
				message: `OpenAI invocation failed: ${error?.message ?? error}`,
				model: this.name,
			});
		}
	}
}

/**
 * AWS Bedrock Anthropic Claude chat model.
 * Port from browser_use/llm/aws/chat_anthropic.py
 *
 * This is a convenience class that provides Claude-specific defaults
 * for the AWS Bedrock service. It uses the @anthropic-ai/bedrock-sdk
 * for native Anthropic-style API access to Bedrock.
 *
 * Note: Requires @anthropic-ai/bedrock-sdk as an optional dependency.
 * Install with: npm install @anthropic-ai/bedrock-sdk
 */

import { z } from 'zod';
import { BaseChatModel } from '../base.js';
import { BaseMessage } from '../messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { ModelProviderError, ModelRateLimitError } from '../exceptions.js';
import { AnthropicMessageSerializer } from '../anthropic/serializer.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Dynamic import helper to avoid TypeScript compilation errors for optional dependencies
async function dynamicImportBedrock(): Promise<any> {
	try {
		// Use dynamic require for optional dependency
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const moduleName = '@anthropic-ai/bedrock-sdk';
		return await import(moduleName);
	} catch {
		throw new Error(
			`@anthropic-ai/bedrock-sdk not available. Install with: npm install @anthropic-ai/bedrock-sdk`
		);
	}
}

export interface ChatAnthropicBedrockOptions {
	/** Model ID (e.g., 'anthropic.claude-3-5-sonnet-20240620-v1:0') */
	model?: string;

	/** Max tokens to generate */
	maxTokens?: number;

	/** Temperature for generation */
	temperature?: number;

	/** Top-p sampling */
	topP?: number;

	/** Top-k sampling */
	topK?: number;

	/** Stop sequences */
	stopSequences?: string[];

	/** Random seed */
	seed?: number;

	/** AWS access key ID */
	awsAccessKey?: string;

	/** AWS secret access key */
	awsSecretKey?: string;

	/** AWS session token */
	awsSessionToken?: string;

	/** AWS region */
	awsRegion?: string;

	/** Max retries */
	maxRetries?: number;

	/** Default headers */
	defaultHeaders?: Record<string, string>;

	/** Default query parameters */
	defaultQuery?: Record<string, unknown>;
}

/**
 * AWS Bedrock Anthropic Claude chat model.
 *
 * This class uses the @anthropic-ai/bedrock-sdk for direct Anthropic-style
 * API access to Claude models on AWS Bedrock, supporting prompt caching
 * and other Anthropic-specific features.
 */
export class ChatAnthropicBedrock implements BaseChatModel {
	model: string;
	private maxTokens: number;
	private temperature: number | undefined;
	private topP: number | undefined;
	private topK: number | undefined;
	private stopSequences: string[] | undefined;
	private seed: number | undefined;
	private awsAccessKey: string | undefined;
	private awsSecretKey: string | undefined;
	private awsSessionToken: string | undefined;
	private awsRegion: string | undefined;
	private maxRetries: number;
	private defaultHeaders: Record<string, string> | undefined;
	private defaultQuery: Record<string, unknown> | undefined;
	private client: any = null;

	constructor(options: ChatAnthropicBedrockOptions = {}) {
		this.model = options.model || 'anthropic.claude-3-5-sonnet-20240620-v1:0';
		// Don't set default - let backend handle token limits
		this.maxTokens = options.maxTokens as number;
		this.temperature = options.temperature;
		this.topP = options.topP;
		this.topK = options.topK;
		this.stopSequences = options.stopSequences;
		this.seed = options.seed;
		this.awsAccessKey = options.awsAccessKey || process.env.AWS_ACCESS_KEY_ID;
		this.awsSecretKey = options.awsSecretKey || process.env.AWS_SECRET_ACCESS_KEY;
		this.awsSessionToken = options.awsSessionToken || process.env.AWS_SESSION_TOKEN;
		this.awsRegion = options.awsRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
		this.maxRetries = options.maxRetries ?? 10;
		this.defaultHeaders = options.defaultHeaders;
		this.defaultQuery = options.defaultQuery;
	}

	get provider(): string {
		return 'anthropic_bedrock';
	}

	get name(): string {
		return this.model;
	}

	/**
	 * Prepare client parameters dictionary for Bedrock.
	 */
	private getClientParams(): Record<string, any> {
		const clientParams: Record<string, any> = {};

		// Add credentials
		if (this.awsAccessKey) {
			clientParams.aws_access_key = this.awsAccessKey;
		}
		if (this.awsSecretKey) {
			clientParams.aws_secret_key = this.awsSecretKey;
		}
		if (this.awsRegion) {
			clientParams.aws_region = this.awsRegion;
		}
		if (this.awsSessionToken) {
			clientParams.aws_session_token = this.awsSessionToken;
		}

		// Add optional parameters
		if (this.maxRetries) {
			clientParams.max_retries = this.maxRetries;
		}
		if (this.defaultHeaders) {
			clientParams.default_headers = this.defaultHeaders;
		}
		if (this.defaultQuery) {
			clientParams.default_query = this.defaultQuery;
		}

		return clientParams;
	}

	/**
	 * Prepare client parameters dictionary for invoke.
	 */
	private getInvokeParams(): Record<string, any> {
		const invokeParams: Record<string, any> = {};

		if (this.temperature !== undefined) {
			invokeParams.temperature = this.temperature;
		}
		if (this.maxTokens !== undefined) {
			invokeParams.max_tokens = this.maxTokens;
		}
		if (this.topP !== undefined) {
			invokeParams.top_p = this.topP;
		}
		if (this.topK !== undefined) {
			invokeParams.top_k = this.topK;
		}
		if (this.seed !== undefined) {
			// Note: Bedrock may not support seed parameter
		}
		if (this.stopSequences !== undefined) {
			invokeParams.stop_sequences = this.stopSequences;
		}

		return invokeParams;
	}

	/**
	 * Get the AsyncAnthropicBedrock client.
	 */
	private async getClient(): Promise<any> {
		if (this.client) return this.client;

		try {
			const bedrockModule = await dynamicImportBedrock();
			const { AnthropicBedrock } = bedrockModule;

			const clientParams = this.getClientParams();
			this.client = new AnthropicBedrock(clientParams);
			return this.client;
		} catch (error: any) {
			throw new ModelProviderError({
				message: `Failed to create Bedrock client: ${error.message}`,
				statusCode: 500,
				model: this.model,
			});
		}
	}

	/**
	 * Extract usage information from the response.
	 */
	private getUsage(response: any): ChatInvokeUsage | null {
		if (!response.usage) return null;

		return {
			promptTokens:
				response.usage.input_tokens + (response.usage.cache_read_input_tokens || 0),
			completionTokens: response.usage.output_tokens,
			totalTokens: response.usage.input_tokens + response.usage.output_tokens,
			promptCachedTokens: response.usage.cache_read_input_tokens ?? null,
			promptCacheCreationTokens: response.usage.cache_creation_input_tokens ?? null,
			promptImageTokens: null,
		};
	}

	async ainvoke<T = string>(
		messages: BaseMessage[],
		outputFormat?: z.ZodType<T>
	): Promise<ChatInvokeCompletion<T>> {
		const [anthropicMessages, systemPrompt] = AnthropicMessageSerializer.serializeMessages(messages);

		try {
			const client = await this.getClient();
			const invokeParams = this.getInvokeParams();

			if (!outputFormat) {
				// Normal completion without structured output
				const requestParams: any = {
					model: this.model,
					messages: anthropicMessages,
					...invokeParams,
				};

				if (systemPrompt) {
					requestParams.system = systemPrompt;
				}

				const response = await client.messages.create(requestParams);
				const usage = this.getUsage(response);

				// Extract text from the first content block
				const firstContent = response.content[0];
				let responseText: string;
				if (firstContent && firstContent.type === 'text') {
					responseText = firstContent.text;
				} else {
					responseText = String(firstContent);
				}

				return {
					completion: responseText as T,
					usage,
					stopReason: response.stop_reason ?? null,
				};
			} else {
				// Use tool calling for structured output
				const toolName = outputFormat.description || 'extract_data';
				const schema = zodToJsonSchema(outputFormat);

				// Remove title from schema if present (Anthropic doesn't like it in parameters)
				if ('title' in schema) {
					delete (schema as any).title;
				}

				const tool = {
					name: toolName,
					description: `Extract information in the format of ${toolName}`,
					input_schema: schema,
					cache_control: { type: 'ephemeral' },
				};

				// Force the model to use this tool
				const toolChoice = { type: 'tool', name: toolName };

				const requestParams: any = {
					model: this.model,
					messages: anthropicMessages,
					tools: [tool],
					tool_choice: toolChoice,
					...invokeParams,
				};

				if (systemPrompt) {
					requestParams.system = systemPrompt;
				}

				const response = await client.messages.create(requestParams);
				const usage = this.getUsage(response);

				// Extract the tool use block
				for (const contentBlock of response.content) {
					if (contentBlock.type === 'tool_use') {
						// Parse the tool input as the structured output
						try {
							const validated = outputFormat.parse(contentBlock.input);
							return {
								completion: validated as T,
								usage,
								stopReason: response.stop_reason ?? null,
							};
						} catch (e) {
							// If validation fails, try to parse it as JSON first
							if (typeof contentBlock.input === 'string') {
								const data = JSON.parse(contentBlock.input);
								const validated = outputFormat.parse(data);
								return {
									completion: validated as T,
									usage,
									stopReason: response.stop_reason ?? null,
								};
							}
							throw e;
						}
					}
				}

				// If no tool use block found, raise an error
				throw new Error('Expected tool use in response but none found');
			}
		} catch (error: any) {
			// Handle specific error types
			if (error.status === 429 || error.name === 'RateLimitError') {
				throw new ModelRateLimitError({
					message: error.message,
					model: this.model,
				});
			}

			if (error instanceof ModelProviderError || error instanceof ModelRateLimitError) {
				throw error;
			}

			throw new ModelProviderError({
				message: error.message || String(error),
				statusCode: error.status || 500,
				model: this.model,
			});
		}
	}
}

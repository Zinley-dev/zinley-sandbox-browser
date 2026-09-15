/**
 * AWS Bedrock chat model
 * Port from browser_use/llm/aws/chat_bedrock.py
 *
 * Note: Requires @aws-sdk/client-bedrock-runtime as an optional dependency.
 * Install with: npm install @aws-sdk/client-bedrock-runtime
 */
import { BaseChatModel } from '../base.js';
import { BaseMessage, SystemMessage } from '../messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { ModelProviderError, ModelRateLimitError } from '../exceptions.js';
import { z } from 'zod';

// Dynamic import helper to avoid TypeScript compilation errors for optional dependencies
async function dynamicImport(moduleName: string): Promise<any> {
	try {
		return await import(/* webpackIgnore: true */ moduleName);
	} catch {
		throw new Error(`Module '${moduleName}' not available. Install with: npm install ${moduleName}`);
	}
}

export interface ChatBedrockOptions {
	/** Model ID (e.g., 'anthropic.claude-3-5-sonnet-20240620-v1:0') */
	model: string;
	/** AWS region */
	region?: string;
	/** Temperature for generation */
	temperature?: number;
	/** Max tokens to generate */
	maxTokens?: number;
	/** Top-p sampling */
	topP?: number;
	/** Stop sequences */
	stopSequences?: string[];
	/** AWS access key ID (optional, can use environment variables) */
	accessKeyId?: string;
	/** AWS secret access key (optional, can use environment variables) */
	secretAccessKey?: string;
	/** AWS session token for temporary credentials */
	sessionToken?: string;
}

interface BedrockMessage {
	role: 'user' | 'assistant';
	content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>;
}

export class ChatBedrock implements BaseChatModel {
	model: string;
	private region: string;
	private temperature: number | undefined;
	private maxTokens: number;
	private topP: number | undefined;
	private stopSequences: string[] | undefined;
	private accessKeyId: string | undefined;
	private secretAccessKey: string | undefined;
	private sessionToken: string | undefined;
	private client: any = null;

	constructor(options: ChatBedrockOptions) {
		this.model = options.model || 'anthropic.claude-3-5-sonnet-20240620-v1:0';
		this.region = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
		this.temperature = options.temperature;
		// Don't set default - let backend handle token limits
		this.maxTokens = options.maxTokens as number;
		this.topP = options.topP;
		this.stopSequences = options.stopSequences;
		this.accessKeyId = options.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
		this.secretAccessKey = options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
		this.sessionToken = options.sessionToken || process.env.AWS_SESSION_TOKEN;
	}

	get provider(): string {
		return 'aws_bedrock';
	}

	get name(): string {
		return this.model;
	}

	/**
	 * Get the AWS Bedrock client
	 */
	private async getClient(): Promise<any> {
		if (this.client) return this.client;

		try {
			// Dynamically import AWS SDK
			const awsModule = await dynamicImport('@aws-sdk/client-bedrock-runtime');
			const { BedrockRuntimeClient } = awsModule;

			const config: any = {
				region: this.region,
			};

			// Add credentials if provided
			if (this.accessKeyId && this.secretAccessKey) {
				config.credentials = {
					accessKeyId: this.accessKeyId,
					secretAccessKey: this.secretAccessKey,
					sessionToken: this.sessionToken,
				};
			}

			this.client = new BedrockRuntimeClient(config);
			return this.client;
		} catch (error: any) {
			throw new ModelProviderError({
				message: `@aws-sdk/client-bedrock-runtime not installed. Please install using: npm install @aws-sdk/client-bedrock-runtime. Error: ${error.message}`,
				statusCode: 500,
				model: this.model,
			});
		}
	}

	/**
	 * Serialize messages to Bedrock format
	 */
	private serializeMessages(messages: BaseMessage[]): { messages: BedrockMessage[]; system?: Array<{ type: 'text'; text: string }> } {
		const bedrockMessages: BedrockMessage[] = [];
		let systemContent: string[] = [];

		for (const message of messages) {
			if (message.role === 'system') {
				// Collect system messages
				if (typeof message.content === 'string') {
					systemContent.push(message.content);
				} else if (Array.isArray(message.content)) {
					for (const part of message.content) {
						if (typeof part === 'string') {
							systemContent.push(part);
						} else if (part.type === 'text') {
							systemContent.push(part.text);
						}
					}
				}
			} else if (message.role === 'user' || message.role === 'assistant') {
				const content: BedrockMessage['content'] = [];

				if (typeof message.content === 'string') {
					content.push({ type: 'text', text: message.content });
				} else if (Array.isArray(message.content)) {
					for (const part of message.content) {
						if (typeof part === 'string') {
							content.push({ type: 'text', text: part });
						} else if (part.type === 'text') {
							content.push({ type: 'text', text: part.text });
						} else if (part.type === 'image_url' && part.imageUrl) {
							// Handle image content
							const url = part.imageUrl.url;
							if (url.startsWith('data:')) {
								// Parse base64 data URL
								const matches = url.match(/^data:([^;]+);base64,(.+)$/);
								if (matches) {
									content.push({
										type: 'image',
										source: {
											type: 'base64',
											media_type: matches[1],
											data: matches[2],
										},
									});
								}
							}
						}
					}
				}

				if (content.length > 0) {
					bedrockMessages.push({
						role: message.role as 'user' | 'assistant',
						content,
					});
				}
			}
		}

		const result: { messages: BedrockMessage[]; system?: Array<{ type: 'text'; text: string }> } = {
			messages: bedrockMessages,
		};

		if (systemContent.length > 0) {
			result.system = [{ type: 'text', text: systemContent.join('\n\n') }];
		}

		return result;
	}

	/**
	 * Get inference configuration
	 */
	private getInferenceConfig(): Record<string, any> {
		const config: Record<string, any> = {};

		if (this.maxTokens !== undefined) {
			config.maxTokens = this.maxTokens;
		}
		if (this.temperature !== undefined) {
			config.temperature = this.temperature;
		}
		if (this.topP !== undefined) {
			config.topP = this.topP;
		}
		if (this.stopSequences !== undefined) {
			config.stopSequences = this.stopSequences;
		}

		return config;
	}

	/**
	 * Extract usage from response
	 */
	private extractUsage(response: any): ChatInvokeUsage | undefined {
		if (!response.usage) return undefined;

		return {
			promptTokens: response.usage.inputTokens || 0,
			completionTokens: response.usage.outputTokens || 0,
			totalTokens: response.usage.totalTokens || (response.usage.inputTokens || 0) + (response.usage.outputTokens || 0),
		};
	}

	async ainvoke<T extends z.ZodType>(
		messages: BaseMessage[],
		outputFormat?: T
	): Promise<ChatInvokeCompletion<T extends z.ZodType<infer U> ? U : string>> {
		try {
			const client = await this.getClient();
			const awsModule = await dynamicImport('@aws-sdk/client-bedrock-runtime');
			const { ConverseCommand } = awsModule;

			const { messages: bedrockMessages, system } = this.serializeMessages(messages);

			// Build request body
			const body: any = {
				modelId: this.model,
				messages: bedrockMessages,
			};

			if (system) {
				body.system = system;
			}

			const inferenceConfig = this.getInferenceConfig();
			if (Object.keys(inferenceConfig).length > 0) {
				body.inferenceConfig = inferenceConfig;
			}

			// Handle structured output via tool calling
			if (outputFormat) {
				const schema = outputFormat._def;
				// Add tool for structured output
				body.toolConfig = {
					tools: [
						{
							toolSpec: {
								name: 'extract_output',
								description: 'Extract structured output',
								inputSchema: {
									json: {
										type: 'object',
										properties: {},
										required: [],
									},
								},
							},
						},
					],
				};
			}

			// Make the API call
			const command = new ConverseCommand(body);
			const response = await client.send(command);

			const usage = this.extractUsage(response);

			// Extract response content
			if (response.output?.message?.content) {
				const content = response.output.message.content;

				if (!outputFormat) {
					// Return text response
					const textParts: string[] = [];
					for (const item of content) {
						if (item.text) {
							textParts.push(item.text);
						}
					}
					const responseText = textParts.join('\n');
					return {
						completion: responseText as any,
						usage,
					};
				} else {
					// Handle structured output from tool calls
					for (const item of content) {
						if (item.toolUse) {
							const toolInput = item.toolUse.input;
							try {
								const parsed = outputFormat.parse(toolInput);
								return {
									completion: parsed,
									usage,
								};
							} catch (e) {
								// Try JSON parse if it's a string
								if (typeof toolInput === 'string') {
									try {
										const data = JSON.parse(toolInput);
										const parsed = outputFormat.parse(data);
										return {
											completion: parsed,
											usage,
										};
									} catch {
										// Fall through
									}
								}
								throw new ModelProviderError({
									message: `Failed to parse structured output: ${e}`,
									statusCode: 500,
									model: this.model,
								});
							}
						}
					}

					// If no tool use found, try to parse text as JSON
					const textParts: string[] = [];
					for (const item of content) {
						if (item.text) {
							textParts.push(item.text);
						}
					}
					const responseText = textParts.join('\n');

					try {
						// Try to extract JSON from response
						let jsonText = responseText.trim();
						if (jsonText.startsWith('```json')) {
							jsonText = jsonText.slice(7);
						}
						if (jsonText.startsWith('```')) {
							jsonText = jsonText.slice(3);
						}
						if (jsonText.endsWith('```')) {
							jsonText = jsonText.slice(0, -3);
						}
						jsonText = jsonText.trim();

						const startIdx = jsonText.indexOf('{');
						const endIdx = jsonText.lastIndexOf('}');
						if (startIdx !== -1 && endIdx !== -1) {
							jsonText = jsonText.slice(startIdx, endIdx + 1);
						}

						const data = JSON.parse(jsonText);
						const parsed = outputFormat.parse(data);
						return {
							completion: parsed,
							usage,
						};
					} catch {
						throw new ModelProviderError({
							message: 'Expected structured output but could not parse response',
							statusCode: 500,
							model: this.model,
						});
					}
				}
			}

			// No valid content found
			return {
				completion: '' as any,
				usage,
			};
		} catch (error: any) {
			// Handle AWS-specific errors
			if (error.name === 'ThrottlingException' || error.name === 'TooManyRequestsException') {
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
				statusCode: error.$metadata?.httpStatusCode || 500,
				model: this.model,
			});
		}
	}
}

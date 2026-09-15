/**
 * OCI Raw API chat model
 * Port from browser_use/llm/oci_raw/chat.py
 */
import { BaseChatModel } from '../base.js';
import { BaseMessage, SystemMessage } from '../messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { ModelProviderError, ModelRateLimitError } from '../exceptions.js';
import { z } from 'zod';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ChatOCIRawOptions {
	/** OCI GenAI model OCID */
	modelId: string;
	/** OCI service endpoint URL */
	serviceEndpoint: string;
	/** OCI compartment OCID */
	compartmentId: string;
	/** Model provider (e.g., 'meta', 'cohere', 'xai') */
	provider?: string;
	/** Temperature for generation */
	temperature?: number;
	/** Max tokens to generate */
	maxTokens?: number;
	/** Frequency penalty */
	frequencyPenalty?: number;
	/** Presence penalty */
	presencePenalty?: number;
	/** Top-p sampling */
	topP?: number;
	/** Top-k sampling */
	topK?: number;
	/** Auth type: 'API_KEY', 'INSTANCE_PRINCIPAL', 'RESOURCE_PRINCIPAL' */
	authType?: string;
	/** Auth profile name */
	authProfile?: string;
	/** Request timeout in seconds */
	timeout?: number;
}

interface OCIMessage {
	role: 'system' | 'user' | 'assistant';
	content: Array<{ type: 'TEXT'; text: string }>;
}

export class ChatOCIRaw implements BaseChatModel {
	model: string;
	private modelId: string;
	private serviceEndpoint: string;
	private compartmentId: string;
	private modelProvider: string;
	private temperature: number;
	private maxTokens: number;
	private frequencyPenalty: number;
	private presencePenalty: number;
	private topP: number;
	private topK: number;
	private authType: string;
	private authProfile: string;
	private timeout: number;
	private ociConfig: any = null;

	constructor(options: ChatOCIRawOptions) {
		this.modelId = options.modelId;
		this.model = options.modelId;
		this.serviceEndpoint = options.serviceEndpoint;
		this.compartmentId = options.compartmentId;
		this.modelProvider = options.provider || 'meta';
		this.temperature = options.temperature ?? 1.0;
		this.maxTokens = options.maxTokens ?? 600;
		this.frequencyPenalty = options.frequencyPenalty ?? 0.0;
		this.presencePenalty = options.presencePenalty ?? 0.0;
		this.topP = options.topP ?? 0.75;
		this.topK = options.topK ?? 0;
		this.authType = options.authType || 'API_KEY';
		this.authProfile = options.authProfile || 'DEFAULT';
		this.timeout = options.timeout ?? 60;
	}

	get provider(): string {
		return 'oci-raw';
	}

	get name(): string {
		// Return a shorter name for display
		if (this.modelId.length > 90) {
			const parts = this.modelId.split('.');
			if (parts.length >= 4) {
				return `oci-${this.modelProvider}-${parts[3]}`;
			}
			return `oci-${this.modelProvider}-model`;
		}
		return this.modelId;
	}

	/**
	 * Check if provider uses Cohere format
	 */
	private useCohereFormat(): boolean {
		return this.modelProvider.toLowerCase() === 'cohere';
	}

	/**
	 * Get OCI config from ~/.oci/config
	 */
	private getOCIConfig(): any {
		if (this.ociConfig) return this.ociConfig;

		const configPath = path.join(os.homedir(), '.oci', 'config');
		if (!fs.existsSync(configPath)) {
			throw new ModelProviderError({
				message: `OCI config file not found at ${configPath}`,
				statusCode: 500,
				model: this.model,
			});
		}

		const content = fs.readFileSync(configPath, 'utf-8');
		const lines = content.split('\n');
		const config: any = {};
		let currentProfile = '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
				currentProfile = trimmed.slice(1, -1);
				config[currentProfile] = {};
			} else if (trimmed && trimmed.includes('=') && currentProfile) {
				const [key, ...valueParts] = trimmed.split('=');
				config[currentProfile][key.trim()] = valueParts.join('=').trim();
			}
		}

		this.ociConfig = config[this.authProfile];
		if (!this.ociConfig) {
			throw new ModelProviderError({
				message: `OCI profile '${this.authProfile}' not found in config`,
				statusCode: 500,
				model: this.model,
			});
		}

		return this.ociConfig;
	}

	/**
	 * Serialize messages to OCI format
	 */
	private serializeMessages(messages: BaseMessage[]): OCIMessage[] {
		const ociMessages: OCIMessage[] = [];

		for (const message of messages) {
			const content: Array<{ type: 'TEXT'; text: string }> = [];

			if (typeof message.content === 'string') {
				content.push({ type: 'TEXT', text: message.content });
			} else if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (typeof part === 'string') {
						content.push({ type: 'TEXT', text: part });
					} else if (part.type === 'text') {
						content.push({ type: 'TEXT', text: part.text });
					}
				}
			}

			if (content.length > 0) {
				ociMessages.push({
					role: message.role as 'system' | 'user' | 'assistant',
					content,
				});
			}
		}

		return ociMessages;
	}

	/**
	 * Serialize messages for Cohere format
	 */
	private serializeMessagesForCohere(messages: BaseMessage[]): string {
		const parts: string[] = [];

		for (const message of messages) {
			let text: string;
			if (typeof message.content === 'string') {
				text = message.content;
			} else if (Array.isArray(message.content)) {
				text = message.content
					.map((p) => (typeof p === 'string' ? p : (p as any).text || ''))
					.join('\n');
			} else {
				text = String(message.content);
			}

			if (message.role === 'system') {
				parts.push(`System: ${text}`);
			} else if (message.role === 'user') {
				parts.push(`User: ${text}`);
			} else if (message.role === 'assistant') {
				parts.push(`Assistant: ${text}`);
			}
		}

		return parts.join('\n\n');
	}

	/**
	 * Sign request for OCI API Key authentication
	 */
	private signRequest(method: string, targetPath: string, body: string, host: string): Record<string, string> {
		const config = this.getOCIConfig();
		const tenancy = config.tenancy;
		const user = config.user;
		const fingerprint = config.fingerprint;
		const keyFile = config.key_file.replace('~', os.homedir());

		// Read private key
		const privateKeyContent = fs.readFileSync(keyFile, 'utf-8');

		// Generate date
		const now = new Date();
		const dateStr = now.toUTCString();

		// Create signing string
		const requestTarget = `${method.toLowerCase()} ${targetPath}`;
		const contentSha256 = crypto.createHash('sha256').update(body).digest('base64');
		const contentLength = Buffer.byteLength(body);

		const signingString = [
			`date: ${dateStr}`,
			`(request-target): ${requestTarget}`,
			`host: ${host}`,
			`content-length: ${contentLength}`,
			`content-type: application/json`,
			`x-content-sha256: ${contentSha256}`,
		].join('\n');

		// Sign
		const sign = crypto.createSign('RSA-SHA256');
		sign.update(signingString);
		const signature = sign.sign(privateKeyContent, 'base64');

		// Build authorization header
		const keyId = `${tenancy}/${user}/${fingerprint}`;
		const authHeader = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="date (request-target) host content-length content-type x-content-sha256",signature="${signature}"`;

		return {
			'date': dateStr,
			'content-type': 'application/json',
			'content-length': String(contentLength),
			'x-content-sha256': contentSha256,
			'authorization': authHeader,
		};
	}

	/**
	 * Make request to OCI API
	 */
	private async makeRequest(messages: BaseMessage[]): Promise<any> {
		// Build request body
		let chatRequest: any;

		if (this.useCohereFormat()) {
			const messageText = this.serializeMessagesForCohere(messages);
			chatRequest = {
				apiFormat: 'COHERE',
				message: messageText,
				maxTokens: this.maxTokens,
				temperature: this.temperature,
				frequencyPenalty: this.frequencyPenalty,
				topP: this.topP,
				topK: this.topK,
			};
		} else {
			const ociMessages = this.serializeMessages(messages);
			chatRequest = {
				apiFormat: 'GENERIC',
				messages: ociMessages,
				maxTokens: this.maxTokens,
				temperature: this.temperature,
				topP: this.topP,
			};

			// Provider-specific parameters
			if (this.modelProvider.toLowerCase() === 'meta') {
				chatRequest.frequencyPenalty = this.frequencyPenalty;
				chatRequest.presencePenalty = this.presencePenalty;
			} else if (this.modelProvider.toLowerCase() === 'xai') {
				chatRequest.topK = this.topK;
			}
		}

		const body = JSON.stringify({
			servingMode: {
				servingType: 'ON_DEMAND',
				modelId: this.modelId,
			},
			chatRequest,
			compartmentId: this.compartmentId,
		});

		// Parse endpoint URL
		const url = new URL(`${this.serviceEndpoint}/20231130/actions/chat`);
		const host = url.hostname;
		const targetPath = url.pathname;

		// Sign request
		const headers = this.signRequest('POST', targetPath, body, host);

		return new Promise((resolve, reject) => {
			const options = {
				hostname: host,
				port: 443,
				path: targetPath,
				method: 'POST',
				headers,
				timeout: this.timeout * 1000,
			};

			const req = https.request(options, (res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					if (res.statusCode === 429) {
						reject(
							new ModelRateLimitError({
								message: 'Rate limit exceeded',
								model: this.model,
							})
						);
						return;
					}

					if (res.statusCode !== 200) {
						reject(
							new ModelProviderError({
								message: `OCI API error: ${res.statusCode} - ${data}`,
								statusCode: res.statusCode || 500,
								model: this.model,
							})
						);
						return;
					}

					try {
						resolve(JSON.parse(data));
					} catch (e) {
						reject(
							new ModelProviderError({
								message: `Failed to parse OCI response: ${e}`,
								statusCode: 500,
								model: this.model,
							})
						);
					}
				});
			});

			req.on('error', (e) => {
				reject(
					new ModelProviderError({
						message: `OCI request failed: ${e.message}`,
						statusCode: 500,
						model: this.model,
					})
				);
			});

			req.on('timeout', () => {
				req.destroy();
				reject(
					new ModelProviderError({
						message: `OCI request timed out after ${this.timeout}s`,
						statusCode: 408,
						model: this.model,
					})
				);
			});

			req.write(body);
			req.end();
		});
	}

	/**
	 * Extract usage from response
	 */
	private extractUsage(response: any): ChatInvokeUsage | undefined {
		try {
			const chatResponse = response.chatResponse;
			if (chatResponse?.usage) {
				return {
					promptTokens: chatResponse.usage.promptTokens || 0,
					completionTokens: chatResponse.usage.completionTokens || 0,
					totalTokens: chatResponse.usage.totalTokens || 0,
				};
			}
		} catch {
			// Ignore errors
		}
		return undefined;
	}

	/**
	 * Extract content from response
	 */
	private extractContent(response: any): string {
		try {
			const chatResponse = response.chatResponse;

			// Handle Cohere response format
			if (chatResponse.text) {
				return chatResponse.text;
			}

			// Handle Generic response format
			if (chatResponse.choices && chatResponse.choices.length > 0) {
				const message = chatResponse.choices[0].message;
				if (message.content && message.content.length > 0) {
					return message.content
						.map((p: any) => p.text || '')
						.join('\n');
				}
			}

			throw new ModelProviderError({
				message: 'Unsupported OCI response format',
				statusCode: 500,
				model: this.model,
			});
		} catch (e) {
			if (e instanceof ModelProviderError) throw e;
			throw new ModelProviderError({
				message: `Failed to extract content from OCI response: ${e}`,
				statusCode: 500,
				model: this.model,
			});
		}
	}

	async ainvoke<T extends z.ZodType>(
		messages: BaseMessage[],
		outputFormat?: T
	): Promise<ChatInvokeCompletion<T extends z.ZodType<infer U> ? U : string>> {
		try {
			if (!outputFormat) {
				// Return string response
				const response = await this.makeRequest(messages);
				const content = this.extractContent(response);
				const usage = this.extractUsage(response);

				return {
					completion: content as any,
					usage,
				};
			} else {
				// For structured output, add JSON schema instructions
				const schemaInstruction = `
You must respond with ONLY a valid JSON object.

IMPORTANT:
- Your response must be ONLY the JSON object, no additional text
- The JSON must be valid and parseable
- Use proper JSON syntax with double quotes
`;

				// Clone messages and add system instruction
				const modifiedMessages = [...messages];

				if (modifiedMessages.length > 0 && modifiedMessages[0].role === 'system') {
					// Modify existing system message
					const existing = modifiedMessages[0].content;
					modifiedMessages[0] = {
						role: 'system',
						content:
							(typeof existing === 'string' ? existing : JSON.stringify(existing)) +
							'\n\n' +
							schemaInstruction,
					};
				} else {
					// Insert new system message
					modifiedMessages.unshift({
						role: 'system',
						content: schemaInstruction,
					});
				}

				const response = await this.makeRequest(modifiedMessages);
				const responseText = this.extractContent(response);
				const usage = this.extractUsage(response);

				// Clean and parse JSON
				try {
					let jsonText = responseText.trim();

					// Remove markdown code blocks
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

					// Find JSON object
					if (!jsonText.startsWith('{')) {
						const startIdx = jsonText.indexOf('{');
						const endIdx = jsonText.lastIndexOf('}');
						if (startIdx !== -1 && endIdx !== -1) {
							jsonText = jsonText.slice(startIdx, endIdx + 1);
						}
					}

					const data = JSON.parse(jsonText);
					const parsed = outputFormat.parse(data);

					return {
						completion: parsed,
						usage,
					};
				} catch (e) {
					throw new ModelProviderError({
						message: `Failed to parse structured output: ${e}. Response was: ${responseText.slice(0, 200)}...`,
						statusCode: 500,
						model: this.model,
					});
				}
			}
		} catch (e) {
			if (e instanceof ModelRateLimitError || e instanceof ModelProviderError) {
				throw e;
			}
			throw new ModelProviderError({
				message: `Unexpected error: ${e}`,
				statusCode: 500,
				model: this.model,
			});
		}
	}
}

/**
 * Ollama chat model (local LLM)
 * Port from browser_use/llm/ollama/chat.py (102 lines)
 */
import { Ollama } from 'ollama';
import { z } from 'zod';
import { BaseChatModel } from '../base.js';
import { BaseMessage } from '../messages.js';
import { ChatInvokeCompletion } from '../views.js';
import { ModelProviderError } from '../exceptions.js';
import { OllamaMessageSerializer } from './serializer.js';

export interface ChatOllamaOptions {
	model: string;
	host?: string;
	timeout?: number;
	clientParams?: Record<string, any>;
	ollamaOptions?: Record<string, any>;
}

export class ChatOllama implements BaseChatModel {
	model: string;
	private host?: string;
	private timeout?: number;
	private clientParams?: Record<string, any>;
	private ollamaOptions?: Record<string, any>;

	constructor(options: ChatOllamaOptions) {
		this.model = options.model;
		this.host = options.host;
		this.timeout = options.timeout;
		this.clientParams = options.clientParams;
		this.ollamaOptions = options.ollamaOptions;
	}

	get provider(): string {
		return 'ollama';
	}

	get name(): string {
		return this.model;
	}

	private client?: Ollama;

	private getClient(): Ollama {
		// Memoize the client so we don't rebuild it on every step.
		if (!this.client) {
			this.client = new Ollama({
				host: this.host,
				...this.clientParams,
			});
		}
		return this.client;
	}

	async ainvoke<T extends z.ZodType>(
		messages: BaseMessage[],
		outputFormat?: T
	): Promise<ChatInvokeCompletion<T extends z.ZodType ? z.infer<T> : string>> {
		const ollamaMessages = OllamaMessageSerializer.serializeMessages(messages);

		try {
			if (!outputFormat) {
				const response = await this.getClient().chat({
					model: this.model,
					messages: ollamaMessages,
					options: this.ollamaOptions,
				});

				return {
					completion: response.message.content || '',
					usage: null, // Ollama doesn't provide token usage
				} as any;
			} else {
				// Use JSON schema for structured output
				const schema = outputFormat._def as any;

				const response = await this.getClient().chat({
					model: this.model,
					messages: ollamaMessages,
					format: schema,
					options: this.ollamaOptions,
				});

				const content = response.message.content || '';
				const parsed = outputFormat.parse(JSON.parse(content));

				return {
					completion: parsed,
					usage: null, // Ollama doesn't provide token usage
				} as any;
			}
		} catch (error: any) {
			throw new ModelProviderError({
				message: error.message || 'Ollama request failed',
				model: this.name,
			});
		}
	}
}

/**
 * ChatBrowserUse - Client for browser-use cloud API
 * Port from browser_use/llm/browser_use/chat.py (synced with 0.13.10)
 *
 * This wraps the BaseChatModel protocol and sends requests to the browser-use cloud API
 * for optimized browser automation LLM inference.
 */

import { z } from 'zod';
import { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { BaseMessage } from '../messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { ModelProviderError, ModelRateLimitError } from '../exceptions.js';
import { getConfig } from '../../config.js';
import { getLogger } from '../../logging_config.js';

const logger = getLogger('browser-use.llm.browser_use');

/** HTTP status codes that should trigger a retry */
export const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** `bu-*` aliases accepted next to provider-prefixed ids */
export const BU_MODEL_ALIASES = ['bu-latest', 'bu-1-0', 'bu-2-0', 'bu-2-0-mini-preview', 'bu-qa-1'];

const NEW_KEY_URL = 'https://cloud.browser-use.com/new-api-key?utm_source=oss&utm_medium=chat_browser_use';
const BILLING_URL = 'https://cloud.browser-use.com/billing?utm_source=oss&utm_medium=chat_browser_use';

export interface ChatBrowserUseOptions {
	/**
	 * Model name to use:
	 * - 'bu-2-0' or 'bu-latest': default model (premium)
	 * - 'bu-2-0-mini-preview': cheaper and faster per token, opt-in while in preview
	 * - 'bu-1-0': previous generation model, redirected to bu-2-0 at the gateway
	 * - 'bu-qa-1': website QA model
	 * - provider-prefixed ids resolved by the gateway, e.g. 'anthropic/claude-sonnet-4-6', 'openai/gpt-5.5'
	 */
	model?: string;
	/** API key for browser-use cloud (default: BROWSER_USE_API_KEY) */
	apiKey?: string;
	/** Base URL for the API (default: BROWSER_USE_LLM_URL or production URL) */
	baseURL?: string;
	/** Request timeout in milliseconds (default 120s) */
	timeout?: number;
	/** Use fast mode */
	fast?: boolean;
	/** Maximum number of attempts for transient errors (default 5) */
	maxRetries?: number;
	/** Base delay in milliseconds for exponential backoff (default 1s) */
	retryBaseDelay?: number;
	/** Maximum delay in milliseconds between retries (default 60s) */
	retryMaxDelay?: number;
}

class HttpStatusError extends Error {
	constructor(
		public readonly status: number,
		public readonly detail: string
	) {
		super(`HTTP ${status}: ${detail}`);
		this.name = 'HttpStatusError';
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Client for browser-use cloud API.
 *
 * This sends requests to the browser-use cloud API which uses optimized models
 * and prompts for browser automation tasks.
 *
 * @example
 * const agent = new Agent({
 *   task: "Find the number of stars of the browser-use repo",
 *   llm: new ChatBrowserUse({ model: 'openai/gpt-5.5' }),
 * });
 */
export class ChatBrowserUse implements BaseChatModel {
	model: string;
	private apiKey: string;
	private baseURL: string;
	private timeout: number;
	private fast: boolean;
	private maxRetries: number;
	private retryBaseDelay: number;
	private retryMaxDelay: number;

	constructor(options: ChatBrowserUseOptions = {}) {
		const inputModel = options.model || 'bu-2-0';

		// Accept 'bu-*' aliases and any provider-prefixed id; the gateway resolves the
		// latter (anthropic/*, openai/*, google/*, browser-use/*), so we don't enumerate them.
		const isValid = BU_MODEL_ALIASES.includes(inputModel) || inputModel.includes('/');
		if (!isValid) {
			throw new Error(
				`Invalid model: '${inputModel}'. Use a 'bu-*' alias (${BU_MODEL_ALIASES.join(', ')}) ` +
					"or a provider-prefixed id like 'anthropic/claude-sonnet-4-6', 'openai/gpt-5.5', or 'google/gemini-3-pro'."
			);
		}

		// Normalize bu-latest to the current latest model, which is also the default: a
		// preview model is opt-in, never something a caller lands on by omission.
		this.model = inputModel === 'bu-latest' ? 'bu-2-0' : inputModel;
		this.fast = options.fast ?? false;
		this.apiKey = options.apiKey || process.env.BROWSER_USE_API_KEY || '';
		this.baseURL = options.baseURL || process.env.BROWSER_USE_LLM_URL || 'https://llm.api.browser-use.com';
		this.timeout = options.timeout ?? 120000;
		this.maxRetries = options.maxRetries ?? 5;
		this.retryBaseDelay = options.retryBaseDelay ?? 1000;
		this.retryMaxDelay = options.retryMaxDelay ?? 60000;

		if (!this.apiKey) {
			throw new Error(`BROWSER_USE_API_KEY is not set. To use ChatBrowserUse, get a key at:\n${NEW_KEY_URL}`);
		}
	}

	get provider(): string {
		return 'browser-use';
	}

	get name(): string {
		return this.model;
	}

	private retryDelay(attempt: number): number {
		const delay = Math.min(this.retryBaseDelay * 2 ** attempt, this.retryMaxDelay);
		const jitter = Math.random() * delay * 0.1;
		return delay + jitter;
	}

	/**
	 * Send request to browser-use cloud API, retrying transient failures with exponential backoff.
	 *
	 * @param options.requestType - 'browser_agent' (default) or 'judge'
	 * @param options.sessionId - session id for sticky routing (same session -> same container)
	 */
	async ainvoke<T = string>(
		messages: BaseMessage[],
		outputFormat?: z.ZodType<T>,
		options: ChatInvokeOptions = {}
	): Promise<ChatInvokeCompletion<T>> {
		const requestType = (options.requestType as string | undefined) ?? 'browser_agent';
		const sessionId = options.sessionId as string | undefined;

		// Prepare request payload
		const payload: Record<string, any> = {
			model: this.model,
			messages: messages.map((msg) => this.serializeMessage(msg)),
			fast: this.fast,
			request_type: requestType,
			anonymized_telemetry: getConfig().ANONYMIZED_TELEMETRY,
		};

		// Add session_id for sticky routing if provided
		if (sessionId) {
			payload.session_id = sessionId;
		}

		// Add output format schema if provided
		if (outputFormat) {
			const { zodToJsonSchema } = await import('zod-to-json-schema');
			payload.output_format = zodToJsonSchema(outputFormat);
		}

		let result: any = null;
		let lastError: unknown = null;

		for (let attempt = 0; attempt < this.maxRetries; attempt++) {
			try {
				result = await this.makeRequest(payload, options.signal);
				lastError = null;
				break;
			} catch (error: any) {
				lastError = error;

				if (error instanceof HttpStatusError) {
					if (RETRYABLE_STATUS_CODES.has(error.status) && attempt < this.maxRetries - 1) {
						const delay = this.retryDelay(attempt);
						logger.warn(
							`Got ${error.status} error, retrying in ${(delay / 1000).toFixed(1)}s... (attempt ${attempt + 1}/${this.maxRetries})`
						);
						await sleep(delay);
						continue;
					}
					// Non-retryable HTTP error or exhausted retries
					this.raiseHttpError(error);
				}

				const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
				const isConnection = error?.name === 'TypeError' || error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND';
				if (isTimeout || isConnection) {
					// Network errors are retryable
					if (attempt < this.maxRetries - 1) {
						const delay = this.retryDelay(attempt);
						logger.warn(
							`Got ${isTimeout ? 'timeout' : 'connection error'}, retrying in ${(delay / 1000).toFixed(1)}s... (attempt ${attempt + 1}/${this.maxRetries})`
						);
						await sleep(delay);
						continue;
					}
					if (isTimeout) {
						throw new ModelProviderError({
							message: `Request timed out after ${this.timeout}ms (retried ${this.maxRetries} times)`,
							statusCode: 408,
							model: this.name,
						});
					}
					throw new ModelProviderError({
						message: `Failed to connect to browser-use API after ${this.maxRetries} attempts: ${error?.message ?? error}`,
						statusCode: 503,
						model: this.name,
					});
				}

				throw new ModelProviderError({
					message: `Failed to connect to browser-use API: ${error?.message ?? error}`,
					statusCode: 503,
					model: this.name,
				});
			}
		}

		if (result === null) {
			if (lastError instanceof HttpStatusError) {
				this.raiseHttpError(lastError);
			}
			throw new ModelProviderError({
				message: `Request failed after ${this.maxRetries} attempts: ${(lastError as any)?.message ?? lastError}`,
				statusCode: 503,
				model: this.name,
			});
		}

		// Parse response - server returns structured data as dict
		let completion: any;
		if (outputFormat) {
			const completionData = result.completion;
			logger.debug(
				`Got structured data from service: ${
					completionData && typeof completionData === 'object'
						? Object.keys(completionData).join(',')
						: typeof completionData
				}`
			);
			// Parse with Zod schema
			completion = outputFormat.parse(completionData);
		} else {
			completion = result.completion;
		}

		// Parse usage info
		let usage: ChatInvokeUsage | undefined;
		const rawUsage = result.usage;
		if (rawUsage) {
			usage = {
				promptTokens: rawUsage.prompt_tokens ?? rawUsage.promptTokens ?? 0,
				completionTokens: rawUsage.completion_tokens ?? rawUsage.completionTokens ?? 0,
				totalTokens: rawUsage.total_tokens ?? rawUsage.totalTokens ?? 0,
				promptCachedTokens: rawUsage.prompt_cached_tokens ?? rawUsage.promptCachedTokens ?? null,
				promptCacheCreationTokens:
					rawUsage.prompt_cache_creation_tokens ?? rawUsage.promptCacheCreationTokens ?? null,
				promptCacheCreation5mTokens: rawUsage.prompt_cache_creation_5m_tokens ?? null,
				promptCacheCreation1hTokens: rawUsage.prompt_cache_creation_1h_tokens ?? null,
				promptImageTokens: rawUsage.prompt_image_tokens ?? null,
				pricingMultiplier: rawUsage.pricing_multiplier ?? null,
			};
		}

		return {
			completion,
			usage,
			stopReason: result.stop_reason ?? null,
		} as ChatInvokeCompletion<T>;
	}

	/**
	 * Make a single API request. Throws HttpStatusError for non-2xx responses.
	 */
	private async makeRequest(payload: Record<string, any>, signal?: AbortSignal): Promise<any> {
		const signals = [AbortSignal.timeout(this.timeout)];
		if (signal) {
			signals.push(signal);
		}
		const response = await fetch(`${this.baseURL}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
			signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
		});

		if (!response.ok) {
			let detail = '';
			try {
				const errorData = await response.json();
				detail = errorData?.detail ?? response.statusText;
			} catch {
				detail = response.statusText;
			}
			throw new HttpStatusError(response.status, String(detail));
		}

		return response.json();
	}

	/**
	 * Raise the appropriate ModelProviderError for an HTTP error.
	 */
	private raiseHttpError(error: HttpStatusError): never {
		const detail = error.detail;
		const status = error.status;

		if (status === 401) {
			throw new ModelProviderError({
				message: `BROWSER_USE_API_KEY is invalid. Get a new key at:\n${NEW_KEY_URL}\n${detail}`,
				statusCode: 401,
				model: this.name,
			});
		}
		if (status === 402) {
			throw new ModelProviderError({
				message: `Browser Use credits exhausted. Add more at:\n${BILLING_URL}\n${detail}`,
				statusCode: 402,
				model: this.name,
			});
		}
		if (status === 429) {
			throw new ModelRateLimitError({ message: `Rate limit exceeded. ${detail}`, model: this.name });
		}
		if (status === 500 || status === 502 || status === 503 || status === 504) {
			throw new ModelProviderError({ message: `Server error. ${detail}`, statusCode: status, model: this.name });
		}
		throw new ModelProviderError({ message: `API request failed: ${detail}`, statusCode: status, model: this.name });
	}

	/**
	 * Serialize a message to JSON format.
	 */
	private serializeMessage(message: BaseMessage): Record<string, any> {
		return {
			role: message.role,
			content: message.content,
			...((message as any).name && { name: (message as any).name }),
			...((message as any).toolCalls && { tool_calls: (message as any).toolCalls }),
		};
	}
}

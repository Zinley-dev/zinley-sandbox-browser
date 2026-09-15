/**
 * Anthropic chat model implementation
 * Port from browser_use/llm/anthropic/chat.py (synced with 0.13.10), keeping the
 * Orion prompt-caching layout (see ./anthropic/promptCaching.ts).
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { BaseChatModel, ChatInvokeOptions } from './base.js';
import { BaseMessage } from './messages.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from './views.js';
import { ModelOutputTruncatedError, ModelProviderError, ModelRateLimitError } from './exceptions.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
	applyAnthropicCacheControl,
	type CacheStrategy,
	type CacheTtl,
} from './anthropic/promptCaching.js';

export interface ChatAnthropicOptions {
	/** Model identifier (e.g., 'claude-sonnet-4-6') */
	model: string;

	/** Maximum tokens to generate */
	maxTokens?: number;

	/** Temperature for sampling (0-1) */
	temperature?: number;

	/** Top-p sampling */
	topP?: number;

	/** Random seed for deterministic outputs */
	seed?: number;

	/**
	 * Extended thinking configuration, e.g. `{ type: 'enabled', budget_tokens: 4096 }`
	 * or `{ type: 'adaptive', display: 'summarized' }` for Fable/Mythos 5.
	 */
	thinking?: Record<string, any> | null;

	/** Beta feature flags sent via the `anthropic-beta` header */
	betas?: string[] | null;

	/**
	 * Server-side fallback models, e.g. `[{ model: 'claude-opus-4-8' }]`. Enables the
	 * `server-side-fallback-2026-06-01` beta automatically.
	 */
	fallbacks?: Record<string, any>[] | null;

	/** Inference region, e.g. 'us' (US-only inference bills at a 1.1x multiplier) */
	inferenceGeo?: string | null;

	/** Provider `output_config` passthrough */
	outputConfig?: Record<string, any> | null;

	/** Anthropic API key */
	apiKey?: string;

	/** Auth token (alternative to API key) */
	authToken?: string;

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

	/**
	 * Apply Anthropic prompt caching (`system_and_3` layout). Defaults to true
	 * for Claude models — cache hits are billed at 0.1× input tokens. Set false
	 * to disable (e.g. when routing through a non-caching proxy).
	 */
	cacheControl?: boolean;

	/** Cache TTL when caching is enabled. Defaults to '5m'. */
	cacheTtl?: CacheTtl;

	/**
	 * Breakpoint placement strategy. Defaults to `'system_only'` because the
	 * browser-use agent sends `[system, state]` with the state message rebuilt
	 * every iteration — message-tail BPs just churn cache creation without
	 * ever reading back. Set to `'system_and_3'` for true multi-turn chat.
	 */
	cacheStrategy?: CacheStrategy;
}

/**
 * `<parameter name="x">value</parameter>`, tolerating the mismatched `</x>` closing tag the
 * model sometimes emits instead of `</parameter>`.
 */
const TEXT_TOOL_CALL_PARAMETER = /<parameter name="([^"]+)">([\s\S]*?)(?:<\/parameter>|<\/\1>)/g;

/**
 * Recursively sort object keys so the JSON byte representation is deterministic
 * regardless of insertion order. Arrays preserve element order (semantics);
 * primitives pass through. Used to stabilize the tool input_schema across
 * requests so Anthropic's prefix cache can hit on the tools block.
 */
function _sortObjectKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(_sortObjectKeys);
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>);
		entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const out: Record<string, unknown> = {};
		for (const [k, v] of entries) {
			out[k] = _sortObjectKeys(v);
		}
		return out;
	}
	return value;
}

/**
 * Candidate JSON documents embedded in free text: the whole text, the body of a
 * ``` fence, and the outermost {...} / [...] span. Port of `_json_candidates_from_text`.
 */
export function jsonCandidatesFromText(text: string): string[] {
	const candidates: string[] = [];
	const stripped = text.trim();
	if (stripped) {
		candidates.push(stripped);
	}

	if (stripped.startsWith('```') && stripped.endsWith('```')) {
		const lines = stripped.split(/\r?\n/);
		if (lines.length >= 3) {
			candidates.push(lines.slice(1, -1).join('\n').trim());
		}
	}

	for (const [startChar, endChar] of [
		['{', '}'],
		['[', ']'],
	] as const) {
		const start = stripped.indexOf(startChar);
		const end = stripped.lastIndexOf(endChar);
		if (start !== -1 && end > start) {
			candidates.push(stripped.slice(start, end + 1));
		}
	}

	return Array.from(new Set(candidates.filter((c) => c)));
}

/**
 * Decode fields the model double-serialized as JSON strings. Port of `_repair_serialized_fields`.
 */
export function repairSerializedFields(values: Record<string, any>): Record<string, any> {
	for (const [key, value] of Object.entries(values)) {
		if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
			try {
				values[key] = JSON.parse(value);
			} catch {
				const cleaned = value.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
				try {
					values[key] = JSON.parse(cleaned);
				} catch {
					// leave the original string in place
				}
			}
		}
	}
	return values;
}

/**
 * Parse arguments out of a tool call the model rendered as text. Port of `_tool_call_from_text`.
 */
export function toolCallFromText(text: string): Record<string, any> | null {
	const values: Record<string, any> = {};
	let found = false;
	for (const match of text.matchAll(TEXT_TOOL_CALL_PARAMETER)) {
		values[match[1]] = match[2].trim();
		found = true;
	}
	return found ? repairSerializedFields(values) : null;
}

/**
 * Split Anthropic content blocks into text, thinking and redacted thinking.
 * Port of `_extract_content_blocks`.
 */
export function extractAnthropicContentBlocks(content: any[] | undefined): {
	text: string;
	thinking: string | null;
	redactedThinking: string | null;
} {
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	const redactedParts: string[] = [];

	for (const block of content ?? []) {
		const type = block?.type;
		if (type === 'text') {
			if (block.text) {
				textParts.push(block.text);
			}
		} else if (type === 'thinking') {
			if (block.thinking) {
				thinkingParts.push(block.thinking);
			}
		} else if (type === 'redacted_thinking') {
			const redacted = block.data ?? block.redacted_thinking;
			if (redacted) {
				redactedParts.push(String(redacted));
			}
		}
	}

	let text: string;
	if (textParts.length > 0) {
		text = textParts.join('');
	} else if (content && content.length > 0) {
		text = typeof content[0] === 'string' ? content[0] : JSON.stringify(content[0]);
	} else {
		text = '';
	}

	return {
		text,
		thinking: thinkingParts.length > 0 ? thinkingParts.join('\n') : null,
		redactedThinking: redactedParts.length > 0 ? redactedParts.join('\n') : null,
	};
}

/**
 * Message serializer for Anthropic format
 */
class AnthropicMessageSerializer {
	static serializeMessages(messages: BaseMessage[]): {
		messages: Anthropic.MessageParam[];
		systemPrompt?: string;
	} {
		const systemMessages: string[] = [];
		const anthropicMessages: Anthropic.MessageParam[] = [];

		for (const msg of messages) {
			if (msg.role === 'system') {
				const text = typeof msg.content === 'string'
					? msg.content
					: msg.content.map((p) => p.text).join('\n');
				systemMessages.push(text);
			} else if (msg.role === 'user') {
				if (typeof msg.content === 'string') {
					anthropicMessages.push({
						role: 'user',
						content: msg.content,
					});
				} else {
					// Handle content parts (text + images)
					const parts: any[] = msg.content.map((part) => {
						if (part.type === 'text') {
							return {
								type: 'text',
								text: part.text,
							};
						} else if (part.type === 'image_url') {
							const url = part.imageUrl.url;
							if (url.startsWith('data:')) {
								// Base64 image
								const [header, data] = url.split(',');
								const mediaType = header.split(';')[0].split(':')[1] as
									| 'image/jpeg'
									| 'image/png'
									| 'image/gif'
									| 'image/webp';

								return {
									type: 'image',
									source: {
										type: 'base64',
										media_type: mediaType,
										data,
									},
								};
							} else {
								// URL image - need to fetch and convert to base64
								throw new Error('URL images not yet supported for Anthropic, use base64');
							}
						}
						throw new Error(`Unsupported content part type: ${(part as any).type}`);
					});

					anthropicMessages.push({
						role: 'user',
						content: parts,
					});
				}
			} else if (msg.role === 'assistant') {
				const content = typeof msg.content === 'string'
					? msg.content
					: msg.content
						? msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
						: '';

				anthropicMessages.push({
					role: 'assistant',
					content: content || '',
				});
			}
		}

		return {
			messages: anthropicMessages,
			systemPrompt: systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined,
		};
	}
}

const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-06-01';

export class ChatAnthropic implements BaseChatModel {
	model: string;
	private client: Anthropic;
	private maxTokens: number;
	private temperature?: number;
	private topP?: number;
	private seed?: number;
	private thinking: Record<string, any> | null;
	private betas: string[] | null;
	private fallbacks: Record<string, any>[] | null;
	private inferenceGeo: string | null;
	private outputConfig: Record<string, any> | null;
	private usePromptCaching: boolean;
	private cacheTtl: CacheTtl;
	private cacheStrategy: CacheStrategy;

	constructor(options: ChatAnthropicOptions) {
		this.model = options.model;
		this.maxTokens = options.maxTokens ?? 8192;
		this.temperature = options.temperature;
		this.topP = options.topP;
		this.seed = options.seed;
		this.thinking = options.thinking ?? null;
		this.betas = options.betas ?? null;
		this.fallbacks = options.fallbacks ?? null;
		this.inferenceGeo = options.inferenceGeo ?? null;
		this.outputConfig = options.outputConfig ?? null;
		// Auto-enable for Claude family; caller can override.
		this.usePromptCaching =
			options.cacheControl ?? options.model.toLowerCase().includes('claude');
		this.cacheTtl = options.cacheTtl ?? '5m';
		this.cacheStrategy = options.cacheStrategy ?? 'system_only';

		this.client = new Anthropic({
			apiKey: options.apiKey,
			authToken: options.authToken,
			baseURL: options.baseURL,
			timeout: options.timeout,
			maxRetries: options.maxRetries ?? 10,
			defaultHeaders: options.defaultHeaders,
			...(options.dangerouslyAllowBrowser !== undefined && {
				dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
			}),
		});
	}

	get provider(): string {
		return 'anthropic';
	}

	get name(): string {
		return this.model;
	}

	/** Claude Fable / Mythos 5 only support adaptive thinking. */
	isAdaptiveThinkingOnlyModel(): boolean {
		const model = this.name.toLowerCase();
		return model.includes('claude-fable-5') || model.includes('claude-mythos-5');
	}

	/**
	 * Whether structured output must use `tool_choice: auto` instead of forcing the
	 * tool: forced tool use is rejected for Fable/Mythos 5 and whenever thinking is on.
	 */
	requiresAutoToolChoice(): boolean {
		const model = this.name.toLowerCase();
		if (model.includes('claude-fable-5') || model.includes('claude-mythos-5')) {
			return true;
		}
		if (this.thinking === null) {
			return false;
		}
		return this.thinking.type !== 'disabled';
	}

	private validateThinkingConfig(): void {
		if (!this.thinking || !this.isAdaptiveThinkingOnlyModel()) {
			return;
		}
		const thinkingType = this.thinking.type;
		if (thinkingType === 'enabled' || thinkingType === 'disabled' || 'budget_tokens' in this.thinking) {
			throw new Error(
				`${this.model} only supports adaptive thinking. Omit thinking or use adaptive display options such as ` +
					'{"type": "adaptive", "display": "summarized"}.'
			);
		}
	}

	private getBetasForInvoke(): string[] | null {
		if (this.fallbacks === null) {
			return this.betas;
		}
		const betas = [...(this.betas ?? [])];
		if (!betas.some((beta) => beta.startsWith('server-side-fallback-'))) {
			betas.push(SERVER_SIDE_FALLBACK_BETA);
		}
		return betas;
	}

	private getExtraBodyForInvoke(): Record<string, any> | null {
		const extraBody: Record<string, any> = {};
		if (this.outputConfig !== null) {
			extraBody.output_config = this.outputConfig;
		}
		if (this.fallbacks !== null) {
			extraBody.fallbacks = this.fallbacks;
		}
		if (this.inferenceGeo !== null) {
			extraBody.inference_geo = this.inferenceGeo;
		}
		return Object.keys(extraBody).length > 0 ? extraBody : null;
	}

	private getPricingMultiplier(): number | null {
		return this.inferenceGeo === 'us' ? 1.1 : null;
	}

	private getUsage(response: any): ChatInvokeUsage | null {
		const usage: any = response?.usage;
		if (!usage) {
			return null;
		}
		const cacheCreation = usage.cache_creation ?? null;
		return {
			promptTokens: usage.input_tokens + (usage.cache_read_input_tokens || 0),
			completionTokens: usage.output_tokens,
			totalTokens: usage.input_tokens + usage.output_tokens,
			promptCachedTokens: usage.cache_read_input_tokens ?? null,
			promptCacheCreationTokens: usage.cache_creation_input_tokens ?? null,
			promptCacheCreation5mTokens: cacheCreation?.ephemeral_5m_input_tokens ?? null,
			promptCacheCreation1hTokens: cacheCreation?.ephemeral_1h_input_tokens ?? null,
			promptImageTokens: null,
			pricingMultiplier: this.getPricingMultiplier(),
		};
	}

	private getStopDetails(response: any): Record<string, any> | null {
		const stopDetails = response?.stop_details;
		if (stopDetails === null || stopDetails === undefined) {
			return null;
		}
		if (typeof stopDetails === 'object') {
			return { ...stopDetails };
		}
		return null;
	}

	/**
	 * Send a messages.create request, routing beta flags through the `anthropic-beta` header.
	 */
	private async createMessage(params: Record<string, any>): Promise<any> {
		const { betas, ...rest } = params;
		// The installed SDK version does not type thinking / output_config / fallbacks /
		// inference_geo / cache_control; they are accepted on the wire, so cast through.
		const body = rest as unknown as Anthropic.MessageCreateParamsNonStreaming;
		if (Array.isArray(betas) && betas.length > 0) {
			return this.client.messages.create(body, { headers: { 'anthropic-beta': betas.join(',') } });
		}
		return this.client.messages.create(body);
	}

	private buildCompletion<T>(
		completion: T,
		response: any,
		usage: ChatInvokeUsage | null,
		thinking: string | null = null,
		redactedThinking: string | null = null
	): ChatInvokeCompletion<T> {
		return {
			completion,
			thinking,
			redactedThinking,
			usage,
			stopReason: response.stop_reason ?? null,
			stopDetails: this.getStopDetails(response),
		};
	}

	/**
	 * Recover the output when the model rendered its whole tool call into a string field.
	 *
	 * Claude sometimes calls the tool but fills only the first string property of the schema,
	 * with the entire call written out as text (`<parameter name=...>` markup or a JSON object)
	 * instead of populating the arguments. That text still carries every field, so parse it out
	 * rather than discarding the step.
	 */
	private completionFromSerializedToolInput<T>(
		toolInput: unknown,
		outputFormat: z.ZodType<T>,
		usage: ChatInvokeUsage | null,
		response: any
	): ChatInvokeCompletion<T> | null {
		if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
			return null;
		}

		// The malformed Anthropic response puts the complete call in the schema's
		// `thinking` argument. Do not promote serialized data from arbitrary fields.
		const thinking = (toolInput as Record<string, any>).thinking;
		if (typeof thinking !== 'string') {
			return null;
		}

		const candidates: any[] = [];
		const toolCall = toolCallFromText(thinking);
		if (toolCall !== null) {
			candidates.push(toolCall);
		}
		for (const textCandidate of jsonCandidatesFromText(thinking)) {
			try {
				let candidate = JSON.parse(textCandidate);
				if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
					candidate = repairSerializedFields(candidate);
				}
				candidates.push(candidate);
			} catch {
				continue;
			}
		}

		for (const candidate of candidates) {
			const parsed = outputFormat.safeParse(candidate);
			if (parsed.success) {
				return this.buildCompletion(parsed.data, response, usage);
			}
		}

		return null;
	}

	/**
	 * With `tool_choice: auto` the model may answer in plain text; parse JSON out of it.
	 */
	private completionFromTextResponse<T>(
		response: any,
		outputFormat: z.ZodType<T>,
		usage: ChatInvokeUsage | null
	): ChatInvokeCompletion<T> | null {
		const { text, thinking, redactedThinking } = extractAnthropicContentBlocks(response.content);
		for (const candidate of jsonCandidatesFromText(text)) {
			let data: unknown;
			try {
				data = JSON.parse(candidate);
			} catch {
				continue;
			}
			const parsed = outputFormat.safeParse(data);
			if (parsed.success) {
				return this.buildCompletion(parsed.data, response, usage, thinking, redactedThinking);
			}
		}
		return null;
	}

	async ainvoke<T = string>(
		messages: BaseMessage[],
		outputFormat?: z.ZodType<T>,
		_options?: ChatInvokeOptions
	): Promise<ChatInvokeCompletion<T>> {
		this.validateThinkingConfig();

		const { messages: anthropicMessages, systemPrompt } =
			AnthropicMessageSerializer.serializeMessages(messages);

		// Apply prompt caching: mark the system prompt (and, for system_and_3, the
		// last 3 messages) as cacheable so repeated prefixes bill at 0.1× input rate.
		let apiMessages = anthropicMessages;
		let apiSystem: Anthropic.MessageCreateParams['system'] | undefined = systemPrompt;
		if (this.usePromptCaching) {
			const cached = applyAnthropicCacheControl(
				systemPrompt,
				anthropicMessages,
				this.cacheTtl,
				this.cacheStrategy
			);
			apiMessages = cached.messages;
			apiSystem = (cached.system ?? systemPrompt) as Anthropic.MessageCreateParams['system'];
		}

		const baseParams: Record<string, any> = {
			model: this.model,
			messages: apiMessages,
			max_tokens: this.maxTokens,
			...(apiSystem && { system: apiSystem }),
			...(this.temperature !== undefined && { temperature: this.temperature }),
			...(this.topP !== undefined && { top_p: this.topP }),
			...(this.seed !== undefined && { seed: this.seed }),
			...(this.thinking !== null && { thinking: this.thinking }),
		};
		const betas = this.getBetasForInvoke();
		if (betas !== null) {
			baseParams.betas = betas;
		}
		const extraBody = this.getExtraBodyForInvoke();
		if (extraBody !== null) {
			Object.assign(baseParams, extraBody);
		}

		try {
			if (!outputFormat) {
				// Normal completion without structured output
				const response = await this.createMessage(baseParams);
				const usage = this.getUsage(response);
				const { text, thinking, redactedThinking } = extractAnthropicContentBlocks(response.content);
				return this.buildCompletion(text as unknown as T, response, usage, thinking, redactedThinking);
			}

			// Use tool calling for structured output
			const toolName = 'extract_data';
			const jsonSchema = zodToJsonSchema(outputFormat);

			// Remove title from schema if present (Anthropic doesn't like it)
			const schema = { ...jsonSchema };
			if ('title' in schema) {
				delete schema.title;
			}

			// Deep-sort keys so the on-wire JSON byte representation is stable
			// across calls — required for the Anthropic prefix cache to hit on
			// the tools block when the underlying Zod schema is unchanged.
			const sortedSchema = _sortObjectKeys({
				type: 'object',
				...schema,
			}) as Record<string, unknown>;

			const tool = {
				name: toolName,
				description: `Extract information in structured format`,
				input_schema: sortedSchema,
				...(this.usePromptCaching && {
					cache_control: { type: 'ephemeral' as const },
				}),
			};

			// Forced tool use is rejected for Fable/Mythos 5 and when thinking is enabled
			const toolChoice = this.requiresAutoToolChoice()
				? { type: 'auto' }
				: { type: 'tool', name: toolName };

			const response = await this.createMessage({
				...baseParams,
				tools: [tool],
				tool_choice: toolChoice,
			});

			const usage = this.getUsage(response);

			if (response.stop_reason === 'max_tokens') {
				throw new ModelOutputTruncatedError({
					message:
						`Model output was truncated at max_tokens=${this.maxTokens}; the structured` +
						' output is incomplete. Increase max_tokens or request shorter output.',
					model: this.name,
				});
			}

			// Extract the tool use block
			for (const block of response.content ?? []) {
				if (block?.type !== 'tool_use') {
					continue;
				}
				const direct = outputFormat.safeParse(block.input);
				if (direct.success) {
					return this.buildCompletion(direct.data, response, usage);
				}

				// If validation fails, try to fix common model output issues
				let input: unknown = block.input;
				if (typeof input === 'string') {
					input = JSON.parse(input);
				} else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
					// Model sometimes double-serializes fields
					input = repairSerializedFields({ ...(input as Record<string, any>) });
				} else {
					throw direct.error;
				}

				const repaired = outputFormat.safeParse(input);
				if (repaired.success) {
					return this.buildCompletion(repaired.data, response, usage);
				}

				const recovered = this.completionFromSerializedToolInput(input, outputFormat, usage, response);
				if (recovered !== null) {
					return recovered;
				}
				throw repaired.error;
			}

			if (this.requiresAutoToolChoice()) {
				const textCompletion = this.completionFromTextResponse(response, outputFormat, usage);
				if (textCompletion !== null) {
					return textCompletion;
				}
			}

			// If no tool use block found, raise an error
			throw new Error('Expected tool use in response but none found');
		} catch (error: any) {
			if (error instanceof ModelProviderError) {
				throw error; // don't re-wrap with the generic 502
			}

			if (error?.status === 429) {
				throw new ModelRateLimitError({
					message: `Rate limit exceeded for model ${this.model}. Error: ${error.message}`,
					model: this.name,
				});
			}

			if (error?.status) {
				throw new ModelProviderError({
					message: `Anthropic API error (${error.status}): ${error.message}`,
					statusCode: error.status,
					model: this.name,
				});
			}

			throw new ModelProviderError({
				message: `Anthropic invocation failed: ${error?.message ?? error}`,
				model: this.name,
			});
		}
	}
}

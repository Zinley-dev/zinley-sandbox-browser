/**
 * Token cost tracking service
 * Port from browser_use/tokens/service.py (synced with 0.13.10)
 *
 * Fetches pricing data from LiteLLM repository and caches it for 1 day.
 * Automatically tracks token usage when LLMs are registered and invoked.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../logging_config.js';
import { BaseChatModel } from '../llm/base.js';
import { ChatInvokeUsage } from '../llm/views.js';
import { getOpenRouterModelPricing, isOpenRouterPricingModel } from './openrouter_pricing.js';
import {
	TokenUsageEntry,
	TokenCostCalculated,
	ModelPricing,
	CachedPricingData,
	ModelUsageStats,
	ModelUsageTokens,
	UsageSummary,
	createModelUsageStats,
	getPromptCost,
	getTotalCost,
} from './views.js';

const logger = getLogger('browser-use.tokens');
const costLogger = getLogger('browser-use.cost');

// Model name to LiteLLM model name mappings (browser_use/tokens/mappings.py)
export const MODEL_TO_LITELLM: Record<string, string> = {
	'gemini-flash-latest': 'gemini/gemini-flash-latest',
	'gemini-3-flash-preview': 'gemini/gemini-3-flash-preview',
	'gemini-3.1-flash-lite': 'gemini/gemini-3.1-flash-lite-preview',
};

type RawPricing = Record<string, number | null>;

const PER_M = 1 / 1_000_000;

const ANTHROPIC_SONNET_4_6: RawPricing = {
	input_cost_per_token: 3.0 * PER_M,
	output_cost_per_token: 15.0 * PER_M,
	cache_read_input_token_cost: 0.3 * PER_M,
	cache_creation_input_token_cost: 3.75 * PER_M,
	cache_creation_1h_input_token_cost: 6.0 * PER_M,
	max_tokens: null,
	max_input_tokens: null,
	max_output_tokens: null,
};

const ANTHROPIC_OPUS_4_6: RawPricing = {
	input_cost_per_token: 5.0 * PER_M,
	output_cost_per_token: 25.0 * PER_M,
	cache_read_input_token_cost: 0.5 * PER_M,
	cache_creation_input_token_cost: 6.25 * PER_M,
	cache_creation_1h_input_token_cost: 10.0 * PER_M,
	max_tokens: null,
	max_input_tokens: null,
	max_output_tokens: null,
};

const ANTHROPIC_FABLE_5: RawPricing = {
	input_cost_per_token: 10.0 * PER_M,
	output_cost_per_token: 50.0 * PER_M,
	cache_read_input_token_cost: 1.0 * PER_M,
	cache_creation_input_token_cost: 12.5 * PER_M,
	cache_creation_1h_input_token_cost: 20.0 * PER_M,
	max_tokens: 1_000_000,
	max_input_tokens: 1_000_000,
	max_output_tokens: 128_000,
};

const BU_2_0: RawPricing = {
	input_cost_per_token: 0.6 * PER_M,
	output_cost_per_token: 3.5 * PER_M,
	cache_read_input_token_cost: 0.06 * PER_M,
	cache_creation_input_token_cost: null,
	max_tokens: null,
	max_input_tokens: null,
	max_output_tokens: null,
};

/**
 * Custom model pricing for models not in LiteLLM (browser_use/tokens/custom_pricing.py).
 * Format matches LiteLLM's model_prices_and_context_window.json structure.
 */
export const CUSTOM_MODEL_PRICING: Record<string, RawPricing> = {
	'bu-2-0': BU_2_0,
	// bu-1-0 is redirected to bu-2-0 at the gateway, so it bills at bu-2-0 rates.
	'bu-1-0': BU_2_0,
	'bu-latest': BU_2_0,
	smart: BU_2_0,
	'bu-2-0-mini-preview': {
		input_cost_per_token: 0.15 * PER_M,
		output_cost_per_token: 1.5 * PER_M,
		// No cache discount on this model: cached reads bill at the input rate.
		cache_read_input_token_cost: 0.15 * PER_M,
		cache_creation_input_token_cost: null,
		max_tokens: null,
		max_input_tokens: null,
		max_output_tokens: null,
	},
	'claude-sonnet-4-6': ANTHROPIC_SONNET_4_6,
	'anthropic/claude-sonnet-4.6': ANTHROPIC_SONNET_4_6,
	'claude-opus-4-6': ANTHROPIC_OPUS_4_6,
	'anthropic/claude-opus-4.6': ANTHROPIC_OPUS_4_6,
	'claude-fable-5': ANTHROPIC_FABLE_5,
	'anthropic/claude-fable-5': ANTHROPIC_FABLE_5,
};

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 1 day in milliseconds
export const DEFAULT_PRICING_URL =
	'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const ORCAROUTER_BASE_URL = 'https://api.orcarouter.ai/v1';

function rawToModelPricing(modelName: string, data: Record<string, any>): ModelPricing {
	return {
		model: modelName,
		inputCostPerToken: data.input_cost_per_token ?? null,
		outputCostPerToken: data.output_cost_per_token ?? null,
		maxTokens: data.max_tokens ?? null,
		maxInputTokens: data.max_input_tokens ?? null,
		maxOutputTokens: data.max_output_tokens ?? null,
		cacheReadInputTokenCost: data.cache_read_input_token_cost ?? null,
		cacheCreationInputTokenCost: data.cache_creation_input_token_cost ?? null,
		cacheCreation1hInputTokenCost: data.cache_creation_1h_input_token_cost ?? null,
	};
}

/**
 * Service for tracking token usage and calculating costs
 */
export class TokenCost {
	private includeCost: boolean;
	private pricingUrl: string;
	private usageHistory: TokenUsageEntry[] = [];
	private registeredLlms: Map<string, BaseChatModel> = new Map();
	/** model name -> name used for pricing lookups (disambiguates gateways such as OpenRouter) */
	private pricingModelNames: Map<string, string> = new Map();
	private pricingData: Record<string, any> | null = null;
	private initialized = false;
	private cacheDir: string;

	constructor(includeCost: boolean = false, pricingUrl?: string | null) {
		this.includeCost =
			includeCost || (process.env.BROWSER_USE_CALCULATE_COST || 'false').toLowerCase() === 'true';
		this.pricingUrl = pricingUrl || process.env.BROWSER_USE_MODEL_PRICING_URL || DEFAULT_PRICING_URL;

		const xdgCacheHome = process.env.XDG_CACHE_HOME || path.join(process.env.HOME || '', '.cache');
		this.cacheDir = path.join(xdgCacheHome, 'browser_use', 'token_cost');
	}

	/**
	 * Initialize the service by loading pricing data
	 */
	async initialize(): Promise<void> {
		if (!this.initialized) {
			if (this.includeCost) {
				await this.loadPricingData();
			}
			this.initialized = true;
		}
	}

	/**
	 * Load pricing data from cache or fetch from GitHub
	 */
	private async loadPricingData(): Promise<void> {
		const cacheFile = this.findValidCache();

		if (cacheFile) {
			this.loadFromCache(cacheFile);
		} else {
			await this.fetchAndCachePricingData();
		}
	}

	/**
	 * Find the most recent valid cache file
	 */
	private findValidCache(): string | null {
		try {
			// Ensure cache directory exists
			fs.mkdirSync(this.cacheDir, { recursive: true });

			// List all JSON files in the cache directory
			const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.json'));

			if (files.length === 0) {
				return null;
			}

			// Sort by modification time (most recent first)
			const cacheFiles = files
				.map((f) => {
					const fullPath = path.join(this.cacheDir, f);
					return { path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
				})
				.sort((a, b) => b.mtime - a.mtime);

			// Check each file until we find a valid one
			for (const cacheFile of cacheFiles) {
				const [isValid, shouldDelete] = this.getCacheStatus(cacheFile.path);
				if (isValid) {
					return cacheFile.path;
				}
				if (shouldDelete) {
					// Clean up expired / unreadable cache files
					try {
						fs.unlinkSync(cacheFile.path);
					} catch {
						// Ignore cleanup errors
					}
				}
			}

			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Return whether a cache file is usable and whether it should be deleted.
	 * Caches written from a different pricing URL are neither used nor deleted.
	 */
	private getCacheStatus(cacheFile: string): [boolean, boolean] {
		try {
			if (!fs.existsSync(cacheFile)) {
				return [false, false];
			}

			const content = fs.readFileSync(cacheFile, 'utf-8');
			const cached: CachedPricingData = JSON.parse(content);

			// Check if cache is still valid
			const cacheTime = new Date(cached.timestamp).getTime();
			if (Date.now() - cacheTime >= CACHE_DURATION_MS) {
				return [false, true];
			}

			// Keep caches from other sources so different pricing URLs don't delete each other.
			return [this.cacheSourceMatches(cached), false];
		} catch {
			return [false, true];
		}
	}

	/**
	 * Only use cached pricing files from the same source URL.
	 */
	private cacheSourceMatches(cached: CachedPricingData): boolean {
		if (cached.sourceUrl === null || cached.sourceUrl === undefined) {
			return this.pricingUrl === DEFAULT_PRICING_URL;
		}
		return cached.sourceUrl === this.pricingUrl;
	}

	/**
	 * Load pricing data from a specific cache file
	 */
	private loadFromCache(cacheFile: string): void {
		try {
			const content = fs.readFileSync(cacheFile, 'utf-8');
			const cached: CachedPricingData = JSON.parse(content);
			this.pricingData = cached.data;
		} catch (e: any) {
			logger.debug(`Error loading cached pricing data from ${cacheFile}: ${e.message}`);
			// Fall back to empty data
			this.pricingData = {};
		}
	}

	/**
	 * Fetch pricing data from the pricing URL and cache it
	 */
	private async fetchAndCachePricingData(): Promise<void> {
		try {
			const response = await fetch(this.pricingUrl, {
				signal: AbortSignal.timeout(30000),
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			this.pricingData = await response.json();

			// Ensure cache directory exists
			fs.mkdirSync(this.cacheDir, { recursive: true });

			// Create cache object with timestamp and source
			const cached: CachedPricingData = {
				timestamp: new Date().toISOString(),
				sourceUrl: this.pricingUrl,
				data: this.pricingData || {},
			};

			// Create cache file with timestamp in filename
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const cacheFile = path.join(this.cacheDir, `pricing_${timestamp}.json`);

			fs.writeFileSync(cacheFile, JSON.stringify(cached, null, 2));
		} catch (e: any) {
			logger.debug(`Error fetching pricing data: ${e.message}`);
			this.pricingData = {};
		}
	}

	/**
	 * Get pricing information for a specific model
	 */
	async getModelPricing(modelName: string): Promise<ModelPricing | null> {
		// Check custom pricing first (no network needed)
		if (modelName in CUSTOM_MODEL_PRICING) {
			return rawToModelPricing(modelName, CUSTOM_MODEL_PRICING[modelName]);
		}

		// Ensure we're initialized before checking remote LiteLLM pricing.
		if (!this.initialized) {
			await this.initialize();
		}

		if (isOpenRouterPricingModel(modelName)) {
			const openRouterPricing = await getOpenRouterModelPricing(modelName);
			if (openRouterPricing !== null) {
				return openRouterPricing;
			}
		}

		// Map model name to LiteLLM model name if needed
		const litellmModelName = MODEL_TO_LITELLM[modelName] || modelName;

		if (this.pricingData && litellmModelName in this.pricingData) {
			return rawToModelPricing(modelName, this.pricingData[litellmModelName]);
		}

		return getOpenRouterModelPricing(modelName);
	}

	/**
	 * Calculate cost for a given model and usage
	 */
	async calculateCost(model: string, usage: ChatInvokeUsage): Promise<TokenCostCalculated | null> {
		if (!this.includeCost) {
			return null;
		}

		const pricingModel = this.pricingModelNames.get(model) ?? model;
		const data = await this.getModelPricing(pricingModel);
		if (!data) {
			return null;
		}

		const uncachedPromptTokens = usage.promptTokens - (usage.promptCachedTokens || 0);
		const pricingMultiplier = usage.pricingMultiplier || 1.0;

		// Cache creation: prefer the TTL-split counts when the provider reports them
		const cacheCreation5m = usage.promptCacheCreation5mTokens;
		const cacheCreation1h = usage.promptCacheCreation1hTokens;
		let promptCacheCreationCost: number | null;
		if (cacheCreation5m != null || cacheCreation1h != null) {
			promptCacheCreationCost =
				(cacheCreation5m || 0) * (data.cacheCreationInputTokenCost || 0) +
				(cacheCreation1h || 0) * (data.cacheCreation1hInputTokenCost || data.cacheCreationInputTokenCost || 0);
		} else {
			promptCacheCreationCost =
				data.cacheCreationInputTokenCost && usage.promptCacheCreationTokens
					? usage.promptCacheCreationTokens * data.cacheCreationInputTokenCost
					: null;
		}

		return {
			newPromptTokens: usage.promptTokens,
			newPromptCost: uncachedPromptTokens * (data.inputCostPerToken || 0) * pricingMultiplier,
			// Cached tokens
			promptReadCachedTokens: usage.promptCachedTokens || null,
			promptReadCachedCost:
				usage.promptCachedTokens && data.cacheReadInputTokenCost
					? usage.promptCachedTokens * data.cacheReadInputTokenCost * pricingMultiplier
					: null,
			// Cache creation tokens
			promptCachedCreationTokens: usage.promptCacheCreationTokens || null,
			promptCacheCreationCost:
				promptCacheCreationCost !== null ? promptCacheCreationCost * pricingMultiplier : null,
			// Completion tokens
			completionTokens: usage.completionTokens,
			completionCost: usage.completionTokens * (data.outputCostPerToken || 0) * pricingMultiplier,
		};
	}

	/**
	 * Add token usage entry to history
	 */
	addUsage(model: string, usage: ChatInvokeUsage): TokenUsageEntry {
		const entry: TokenUsageEntry = {
			model,
			timestamp: new Date(),
			usage,
		};

		this.usageHistory.push(entry);
		return entry;
	}

	/**
	 * Log usage to the logger
	 */
	async logUsage(model: string, usage: TokenUsageEntry): Promise<void> {
		if (!this.initialized) {
			await this.initialize();
		}

		// Get cost breakdown for token details
		const cost = await this.calculateCost(model, usage.usage);

		// Build input tokens breakdown
		const inputPart = this.buildInputTokensDisplay(usage.usage, cost);

		// Build output tokens display
		const completionTokensFmt = this.formatTokens(usage.usage.completionTokens);
		const outputPart =
			this.includeCost && cost && cost.completionCost > 0
				? `out: ${completionTokensFmt} ($${cost.completionCost.toFixed(4)})`
				: `out: ${completionTokensFmt}`;

		costLogger.debug(`${model} | ${inputPart} | ${outputPart}`);
	}

	/**
	 * Build a clear display of input tokens breakdown
	 */
	private buildInputTokensDisplay(usage: ChatInvokeUsage, cost: TokenCostCalculated | null): string {
		const parts: string[] = [];

		if (usage.promptCachedTokens || usage.promptCacheCreationTokens) {
			const newTokens = usage.promptTokens - (usage.promptCachedTokens || 0);

			if (newTokens > 0) {
				const newTokensFmt = this.formatTokens(newTokens);
				if (this.includeCost && cost && cost.newPromptCost > 0) {
					parts.push(`new: ${newTokensFmt} ($${cost.newPromptCost.toFixed(4)})`);
				} else {
					parts.push(`new: ${newTokensFmt}`);
				}
			}

			if (usage.promptCachedTokens) {
				const cachedTokensFmt = this.formatTokens(usage.promptCachedTokens);
				if (this.includeCost && cost && cost.promptReadCachedCost) {
					parts.push(`cached: ${cachedTokensFmt} ($${cost.promptReadCachedCost.toFixed(4)})`);
				} else {
					parts.push(`cached: ${cachedTokensFmt}`);
				}
			}

			if (usage.promptCacheCreationTokens) {
				const creationTokensFmt = this.formatTokens(usage.promptCacheCreationTokens);
				if (this.includeCost && cost && cost.promptCacheCreationCost) {
					parts.push(`created: ${creationTokensFmt} ($${cost.promptCacheCreationCost.toFixed(4)})`);
				} else {
					parts.push(`created: ${creationTokensFmt}`);
				}
			}
		}

		if (parts.length === 0) {
			const totalTokensFmt = this.formatTokens(usage.promptTokens);
			if (this.includeCost && cost && cost.newPromptCost > 0) {
				parts.push(`in: ${totalTokensFmt} ($${cost.newPromptCost.toFixed(4)})`);
			} else {
				parts.push(`in: ${totalTokensFmt}`);
			}
		}

		return parts.join(' + ');
	}

	/**
	 * Register an LLM to automatically track its token usage
	 */
	registerLlm(llm: BaseChatModel): BaseChatModel {
		const instanceId = String(llm);

		if (this.registeredLlms.has(instanceId)) {
			logger.debug(`LLM instance ${instanceId} (${llm.provider}_${llm.model}) is already registered`);
			return llm;
		}

		this.registeredLlms.set(instanceId, llm);
		this.pricingModelNames.set(llm.model, this.getPricingModelName(llm));

		// Store the original method
		const originalAinvoke = llm.ainvoke.bind(llm);
		const tokenCostService = this;

		// Create a wrapped version that tracks usage
		const trackedAinvoke = async function (messages: any, outputFormat?: any) {
			const result = await originalAinvoke(messages, outputFormat);

			// Track usage if available
			if (result.usage) {
				const usage = tokenCostService.addUsage(llm.model, result.usage);
				logger.debug(`Token cost service: ${JSON.stringify(usage)}`);
				// Fire-and-forget; logging must never fail the LLM call
				tokenCostService.logUsage(llm.model, usage).catch(() => {});
			}

			return result;
		};

		// Replace the method
		(llm as any).ainvoke = trackedAinvoke;

		return llm;
	}

	/**
	 * Disambiguate gateway prices (OpenRouter, OrcaRouter) from same-named upstream model ids.
	 */
	getPricingModelName(llm: BaseChatModel): string {
		const model = String(llm.model);
		const baseUrl = String((llm as any).baseURL ?? (llm as any).baseUrl ?? '').replace(/\/+$/, '');

		if (llm.provider === 'openrouter' || baseUrl === OPENROUTER_BASE_URL) {
			if (!isOpenRouterPricingModel(model)) {
				return `openrouter/${model}`;
			}
		}
		// OrcaRouter is a gateway with its own pricing; never attribute upstream prices to it.
		if (llm.provider === 'orcarouter' || baseUrl === ORCAROUTER_BASE_URL) {
			return `orcarouter/${model}`;
		}

		return model;
	}

	/**
	 * Get usage tokens for a specific model
	 */
	getUsageTokensForModel(model: string): ModelUsageTokens {
		const filteredUsage = this.usageHistory.filter((u) => u.model === model);

		return {
			model,
			promptTokens: filteredUsage.reduce((sum, u) => sum + u.usage.promptTokens, 0),
			promptCachedTokens: filteredUsage.reduce((sum, u) => sum + (u.usage.promptCachedTokens || 0), 0),
			completionTokens: filteredUsage.reduce((sum, u) => sum + u.usage.completionTokens, 0),
			totalTokens: filteredUsage.reduce((sum, u) => sum + u.usage.promptTokens + u.usage.completionTokens, 0),
		};
	}

	/**
	 * Get summary of token usage and costs
	 */
	async getUsageSummary(model?: string, since?: Date): Promise<UsageSummary> {
		let filteredUsage = this.usageHistory;

		if (model) {
			filteredUsage = filteredUsage.filter((u) => u.model === model);
		}

		if (since) {
			filteredUsage = filteredUsage.filter((u) => u.timestamp >= since);
		}

		if (filteredUsage.length === 0) {
			return {
				totalPromptTokens: 0,
				totalPromptCost: 0,
				totalPromptCachedTokens: 0,
				totalPromptCachedCost: 0,
				totalPromptCacheCreationTokens: 0,
				totalPromptCacheCreationCost: 0,
				totalCompletionTokens: 0,
				totalCompletionCost: 0,
				totalTokens: 0,
				totalCost: 0,
				entryCount: 0,
				byModel: {},
			};
		}

		const totalPrompt = filteredUsage.reduce((sum, u) => sum + u.usage.promptTokens, 0);
		const totalCompletion = filteredUsage.reduce((sum, u) => sum + u.usage.completionTokens, 0);
		const totalTokens = totalPrompt + totalCompletion;
		const totalPromptCached = filteredUsage.reduce((sum, u) => sum + (u.usage.promptCachedTokens || 0), 0);
		const totalPromptCacheCreation = filteredUsage.reduce(
			(sum, u) => sum + (u.usage.promptCacheCreationTokens || 0),
			0
		);

		// Calculate per-model stats with record-by-record cost calculation
		const modelStats: Record<string, ModelUsageStats> = {};
		let totalPromptCost = 0;
		let totalCompletionCost = 0;
		let totalPromptCachedCost = 0;
		let totalPromptCacheCreationCost = 0;

		for (const entry of filteredUsage) {
			if (!(entry.model in modelStats)) {
				modelStats[entry.model] = createModelUsageStats(entry.model);
			}

			const stats = modelStats[entry.model];
			stats.promptTokens += entry.usage.promptTokens;
			stats.completionTokens += entry.usage.completionTokens;
			stats.totalTokens += entry.usage.promptTokens + entry.usage.completionTokens;
			stats.invocations += 1;

			if (this.includeCost) {
				const cost = await this.calculateCost(entry.model, entry.usage);
				if (cost) {
					stats.cost += getTotalCost(cost);
					totalPromptCost += getPromptCost(cost);
					totalCompletionCost += cost.completionCost;
					totalPromptCachedCost += cost.promptReadCachedCost || 0;
					totalPromptCacheCreationCost += cost.promptCacheCreationCost || 0;
				}
			}
		}

		// Calculate averages
		for (const stats of Object.values(modelStats)) {
			if (stats.invocations > 0) {
				stats.averageTokensPerInvocation = stats.totalTokens / stats.invocations;
			}
		}

		return {
			totalPromptTokens: totalPrompt,
			totalPromptCost,
			totalPromptCachedTokens: totalPromptCached,
			totalPromptCachedCost,
			totalPromptCacheCreationTokens: totalPromptCacheCreation,
			totalPromptCacheCreationCost,
			totalCompletionTokens: totalCompletion,
			totalCompletionCost,
			totalTokens,
			// totalPromptCost already includes the cached-read and cache-creation parts
			totalCost: totalPromptCost + totalCompletionCost,
			entryCount: filteredUsage.length,
			byModel: modelStats,
		};
	}

	/**
	 * Format token count with k/M/B suffix
	 */
	private formatTokens(tokens: number): string {
		if (tokens >= 1_000_000_000) {
			return `${(tokens / 1_000_000_000).toFixed(1)}B`;
		}
		if (tokens >= 1_000_000) {
			return `${(tokens / 1_000_000).toFixed(1)}M`;
		}
		if (tokens >= 1000) {
			return `${(tokens / 1000).toFixed(1)}k`;
		}
		return String(tokens);
	}

	/**
	 * Log a comprehensive usage summary per model
	 */
	async logUsageSummary(): Promise<void> {
		if (this.usageHistory.length === 0) {
			return;
		}

		const summary = await this.getUsageSummary();

		if (summary.entryCount === 0) {
			return;
		}

		const totalTokensFmt = this.formatTokens(summary.totalTokens);
		const promptTokensFmt = this.formatTokens(summary.totalPromptTokens);
		const completionTokensFmt = this.formatTokens(summary.totalCompletionTokens);

		let totalCostPart = '';
		let promptCostPart = '';
		let completionCostPart = '';

		if (this.includeCost && summary.totalCost > 0) {
			totalCostPart = ` ($${summary.totalCost.toFixed(4)})`;
			promptCostPart = ` ($${summary.totalPromptCost.toFixed(4)})`;
			completionCostPart = ` ($${summary.totalCompletionCost.toFixed(4)})`;
		}

		if (Object.keys(summary.byModel).length > 1) {
			costLogger.debug(
				`Total Usage: ${totalTokensFmt} tokens${totalCostPart} | ` +
					`in: ${promptTokensFmt}${promptCostPart} | out: ${completionTokensFmt}${completionCostPart}`
			);
		}

		for (const [model, stats] of Object.entries(summary.byModel)) {
			const modelTotalFmt = this.formatTokens(stats.totalTokens);
			const modelPromptFmt = this.formatTokens(stats.promptTokens);
			const modelCompletionFmt = this.formatTokens(stats.completionTokens);
			const avgTokensFmt = this.formatTokens(Math.round(stats.averageTokensPerInvocation));

			let costPart = '';
			if (this.includeCost && stats.cost > 0) {
				costPart = ` ($${stats.cost.toFixed(4)})`;
			}

			costLogger.debug(
				`  ${model}: ${modelTotalFmt} tokens${costPart} | ` +
					`in: ${modelPromptFmt} | out: ${modelCompletionFmt} | ` +
					`${stats.invocations} calls | ${avgTokensFmt}/call`
			);
		}
	}

	/**
	 * Get cost breakdown by model
	 */
	async getCostByModel(): Promise<Record<string, ModelUsageStats>> {
		const summary = await this.getUsageSummary();
		return summary.byModel;
	}

	/**
	 * Clear usage history
	 */
	clearHistory(): void {
		this.usageHistory = [];
	}

	/**
	 * Force refresh of pricing data from the pricing URL
	 */
	async refreshPricingData(): Promise<void> {
		if (this.includeCost) {
			await this.fetchAndCachePricingData();
		}
	}

	/**
	 * Clean up old cache files, keeping only the most recent ones from this source URL
	 */
	async cleanOldCaches(keepCount: number = 3): Promise<void> {
		try {
			const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.json'));

			if (files.length === 0) {
				return;
			}

			// Only consider cache files from the same source URL
			const ownFiles: { path: string; mtime: number }[] = [];
			for (const f of files) {
				const fullPath = path.join(this.cacheDir, f);
				try {
					const cached: CachedPricingData = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
					if (this.cacheSourceMatches(cached)) {
						ownFiles.push({ path: fullPath, mtime: fs.statSync(fullPath).mtimeMs });
					}
				} catch {
					// Unreadable file: leave it alone
				}
			}

			if (ownFiles.length <= keepCount) {
				return;
			}

			// Sort by modification time (oldest first)
			ownFiles.sort((a, b) => a.mtime - b.mtime);

			// Remove all but the most recent files
			for (const cacheFile of ownFiles.slice(0, -keepCount)) {
				try {
					fs.unlinkSync(cacheFile.path);
				} catch {
					// Ignore cleanup errors
				}
			}
		} catch (e: any) {
			logger.debug(`Error cleaning old cache files: ${e.message}`);
		}
	}

	/**
	 * Ensure pricing data is loaded in the background
	 */
	async ensurePricingLoaded(): Promise<void> {
		if (!this.initialized && this.includeCost) {
			await this.initialize();
		}
	}
}

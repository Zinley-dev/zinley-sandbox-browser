/**
 * Token tracking data models
 * Port from browser_use/tokens/views.py
 */

import { ChatInvokeUsage } from '../llm/views.js';

/**
 * Single token usage entry
 */
export interface TokenUsageEntry {
	model: string;
	timestamp: Date;
	usage: ChatInvokeUsage;
}

/**
 * Token cost calculation result
 */
export interface TokenCostCalculated {
	newPromptTokens: number;
	newPromptCost: number;

	promptReadCachedTokens: number | null;
	promptReadCachedCost: number | null;

	promptCachedCreationTokens: number | null;
	promptCacheCreationCost: number | null;

	completionTokens: number;
	completionCost: number;
}

/**
 * Get prompt cost from token cost calculation
 */
export function getPromptCost(cost: TokenCostCalculated): number {
	return cost.newPromptCost + (cost.promptReadCachedCost || 0) + (cost.promptCacheCreationCost || 0);
}

/**
 * Get total cost from token cost calculation
 */
export function getTotalCost(cost: TokenCostCalculated): number {
	return (
		cost.newPromptCost +
		(cost.promptReadCachedCost || 0) +
		(cost.promptCacheCreationCost || 0) +
		cost.completionCost
	);
}

/**
 * Pricing information for a model
 */
export interface ModelPricing {
	model: string;
	inputCostPerToken: number | null;
	outputCostPerToken: number | null;

	cacheReadInputTokenCost: number | null;
	cacheCreationInputTokenCost: number | null;
	/** Anthropic: cost of cache-creation tokens written with the 1-hour TTL */
	cacheCreation1hInputTokenCost?: number | null;

	maxTokens: number | null;
	maxInputTokens: number | null;
	maxOutputTokens: number | null;
}

/**
 * Cached pricing data with timestamp
 */
export interface CachedPricingData {
	timestamp: string; // ISO date string
	/** Pricing source URL the data was fetched from (null = legacy cache, default URL) */
	sourceUrl?: string | null;
	data: Record<string, any>;
}

/**
 * Usage statistics for a single model
 */
export interface ModelUsageStats {
	model: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cost: number;
	invocations: number;
	averageTokensPerInvocation: number;
}

/**
 * Create default model usage stats
 */
export function createModelUsageStats(model: string): ModelUsageStats {
	return {
		model,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cost: 0,
		invocations: 0,
		averageTokensPerInvocation: 0,
	};
}

/**
 * Usage tokens for a single model
 */
export interface ModelUsageTokens {
	model: string;
	promptTokens: number;
	promptCachedTokens: number;
	completionTokens: number;
	totalTokens: number;
}

/**
 * Summary of token usage and costs
 */
export interface UsageSummary {
	totalPromptTokens: number;
	totalPromptCost: number;

	totalPromptCachedTokens: number;
	totalPromptCachedCost: number;

	totalPromptCacheCreationTokens: number;
	totalPromptCacheCreationCost: number;

	totalCompletionTokens: number;
	totalCompletionCost: number;

	totalTokens: number;
	totalCost: number;
	entryCount: number;

	byModel: Record<string, ModelUsageStats>;
}

/**
 * Legacy TokenUsage interface for backwards compatibility
 */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalCost: number;
}

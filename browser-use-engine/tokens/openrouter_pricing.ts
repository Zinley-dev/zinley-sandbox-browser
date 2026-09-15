/**
 * Pricing helpers for OpenRouter model ids.
 * Port from browser_use/tokens/openrouter_pricing.py (0.13.10)
 *
 * OpenRouter publishes prices as per-token strings at /api/v1/models. This
 * module keeps a small in-process cache so new OpenRouter models can be costed
 * before LiteLLM's pricing file has caught up.
 */

import { getLogger } from '../logging_config.js';
import { ModelPricing } from './views.js';

const logger = getLogger('browser-use.tokens.openrouter');

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_MODELS_CACHE_MS = 60 * 60 * 1000;

type OpenRouterModel = Record<string, any>;

let modelsCache: Record<string, OpenRouterModel> | null = null;
let modelsCacheFetchedAt = 0;

function floatOrNull(value: unknown): number | null {
	if (value === null || value === undefined || value === '') {
		return null;
	}
	const parsed = typeof value === 'number' ? value : parseFloat(String(value));
	return Number.isFinite(parsed) ? parsed : null;
}

function intOrNull(value: unknown): number | null {
	if (value === null || value === undefined || value === '') {
		return null;
	}
	const parsed = typeof value === 'number' ? Math.trunc(value) : parseInt(String(value), 10);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Return the OpenRouter model id if the name looks like one, else null.
 */
export function normalizeOpenRouterModelId(modelName: string): string | null {
	let name = modelName;
	if (name.startsWith('openrouter/')) {
		name = name.slice('openrouter/'.length);
	} else if (name.startsWith('openrouter-')) {
		name = name.slice('openrouter-'.length);
	}

	if (!name.includes('/')) {
		return null;
	}

	return name;
}

/**
 * Whether the model name explicitly requests OpenRouter pricing.
 */
export function isOpenRouterPricingModel(modelName: string): boolean {
	return modelName.startsWith('openrouter/') || modelName.startsWith('openrouter-');
}

/**
 * Fetch OpenRouter model metadata keyed by model id (cached for one hour).
 */
export async function getOpenRouterModelsMetadata(refresh = false): Promise<Record<string, OpenRouterModel>> {
	const now = Date.now();
	if (!refresh && modelsCache !== null && now - modelsCacheFetchedAt < OPENROUTER_MODELS_CACHE_MS) {
		return modelsCache;
	}

	try {
		const response = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(30000) });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const body: any = await response.json();
		const models = body && typeof body === 'object' ? body.data : null;
		if (!Array.isArray(models)) {
			return modelsCache || {};
		}

		const byId: Record<string, OpenRouterModel> = {};
		for (const model of models) {
			if (model && typeof model === 'object' && typeof model.id === 'string') {
				byId[model.id] = model;
			}
		}
		modelsCache = byId;
		modelsCacheFetchedAt = now;
		return modelsCache;
	} catch (e: any) {
		logger.debug(`Error fetching OpenRouter pricing data: ${e?.message ?? e}`);
		return modelsCache || {};
	}
}

/**
 * Fetch metadata for one OpenRouter model id.
 */
export async function getOpenRouterModelMetadata(
	modelName: string,
	refresh = false
): Promise<OpenRouterModel | null> {
	const modelId = normalizeOpenRouterModelId(modelName);
	if (modelId === null) {
		return null;
	}

	const models = await getOpenRouterModelsMetadata(refresh);
	return models[modelId] ?? null;
}

/**
 * Convert one OpenRouter model metadata object into Browser Use pricing.
 */
export function modelPricingFromOpenRouterMetadata(
	modelName: string,
	metadata: OpenRouterModel
): ModelPricing | null {
	const pricing = metadata?.pricing;
	if (!pricing || typeof pricing !== 'object') {
		return null;
	}

	const inputCost = floatOrNull(pricing.prompt);
	const outputCost = floatOrNull(pricing.completion);
	if (inputCost === null && outputCost === null) {
		return null;
	}

	const contextLength = intOrNull(metadata.context_length);
	const topProvider = metadata.top_provider;
	const maxOutputTokens =
		topProvider && typeof topProvider === 'object' ? intOrNull(topProvider.max_completion_tokens) : null;

	return {
		model: modelName,
		inputCostPerToken: inputCost,
		outputCostPerToken: outputCost,
		cacheReadInputTokenCost: floatOrNull(pricing.input_cache_read),
		cacheCreationInputTokenCost: floatOrNull(pricing.input_cache_write),
		maxTokens: contextLength,
		maxInputTokens: contextLength,
		maxOutputTokens,
	};
}

/**
 * Fetch pricing for a model if it looks like an OpenRouter model id.
 */
export async function getOpenRouterModelPricing(modelName: string, refresh = false): Promise<ModelPricing | null> {
	const metadata = await getOpenRouterModelMetadata(modelName, refresh);
	if (metadata === null) {
		return null;
	}

	return modelPricingFromOpenRouterMetadata(modelName, metadata);
}

/** Test hook: drop the in-process cache. */
export function _resetOpenRouterPricingCache(): void {
	modelsCache = null;
	modelsCacheFetchedAt = 0;
}

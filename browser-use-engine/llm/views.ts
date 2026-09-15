/**
 * LLM response types and usage information
 */

export interface ChatInvokeUsage {
	/** The number of tokens in the prompt (includes cached tokens) */
	promptTokens: number;

	/** The number of cached tokens */
	promptCachedTokens?: number | null;

	/** Anthropic only: The number of tokens used to create the cache */
	promptCacheCreationTokens?: number | null;

	/** Anthropic only: cache-creation tokens written with the 5-minute TTL */
	promptCacheCreation5mTokens?: number | null;

	/** Anthropic only: cache-creation tokens written with the 1-hour TTL (billed higher) */
	promptCacheCreation1hTokens?: number | null;

	/** Google only: The number of tokens in the image */
	promptImageTokens?: number | null;

	/** The number of tokens in the completion */
	completionTokens: number;

	/** The total number of tokens in the response */
	totalTokens: number;

	/**
	 * Provider-reported price multiplier for this request (e.g. Anthropic
	 * long-context or priority tiers). Applied on top of the model's base rates.
	 */
	pricingMultiplier?: number | null;
}

export interface ChatInvokeCompletion<T = string> {
	/** The completion of the response */
	completion: T;

	/** Extended thinking output (for models that support it) */
	thinking?: string | null;

	/** Redacted thinking output */
	redactedThinking?: string | null;

	/** Usage information */
	usage?: ChatInvokeUsage | null;

	/**
	 * The reason the model stopped generating.
	 * Common values: 'end_turn', 'max_tokens', 'stop_sequence'
	 */
	stopReason?: string | null;

	/** Provider-specific stop details, e.g. Anthropic refusal category information */
	stopDetails?: Record<string, any> | null;
}

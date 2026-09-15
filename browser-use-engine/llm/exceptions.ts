/**
 * LLM exceptions
 * Port from browser_use/llm/exceptions.py (30 lines)
 */

export class ModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ModelError';
	}
}

export interface ModelProviderErrorOptions {
	message: string;
	statusCode?: number;
	model?: string;
}

export class ModelProviderError extends ModelError {
	/**
	 * Exception raised when a model provider returns an error.
	 */
	statusCode: number;
	model?: string;

	constructor(options: ModelProviderErrorOptions) {
		super(options.message);
		this.name = 'ModelProviderError';
		this.statusCode = options.statusCode ?? 502;
		this.model = options.model;
	}
}

/**
 * Output was cut off at an output-token limit (finish_reason='length' / stop_reason='max_tokens').
 *
 * Status 400 keeps it out of same-provider retry loops; the agent's fallback switch treats it as recoverable.
 */
export class ModelOutputTruncatedError extends ModelProviderError {
	constructor(options: Omit<ModelProviderErrorOptions, 'statusCode'>) {
		super({ ...options, statusCode: 400 });
		this.name = 'ModelOutputTruncatedError';
	}
}

export class ModelRateLimitError extends ModelProviderError {
	/**
	 * Exception raised when a model provider returns a rate limit error.
	 */
	constructor(options: Omit<ModelProviderErrorOptions, 'statusCode'> & { statusCode?: number }) {
		super({
			...options,
			statusCode: options.statusCode ?? 429,
		});
		this.name = 'ModelRateLimitError';
	}
}

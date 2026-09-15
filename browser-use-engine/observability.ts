/**
 * Observability module for browser-use
 * Port from browser_use/observability.py
 *
 * This module provides observability decorators that optionally integrate with lmnr (Laminar) for tracing.
 * If lmnr is not installed, it provides no-op wrappers that accept the same parameters.
 *
 * Features:
 * - Optional lmnr integration - works with or without lmnr installed
 * - Debug mode support - observe_debug only traces when in debug mode
 * - Full parameter compatibility with lmnr observe decorator
 * - No-op fallbacks when lmnr is unavailable
 */

import { getLogger } from './logging_config.js';

const logger = getLogger('browser-use.observability');

// Check if lmnr is available
let LMNR_AVAILABLE = false;
let lmnrObserve: any = null;

try {
	const lmnr = require('lmnr');
	lmnrObserve = lmnr.observe;
	LMNR_AVAILABLE = true;
	if (process.env.BROWSER_USE_VERBOSE_OBSERVABILITY?.toLowerCase() === 'true') {
		logger.debug('Lmnr is available for observability');
	}
} catch {
	if (process.env.BROWSER_USE_VERBOSE_OBSERVABILITY?.toLowerCase() === 'true') {
		logger.debug('Lmnr is not available for observability');
	}
}

/**
 * Check if we're in debug mode based on environment variables
 */
function isDebugMode(): boolean {
	const lmnrDebugMode = (process.env.LMNR_LOGGING_LEVEL || '').toLowerCase();
	return lmnrDebugMode === 'debug';
}

/**
 * Observability options for decorators
 */
export interface ObserveOptions {
	name?: string;
	ignoreInput?: boolean;
	ignoreOutput?: boolean;
	metadata?: Record<string, any>;
	spanType?: 'DEFAULT' | 'LLM' | 'TOOL';
	tags?: string[];
}

/**
 * Create a no-op decorator that accepts all lmnr observe parameters but does nothing.
 */
function createNoOpDecorator(options: ObserveOptions = {}): MethodDecorator {
	return function (
		target: any,
		propertyKey: string | symbol,
		descriptor: PropertyDescriptor
	): PropertyDescriptor {
		return descriptor;
	};
}

/**
 * Create a no-op function wrapper for higher-order function usage
 */
function createNoOpWrapper<T extends (...args: any[]) => any>(fn: T): T {
	return fn;
}

/**
 * Observability decorator that traces function execution when lmnr is available.
 *
 * This decorator will use lmnr's observe decorator if lmnr is installed,
 * otherwise it will be a no-op that accepts the same parameters.
 *
 * @param options - Observation options
 * @returns Decorated function that may be traced depending on lmnr availability
 *
 * @example
 * // As a method decorator
 * class MyClass {
 *   @observe({ name: 'myMethod', metadata: { version: '1.0' } })
 *   myMethod() {
 *     return 'result';
 *   }
 * }
 *
 * @example
 * // As a function wrapper
 * const tracedFn = observe({ name: 'myFunction' })(myFunction);
 */
export function observe(options: ObserveOptions = {}): any {
	const fullOptions = {
		name: options.name,
		ignore_input: options.ignoreInput ?? false,
		ignore_output: options.ignoreOutput ?? false,
		metadata: options.metadata,
		span_type: options.spanType ?? 'DEFAULT',
		tags: options.tags ?? ['observe', 'observe_debug'],
	};

	if (LMNR_AVAILABLE && lmnrObserve) {
		// Use the real lmnr observe decorator
		return lmnrObserve(fullOptions);
	} else {
		// Return a no-op wrapper
		return function <T>(target: T): T {
			// If target is a function, return it as-is
			if (typeof target === 'function') {
				return target;
			}
			// If used as a method decorator
			return target;
		};
	}
}

/**
 * Debug-only observability decorator that only traces when in debug mode.
 *
 * This decorator will use lmnr's observe decorator if both lmnr is installed
 * AND we're in debug mode, otherwise it will be a no-op.
 *
 * Debug mode is determined by:
 * - LMNR_LOGGING_LEVEL environment variable set to 'debug'
 *
 * @param options - Observation options
 * @returns Decorated function that may be traced only in debug mode
 *
 * @example
 * @observe_debug({ name: 'debugMethod', ignoreInput: true })
 * debugMethod() {
 *   return 'debug result';
 * }
 */
export function observe_debug(options: ObserveOptions = {}): any {
	const fullOptions = {
		name: options.name,
		ignore_input: options.ignoreInput ?? false,
		ignore_output: options.ignoreOutput ?? false,
		metadata: options.metadata,
		span_type: options.spanType ?? 'DEFAULT',
		tags: options.tags ?? ['observe_debug'],
	};

	if (LMNR_AVAILABLE && lmnrObserve && isDebugMode()) {
		// Use the real lmnr observe decorator only in debug mode
		return lmnrObserve(fullOptions);
	} else {
		// Return a no-op wrapper
		return function <T>(target: T): T {
			if (typeof target === 'function') {
				return target;
			}
			return target;
		};
	}
}

/**
 * Check if lmnr is available for tracing.
 */
export function isLmnrAvailable(): boolean {
	return LMNR_AVAILABLE;
}

/**
 * Get the current status of observability features.
 */
export function getObservabilityStatus(): {
	lmnrAvailable: boolean;
	debugMode: boolean;
	observeActive: boolean;
	observeDebugActive: boolean;
} {
	return {
		lmnrAvailable: LMNR_AVAILABLE,
		debugMode: isDebugMode(),
		observeActive: LMNR_AVAILABLE,
		observeDebugActive: LMNR_AVAILABLE && isDebugMode(),
	};
}

// Export debug mode check
export { isDebugMode };

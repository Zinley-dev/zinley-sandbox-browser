/**
 * Browser-use exceptions
 * Port from browser_use/exceptions.py and browser_use/browser/views.py
 *
 * Note: Some error classes are defined in their domain-specific modules:
 * - ModelError, ParseFailedGenerationError -> src/llm/
 * - EvaluateError -> src/code_use/
 * - CloudBrowserError, CloudBrowserAuthError -> src/cloud/
 */

/**
 * Base error for all browser-use errors
 */
export class BrowserUseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BrowserUseError';
	}
}

/**
 * LLM Exception with status code
 * Port from browser_use/exceptions.py
 */
export class LLMException extends BrowserUseError {
	statusCode: number;

	constructor(statusCode: number, message: string) {
		super(`Error ${statusCode}: ${message}`);
		this.name = 'LLMException';
		this.statusCode = statusCode;
	}
}

/**
 * Options for BrowserError constructor
 */
export interface BrowserErrorOptions {
	shortTermMemory?: string;
	longTermMemory?: string;
	details?: Record<string, any>;
	event?: any;
}

/**
 * Browser error with structured memory for LLM context management.
 * Port from browser_use/browser/views.py
 *
 * This exception class provides separate memory contexts for browser actions:
 * - shortTermMemory: Immediate context shown once to the LLM for the next action
 * - longTermMemory: Persistent error information stored across steps
 */
export class BrowserError extends BrowserUseError {
	shortTermMemory?: string;
	longTermMemory?: string;
	details?: Record<string, any>;
	whileHandlingEvent?: any;

	constructor(message: string, options?: BrowserErrorOptions) {
		super(message);
		this.name = 'BrowserError';
		this.shortTermMemory = options?.shortTermMemory;
		this.longTermMemory = options?.longTermMemory;
		this.details = options?.details;
		this.whileHandlingEvent = options?.event;
	}

	toString(): string {
		if (this.details) {
			return `${this.message} (${JSON.stringify(this.details)}) during: ${this.whileHandlingEvent}`;
		} else if (this.whileHandlingEvent) {
			return `${this.message} (while handling: ${this.whileHandlingEvent})`;
		}
		return this.message;
	}
}

/**
 * Error raised when a URL is not allowed
 * Port from browser_use/browser/views.py
 */
export class URLNotAllowedError extends BrowserError {
	constructor(message: string, options?: BrowserErrorOptions) {
		super(message, options);
		this.name = 'URLNotAllowedError';
	}
}

/**
 * Navigation error for page navigation issues
 */
export class NavigationError extends BrowserError {
	constructor(message: string, options?: BrowserErrorOptions) {
		super(message, options);
		this.name = 'NavigationError';
	}
}

/**
 * Element not found error
 */
export class ElementNotFoundError extends BrowserError {
	elementIndex?: number;
	selector?: string;

	constructor(
		message: string,
		options?: BrowserErrorOptions & {
			elementIndex?: number;
			selector?: string;
		}
	) {
		super(message, options);
		this.name = 'ElementNotFoundError';
		this.elementIndex = options?.elementIndex;
		this.selector = options?.selector;
	}
}

/**
 * File system error
 * Port from browser_use/filesystem/file_system.py
 */
export class FileSystemError extends BrowserUseError {
	constructor(message: string) {
		super(message);
		this.name = 'FileSystemError';
	}
}

/**
 * Session error for browser session issues
 */
export class SessionError extends BrowserError {
	sessionId?: string;

	constructor(message: string, options?: BrowserErrorOptions & { sessionId?: string }) {
		super(message, options);
		this.name = 'SessionError';
		this.sessionId = options?.sessionId;
	}
}

/**
 * Timeout error
 */
export class TimeoutError extends BrowserError {
	timeoutMs?: number;

	constructor(message: string, options?: BrowserErrorOptions & { timeoutMs?: number }) {
		super(message, options);
		this.name = 'TimeoutError';
		this.timeoutMs = options?.timeoutMs;
	}
}

/**
 * Action error for failed browser actions
 */
export class ActionError extends BrowserError {
	actionType?: string;
	targetElement?: any;

	constructor(
		message: string,
		options?: BrowserErrorOptions & {
			actionType?: string;
			targetElement?: any;
		}
	) {
		super(message, options);
		this.name = 'ActionError';
		this.actionType = options?.actionType;
		this.targetElement = options?.targetElement;
	}
}

/**
 * Agent error for agent-related issues
 */
export class AgentError extends BrowserUseError {
	step?: number;
	task?: string;

	constructor(message: string, options?: { step?: number; task?: string }) {
		super(message);
		this.name = 'AgentError';
		this.step = options?.step;
		this.task = options?.task;
	}
}

/**
 * Max steps reached error
 */
export class MaxStepsReachedError extends AgentError {
	maxSteps: number;

	constructor(message: string, maxSteps: number, options?: { step?: number; task?: string }) {
		super(message, options);
		this.name = 'MaxStepsReachedError';
		this.maxSteps = maxSteps;
	}
}

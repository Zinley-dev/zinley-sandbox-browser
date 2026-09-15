/**
 * Namespace initialization for code-use mode.
 * Port from browser_use/code_use/namespace.py
 *
 * This module creates a namespace with all browser tools available as functions,
 * similar to a Jupyter notebook environment.
 */

import { BrowserSession } from '../browser/session.js';
import { BaseChatModel } from '../llm/base.js';
import { FileSystem } from '../filesystem/file_system.js';
import { Tools } from '../tools/service.js';
import { getLogger } from '../logging_config.js';
import { stripJsComments } from './utils.js';

const logger = getLogger('browser-use.code_use.namespace');

/**
 * Special exception raised by evaluate() to stop execution immediately.
 */
export class EvaluateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EvaluateError';
	}
}

/**
 * Execute JavaScript code in the browser and return the result.
 *
 * @param code - JavaScript code to execute (must be wrapped in IIFE)
 * @param browserSession - The browser session to use
 * @returns The result of the JavaScript execution
 * @throws EvaluateError if JavaScript execution fails
 *
 * @example
 * const result = await evaluate(`
 *   (function(){
 *     return Array.from(document.querySelectorAll('.product')).map(p => ({
 *       name: p.querySelector('.name').textContent,
 *       price: p.querySelector('.price').textContent
 *     }))
 *   })()
 * `, browserSession);
 */
export async function evaluate(code: string, browserSession: BrowserSession): Promise<any> {
	// Strip JavaScript comments before CDP evaluation
	code = stripJsComments(code);

	// Get the current page from browser session and evaluate
	const page = browserSession.page;
	if (!page) {
		throw new EvaluateError('No page available');
	}

	try {
		// Use Playwright's evaluate which handles the CDP internally
		const result = await page.evaluate(code);
		return result;
	} catch (error: any) {
		// Build comprehensive error message
		const errorMsg = `JavaScript execution error: ${error.message || String(error)}`;
		throw new EvaluateError(errorMsg);
	}
}

/**
 * Validate if task is truly complete by asking LLM without system prompt or history.
 *
 * @param task - The original task description
 * @param output - The output from the done() call
 * @param llm - The LLM to use for validation
 * @returns Tuple of [isComplete, reasoning]
 */
export async function validateTaskCompletion(
	task: string,
	output: string | null,
	llm: BaseChatModel
): Promise<[boolean, string]> {
	// Build validation prompt
	const truncatedOutput = output ? output.slice(0, 100000) : '(No output provided)';
	const validationPrompt = `You are a task completion validator. Analyze if the agent has truly completed the user's task.

**Original Task:**
${task}

**Agent's Output:**
${truncatedOutput}

**Your Task:**
Determine if the agent has successfully completed the user's task. Consider:
1. Has the agent delivered what the user requested?
2. If data extraction was requested, is there actual data?
3. If the task is impossible (e.g., localhost website, login required but no credentials), is it truly impossible?
4. Could the agent continue and make meaningful progress?

**Response Format:**
Reasoning: [Your analysis of whether the task is complete]
Verdict: [YES or NO]

YES = Task is complete OR truly impossible to complete
NO = Agent should continue working`;

	try {
		// Call LLM with just the validation prompt
		const response = await llm.ainvoke([{ role: 'user', content: validationPrompt }]);
		const responseText = typeof response.completion === 'string'
			? response.completion
			: JSON.stringify(response.completion);

		// Parse the response
		let reasoning = '';
		let verdict = 'NO';

		const lines = responseText.split('\n');
		for (const line of lines) {
			const trimmedLine = line.trim().toLowerCase();
			if (trimmedLine.startsWith('reasoning:')) {
				reasoning = line.split(':', 2)[1]?.trim() || '';
			} else if (trimmedLine.startsWith('verdict:')) {
				const verdictText = line.split(':', 2)[1]?.trim().toUpperCase() || '';
				if (verdictText.includes('YES')) {
					verdict = 'YES';
				} else if (verdictText.includes('NO')) {
					verdict = 'NO';
				}
			}
		}

		// If we couldn't parse, use full response as reasoning
		if (!reasoning) {
			reasoning = responseText;
		}

		const isComplete = verdict === 'YES';

		logger.info(`Task validation: ${verdict}`);
		logger.debug(`Validation reasoning: ${reasoning}`);

		return [isComplete, reasoning];
	} catch (error) {
		logger.warn(`Failed to validate task completion: ${error}`);
		// On error, assume the agent knows what they're doing
		return [true, `Validation failed: ${error}`];
	}
}

/**
 * Namespace type definition
 */
export interface CodeNamespace {
	[key: string]: any;
	browser: BrowserSession;
	fileSystem: FileSystem | null;
	evaluate: (code: string, variables?: Record<string, any>) => Promise<any>;
	getSelectorFromIndex: (index: number) => Promise<string>;
	_evaluateFailures: Array<{ error: string; type: string }>;
	_taskDone: boolean;
	_taskResult: string | null;
	_taskSuccess: boolean | null;
	_codeBlockVars: Set<string>;
	_currentCellCode: string | null;
	_allCodeBlocks: Record<string, string>;
	_consecutiveErrors: number;
}

export interface CreateNamespaceOptions {
	browserSession: BrowserSession;
	tools?: Tools;
	pageExtractionLlm?: BaseChatModel;
	fileSystem?: FileSystem;
	availableFilePaths?: string[];
	sensitiveData?: Record<string, string | Record<string, string>>;
}

/**
 * Create a namespace with all browser tools available as functions.
 *
 * This function creates an object of functions that can be used to interact
 * with the browser, similar to a Jupyter notebook environment.
 *
 * @param options - Configuration options for the namespace
 * @returns Object containing all available functions
 *
 * @example
 * const namespace = createNamespace({ browserSession });
 * await namespace.navigate('https://google.com');
 * const result = await namespace.evaluate('document.title');
 */
export function createNamespace(options: CreateNamespaceOptions): CodeNamespace {
	const {
		browserSession,
		tools = new Tools(),
		pageExtractionLlm,
		fileSystem = null,
		availableFilePaths = [],
		sensitiveData = {},
	} = options;

	const namespace: CodeNamespace = {
		// Core objects
		browser: browserSession,
		fileSystem: fileSystem,

		// Internal tracking
		_evaluateFailures: [],
		_taskDone: false,
		_taskResult: null,
		_taskSuccess: null,
		_codeBlockVars: new Set(),
		_currentCellCode: null,
		_allCodeBlocks: {},
		_consecutiveErrors: 0,

		// Placeholder functions - will be replaced below
		evaluate: async () => null,
		getSelectorFromIndex: async () => '',
	};

	// Custom evaluate function that wraps code properly
	const evaluateWrapper = async (
		code: string,
		variables?: Record<string, any>
	): Promise<any> => {
		if (!code) {
			throw new Error('No JavaScript code provided to evaluate()');
		}

		// Inject variables if provided
		if (variables && Object.keys(variables).length > 0) {
			const varsJson = JSON.stringify(variables);
			const stripped = code.trim();

			// Check if code is already a function expression expecting params
			const funcMatch = stripped.match(/^\((?:async\s+)?function\s*\(\s*\w+\s*\)/);
			if (funcMatch) {
				// Already expects params, wrap to call it with our variables
				code = `(function(){ const params = ${varsJson}; return ${stripped}(params); })()`;
			} else {
				// Check if already wrapped in IIFE
				const isWrapped =
					(stripped.startsWith('(function()') && stripped.slice(-10).includes('})()')) ||
					(stripped.startsWith('(async function()') && stripped.slice(-10).includes('})()')) ||
					(stripped.startsWith('(() =>') && stripped.slice(-10).includes(')()')) ||
					(stripped.startsWith('(async () =>') && stripped.slice(-10).includes(')()'));

				if (isWrapped) {
					// Try to inject params at the start
					const funcIIFEMatch = stripped.match(/^(\((?:async\s+)?function\s*\(\s*\)\s*\{)/);
					if (funcIIFEMatch) {
						const prefix = funcIIFEMatch[1];
						const rest = stripped.slice(prefix.length);
						code = `${prefix} const params = ${varsJson}; ${rest}`;
					} else {
						// Arrow function or fallback
						const arrowMatch = stripped.match(/^(\((?:async\s+)?\(\s*\)\s*=>\s*\{)/);
						if (arrowMatch) {
							const prefix = arrowMatch[1];
							const rest = stripped.slice(prefix.length);
							code = `${prefix} const params = ${varsJson}; ${rest}`;
						} else {
							code = `(function(){ const params = ${varsJson}; return ${stripped}; })()`;
						}
					}
				} else {
					// Not wrapped, wrap with params
					code = `(function(){ const params = ${varsJson}; ${code} })()`;
					return await evaluate(code, browserSession);
				}
			}
		}

		// Auto-wrap in IIFE if not already wrapped
		if (!variables) {
			const stripped = code.trim();
			const isWrapped =
				(stripped.startsWith('(function()') && stripped.slice(-10).includes('})()')) ||
				(stripped.startsWith('(async function()') && stripped.slice(-10).includes('})()')) ||
				(stripped.startsWith('(() =>') && stripped.slice(-10).includes(')()')) ||
				(stripped.startsWith('(async () =>') && stripped.slice(-10).includes(')()'));

			if (!isWrapped) {
				code = `(function(){${code}})()`;
			}
		}

		// Execute and track failures
		try {
			const result = await evaluate(code, browserSession);

			// Print result structure for debugging
			if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') {
				let resultPreview = `list of dicts - len=${result.length}, example 1:\n`;
				const sampleResult = result[0];
				const keys = Object.keys(sampleResult).slice(0, 10);
				for (const key of keys) {
					const value = sampleResult[key];
					const valueStr = typeof value === 'string' ? value.slice(0, 10) : String(value);
					resultPreview += `  ${key}: ${valueStr}...\n`;
				}
				if (Object.keys(sampleResult).length > 10) {
					resultPreview += `  ... ${Object.keys(sampleResult).length - 10} more keys`;
				}
				console.log(resultPreview);
			} else if (Array.isArray(result)) {
				if (result.length === 0) {
					console.log('type=list, len=0');
				} else {
					const resultPreview = String(result).slice(0, 100);
					console.log(`type=list, len=${result.length}, preview=${resultPreview}...`);
				}
			} else if (typeof result === 'object' && result !== null) {
				let resultPreview = `type=dict, len=${Object.keys(result).length}, sample keys:\n`;
				const keys = Object.keys(result).slice(0, 10);
				for (const key of keys) {
					const value = result[key];
					const valueStr = typeof value === 'string' ? value.slice(0, 10) : String(value);
					resultPreview += `  ${key}: ${valueStr}...\n`;
				}
				if (Object.keys(result).length > 10) {
					resultPreview += `  ... ${Object.keys(result).length - 10} more keys`;
				}
				console.log(resultPreview);
			} else {
				console.log(`type=${typeof result}, value=${String(result).slice(0, 50)}`);
			}

			return result;
		} catch (error) {
			// Track errors for pattern detection
			namespace._evaluateFailures.push({ error: String(error), type: 'exception' });
			throw error;
		}
	};

	namespace.evaluate = evaluateWrapper;

	// Add get_selector_from_index helper
	const getSelectorFromIndexWrapper = async (index: number): Promise<string> => {
		// Get element by index from browser session
		const node = await browserSession.getElementByIndex(index);
		if (node === null) {
			const msg = `Element index ${index} not available - page may have changed. Try refreshing browser state.`;
			logger.warn(`⚠️ ${msg}`);
			throw new Error(msg);
		}

		// Generate CSS selector from the node
		// This is a simplified version - full implementation would use dom/utils
		if (node.attributes?.id) {
			return `#${CSS.escape(node.attributes.id)}`;
		}

		// Use nodeName (tag name) with classes
		let selector = node.nodeName?.toLowerCase() || 'div';
		if (node.attributes?.class) {
			const classes = node.attributes.class.split(/\s+/).filter(Boolean);
			if (classes.length > 0) {
				selector += '.' + classes.map((c: string) => CSS.escape(c)).join('.');
			}
		}

		return selector;
	};

	namespace.getSelectorFromIndex = getSelectorFromIndexWrapper;

	// Add browser control functions
	namespace.navigate = async (url: string) => {
		await browserSession.navigate(url);
		return `Navigated to ${url}`;
	};

	namespace.click = async (index: number) => {
		const element = await browserSession.getElementByIndex(index);
		if (!element) throw new Error(`Element at index ${index} not found`);
		await browserSession.clickElement(element);
		return `Clicked element ${index}`;
	};

	namespace.inputText = async (index: number, text: string) => {
		const element = await browserSession.getElementByIndex(index);
		if (!element) throw new Error(`Element at index ${index} not found`);
		await browserSession.typeText(text, element);
		return `Typed text into element ${index}`;
	};

	namespace.scroll = async (direction: 'up' | 'down', amount: number = 500) => {
		await browserSession.scroll(direction, amount);
		return `Scrolled ${direction} by ${amount}px`;
	};

	namespace.screenshot = async () => {
		return await browserSession.screenshot();
	};

	namespace.wait = async (seconds: number) => {
		await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
		return `Waited ${seconds} seconds`;
	};

	namespace.sendKeys = async (keys: string) => {
		await browserSession.sendKeys([keys]);
		return `Sent keys: ${keys}`;
	};

	namespace.goBack = async () => {
		await browserSession.goBack();
		return 'Navigated back';
	};

	namespace.goForward = async () => {
		await browserSession.goForward();
		return 'Navigated forward';
	};

	namespace.switchTab = async (tabId: string) => {
		await browserSession.switchTab(tabId);
		return `Switched to tab ${tabId}`;
	};

	namespace.closeTab = async (tabId: string) => {
		await browserSession.closeTab(tabId);
		return `Closed tab ${tabId}`;
	};

	// File system operations
	if (fileSystem) {
		namespace.readFile = async (filename: string) => {
			return await fileSystem.readFile(filename);
		};

		namespace.writeFile = async (filename: string, content: string) => {
			await fileSystem.writeFile(filename, content);
			return `Wrote to file ${filename}`;
		};
	}

	// Sensitive data access
	namespace.getSensitiveData = (key: string) => {
		return sensitiveData[key] || null;
	};

	// Done action - marks task as complete
	namespace.done = (text: string, success: boolean = true, data?: any) => {
		namespace._taskDone = true;
		namespace._taskResult = text;
		namespace._taskSuccess = success;
		return {
			_isDone: true,
			success,
			text,
			data,
		};
	};

	return namespace;
}

/**
 * Generate documentation for all available functions in the namespace.
 *
 * @param namespace - The namespace object
 * @returns Markdown-formatted documentation string
 */
export function getNamespaceDocumentation(namespace: CodeNamespace): string {
	const docs: string[] = ['# Available Functions\n'];

	// Document each function
	const sortedKeys = Object.keys(namespace).filter((k) => !k.startsWith('_')).sort();
	for (const name of sortedKeys) {
		const obj = namespace[name];
		if (typeof obj === 'function') {
			docs.push(`## ${name}\n`);
			// Add basic signature info
			docs.push(`Function: ${name}()\n`);
		}
	}

	return docs.join('\n');
}

/**
 * Code-use agent service - JavaScript code execution for browser automation
 * Port from browser_use/code_use/service.py
 */

import { v4 as uuidv4 } from 'uuid';
import { BrowserSession } from '../browser/session.js';
import { BaseChatModel } from '../llm/base.js';
import { BaseMessage, SystemMessage, UserMessage, AssistantMessage } from '../llm/messages.js';
import { Tools } from '../tools/service.js';
import { FileSystem } from '../filesystem/file_system.js';
import { ScreenshotService } from '../screenshots/service.js';
import path from 'path';
import os from 'os';

// Execution status for notebook cells
export enum ExecutionStatus {
	PENDING = 'pending',
	RUNNING = 'running',
	SUCCESS = 'success',
	ERROR = 'error',
}

// Notebook cell representing a single code execution
export interface NotebookCell {
	id: string;
	source: string;
	status: ExecutionStatus;
	output?: string;
	error?: string;
	executionCount?: number;
	browserState?: string;
	createdAt: Date;
	executedAt?: Date;
}

// Notebook session tracking all cells
export class NotebookSession {
	cells: NotebookCell[] = [];
	private executionCounter = 0;

	addCell(source: string): NotebookCell {
		const cell: NotebookCell = {
			id: uuidv4(),
			source,
			status: ExecutionStatus.PENDING,
			createdAt: new Date(),
		};
		this.cells.push(cell);
		return cell;
	}

	incrementExecutionCount(): number {
		return ++this.executionCounter;
	}

	get lastCell(): NotebookCell | undefined {
		return this.cells[this.cells.length - 1];
	}

	get isComplete(): boolean {
		return this.cells.some(
			(cell) => cell.output?.includes('done(') || cell.source.includes('done(')
		);
	}
}

// Code agent history entry
export interface CodeAgentHistory {
	stepNumber: number;
	code: string;
	llmResponse: string;
	output?: string;
	error?: string;
	screenshotPath?: string;
}

// Code agent result
export interface CodeAgentResult {
	success: boolean;
	text?: string;
	data?: any;
	error?: string;
}

export interface CodeAgentOptions {
	task: string;
	llm?: BaseChatModel;
	browserSession?: BrowserSession;
	tools?: Tools;
	pageExtractionLlm?: BaseChatModel;
	fileSystem?: FileSystem;
	availableFilePaths?: string[];
	sensitiveData?: Record<string, string | Record<string, string>>;
	maxSteps?: number;
	maxFailures?: number;
	useVision?: boolean;
	calculateCost?: boolean;
}

/**
 * Agent that executes JavaScript code in a browser automation context.
 *
 * This agent provides an interface where the LLM writes JavaScript code
 * that gets executed with browser control functions available.
 */
export class CodeAgent {
	private id: string;
	private task: string;
	private llm: BaseChatModel | null;
	private browserSession: BrowserSession | null;
	private tools: Tools;
	private pageExtractionLlm: BaseChatModel | null;
	private fileSystem: FileSystem;
	private availableFilePaths: string[];
	private sensitiveData: Record<string, string | Record<string, string>> | null;
	private maxSteps: number;
	private maxFailures: number;
	private useVision: boolean;

	private session: NotebookSession;
	private namespace: Record<string, any> = {};
	private llmMessages: BaseMessage[] = [];
	private completeHistory: CodeAgentHistory[] = [];
	private consecutiveErrors = 0;
	private lastBrowserStateText: string | null = null;
	private lastScreenshot: string | null = null;

	private agentDirectory: string;
	private screenshotService: ScreenshotService | null = null;

	constructor(options: CodeAgentOptions) {
		this.id = uuidv4();
		this.task = options.task;
		this.llm = options.llm || null;
		this.browserSession = options.browserSession || null;
		this.tools = options.tools || new Tools();
		this.pageExtractionLlm = options.pageExtractionLlm || null;
		this.fileSystem = options.fileSystem || new FileSystem('./');
		this.availableFilePaths = options.availableFilePaths || [];
		this.sensitiveData = options.sensitiveData || null;
		this.maxSteps = options.maxSteps ?? 100;
		this.maxFailures = options.maxFailures ?? 8;
		this.useVision = options.useVision ?? true;

		this.session = new NotebookSession();

		// Create agent directory for screenshots
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		this.agentDirectory = path.join(os.tmpdir(), `browser_use_code_agent_${this.id}_${timestamp}`);
		this.screenshotService = new ScreenshotService(this.agentDirectory);
	}

	/**
	 * Create the execution namespace with browser functions
	 */
	private createNamespace(): Record<string, any> {
		const browserSession = this.browserSession;
		const fileSystem = this.fileSystem;
		const sensitiveData = this.sensitiveData;

		return {
			// Browser navigation
			navigate: async (url: string) => {
				if (!browserSession) throw new Error('Browser session not initialized');
				await browserSession.navigate(url);
				return `Navigated to ${url}`;
			},

			// Element interaction
			click: async (index: number) => {
				if (!browserSession) throw new Error('Browser session not initialized');
				const element = await browserSession.getElementByIndex(index);
				if (!element) throw new Error(`Element at index ${index} not found`);
				await browserSession.clickElement(element);
				return `Clicked element ${index}`;
			},

			type: async (index: number, text: string) => {
				if (!browserSession) throw new Error('Browser session not initialized');
				const element = await browserSession.getElementByIndex(index);
				if (!element) throw new Error(`Element at index ${index} not found`);
				await browserSession.typeText(text, element);
				return `Typed text into element ${index}`;
			},

			scroll: async (direction: 'up' | 'down', amount: number = 500) => {
				if (!browserSession) throw new Error('Browser session not initialized');
				await browserSession.scroll(direction, amount);
				return `Scrolled ${direction} by ${amount}px`;
			},

			// Screenshot
			screenshot: async () => {
				if (!browserSession) throw new Error('Browser session not initialized');
				const screenshot = await browserSession.screenshot();
				return screenshot;
			},

			// Browser state
			getState: async () => {
				if (!browserSession) throw new Error('Browser session not initialized');
				return await browserSession.getState();
			},

			// Wait
			wait: async (seconds: number) => {
				await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
				return `Waited ${seconds} seconds`;
			},

			// Send keys
			sendKeys: async (keys: string) => {
				if (!browserSession) throw new Error('Browser session not initialized');
				await browserSession.sendKeys([keys]);
				return `Sent keys: ${keys}`;
			},

			// Tab management
			switchTab: async (tabId: string) => {
				if (!browserSession) throw new Error('Browser session not initialized');
				await browserSession.switchTab(tabId);
				return `Switched to tab ${tabId}`;
			},

			closeTab: async (tabId: string) => {
				if (!browserSession) throw new Error('Browser session not initialized');
				await browserSession.closeTab(tabId);
				return `Closed tab ${tabId}`;
			},

			// File system operations
			readFile: async (filename: string) => {
				return await fileSystem.readFile(filename);
			},

			writeFile: async (filename: string, content: string) => {
				await fileSystem.writeFile(filename, content);
				return `Wrote to file ${filename}`;
			},

			// Get sensitive data
			getSensitiveData: (key: string) => {
				if (!sensitiveData) return null;
				return sensitiveData[key] || null;
			},

			// Done action - marks task as complete
			done: (text: string, success: boolean = true, data?: any) => {
				return {
					_isDone: true,
					success,
					text,
					data,
				};
			},

			// Console for output capture
			console: {
				log: (...args: any[]) => console.log('[CodeAgent]', ...args),
				error: (...args: any[]) => console.error('[CodeAgent]', ...args),
				warn: (...args: any[]) => console.warn('[CodeAgent]', ...args),
			},

			// Utilities
			sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
		};
	}

	/**
	 * Execute JavaScript code in the namespace
	 */
	private async executeCode(code: string): Promise<{ output: string | null; error: string | null }> {
		try {
			// Create async function wrapper to support await
			const asyncFn = new Function(
				...Object.keys(this.namespace),
				`return (async () => {
					${code}
				})()`
			);

			const result = await asyncFn(...Object.values(this.namespace));

			// Check if result is a done() call
			if (result && typeof result === 'object' && result._isDone) {
				return {
					output: JSON.stringify(result, null, 2),
					error: null,
				};
			}

			return {
				output: result !== undefined ? String(result) : null,
				error: null,
			};
		} catch (error: any) {
			return {
				output: null,
				error: error.message || String(error),
			};
		}
	}

	/**
	 * Get browser state for LLM context
	 */
	private async getBrowserState(): Promise<{ text: string; screenshot: string | null }> {
		if (!this.browserSession) {
			return { text: 'Browser not initialized', screenshot: null };
		}

		try {
			const state = await this.browserSession.getState();
			let screenshot: string | null = null;

			if (this.useVision) {
				screenshot = await this.browserSession.screenshot();
			}

			// Format state for LLM
			const stateText = `Current URL: ${state.url}
Title: ${state.title}
Tabs: ${state.tabs.map((t) => `${t.targetId}: ${t.title}`).join(', ')}

Interactive Elements:
${state.domTree?.llmRepresentation?.([]) || 'No elements extracted'}`;

			return { text: stateText, screenshot };
		} catch (error: any) {
			return { text: `Error getting browser state: ${error.message}`, screenshot: null };
		}
	}

	/**
	 * Extract code blocks from LLM response
	 */
	private extractCodeBlocks(response: string): string[] {
		const codeBlockRegex = /```(?:javascript|js|typescript|ts)?\n([\s\S]*?)```/g;
		const blocks: string[] = [];
		let match;

		while ((match = codeBlockRegex.exec(response)) !== null) {
			blocks.push(match[1].trim());
		}

		return blocks;
	}

	/**
	 * Get code from LLM
	 */
	private async getCodeFromLlm(): Promise<{ code: string; fullResponse: string }> {
		if (!this.llm) {
			throw new Error('LLM not initialized');
		}

		// Add browser state to context
		const { text: browserStateText, screenshot } = await this.getBrowserState();
		this.lastBrowserStateText = browserStateText;
		this.lastScreenshot = screenshot;

		// Build context message
		let contextContent = `
<browser_state>
${browserStateText}
</browser_state>

Write JavaScript code to accomplish the next step of the task. Available functions:
- navigate(url) - Navigate to a URL
- click(index) - Click element by index
- type(index, text) - Type text into element
- scroll(direction, amount) - Scroll up/down
- screenshot() - Take a screenshot
- getState() - Get current browser state
- wait(seconds) - Wait for specified seconds
- sendKeys(keys) - Send keyboard keys
- switchTab(tabId) - Switch to a tab
- closeTab(tabId) - Close a tab
- readFile(filename) - Read file contents
- writeFile(filename, content) - Write to file
- done(text, success, data) - Complete the task

All functions are async, use await.
`;

		// Add screenshot if available
		if (screenshot && this.useVision) {
			this.llmMessages.push({
				role: 'user',
				content: [
					{ type: 'text', text: contextContent },
					{
						type: 'image_url',
						imageUrl: {
							url: `data:image/jpeg;base64,${screenshot}`,
							mediaType: 'image/jpeg',
							detail: 'high',
						},
					},
				],
			});
		} else {
			this.llmMessages.push({
				role: 'user',
				content: contextContent,
			});
		}

		// Call LLM
		const response = await this.llm.ainvoke(this.llmMessages);
		const fullResponse = typeof response.completion === 'string'
			? response.completion
			: JSON.stringify(response.completion);

		// Add assistant response to messages
		this.llmMessages.push({
			role: 'assistant',
			content: fullResponse,
		});

		// Extract code blocks
		const codeBlocks = this.extractCodeBlocks(fullResponse);
		const code = codeBlocks.join('\n\n');

		return { code, fullResponse };
	}

	/**
	 * Run the agent to complete the task
	 */
	async run(maxSteps?: number): Promise<NotebookSession> {
		const stepsToRun = maxSteps ?? this.maxSteps;

		// Start browser if not provided
		if (!this.browserSession) {
			this.browserSession = new BrowserSession({});
			await this.browserSession.start();
		}

		// Initialize screenshot service
		if (this.screenshotService) {
			await this.screenshotService.initialize();
		}

		// Create namespace with browser functions
		this.namespace = this.createNamespace();

		// Initialize conversation with task
		const systemPrompt = `You are a browser automation agent that writes JavaScript code to accomplish tasks.
Write concise, working JavaScript code using the provided browser control functions.
Always use await for async functions. Wrap your code in \`\`\`javascript code blocks.
Call done(text, success) when the task is complete.`;

		this.llmMessages.push({ role: 'system', content: systemPrompt });
		this.llmMessages.push({ role: 'user', content: `Task: ${this.task}` });

		// Main execution loop
		for (let step = 0; step < stepsToRun; step++) {
			console.log(`\n📋 Step ${step + 1}/${stepsToRun}`);

			// Check for step/error limits
			const stepsRemaining = stepsToRun - step - 1;
			if (stepsRemaining <= 1 || this.consecutiveErrors >= this.maxFailures - 1) {
				this.llmMessages.push({
					role: 'user',
					content: `⚠️ WARNING: ${stepsRemaining + 1} steps remaining, ${this.consecutiveErrors}/${this.maxFailures} errors. Call done() in your next response.`,
				});
			}

			try {
				// Get code from LLM
				const { code, fullResponse } = await this.getCodeFromLlm();

				if (!code || code.trim() === '') {
					console.warn('LLM returned empty code');
					this.consecutiveErrors++;

					if (this.session.isComplete) {
						console.log('Task marked as complete');
						break;
					}
					continue;
				}

				// Add cell to notebook
				const cell = this.session.addCell(code);
				cell.status = ExecutionStatus.RUNNING;
				cell.executionCount = this.session.incrementExecutionCount();

				// Execute code
				const { output, error } = await this.executeCode(code);

				if (error) {
					cell.status = ExecutionStatus.ERROR;
					cell.error = error;
					this.consecutiveErrors++;
					console.error(`❌ Error: ${error}`);

					// Add error to LLM context
					this.llmMessages.push({
						role: 'user',
						content: `Error executing code: ${error}\nPlease fix and try again.`,
					});

					if (this.consecutiveErrors >= this.maxFailures) {
						console.error(`Terminating: ${this.maxFailures} consecutive errors`);
						break;
					}
				} else {
					cell.status = ExecutionStatus.SUCCESS;
					cell.output = output || '';
					cell.executedAt = new Date();
					this.consecutiveErrors = 0;
					console.log(`✅ Output: ${output || '(no output)'}`);

					// Check if done was called
					if (output && output.includes('"_isDone":true')) {
						console.log('🎉 Task completed!');
						break;
					}
				}

				// Add to history
				this.completeHistory.push({
					stepNumber: step + 1,
					code,
					llmResponse: fullResponse,
					output: output || undefined,
					error: error || undefined,
				});

			} catch (error: any) {
				console.error(`Step failed: ${error.message}`);
				this.consecutiveErrors++;

				if (this.consecutiveErrors >= this.maxFailures) {
					console.error(`Terminating: ${this.maxFailures} consecutive errors`);
					break;
				}
			}
		}

		return this.session;
	}

	/**
	 * Get the complete history of agent execution
	 */
	getHistory(): CodeAgentHistory[] {
		return this.completeHistory;
	}

	/**
	 * Get the result of the agent execution
	 */
	getResult(): CodeAgentResult | null {
		const lastCell = this.session.lastCell;
		if (!lastCell || lastCell.status !== ExecutionStatus.SUCCESS) {
			return null;
		}

		try {
			if (lastCell.output) {
				const parsed = JSON.parse(lastCell.output);
				if (parsed._isDone) {
					return {
						success: parsed.success,
						text: parsed.text,
						data: parsed.data,
					};
				}
			}
		} catch {
			// Not a done() result
		}

		return null;
	}

	/**
	 * Format execution result for LLM context
	 */
	private _formatExecutionResult(output: string | null, error: string | null): string {
		const parts: string[] = [];

		if (error) {
			parts.push(`<execution_error>\n${error}\n</execution_error>`);
		}

		if (output) {
			// Truncate very long outputs
			const maxLength = 10000;
			let formattedOutput = output;
			if (output.length > maxLength) {
				formattedOutput = output.substring(0, maxLength) + '\n... [Output truncated]';
			}
			parts.push(`<execution_output>\n${formattedOutput}\n</execution_output>`);
		}

		if (parts.length === 0) {
			return '<execution_output>Code executed successfully with no output</execution_output>';
		}

		return parts.join('\n');
	}

	/**
	 * Check if task is marked as done in the namespace
	 */
	private _isTaskDone(result: any): boolean {
		if (result && typeof result === 'object' && result._isDone === true) {
			return true;
		}

		// Check session completion status
		if (this.session.isComplete) {
			return true;
		}

		return false;
	}

	/**
	 * Capture screenshot and save to agent directory
	 */
	private async _captureScreenshot(stepNumber: number): Promise<string | null> {
		if (!this.browserSession || !this.screenshotService) {
			return null;
		}

		try {
			const screenshot = await this.browserSession.screenshot();
			if (screenshot) {
				const screenshotPath = await this.screenshotService.storeScreenshot(
					screenshot,
					stepNumber
				);
				return screenshotPath;
			}
		} catch (error: any) {
			console.warn(`Failed to capture screenshot: ${error.message}`);
		}

		return null;
	}

	/**
	 * Get all screenshot paths from history
	 */
	get screenshotPaths(): string[] {
		return this.completeHistory
			.filter((h) => h.screenshotPath)
			.map((h) => h.screenshotPath!);
	}

	/**
	 * Close the browser session and cleanup resources
	 */
	async close(): Promise<void> {
		try {
			// Stop browser session if we created it
			if (this.browserSession) {
				await this.browserSession.stop();
				this.browserSession = null;
			}

			// Clear screenshot service reference
			this.screenshotService = null;

			// Clear namespace
			this.namespace = {};

			// Clear LLM messages to free memory
			this.llmMessages = [];

		} catch (error: any) {
			console.warn(`Error during cleanup: ${error.message}`);
		}
	}

	/**
	 * Get the agent directory path
	 */
	getAgentDirectory(): string {
		return this.agentDirectory;
	}

	/**
	 * Get the current notebook session
	 */
	getSession(): NotebookSession {
		return this.session;
	}

	/**
	 * Get execution statistics
	 */
	getStats(): {
		totalSteps: number;
		successfulSteps: number;
		failedSteps: number;
		consecutiveErrors: number;
	} {
		const successfulSteps = this.session.cells.filter(
			(c) => c.status === ExecutionStatus.SUCCESS
		).length;
		const failedSteps = this.session.cells.filter(
			(c) => c.status === ExecutionStatus.ERROR
		).length;

		return {
			totalSteps: this.session.cells.length,
			successfulSteps,
			failedSteps,
			consecutiveErrors: this.consecutiveErrors,
		};
	}

	// ============================================================================
	// History Methods (Port from Python)
	// ============================================================================

	/**
	 * Add step to complete history
	 * Port from browser_use/code_use/service.py _add_step_to_complete_history (lines 1085-1156)
	 */
	private async _addStepToCompleteHistory(
		stepNumber: number,
		code: string,
		llmResponse: string,
		output?: string,
		error?: string
	): Promise<void> {
		// Capture screenshot for history
		const screenshotPath = await this._captureScreenshot(stepNumber);

		this.completeHistory.push({
			stepNumber,
			code,
			llmResponse,
			output,
			error,
			screenshotPath: screenshotPath ?? undefined,
		});
	}

	/**
	 * Print variable information for debugging
	 * Port from browser_use/code_use/service.py _print_variable_info (lines 698-733)
	 */
	private _printVariableInfo(varName: string, value: any): void {
		const valueType = typeof value;

		if (value === null || value === undefined) {
			console.log(`  ${varName} = ${value} (${valueType})`);
			return;
		}

		if (Array.isArray(value)) {
			console.log(`  ${varName} = Array(${value.length})`);
			if (value.length <= 5) {
				value.forEach((item, i) => console.log(`    [${i}] = ${JSON.stringify(item)}`));
			} else {
				console.log(`    [0] = ${JSON.stringify(value[0])}`);
				console.log(`    ... ${value.length - 2} more items ...`);
				console.log(`    [${value.length - 1}] = ${JSON.stringify(value[value.length - 1])}`);
			}
			return;
		}

		if (valueType === 'object') {
			const keys = Object.keys(value);
			console.log(`  ${varName} = Object(${keys.length} keys)`);
			keys.slice(0, 5).forEach((key) => {
				const val = value[key];
				const valStr = typeof val === 'string' && val.length > 50 ? val.substring(0, 50) + '...' : val;
				console.log(`    ${key}: ${JSON.stringify(valStr)}`);
			});
			if (keys.length > 5) {
				console.log(`    ... ${keys.length - 5} more keys`);
			}
			return;
		}

		// Simple value
		const valueStr = String(value);
		const displayValue = valueStr.length > 100 ? valueStr.substring(0, 100) + '...' : valueStr;
		console.log(`  ${varName} = ${displayValue} (${valueType})`);
	}

	/**
	 * Log agent event for telemetry
	 * Port from browser_use/code_use/service.py _log_agent_event (lines 1158-1225)
	 */
	private _logAgentEvent(maxSteps: number, agentRunError: string | null = null): void {
		const stats = this.getStats();
		const result = this.getResult();

		const event = {
			type: 'code_agent_run',
			agentId: this.id,
			task: this.task,
			maxSteps,
			stepsCompleted: stats.totalSteps,
			successfulSteps: stats.successfulSteps,
			failedSteps: stats.failedSteps,
			success: result?.success ?? false,
			error: agentRunError || result?.error,
			timestamp: new Date().toISOString(),
		};

		console.debug('📊 Code Agent event:', JSON.stringify(event, null, 2));
	}

	// ============================================================================
	// Message Manager Property
	// ============================================================================

	/**
	 * Get message manager (LLM messages)
	 * Port from browser_use/code_use/service.py message_manager (lines 1245-1257)
	 */
	get messageManager(): { messages: BaseMessage[] } {
		return {
			messages: this.llmMessages,
		};
	}

	// ============================================================================
	// History Property with Wrapper
	// ============================================================================

	/**
	 * Get history as structured object
	 * Port from browser_use/code_use/service.py history (lines 1259-1313)
	 */
	get history(): {
		data: CodeAgentHistory[];
		getScreenshot: (stepNumber: number) => string | undefined;
		modelDump: () => any;
	} {
		const historyData = this.completeHistory;

		return {
			data: historyData,
			getScreenshot: (stepNumber: number) => {
				const step = historyData.find((h) => h.stepNumber === stepNumber);
				return step?.screenshotPath;
			},
			modelDump: () => ({
				task: this.task,
				history: historyData,
				session: {
					cells: this.session.cells,
					isComplete: this.session.isComplete,
				},
			}),
		};
	}

	// ============================================================================
	// Usage Summary
	// ============================================================================

	/**
	 * Get usage summary (token counts, costs, etc.)
	 */
	getUsageSummary(): {
		totalMessages: number;
		totalCells: number;
		inputTokensEstimate: number;
		outputTokensEstimate: number;
	} {
		// Rough token estimation (4 chars per token average)
		let inputTokens = 0;
		let outputTokens = 0;

		for (const msg of this.llmMessages) {
			const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
			if (msg.role === 'user' || msg.role === 'system') {
				inputTokens += Math.ceil(content.length / 4);
			} else {
				outputTokens += Math.ceil(content.length / 4);
			}
		}

		return {
			totalMessages: this.llmMessages.length,
			totalCells: this.session.cells.length,
			inputTokensEstimate: inputTokens,
			outputTokensEstimate: outputTokens,
		};
	}

	// ============================================================================
	// Async Context Manager Support
	// ============================================================================

	/**
	 * Use as async context: await codeAgent.withSession(async (agent) => { ... })
	 */
	async withSession<T>(fn: (agent: CodeAgent) => Promise<T>): Promise<T> {
		try {
			return await fn(this);
		} finally {
			await this.close();
		}
	}

	// ============================================================================
	// Export History
	// ============================================================================

	/**
	 * Export history to JSON file
	 */
	async exportHistoryToFile(filePath: string): Promise<void> {
		const fs = await import('fs/promises');
		const data = {
			task: this.task,
			agentId: this.id,
			history: this.completeHistory,
			session: {
				cells: this.session.cells,
				isComplete: this.session.isComplete,
			},
			stats: this.getStats(),
			result: this.getResult(),
			exportedAt: new Date().toISOString(),
		};

		await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
		console.log(`📁 Exported history to ${filePath}`);
	}

	/**
	 * Load and continue from exported history
	 */
	async loadHistory(filePath: string): Promise<void> {
		const fs = await import('fs/promises');
		const content = await fs.readFile(filePath, 'utf-8');
		const data = JSON.parse(content);

		// Restore history
		this.completeHistory = data.history || [];

		// Restore session cells
		if (data.session?.cells) {
			for (const cell of data.session.cells) {
				this.session.cells.push(cell);
			}
		}

		console.log(`📁 Loaded history from ${filePath} (${this.completeHistory.length} steps)`);
	}
}

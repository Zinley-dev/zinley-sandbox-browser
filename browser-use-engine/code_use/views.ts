/**
 * Data models for code-use mode.
 * Port from browser_use/code_use/views.py
 */

import * as fs from 'fs';

/**
 * Type of notebook cell.
 */
export enum CellType {
	CODE = 'code',
	MARKDOWN = 'markdown',
}

/**
 * Execution status of a cell.
 */
export enum ExecutionStatus {
	PENDING = 'pending',
	RUNNING = 'running',
	SUCCESS = 'success',
	ERROR = 'error',
}

/**
 * Generate a UUID v7-like string
 */
function generateUuid(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Represents a code cell in the notebook-like execution.
 */
export interface CodeCell {
	id: string;
	cellType: CellType;
	source: string;
	output: string | null;
	executionCount: number | null;
	status: ExecutionStatus;
	error: string | null;
	browserState: string | null;
}

/**
 * Create a new code cell
 */
export function createCodeCell(source: string): CodeCell {
	return {
		id: generateUuid(),
		cellType: CellType.CODE,
		source,
		output: null,
		executionCount: null,
		status: ExecutionStatus.PENDING,
		error: null,
		browserState: null,
	};
}

/**
 * Represents a notebook-like session.
 */
export interface NotebookSession {
	id: string;
	cells: CodeCell[];
	currentExecutionCount: number;
	namespace: Record<string, any>;
}

/**
 * Create a new notebook session
 */
export function createNotebookSession(): NotebookSession {
	return {
		id: generateUuid(),
		cells: [],
		currentExecutionCount: 0,
		namespace: {},
	};
}

/**
 * Add a new code cell to the session
 */
export function addCell(session: NotebookSession, source: string): CodeCell {
	const cell = createCodeCell(source);
	session.cells.push(cell);
	return cell;
}

/**
 * Get a cell by ID
 */
export function getCell(session: NotebookSession, cellId: string): CodeCell | null {
	return session.cells.find((c) => c.id === cellId) || null;
}

/**
 * Get the most recently added cell
 */
export function getLatestCell(session: NotebookSession): CodeCell | null {
	return session.cells.length > 0 ? session.cells[session.cells.length - 1] : null;
}

/**
 * Increment and return the execution count
 */
export function incrementExecutionCount(session: NotebookSession): number {
	session.currentExecutionCount += 1;
	return session.currentExecutionCount;
}

/**
 * Export format for Jupyter notebook.
 */
export interface NotebookExport {
	nbformat: number;
	nbformat_minor: number;
	metadata: Record<string, any>;
	cells: Record<string, any>[];
}

/**
 * Create a new notebook export
 */
export function createNotebookExport(metadata: Record<string, any> = {}): NotebookExport {
	return {
		nbformat: 4,
		nbformat_minor: 5,
		metadata,
		cells: [],
	};
}

/**
 * Model output for CodeAgent - contains the code and full LLM response.
 */
export interface CodeAgentModelOutput {
	modelOutput: string;
	fullResponse: string;
}

/**
 * Result of executing a code cell in CodeAgent.
 */
export interface CodeAgentResult {
	extractedContent: string | null;
	error: string | null;
	isDone: boolean;
	success: boolean | null;
}

/**
 * Create a default code agent result
 */
export function createCodeAgentResult(): CodeAgentResult {
	return {
		extractedContent: null,
		error: null,
		isDone: false,
		success: null,
	};
}

/**
 * State information for a CodeAgent step.
 */
export interface CodeAgentState {
	url: string | null;
	title: string | null;
	screenshotPath: string | null;
}

/**
 * Get screenshot from disk and return as base64 string.
 */
export function getScreenshot(state: CodeAgentState): string | null {
	if (!state.screenshotPath) {
		return null;
	}

	try {
		if (!fs.existsSync(state.screenshotPath)) {
			return null;
		}

		const screenshotData = fs.readFileSync(state.screenshotPath);
		return screenshotData.toString('base64');
	} catch {
		return null;
	}
}

/**
 * Metadata for a single CodeAgent step including timing and token information.
 */
export interface CodeAgentStepMetadata {
	inputTokens: number | null;
	outputTokens: number | null;
	stepStartTime: number;
	stepEndTime: number;
}

/**
 * Get step duration in seconds.
 */
export function getDurationSeconds(metadata: CodeAgentStepMetadata): number {
	return metadata.stepEndTime - metadata.stepStartTime;
}

/**
 * History item for CodeAgent actions.
 */
export interface CodeAgentHistory {
	modelOutput: CodeAgentModelOutput | null;
	result: CodeAgentResult[];
	state: CodeAgentState;
	metadata: CodeAgentStepMetadata | null;
	screenshotPath: string | null;
}

/**
 * Legacy interface for backwards compatibility
 */
export interface CodeExecutionResult {
	output: string;
	error?: string | null;
	exitCode: number;
}

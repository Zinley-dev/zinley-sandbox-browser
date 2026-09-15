export {
	CodeAgent,
	NotebookSession,
	ExecutionStatus,
	type NotebookCell,
	type CodeAgentHistory,
	type CodeAgentResult,
	type CodeAgentOptions,
} from './service.js';

// Keep old export for backwards compatibility
export { CodeAgent as CodeUseAgent } from './service.js';

// Export views
export {
	CellType,
	ExecutionStatus as CellExecutionStatus,
	type CodeCell,
	type NotebookExport,
	type CodeAgentModelOutput,
	type CodeAgentState,
	type CodeAgentStepMetadata,
	createCodeCell,
	createNotebookSession,
	createNotebookExport,
	createCodeAgentResult,
	addCell,
	getCell,
	getLatestCell,
	incrementExecutionCount,
	getScreenshot,
	getDurationSeconds as getCodeAgentDurationSeconds,
} from './views.js';

// Export utilities
export {
	truncateMessageContent,
	detectTokenLimitIssue,
	extractUrlFromTask,
	extractCodeBlocks,
	stripJsComments,
} from './utils.js';

// Export formatting
export { formatBrowserStateForLlm } from './formatting.js';

// Export notebook export
export { exportToIpynb, sessionToPythonScript, exportToNotebook } from './notebook_export.js';

// Export namespace
export {
	EvaluateError,
	evaluate,
	validateTaskCompletion,
	createNamespace,
	getNamespaceDocumentation,
	type CodeNamespace,
	type CreateNamespaceOptions,
} from './namespace.js';

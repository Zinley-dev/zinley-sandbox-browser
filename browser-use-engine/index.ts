/**
 * Browser-Use - Make websites accessible for AI agents
 * Node.js/TypeScript port of the Python browser-use library
 */

// Core exports
export * from './agent/index.js';
export * from './browser/index.js';
export * from './dom/index.js';
export * from './actions/index.js';
export * from './events/index.js';
export * from './llm/index.js';
export * from './types/index.js';
export * from './telemetry/index.js';
export * from './tokens/index.js';
export * from './cloud/index.js';
export * from './gif/index.js';
export * from './code_use/index.js';

// Utilities
export { observe, observe_debug } from './observability.js';
export { configureLogging, logger } from './logging_config.js';

// Re-export commonly used classes for convenience
export { Agent } from './agent/service.js';
export { BrowserSession } from './browser/session.js';
export { ChatOpenAI } from './llm/openai/index.js';
export { ChatAnthropic } from './llm/anthropic/index.js';
export { ChatGoogle } from './llm/google/index.js';
export { ChatAzureOpenAI } from './llm/azure/index.js';
export { ActionRegistry } from './actions/registry.js';
export { registerBuiltinActions } from './actions/builtin.js';
export { Tools, CodeAgentTools, handleBrowserError } from './tools/service.js';
export * from './tools/views.js';
export {
	getClickDescription,
	isAutocompleteField,
	buildSearchPageJs,
	buildFindElementsJs,
	formatSearchResults,
	formatFindResults,
	parseEnvActionTimeout,
	coerceValidActionTimeout,
	ActionTimeoutError,
} from './tools/utils.js';
export { schemaDictToZod, UnsupportedSchemaError } from './tools/extraction/schema_utils.js';
export { createExtractionResult, type ExtractionResult } from './tools/extraction/views.js';
export { Registry, replaceSensitiveData, collectApplicableSecrets } from './tools/registry/service.js';
export * from './integrations/index.js';
export * from './screenshots/index.js';
export * from './sync/index.js';
export { config } from './config.js';
export * from './exceptions.js';

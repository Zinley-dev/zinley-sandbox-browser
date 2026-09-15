/**
 * Telemetry data models
 * Port from browser_use/telemetry/views.py (synced with 0.13.10)
 */

import { isRunningInDocker } from '../config.js';

/**
 * Base telemetry event interface
 */
export interface BaseTelemetryEvent {
	name: string;
	properties: Record<string, any>;
}

/**
 * Agent telemetry event
 */
export interface AgentTelemetryEvent extends BaseTelemetryEvent {
	name: 'agent_event';
	// Start details
	task: string;
	model: string;
	modelProvider: string;
	maxSteps: number;
	maxActionsPerStep: number;
	useVision: boolean | 'auto';
	version: string;
	source: string;
	cdpUrl: string | null;
	agentType: string | null;
	// Step details
	actionErrors: (string | null)[];
	actionHistory: (Record<string, any>[] | null)[];
	urlsVisited: (string | null)[];
	// End details
	steps: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	promptCachedTokens: number;
	totalTokens: number;
	totalDurationSeconds: number;
	success: boolean | null;
	finalResultResponse: string | null;
	errorMessage: string | null;
	// Judge details (optional; only set when the judge ran)
	judgeVerdict?: boolean | null;
	judgeReasoning?: string | null;
	judgeFailureReason?: string | null;
	judgeReachedCaptcha?: boolean | null;
	judgeImpossibleTask?: boolean | null;
}

/**
 * MCP client telemetry event
 */
export interface MCPClientTelemetryEvent extends BaseTelemetryEvent {
	name: 'mcp_client_event';
	serverName: string;
	command: string;
	toolsDiscovered: number;
	version: string;
	action: 'connect' | 'disconnect' | 'tool_call';
	toolName?: string | null;
	durationSeconds?: number | null;
	errorMessage?: string | null;
}

/**
 * MCP server telemetry event
 */
export interface MCPServerTelemetryEvent extends BaseTelemetryEvent {
	name: 'mcp_server_event';
	version: string;
	action: 'start' | 'stop' | 'tool_call';
	toolName?: string | null;
	durationSeconds?: number | null;
	errorMessage?: string | null;
	parentProcessCmdline?: string | null;
}

/**
 * Create agent telemetry event
 */
export function createAgentTelemetryEvent(data: Omit<AgentTelemetryEvent, 'name' | 'properties'>): AgentTelemetryEvent {
	const props = { ...data, isDocker: isRunningInDocker() };
	return {
		name: 'agent_event',
		properties: props,
		...data,
	};
}

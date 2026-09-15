/**
 * Agent cloud events for syncing with browser-use cloud service.
 * Port from browser_use/agent/cloud_events.py
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// Max limits for fields
const MAX_STRING_LENGTH = 500000; // 500K chars (Python 0.13.10)
const MAX_URL_LENGTH = 100000;
const MAX_TASK_LENGTH = 100000;
const MAX_COMMENT_LENGTH = 2000;
const MAX_FILE_CONTENT_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Base interface for all cloud events
 */
export interface BaseCloudEvent {
	id?: string;
	userId?: string;
	deviceId?: string | null;
}

/**
 * Event to update an existing agent task
 */
export interface UpdateAgentTaskEvent extends BaseCloudEvent {
	stopped?: boolean | null;
	paused?: boolean | null;
	doneOutput?: string | null;
	finishedAt?: Date | null;
	agentState?: Record<string, any> | null;
	userFeedbackType?: string | null;
	userComment?: string | null;
	gifUrl?: string | null;
}

/**
 * Event to create an agent output file
 */
export interface CreateAgentOutputFileEvent extends BaseCloudEvent {
	taskId: string;
	fileName: string;
	fileContent?: string | null; // Base64 encoded
	contentType?: string | null; // MIME type
	createdAt?: Date;
}

/**
 * Event to create an agent step
 */
export interface CreateAgentStepEvent extends BaseCloudEvent {
	createdAt?: Date;
	agentTaskId: string;
	step: number;
	evaluationPreviousGoal: string;
	memory: string;
	nextGoal: string;
	actions: Record<string, any>[];
	screenshotUrl?: string | null;
	url: string;
}

/**
 * Event to create an agent task
 */
export interface CreateAgentTaskEvent extends BaseCloudEvent {
	agentSessionId: string;
	llmModel: string;
	stopped?: boolean;
	paused?: boolean;
	task: string;
	doneOutput?: string | null;
	scheduledTaskId?: string | null;
	startedAt?: Date;
	finishedAt?: Date | null;
	agentState?: Record<string, any>;
	userFeedbackType?: string | null;
	userComment?: string | null;
	gifUrl?: string | null;
}

/**
 * Event to create an agent session
 */
export interface CreateAgentSessionEvent extends BaseCloudEvent {
	browserSessionId: string;
	browserSessionLiveUrl: string;
	browserSessionCdpUrl: string;
	browserSessionStopped?: boolean;
	browserSessionStoppedAt?: Date | null;
	isSourceApi?: boolean | null;
	browserState?: Record<string, any>;
	browserSessionData?: Record<string, any> | null;
}

/**
 * Event to update an existing agent session
 */
export interface UpdateAgentSessionEvent extends BaseCloudEvent {
	browserSessionStopped?: boolean | null;
	browserSessionStoppedAt?: Date | null;
	endReason?: string | null;
}

/**
 * Generate UUID v7-like string
 */
function generateUuid(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Truncate string to max length
 */
function truncateString(str: string | null | undefined, maxLength: number): string {
	if (!str) return '';
	return str.length > maxLength ? str.slice(0, maxLength) : str;
}

/**
 * Helper to create UpdateAgentTaskEvent from agent
 */
export function createUpdateAgentTaskEvent(
	agent: any,
	additionalData?: Partial<UpdateAgentTaskEvent>
): UpdateAgentTaskEvent {
	const doneOutput = agent.history?.finalResult?.() ?? null;

	return {
		id: String(agent.taskId || agent.id),
		userId: '', // To be filled by cloud handler
		deviceId: agent.cloudSync?.authClient?.deviceId ?? null,
		stopped: agent.state?.stopped ?? false,
		paused: agent.state?.paused ?? false,
		doneOutput: truncateString(doneOutput, MAX_STRING_LENGTH),
		finishedAt: agent.history?.isDone?.() ? new Date() : null,
		agentState: agent.state ?? {},
		userFeedbackType: null,
		userComment: null,
		gifUrl: null,
		...additionalData,
	};
}

/**
 * Helper to create CreateAgentOutputFileEvent from file
 */
export async function createAgentOutputFileEvent(
	agent: any,
	outputPath: string
): Promise<CreateAgentOutputFileEvent> {
	const stats = await fs.stat(outputPath);

	if (!stats.isFile()) {
		throw new Error(`Not a file: ${outputPath}`);
	}

	let fileContent: string | null = null;
	if (stats.size < MAX_FILE_CONTENT_SIZE) {
		const fileBuffer = await fs.readFile(outputPath);
		fileContent = fileBuffer.toString('base64');
	}

	const fileName = path.basename(outputPath);
	const ext = path.extname(outputPath).toLowerCase();

	let contentType = 'application/octet-stream';
	if (ext === '.gif') contentType = 'image/gif';
	else if (ext === '.png') contentType = 'image/png';
	else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
	else if (ext === '.json') contentType = 'application/json';
	else if (ext === '.txt') contentType = 'text/plain';

	return {
		id: generateUuid(),
		userId: '', // To be filled by cloud handler
		deviceId: agent.cloudSync?.authClient?.deviceId ?? null,
		taskId: String(agent.taskId || agent.id),
		fileName,
		fileContent,
		contentType,
		createdAt: new Date(),
	};
}

/**
 * Helper to create CreateAgentStepEvent from agent step
 */
export function createAgentStepEvent(
	agent: any,
	modelOutput: any,
	result: any[],
	actionsData: Record<string, any>[],
	browserStateSummary: any
): CreateAgentStepEvent {
	const currentState = modelOutput.currentState ?? null;

	// Capture screenshot as base64 data URL if available
	let screenshotUrl: string | null = null;
	if (browserStateSummary?.screenshot) {
		screenshotUrl = `data:image/png;base64,${browserStateSummary.screenshot}`;
	}

	return {
		id: generateUuid(),
		userId: '', // To be filled by cloud handler
		deviceId: agent.cloudSync?.authClient?.deviceId ?? null,
		createdAt: new Date(),
		agentTaskId: String(agent.taskId || agent.id),
		step: agent.state?.nSteps ?? 0,
		evaluationPreviousGoal: truncateString(currentState?.evaluationPreviousGoal, MAX_STRING_LENGTH),
		memory: truncateString(currentState?.memory, MAX_STRING_LENGTH),
		nextGoal: truncateString(currentState?.nextGoal, MAX_STRING_LENGTH),
		actions: actionsData,
		url: truncateString(browserStateSummary?.url, MAX_URL_LENGTH),
		screenshotUrl,
	};
}

/**
 * Helper to create CreateAgentTaskEvent from agent
 */
export function createAgentTaskEvent(agent: any): CreateAgentTaskEvent {
	return {
		id: String(agent.taskId || agent.id),
		userId: '', // To be filled by cloud handler
		deviceId: agent.cloudSync?.authClient?.deviceId ?? null,
		agentSessionId: String(agent.sessionId || agent.id),
		task: truncateString(agent.task, MAX_TASK_LENGTH),
		llmModel: agent.llm?.modelName ?? 'unknown',
		agentState: agent.state ?? {},
		stopped: false,
		paused: false,
		doneOutput: null,
		startedAt: agent._taskStartTime ? new Date(agent._taskStartTime * 1000) : new Date(),
		finishedAt: null,
		userFeedbackType: null,
		userComment: null,
		gifUrl: null,
	};
}

/**
 * Helper to create CreateAgentSessionEvent from agent
 */
export function createAgentSessionEvent(agent: any): CreateAgentSessionEvent {
	const browserProfile = agent.browserProfile;

	return {
		id: String(agent.sessionId || agent.id),
		userId: '', // To be filled by cloud handler
		deviceId: agent.cloudSync?.authClient?.deviceId ?? null,
		browserSessionId: agent.browserSession?.id ?? '',
		browserSessionLiveUrl: '', // To be filled by cloud handler
		browserSessionCdpUrl: '', // To be filled by cloud handler
		browserState: {
			viewport: browserProfile?.viewport ?? { width: 1280, height: 720 },
			userAgent: browserProfile?.userAgent ?? null,
			headless: browserProfile?.headless ?? true,
			initialUrl: null, // Will be updated during execution
			finalUrl: null, // Will be updated during execution
			totalPagesVisited: 0, // Will be updated during execution
			sessionDurationSeconds: 0, // Will be updated during execution
		},
		browserSessionData: {
			cookies: [],
			secrets: {},
			allowedDomains: browserProfile?.allowedDomains ?? [],
		},
	};
}

/**
 * Agent cloud events emitter
 */
export class AgentCloudEvents {
	private eventQueue: Array<{ type: string; event: any }> = [];
	private apiBaseUrl: string;
	private apiToken: string | null = null;

	constructor(apiBaseUrl: string = 'https://api.browser-use.com') {
		this.apiBaseUrl = apiBaseUrl;
		this.apiToken = process.env.BROWSER_USE_API_KEY || null;
	}

	/**
	 * Emit an event to the cloud
	 */
	async emit(eventType: string, event: any): Promise<void> {
		if (!this.apiToken) {
			// Queue event if no API token
			this.eventQueue.push({ type: eventType, event });
			return;
		}

		try {
			const url = `${this.apiBaseUrl}/api/v2/events`;
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'X-Browser-Use-API-Key': this.apiToken,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					type: eventType,
					data: event,
					timestamp: Date.now(),
				}),
			});

			if (!response.ok) {
				console.debug(`Failed to emit cloud event: ${response.status}`);
			}
		} catch (error) {
			console.debug(`Error emitting cloud event: ${error}`);
		}
	}

	/**
	 * Emit UpdateAgentTaskEvent
	 */
	async emitUpdateAgentTask(event: UpdateAgentTaskEvent): Promise<void> {
		await this.emit('update_agent_task', event);
	}

	/**
	 * Emit CreateAgentOutputFileEvent
	 */
	async emitCreateAgentOutputFile(event: CreateAgentOutputFileEvent): Promise<void> {
		await this.emit('create_agent_output_file', event);
	}

	/**
	 * Emit CreateAgentStepEvent
	 */
	async emitCreateAgentStep(event: CreateAgentStepEvent): Promise<void> {
		await this.emit('create_agent_step', event);
	}

	/**
	 * Emit CreateAgentTaskEvent
	 */
	async emitCreateAgentTask(event: CreateAgentTaskEvent): Promise<void> {
		await this.emit('create_agent_task', event);
	}

	/**
	 * Emit CreateAgentSessionEvent
	 */
	async emitCreateAgentSession(event: CreateAgentSessionEvent): Promise<void> {
		await this.emit('create_agent_session', event);
	}

	/**
	 * Emit UpdateAgentSessionEvent
	 */
	async emitUpdateAgentSession(event: UpdateAgentSessionEvent): Promise<void> {
		await this.emit('update_agent_session', event);
	}

	/**
	 * Flush queued events (call after API token is set)
	 */
	async flush(): Promise<void> {
		if (!this.apiToken || this.eventQueue.length === 0) return;

		const queue = [...this.eventQueue];
		this.eventQueue = [];

		for (const { type, event } of queue) {
			await this.emit(type, event);
		}
	}

	/**
	 * Set API token
	 */
	setApiToken(token: string): void {
		this.apiToken = token;
	}
}

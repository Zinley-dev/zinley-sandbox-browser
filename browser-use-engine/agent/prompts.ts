/**
 * Agent prompts and message formatting
 * Port from browser_use/agent/prompts.py (Python browser-use 0.13.10)
 */

import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SystemMessage, UserMessage, ContentPartTextParam, ContentPartImageParam } from '../llm/messages.js';
import { NodeType, SimplifiedNode } from '../dom/views.js';
import { isNewTabPage, sanitizeSurrogates } from '../utils.js';
import { PLACEHOLDER_4PX_SCREENSHOT, type BrowserStateSummary } from '../browser/views.js';
import type { AgentStepInfo } from './views.js';
import type { ReadStateImage } from './message_manager/views.js';

// ============================================================================
// Constants
// ============================================================================

/** Directory holding the markdown system prompt templates */
export const SYSTEM_PROMPTS_DIR = 'system_prompts';

export type SystemPromptTemplateName =
	| 'system_prompt.md'
	| 'system_prompt_no_thinking.md'
	| 'system_prompt_flash.md'
	| 'system_prompt_flash_anthropic.md'
	| 'system_prompt_anthropic_flash.md'
	| 'system_prompt_browser_use.md'
	| 'system_prompt_browser_use_flash.md'
	| 'system_prompt_browser_use_no_thinking.md';

// ============================================================================
// Helpers
// ============================================================================

/** Claude Opus 4.5 / Haiku 4.5 need 4096+ token prompts for prompt caching. */
export function isAnthropic45Model(modelName: string | null | undefined): boolean {
	if (!modelName) return false;
	const lower = modelName.toLowerCase();
	const is45 = lower.includes('4.5') || lower.includes('4-5');
	return is45 && (lower.includes('opus') || lower.includes('haiku'));
}

export interface SystemPromptOptions {
	maxActionsPerStep?: number;
	overrideSystemMessage?: string | null;
	extendSystemMessage?: string | null;
	useThinking?: boolean;
	flashMode?: boolean;
	isAnthropic?: boolean;
	isBrowserUseModel?: boolean;
	modelName?: string | null;
}

/**
 * Pick the template for the model type and mode (Python SystemPrompt._load_prompt_template).
 */
export function selectSystemPromptTemplate(options: {
	useThinking: boolean;
	flashMode: boolean;
	isAnthropic: boolean;
	isBrowserUseModel: boolean;
	isAnthropic45: boolean;
}): SystemPromptTemplateName {
	if (options.isBrowserUseModel) {
		if (options.flashMode) return 'system_prompt_browser_use_flash.md';
		if (options.useThinking) return 'system_prompt_browser_use.md';
		return 'system_prompt_browser_use_no_thinking.md';
	}
	if (options.isAnthropic45 && options.flashMode) return 'system_prompt_anthropic_flash.md';
	if (options.flashMode && options.isAnthropic) return 'system_prompt_flash_anthropic.md';
	if (options.flashMode) return 'system_prompt_flash.md';
	if (options.useThinking) return 'system_prompt.md';
	return 'system_prompt_no_thinking.md';
}

/** Candidate locations for a template: next to this module (dev) or the bundled main dir. */
function templateCandidates(templateFilename: string): string[] {
	const candidates: string[] = [];
	try {
		const currentDir = path.dirname(fileURLToPath(import.meta.url));
		candidates.push(path.join(currentDir, SYSTEM_PROMPTS_DIR, templateFilename));
		candidates.push(path.join(currentDir, templateFilename));
	} catch {
		// import.meta.url unavailable (bundled CJS without shim) — fall through
	}
	try {
		if (typeof __dirname === 'string') {
			candidates.push(path.join(__dirname, SYSTEM_PROMPTS_DIR, templateFilename));
			candidates.push(path.join(__dirname, templateFilename));
		}
	} catch {
		// __dirname not defined in ESM
	}
	return candidates;
}

// ============================================================================
// System prompt
// ============================================================================

export class SystemPrompt {
	private maxActionsPerStep: number;
	private useThinking: boolean;
	private flashMode: boolean;
	private isAnthropic: boolean;
	private isBrowserUseModel: boolean;
	private modelName: string | null;
	private isAnthropic45: boolean;
	private promptTemplate: string = '';
	readonly templateName: SystemPromptTemplateName;
	systemMessage: SystemMessage;

	constructor(options: SystemPromptOptions = {}) {
		this.maxActionsPerStep = options.maxActionsPerStep ?? 3;
		this.useThinking = options.useThinking ?? true;
		this.flashMode = options.flashMode ?? false;
		this.isAnthropic = options.isAnthropic ?? false;
		this.isBrowserUseModel = options.isBrowserUseModel ?? false;
		this.modelName = options.modelName ?? null;
		this.isAnthropic45 = isAnthropic45Model(this.modelName);
		this.templateName = selectSystemPromptTemplate({
			useThinking: this.useThinking,
			flashMode: this.flashMode,
			isAnthropic: this.isAnthropic,
			isBrowserUseModel: this.isBrowserUseModel,
			isAnthropic45: this.isAnthropic45,
		});

		let prompt = '';
		if (options.overrideSystemMessage) {
			prompt = options.overrideSystemMessage;
		} else {
			this.loadPromptTemplate();
			prompt = this.promptTemplate.replace('{max_actions}', String(this.maxActionsPerStep));
		}

		if (options.extendSystemMessage) {
			prompt += `\n${options.extendSystemMessage}`;
		}

		this.systemMessage = {
			role: 'system',
			content: prompt,
			cache: true,
		};
	}

	private loadPromptTemplate(): void {
		try {
			for (const templatePath of templateCandidates(this.templateName)) {
				if (fsSync.existsSync(templatePath)) {
					this.promptTemplate = fsSync.readFileSync(templatePath, 'utf-8');
					return;
				}
			}
			console.warn(`System prompt template ${this.templateName} not found, using fallback`);
			this.promptTemplate = this.getFallbackTemplate();
		} catch (error: any) {
			console.warn(`Failed to load system prompt template: ${error.message}, using fallback`);
			this.promptTemplate = this.getFallbackTemplate();
		}
	}

	private getFallbackTemplate(): string {
		const outputFields = this.flashMode
			? `  "memory": "Up to 5 sentences: was the previous step successful, what to remember, what is the next immediate goal",`
			: `${this.useThinking ? '  "thinking": "Your reasoning about the current state and next steps",\n' : ''}  "evaluationPreviousGoal": "Assessment of your last action - success, failure, or uncertain",
  "memory": "Key information to remember for future steps",
  "nextGoal": "Your immediate next goal",
  "currentPlanItem": 0,
  "planUpdate": ["Todo item 1", "Todo item 2"],`;
		return `You are an AI agent designed to operate in an iterative loop to automate browser tasks.
Your ultimate goal is accomplishing the task provided by the user.

<proactive_mindset>
You are PROACTIVE. ACT FIRST, verify after. ASSUME SUCCESS. BE RESOURCEFUL - try alternatives without asking.
NEVER GIVE UP EASILY. PREFER ACTION over explanation. The user wants the task DONE.
</proactive_mindset>

<resourceful_solutions>
NEVER SAY "I CAN'T". You have FULL computer access - code, bash, install tools, use APIs.
- No direct tool? → Find CLI alternative (notion-cli, gh, twurl, slack-cli, gcloud, etc.)
- No API access? → Guide user to provide credentials/tokens
- Browser blocked? → Use curl, wget, lynx, or write a script
- Missing tool? → Install it (brew, npm, pip, cargo)
- Complex task? → Write Python/Node/Shell scripts, use SDKs
MINDSET: For ANY task, a solution path EXISTS. Your job is to FIND it and EXECUTE it.
</resourceful_solutions>

<browser_state>
Interactive Elements: Elements are provided in format [index]<type>text</type>
- Only elements with numeric indexes in [] are interactive
- Use the index to interact with elements
- Elements tagged with a star \`*[\` are new since the last step
</browser_state>

<access_assumptions>
CRITICAL: You are running in the user's personal browser with their existing login sessions.
- ALWAYS ASSUME the user is already logged in. Their browser has cookies, sessions, and saved credentials.
- ALWAYS ASSUME the user has permission to perform the requested task.
- NEVER refuse claiming "no credentials" without FIRST trying and checking the actual state.
- If you hit a login wall AFTER trying: check for guest options, then ASK user before giving up.
- If captcha appears: try solving it first, if can't, ASK user to solve it manually then continue.
- The user trusts you to attempt tasks - refusing without trying breaks trust.
</access_assumptions>

<action_rules>
- You are allowed to use a maximum of {max_actions} actions per step
- Actions are executed sequentially. Page-changing actions (navigate, search, go_back, switch, evaluate) end the sequence — place them last.
</action_rules>

<task_completion_rules>
- Call \`done\` as a single action when the task is complete, at max_steps, or when it is impossible to continue.
- Set success=true only if every requirement of the user request is met; otherwise success=false.
- Only report data you observed in browser state or tool outputs. Never fabricate values.
</task_completion_rules>

<output>
You must respond with a valid JSON in this format:
{
${outputFields}
  "action": [{"action_name": {"param": "value"}}]
}
Action list should NEVER be empty.
</output>`;
	}

	getSystemMessage(): SystemMessage {
		return this.systemMessage;
	}
}

// ============================================================================
// Screenshot resizing
// ============================================================================

/**
 * Resize a base64 PNG screenshot to the target size (sharp, loaded lazily).
 * Returns the original when sharp is unavailable, the size already matches, or resizing fails.
 */
export async function resizeScreenshotBase64(screenshotB64: string, size: [number, number] | null | undefined): Promise<string> {
	if (!size) {
		return screenshotB64;
	}
	try {
		const specifier = 'sharp';
		const sharpModule: any = await import(/* @vite-ignore */ specifier);
		const sharp = sharpModule.default ?? sharpModule;
		const input = Buffer.from(screenshotB64, 'base64');
		const image = sharp(input);
		const meta = await image.metadata();
		if (meta.width === size[0] && meta.height === size[1]) {
			return screenshotB64;
		}
		console.info(`🔄 Resizing screenshot from ${meta.width}x${meta.height} to ${size[0]}x${size[1]} for LLM`);
		const resized: Buffer = await image.resize(size[0], size[1], { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
		return resized.toString('base64');
	} catch (error: any) {
		console.warn(`Failed to resize screenshot: ${error?.message ?? error}, using original`);
		return screenshotB64;
	}
}

// ============================================================================
// Agent message prompt
// ============================================================================

export interface AgentMessagePromptOptions {
	browserStateSummary: BrowserStateSummary;
	fileSystem: any | null;
	agentHistoryDescription?: string | null;
	readStateDescription?: string | null;
	task?: string | null;
	includeAttributes?: string[] | null;
	stepInfo?: AgentStepInfo | null;
	pageFilteredActions?: string | null;
	maxClickableElementsLength?: number;
	sensitiveData?: string | null;
	availableFilePaths?: string[] | null;
	screenshots?: string[] | null;
	visionDetailLevel?: 'auto' | 'low' | 'high';
	includeRecentEvents?: boolean;
	sampleImages?: (ContentPartTextParam | ContentPartImageParam)[] | null;
	/** Images from read_file to show once in the next message */
	readStateImages?: ReadStateImage[] | null;
	/** Resize screenshots to this size before sending them to the LLM */
	llmScreenshotSize?: [number, number] | null;
	/** Information about skills that cannot be used yet */
	unavailableSkillsInfo?: string | null;
	/** Rendered plan for injection into agent state */
	planDescription?: string | null;
}

export class AgentMessagePrompt {
	private browserState: BrowserStateSummary;
	private fileSystem: any | null; // FileSystem type
	private agentHistoryDescription: string | null;
	private readStateDescription: string | null;
	private task: string | null;
	private includeAttributes: string[] | null;
	private stepInfo: AgentStepInfo | null;
	private pageFilteredActions: string | null;
	private maxClickableElementsLength: number;
	private sensitiveData: string | null;
	private availableFilePaths: string[] | null;
	private screenshots: string[];
	private visionDetailLevel: 'auto' | 'low' | 'high';
	private includeRecentEvents: boolean;
	private sampleImages: (ContentPartTextParam | ContentPartImageParam)[];
	private readStateImages: ReadStateImage[];
	private llmScreenshotSize: [number, number] | null;
	private unavailableSkillsInfo: string | null;
	private planDescription: string | null;

	constructor(options: AgentMessagePromptOptions) {
		this.browserState = options.browserStateSummary;
		this.fileSystem = options.fileSystem;
		this.agentHistoryDescription = options.agentHistoryDescription || null;
		this.readStateDescription = options.readStateDescription || null;
		this.task = options.task || null;
		this.includeAttributes = options.includeAttributes || null;
		this.stepInfo = options.stepInfo || null;
		this.pageFilteredActions = options.pageFilteredActions || null;
		this.maxClickableElementsLength = options.maxClickableElementsLength || 40000;
		this.sensitiveData = options.sensitiveData || null;
		this.availableFilePaths = options.availableFilePaths || null;
		this.screenshots = options.screenshots || [];
		this.visionDetailLevel = options.visionDetailLevel || 'auto';
		this.includeRecentEvents = options.includeRecentEvents || false;
		this.sampleImages = options.sampleImages || [];
		this.readStateImages = options.readStateImages || [];
		this.llmScreenshotSize = options.llmScreenshotSize ?? null;
		this.unavailableSkillsInfo = options.unavailableSkillsInfo || null;
		this.planDescription = options.planDescription || null;
	}

	/**
	 * Extract high-level page statistics from DOM tree for LLM context
	 */
	private extractPageStatistics(): Record<string, number> {
		const stats = {
			links: 0,
			iframes: 0,
			shadow_open: 0,
			shadow_closed: 0,
			scroll_containers: 0,
			images: 0,
			interactive_elements: 0,
			total_elements: 0,
			text_chars: 0,
		};

		// Use selectorMap as the source of truth for interactive elements
		const selectorMap = this.browserState.domState?.selectorMap;
		if (selectorMap && selectorMap instanceof Map) {
			stats.interactive_elements = selectorMap.size;

			for (const node of Array.from(selectorMap.values())) {
				const nodeName = (node.nodeName || '').toLowerCase();
				if (nodeName === 'a') {
					stats.links += 1;
				} else if (nodeName === 'iframe' || nodeName === 'frame') {
					stats.iframes += 1;
				} else if (nodeName === 'img') {
					stats.images += 1;
				}
				if ((node as any).isScrollable) {
					stats.scroll_containers += 1;
				}
			}
		}

		// Count total elements + visible text by traversing the DOM tree (like Python)
		if (this.browserState.domState?.root) {
			const countAllNodes = (node: any): number => {
				if (!node) return 0;
				let count = 1;
				if (node.children && Array.isArray(node.children)) {
					for (const child of node.children) {
						count += countAllNodes(child);
					}
				}
				return count;
			};
			stats.total_elements = countAllNodes(this.browserState.domState.root);
		} else if (selectorMap) {
			stats.total_elements = selectorMap.size;
		}

		if (this.browserState.domState?.root) {
			const traverseNode = (node: SimplifiedNode): void => {
				if (!node || !node.originalNode) {
					return;
				}

				const original = node.originalNode;

				if (node.isShadowHost) {
					const hasClosedShadow = node.children.some(
						(child) =>
							child.originalNode.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE &&
							child.originalNode.shadowRootType &&
							child.originalNode.shadowRootType.toLowerCase() === 'closed'
					);
					if (hasClosedShadow) {
						stats.shadow_closed += 1;
					} else {
						stats.shadow_open += 1;
					}
				} else if (original.nodeType === NodeType.TEXT_NODE) {
					stats.text_chars += (original.nodeValue || '').trim().length;
				}

				for (const child of node.children) {
					traverseNode(child);
				}
			};

			traverseNode(this.browserState.domState.root);
		}

		return stats;
	}

	/**
	 * Get browser state description
	 */
	private getBrowserStateDescription(): string {
		const pageStats = this.extractPageStatistics();
		const pendingRequests = (this.browserState as any).pendingNetworkRequests as unknown[] | undefined;

		let statsText = '<page_stats>';
		if (pageStats.total_elements < 10) {
			statsText += 'Page appears empty - consider waiting - ';
		} else if (
			pendingRequests &&
			pendingRequests.length > 0 &&
			pageStats.total_elements > 20 &&
			pageStats.text_chars < pageStats.total_elements * 5
		) {
			// Skeleton screen: low text density only means "loading" while requests are actually in flight
			statsText += `${pendingRequests.length} network request(s) in flight and little text rendered - page may still be loading, consider waiting - `;
		}
		statsText += `${pageStats.links} links, ${pageStats.interactive_elements} interactive, `;
		statsText += `${pageStats.iframes} iframes`;
		if (pageStats.shadow_open > 0 || pageStats.shadow_closed > 0) {
			statsText += `, ${pageStats.shadow_open} shadow(open), ${pageStats.shadow_closed} shadow(closed)`;
		}
		if (pageStats.images > 0) {
			statsText += `, ${pageStats.images} images`;
		}
		statsText += `, ${pageStats.total_elements} total elements`;
		statsText += '</page_stats>\n';

		// Get LLM representation of DOM state
		let elementsText = this.browserState.domState?.llmRepresentation?.(this.includeAttributes || []) || '';

		let truncatedText = '';
		if (elementsText.length > this.maxClickableElementsLength) {
			elementsText = elementsText.substring(0, this.maxClickableElementsLength);
			truncatedText = ` (truncated to ${this.maxClickableElementsLength} characters)`;
		}

		let hasContentAbove = false;
		let hasContentBelow = false;

		let pageInfoText = '';
		if (this.browserState.pageInfo) {
			const pi = this.browserState.pageInfo;
			const pagesAbove = pi.viewportHeight > 0 ? pi.pixelsAbove / pi.viewportHeight : 0;
			const pagesBelow = pi.viewportHeight > 0 ? pi.pixelsBelow / pi.viewportHeight : 0;
			hasContentAbove = pagesAbove > 0;
			hasContentBelow = pagesBelow > 0;
			pageInfoText = `<page_info>${pagesAbove.toFixed(1)} pages above, ${pagesBelow.toFixed(1)} pages below`;
			if (pagesBelow > 0.2) {
				pageInfoText += ' — scroll down to reveal more content';
			}
			pageInfoText += '</page_info>\n';
		}

		if (elementsText !== '') {
			if (!hasContentAbove) {
				elementsText = `[Start of page]\n${elementsText}`;
			}
			if (!hasContentBelow) {
				elementsText = `${elementsText}\n[End of page]`;
			}
		} else {
			elementsText = 'empty page';
		}

		// Tabs text
		let tabsText = '';
		const currentTabCandidates: string[] = [];
		for (const tab of this.browserState.tabs) {
			if (tab.url === this.browserState.url && tab.title === this.browserState.title) {
				currentTabCandidates.push(tab.targetId);
			}
		}
		const currentTargetId = currentTabCandidates.length === 1 ? currentTabCandidates[0] : null;
		for (const tab of this.browserState.tabs) {
			tabsText += `Tab ${tab.targetId.slice(-4)}: ${tab.url} - ${(tab.title || '').substring(0, 30)}\n`;
		}
		const currentTabText = currentTargetId ? `Current tab: ${currentTargetId.slice(-4)}` : '';

		let stateErrorText = '';
		const stateError = (this.browserState as any).stateError;
		if (stateError) {
			stateErrorText = `<browser_state_error>${stateError}</browser_state_error>\n`;
		}

		let pdfMessage = '';
		if (this.browserState.isPdfViewer) {
			pdfMessage = 'PDF viewer cannot be rendered. In this page, DO NOT use the extract action as PDF content cannot be rendered. ';
			pdfMessage += 'Use the read_file action on the downloaded PDF in available_file_paths to read the full text content.\n\n';
		}

		let recentEventsText = '';
		if (this.includeRecentEvents && this.browserState.recentEvents) {
			recentEventsText = `Recent browser events: ${this.browserState.recentEvents}\n`;
		}

		let closedPopupsText = '';
		const closedPopups = (this.browserState as any).closedPopupMessages as string[] | undefined;
		if (closedPopups && closedPopups.length > 0) {
			closedPopupsText = 'Auto-closed JavaScript dialogs:\n';
			for (const popupMsg of closedPopups) {
				closedPopupsText += `  - ${popupMsg}\n`;
			}
			closedPopupsText += '\n';
		}

		return `${statsText}${currentTabText}
Available tabs:
${tabsText}
${pageInfoText}
${stateErrorText}${recentEventsText}${closedPopupsText}${pdfMessage}Interactive elements${truncatedText}:
${elementsText}
`;
	}

	/**
	 * Get agent state description (file system, todo, plan, sensitive data, files)
	 */
	private getAgentStateDescription(): string {
		const todoContents = this.fileSystem?.getTodoContents?.() || '';
		const finalTodoContents = todoContents.length > 0 ? todoContents : '[empty todo.md, fill it when applicable]';

		let agentState = `
<file_system>
${this.fileSystem?.describe?.() || 'No file system available'}
</file_system>
<todo_contents>
${finalTodoContents}
</todo_contents>
`;
		if (this.planDescription) {
			agentState += `<plan>\n${this.planDescription}\n</plan>\n`;
		}

		if (this.sensitiveData) {
			agentState += `<sensitive_data>${this.sensitiveData}</sensitive_data>\n`;
		}

		if (this.availableFilePaths && this.availableFilePaths.length > 0) {
			const availableFilePathsText = this.availableFilePaths.join('\n');
			agentState += `<available_file_paths>${availableFilePathsText}\nUse with absolute paths</available_file_paths>\n`;
		}

		return agentState;
	}

	private getUserRequestDescription(): string {
		return `<user_request>\n${this.task}\n</user_request>\n\n`;
	}

	/**
	 * Per-step varying metadata (step counter, date). Kept at the tail of the user message so
	 * everything above can in principle be treated as a cacheable prefix.
	 */
	private getStepMetaDescription(): string {
		let stepInfoDescription = '';
		if (this.stepInfo) {
			stepInfoDescription = `Step${this.stepInfo.stepNumber + 1} maximum:${this.stepInfo.maxSteps}\n`;
		}
		const now = new Date();
		const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
		stepInfoDescription += `Today:${timeStr}`;
		return `<step_info>${stepInfoDescription}</step_info>\n`;
	}

	/**
	 * Get complete state as a single cached message
	 */
	async getUserMessage(useVision: boolean = true): Promise<UserMessage> {
		// New-tab pages only carry placeholder screenshots, even later in a multi-tab session.
		if (isNewTabPage(this.browserState.url)) {
			useVision = false;
		}

		let stateDescription =
			this.getUserRequestDescription() +
			'<agent_history>\n' +
			(this.agentHistoryDescription?.replace(/^\n+|\n+$/g, '') || '') +
			'\n</agent_history>\n\n';

		stateDescription += '<agent_state>\n';
		stateDescription += this.getAgentStateDescription().trim() + '\n';
		stateDescription += '</agent_state>\n';

		stateDescription += '<browser_state>\n';
		stateDescription += this.getBrowserStateDescription().trim() + '\n';
		stateDescription += '</browser_state>\n';

		const readStateDesc = this.readStateDescription?.trim() || '';
		if (readStateDesc) {
			stateDescription += '<read_state>\n';
			stateDescription += readStateDesc + '\n';
			stateDescription += '</read_state>\n';
		}

		if (this.pageFilteredActions) {
			stateDescription += '<page_specific_actions>\n';
			stateDescription += this.pageFilteredActions + '\n';
			stateDescription += '</page_specific_actions>\n';
		}

		if (this.unavailableSkillsInfo) {
			stateDescription += '\n' + this.unavailableSkillsInfo + '\n';
		}

		stateDescription += this.getStepMetaDescription();

		stateDescription = sanitizeSurrogates(stateDescription);

		const hasImages = this.readStateImages.length > 0;
		const screenshots = this.screenshots.filter((s) => s !== PLACEHOLDER_4PX_SCREENSHOT);

		if ((useVision && screenshots.length > 0) || hasImages) {
			const contentParts: (ContentPartTextParam | ContentPartImageParam)[] = [
				{ type: 'text', text: stateDescription },
			];

			contentParts.push(...this.sampleImages);

			if (useVision) {
				for (let i = 0; i < screenshots.length; i++) {
					const label = i === screenshots.length - 1 ? 'Current screenshot:' : 'Previous screenshot:';
					contentParts.push({ type: 'text', text: label });

					const processed = await resizeScreenshotBase64(screenshots[i], this.llmScreenshotSize);
					contentParts.push({
						type: 'image_url',
						imageUrl: {
							url: `data:image/png;base64,${processed}`,
							mediaType: 'image/png',
							detail: this.visionDetailLevel,
						},
					});
				}
			}

			// Images from read_file (shown once)
			for (const img of this.readStateImages) {
				if (!img.data) continue;
				const mediaType = img.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
				contentParts.push({ type: 'text', text: `Image from file: ${img.name}` });
				contentParts.push({
					type: 'image_url',
					imageUrl: {
						url: `data:${mediaType};base64,${img.data}`,
						mediaType,
						detail: this.visionDetailLevel,
					},
				});
			}

			return { role: 'user', content: contentParts, cache: true };
		}

		return { role: 'user', content: stateDescription, cache: true };
	}
}

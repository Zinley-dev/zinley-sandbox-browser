/**
 * Judge system for evaluating browser-use agent execution traces.
 * Port of browser_use/agent/judge.py (Python browser-use 0.13.10).
 */

import * as fs from 'node:fs';
import { z } from 'zod';
import {
	BaseMessage,
	ContentPartImageParam,
	ContentPartTextParam,
	createSystemMessage,
	createUserMessage,
} from '../llm/messages.js';

// ============================================================================
// Types
// ============================================================================

/** LLM judgement of an agent trace. */
export interface JudgementResult {
	/** Explanation of the judgement */
	reasoning?: string | null;
	/** Whether the trace was successful or not */
	verdict: boolean;
	/** Why the task was not completed successfully; empty string when verdict is true */
	failureReason?: string | null;
	/** True if the task was impossible (vague instructions, broken site, missing credentials, ...) */
	impossibleTask: boolean;
	/** True if the agent encountered captcha challenges during execution */
	reachedCaptcha: boolean;
}

/** Structured-output schema handed to the judge LLM. */
export const JudgementResultSchema = z.object({
	reasoning: z.string().nullable().optional().describe('Explanation of the judgement'),
	verdict: z.boolean().describe('Whether the trace was successful or not'),
	failureReason: z
		.string()
		.nullable()
		.optional()
		.describe(
			'Max 5 sentences explanation of why the task was not completed successfully in case of failure. If verdict is true, use an empty string.'
		),
	impossibleTask: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'True if the task was impossible to complete due to vague instructions, broken website, inaccessible links, missing login credentials, or other insurmountable obstacles'
		),
	reachedCaptcha: z
		.boolean()
		.optional()
		.default(false)
		.describe('True if the agent encountered captcha challenges during task execution'),
});

export interface JudgeMessageOptions {
	/** The original task description */
	task: string;
	/** The final result returned to the user */
	finalResult: string;
	/** Formatted agent step descriptions */
	agentSteps: string[];
	/** Screenshot file paths (last `maxImages` are attached) */
	screenshotPaths: string[];
	/** Maximum number of screenshots to include (default 10) */
	maxImages?: number;
	/** Verified answer or criteria that must be satisfied for success */
	groundTruth?: string | null;
	/** Screenshots are only attached when vision is not disabled */
	useVision?: boolean | 'auto';
}

// ============================================================================
// Helpers
// ============================================================================

const TRUNCATION_MARKER_LENGTH = 23;

/** Encode an image file to base64, or null when unreadable. */
export function encodeImageFile(imagePath: string): string | null {
	try {
		if (!fs.existsSync(imagePath)) {
			return null;
		}
		return fs.readFileSync(imagePath).toString('base64');
	} catch (error: any) {
		console.warn(`Failed to encode image ${imagePath}: ${error?.message ?? error}`);
		return null;
	}
}

/** Truncate text to a maximum length with an explicit truncation marker. */
export function truncateJudgeText(text: string, maxLength: number, fromBeginning = false): string {
	if (text.length <= maxLength) {
		return text;
	}
	if (fromBeginning) {
		return '...[text truncated]' + text.slice(-(maxLength - TRUNCATION_MARKER_LENGTH));
	}
	return text.slice(0, maxLength - TRUNCATION_MARKER_LENGTH) + '...[text truncated]...';
}

function formatUtcNow(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
}

const GROUND_TRUTH_SECTION = `
**GROUND TRUTH VALIDATION (HIGHEST PRIORITY):**
The <ground_truth> section contains verified correct information for this task. This can be:
- **Evaluation criteria**: Specific conditions that must be met (e.g., "The success popup should show up", "Must extract exactly 5 items")
- **Factual answers**: The correct answer to a question or information retrieval task (e.g. "10/11/24", "Paris")
- **Expected outcomes**: What should happen after task completion (e.g., "Google Doc must be created", "File should be downloaded")

The ground truth takes ABSOLUTE precedence over all other evaluation criteria. If the ground truth is not satisfied by the agent's execution and final response, the verdict MUST be false.
`;

export function buildJudgeSystemPrompt(groundTruth: string | null | undefined, currentDate: string): string {
	const groundTruthSection = groundTruth ? GROUND_TRUTH_SECTION : '';
	return `You are an expert judge evaluating browser automation agent performance.

<evaluation_framework>
${groundTruthSection}
**PRIMARY EVALUATION CRITERIA (in order of importance):**
1. **Task Satisfaction (Most Important)**: Did the agent accomplish what the user asked for? Break down the task into the key criteria and evaluate if the agent all of them. Focus on user intent and final outcome.
2. **Output Quality**: Is the final result in the correct format and complete? Does it match exactly what was requested?
3. **Tool Effectiveness**: Did the browser interactions work as expected? Were tools used appropriately? How many % of the tools failed?
4. **Agent Reasoning**: Quality of decision-making, planning, and problem-solving throughout the trajectory.
5. **Browser Handling**: Navigation stability, error recovery, and technical execution. If the browser crashes, does not load or a captcha blocks the task, the score must be very low.

**VERDICT GUIDELINES:**
- true: Task completed as requested, human-like execution, all of the users criteria were met and the agent did not make up any information.
- false: Task not completed, or only partially completed.

**Examples of task completion verdict:**
- If task asks for 10 items and agent finds 4 items correctly: false
- If task completed to full user requirements but with some errors to improve in the trajectory: true
- If task impossible due to captcha/login requirements: false
- If the trajectory is ideal and the output is perfect: true
- If the task asks to search all headphones in amazon under $100 but the agent searches all headphones and the lowest price is $150: false
- If the task asks to research a property and create a google doc with the result but the agents only returns the results in text: false
- If the task asks to complete an action on the page, and the agent reports that the action is completed but the screenshot or page shows the action is not actually complete: false
- If the task asks to use a certain tool or site to complete the task but the agent completes the task without using it: false
- If the task asks to look for a section of a page that does not exist: false
- If the agent concludes the task is impossible but it is not: false
- If the agent concludes the task is impossible and it truly is impossible: false
- If the agent is unable to complete the task because no login information was provided and it is truly needed to complete the task: false

**FAILURE CONDITIONS (automatically set verdict to false):**
- Blocked by captcha or missing authentication
- Output format completely wrong or missing
- Infinite loops or severe technical failures
- Critical user requirements ignored
- Page not loaded
- Browser crashed
- Agent could not interact with required UI elements
- The agent moved on from a important step in the task without completing it
- The agent made up content that is not in the screenshot or the page state
- The agent calls done action before completing all key points of the task

**IMPOSSIBLE TASK DETECTION:**
Set \`impossibleTask\` to true when the task fundamentally could not be completed due to:
- Vague or ambiguous task instructions that cannot be reasonably interpreted
- Website genuinely broken or non-functional (be conservative - temporary issues don't count)
- Required links/pages truly inaccessible (404, 403, etc.)
- Task requires authentication/login but no credentials were provided
- Task asks for functionality that doesn't exist on the target site
- Other insurmountable external obstacles beyond the agent's control

Do NOT mark as impossible if:
- Agent made poor decisions but task was achievable
- Temporary page loading issues that could be retried
- Agent didn't try the right approach
- Website works but agent struggled with it

**CAPTCHA DETECTION:**
Set \`reachedCaptcha\` to true if:
- Screenshots show captcha challenges (reCAPTCHA, hCaptcha, etc.)
- Agent reports being blocked by bot detection
- Error messages indicate captcha/verification requirements
- Any evidence the agent encountered anti-bot measures during execution

**IMPORTANT EVALUATION NOTES:**
- **evaluate for action** - For each key step of the trace, double check whether the action that the agent tried to performed actually happened. If the required action did not actually occur, the verdict should be false.
- **screenshot is not entire content** - The agent has the entire DOM content, but the screenshot is only part of the content. If the agent extracts information from the page, but you do not see it in the screenshot, you can assume this information is there.
- **Penalize poor tool usage** - Wrong tools, inefficient approaches, ignoring available information.
- **current date/time is ${currentDate}** - content with recent dates is real, not fabricated.
- **IMPORTANT**: be very picky about the user's request - Have very high standard for the agent completing the task exactly to the user's request.
- **IMPORTANT**: be initially doubtful of the agent's self reported success, be sure to verify that its methods are valid and fulfill the user's desires to a tee.

</evaluation_framework>

<response_format>
Respond with EXACTLY this JSON structure (no additional text before or after):

{
	"reasoning": "Breakdown of user task into key points. Detailed analysis covering: what went well, what didn't work, trajectory quality assessment, tool usage evaluation, output quality review, and overall user satisfaction prediction.",
	"verdict": true or false,
	"failureReason": "Max 5 sentences explanation of why the task was not completed successfully in case of failure. If verdict is true, use an empty string.",
	"impossibleTask": true or false,
	"reachedCaptcha": true or false
}
</response_format>
`;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Construct the system + user messages for judge evaluation of an agent trace.
 */
export function constructJudgeMessages(options: JudgeMessageOptions): BaseMessage[] {
	const maxImages = options.maxImages ?? 10;
	const taskTruncated = truncateJudgeText(options.task, 40000);
	const finalResultTruncated = truncateJudgeText(options.finalResult, 40000);
	const stepsTextTruncated = truncateJudgeText(options.agentSteps.join('\n'), 40000);

	// Only include screenshots if vision is not disabled
	const encodedImages: ContentPartImageParam[] = [];
	if (options.useVision !== false) {
		const selected =
			options.screenshotPaths.length > maxImages ? options.screenshotPaths.slice(-maxImages) : options.screenshotPaths;
		for (const imgPath of selected) {
			const encoded = encodeImageFile(imgPath);
			if (encoded) {
				encodedImages.push({
					type: 'image_url',
					imageUrl: { url: `data:image/png;base64,${encoded}`, mediaType: 'image/png' },
				});
			}
		}
	}

	const systemPrompt = buildJudgeSystemPrompt(options.groundTruth, formatUtcNow());

	const groundTruthPrompt = options.groundTruth ? `\n<ground_truth>\n${options.groundTruth}\n</ground_truth>\n` : '';

	const userPrompt = `
<task>
${taskTruncated || 'No task provided'}
</task>
${groundTruthPrompt}
<agent_trajectory>
${stepsTextTruncated || 'No agent trajectory provided'}
</agent_trajectory>

<final_result>
${finalResultTruncated || 'No final result provided'}
</final_result>

${encodedImages.length} screenshots from execution are attached.

Evaluate this agent execution given the criteria and respond with the exact JSON structure requested.`;

	const contentParts: (ContentPartTextParam | ContentPartImageParam)[] = [{ type: 'text', text: userPrompt }];
	contentParts.push(...encodedImages);

	return [createSystemMessage(systemPrompt), createUserMessage(contentParts)];
}

/** Normalize a raw judge completion (object or JSON string) into a JudgementResult, or null. */
export function parseJudgementResult(raw: unknown): JudgementResult | null {
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	const parsed = JudgementResultSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return {
		reasoning: parsed.data.reasoning ?? null,
		verdict: parsed.data.verdict,
		failureReason: parsed.data.failureReason ?? null,
		impossibleTask: parsed.data.impossibleTask ?? false,
		reachedCaptcha: parsed.data.reachedCaptcha ?? false,
	};
}

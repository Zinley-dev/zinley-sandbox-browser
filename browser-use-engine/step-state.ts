/**
 * One browser_control step, seen the way the autonomous agent's model sees a
 * step (AgentMessagePrompt.getBrowserStateDescription + the highlighted
 * screenshot): the page and its tabs, how much lies above/below the viewport,
 * load / dialog / PDF hints, the indexed interactive elements with new ones
 * marked `*[`, and a screenshot with the same indices drawn on it — done with
 * the engine's in-page overlay (addHighlights), so no sharp is needed.
 *
 * Shared by the desktop app (BrowserUseManager.browserStep) and the Zinley's
 * Computer daemon. The two engine copies must stay identical.
 */
import type { BrowserSession } from './browser/session.js';
import type { ActionRegistry, ActionContext } from './actions/registry.js';
import { DEFAULT_INCLUDE_ATTRIBUTES } from './dom/views.js';

export interface StepTab {
	/** Last four characters of the target id — enough to `switch{tab_index}` by. */
	id: string;
	url: string;
	title: string;
	active: boolean;
}

export interface StepState {
	url: string;
	title: string;
	tabs: StepTab[];
	/** `[index]<tag attrs>text</tag>` lines; `*[` marks an element new since the last step. */
	elements: string;
	elementsTruncated: boolean;
	interactiveCount: number;
	/** e.g. "0.0 pages above, 2.3 pages below — scroll down to reveal more content". */
	pageInfo: string;
	/** Hints the agent's model gets too: auto-closed dialogs, PDF viewer, capture errors. */
	notes: string[];
	/** JPEG base64 with numbered boxes over the interactive elements. */
	screenshot?: string | null;
	screenshotMime?: string;
}

export interface CaptureOptions {
	screenshot?: boolean;
	/** Draw the `[index]` boxes into the screenshot (default true). */
	highlight?: boolean;
	jpegQuality?: number;
	maxElementsChars?: number;
}

export async function captureStepState(session: BrowserSession, opts: CaptureOptions = {}): Promise<StepState> {
	const wantShot = opts.screenshot !== false;
	const maxChars = opts.maxElementsChars ?? 12000;
	const out: StepState = {
		url: '', title: '', tabs: [], elements: '', elementsTruncated: false, interactiveCount: 0, pageInfo: '', notes: [], screenshot: null,
	};
	let state: any = null;
	try {
		state = await session.getState({ includeScreenshot: false, includeDom: true, includeRecentEvents: false });
	} catch (err: any) {
		out.notes.push(`Page state could not be captured (${String(err?.message || err).slice(0, 120)}) — the page may be mid-navigation; wait a second and look again.`);
		try {
			out.url = await session.getCurrentPageUrl();
			out.title = await session.getCurrentPageTitle();
		} catch {
			/* keep empty */
		}
	}
	let selectorMap: Map<number, any> | undefined;
	if (state) {
		out.url = state.url || '';
		out.title = state.title || '';
		const currentId = String(session.getCurrentPageId?.() || '');
		out.tabs = (state.tabs || []).map((t: any) => {
			const full = String(t.targetId || t.id || '');
			return { id: full.slice(-4), url: String(t.url || ''), title: String(t.title || ''), active: full === currentId };
		});
		selectorMap = state.domState?.selectorMap;
		out.interactiveCount = selectorMap?.size ?? 0;
		let elements: string = state.domState?.llmRepresentation?.(DEFAULT_INCLUDE_ATTRIBUTES) ?? '';
		const pi = state.pageInfo;
		let above = false;
		let below = false;
		if (pi && pi.viewportHeight > 0) {
			const pagesAbove = pi.pixelsAbove / pi.viewportHeight;
			const pagesBelow = pi.pixelsBelow / pi.viewportHeight;
			above = pagesAbove > 0;
			below = pagesBelow > 0;
			out.pageInfo = `${pagesAbove.toFixed(1)} pages above, ${pagesBelow.toFixed(1)} pages below` + (pagesBelow > 0.2 ? ' — scroll down to reveal more content' : '');
		}
		if (elements) {
			if (!above) elements = `[Start of page]\n${elements}`;
			if (!below) elements = `${elements}\n[End of page]`;
		} else {
			elements = 'empty page';
		}
		if (elements.length > maxChars) {
			elements = `${elements.slice(0, maxChars)}\n… (${elements.length - maxChars} more chars; scroll or narrow the page)`;
			out.elementsTruncated = true;
		}
		out.elements = elements;
		if (Array.isArray(state.closedPopupMessages) && state.closedPopupMessages.length > 0) {
			out.notes.push(`Auto-closed JavaScript dialog(s): ${state.closedPopupMessages.join(' | ')}`);
		}
		if (state.stateError) out.notes.push(String(state.stateError));
		if (state.isPdfViewer) out.notes.push('This is a PDF viewer — extract cannot read it; scroll to read it, or download the file.');
	}
	if (wantShot) {
		let highlighted = false;
		if (opts.highlight !== false && selectorMap && selectorMap.size > 0) {
			try {
				await session.addHighlights(selectorMap);
				highlighted = true;
			} catch {
				/* plain screenshot then */
			}
		}
		try {
			const page: any = session.getPageOrCurrent();
			const buf: Buffer = await page.screenshot({ type: 'jpeg', quality: opts.jpegQuality ?? 60, timeout: 15000 });
			out.screenshot = buf.toString('base64');
			out.screenshotMime = 'image/jpeg';
		} catch (err: any) {
			out.notes.push(`Screenshot failed (${String(err?.message || err).slice(0, 80)}).`);
		}
		if (highlighted) await session.removeHighlights().catch(() => undefined);
	}
	return out;
}

/** The text block the chat model reads — the same ingredients as the agent's <browser_state>. */
export function renderStepState(head: string, st: StepState): string {
	const lines: string[] = [head, `Page: ${st.title || '(untitled)'} — ${st.url || '(no url)'}`];
	if (st.tabs.length > 0) {
		lines.push(`Tabs (${st.tabs.length}): ${st.tabs.map(t => `${t.active ? '*' : ''}[${t.id}] ${(t.title || t.url).slice(0, 40)}`).join(' | ')}`);
	}
	if (st.pageInfo) lines.push(`Viewport: ${st.pageInfo}`);
	for (const note of st.notes) lines.push(`⚠️ ${note}`);
	lines.push('');
	lines.push(
		`Interactive elements (${st.interactiveCount}; act on an [index] with click/input/select_dropdown — *[ = new since the last step; the screenshot draws the same numbers):`,
	);
	lines.push(st.elements || '(none found)');
	return lines.join('\n');
}

export interface StepAction {
	action: string;
	params?: Record<string, unknown>;
}

export interface StepActionResult {
	action: string;
	ok: boolean;
	message?: string;
	error?: string;
}

export interface RunActionsOutcome {
	ok: boolean;
	results: StepActionResult[];
	/** Why a later action in the batch was not run. */
	interrupted?: string;
}

/**
 * Run one or several engine actions in order — the agent's "up to N actions
 * per step" rule: stop at the first failure, and stop when an action changed
 * the page (a new URL), because the indices the model chose no longer apply.
 */
export async function runStepActions(
	session: BrowserSession,
	registry: ActionRegistry,
	actions: StepAction[],
	context: ActionContext,
	opts: { actionTimeoutS?: number; max?: number } = {},
): Promise<RunActionsOutcome> {
	const max = opts.max ?? 5;
	const results: StepActionResult[] = [];
	let interrupted: string | undefined;
	const urlBefore = await session.getCurrentPageUrl().catch(() => '');
	for (let i = 0; i < Math.min(actions.length, max); i++) {
		const { action, params } = actions[i];
		if (!registry.getAction(action)) {
			results.push({ action, ok: false, error: `Unknown action '${action}'. Available: ${[...registry.getActions().keys()].join(', ')}` });
			break;
		}
		try {
			const r = await registry.execute(action, params ?? {}, context, { actionTimeoutS: opts.actionTimeoutS ?? 60 });
			const message = [r.extractedContent, r.longTermMemory].filter(Boolean).join('\n') || undefined;
			results.push({ action, ok: !r.error, message, error: r.error || undefined });
			if (r.error) break;
		} catch (err: any) {
			const msg = err?.issues ? `Invalid params: ${JSON.stringify(err.issues)}` : String(err?.message || err);
			results.push({ action, ok: false, error: msg });
			break;
		}
		if (i < actions.length - 1) {
			const urlAfter = await session.getCurrentPageUrl().catch(() => '');
			if (urlAfter && urlBefore && urlAfter !== urlBefore) {
				interrupted = `The page changed after '${action}' (${urlAfter}); the remaining ${actions.length - i - 1} action(s) were not run — look at the new page first.`;
				break;
			}
		}
	}
	if (actions.length > max) interrupted = interrupted ?? `Only the first ${max} actions were run.`;
	return { ok: results.length > 0 && results.every(r => r.ok), results, interrupted };
}

/**
 * One browser_control step, seen the way the autonomous agent's model sees a
 * step (AgentMessagePrompt.getBrowserStateDescription + the highlighted
 * screenshot): the page and its tabs, how much lies above/below the viewport,
 * load / dialog / PDF hints, the indexed interactive elements with new ones
 * marked `*[`, and a screenshot with the same indices drawn on it — done with
 * a small in-page overlay of our own (no sharp, and no function passed to
 * page.evaluate: see drawIndexOverlay).
 *
 * Shared by the desktop app (BrowserUseManager.browserStep) and the Zinley's
 * Computer daemon. The two engine copies must stay identical.
 *
 * `*[` is decided HERE, not by the DOM service: the engine creates a fresh
 * DOMService per capture, so its own "new since last time" set is always empty
 * and every element would be starred. We remember the backendNodeIds of the
 * previous capture per session and star only what was not there on the SAME
 * page (a fresh page / URL has no stars — everything is new, so nothing is).
 */
import type { BrowserSession } from './browser/session.js';
import type { ActionRegistry, ActionContext } from './actions/registry.js';
import { DEFAULT_INCLUDE_ATTRIBUTES } from './dom/views.js';

export interface StepTab {
	/** Last four characters of the target id — enough to `switch{tab_id}` by. */
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
		state = await getStateWithPage(session);
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
		let elements: string = markNewElements(session, out.url, state.domState?.llmRepresentation?.(DEFAULT_INCLUDE_ATTRIBUTES) ?? '', selectorMap);
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
			// Cut on a line so no `[index]` is half there, and remember which
			// indices survived: the screenshot must not number boxes the text lacks.
			const nl = elements.lastIndexOf('\n', maxChars);
			const keep = nl > maxChars / 2 ? nl : maxChars;
			elements = `${elements.slice(0, keep)}\n… (${elements.length - keep} more chars not shown; scroll or narrow the page)`;
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
		let page: any = null;
		try {
			page = session.getPageOrCurrent();
		} catch (err: any) {
			out.notes.push(`Screenshot skipped (${String(err?.message || err).slice(0, 80)}).`);
		}
		let highlighted = false;
		if (page && opts.highlight !== false && selectorMap && selectorMap.size > 0) {
			highlighted = await drawIndexOverlay(page, selectorMap, out.elementsTruncated ? indicesIn(out.elements) : undefined);
		}
		if (page) try {
			// CSS-pixel scale: a Retina desktop would otherwise send a 2× image (4× the bytes and tokens).
			const buf: Buffer = await page.screenshot({ type: 'jpeg', quality: opts.jpegQuality ?? 50, scale: 'css', timeout: 15000 });
			out.screenshot = buf.toString('base64');
			out.screenshotMime = 'image/jpeg';
		} catch (err: any) {
			out.notes.push(`Screenshot failed (${String(err?.message || err).slice(0, 80)}).`);
		}
		if (highlighted) await page.evaluate(REMOVE_OVERLAY_SCRIPT).catch(() => undefined);
	}
	return out;
}

const STATE_OPTS = { includeScreenshot: false, includeDom: true, includeRecentEvents: false };

/** The site closed the last tab (or the model did): the engine throws "No
 *  active page" — open a blank one and read that instead of losing the step. */
async function getStateWithPage(session: BrowserSession): Promise<any> {
	try {
		return await session.getState(STATE_OPTS);
	} catch (err: any) {
		const ensure = (session as any).ensurePage;
		if (/no active page/i.test(String(err?.message || err)) && typeof ensure === 'function') {
			await ensure.call(session);
			return await session.getState(STATE_OPTS);
		}
		throw err;
	}
}

const lastSeen = new WeakMap<object, { url: string; ids: Set<number> }>();
const INDEX_LINE = /^([ \t]*)\*?\[(\d+)\]/gm;

/** Star an element only when the previous capture of the SAME url did not
 *  have its node (backendNodeId is stable for the life of a DOM node). */
function markNewElements(session: BrowserSession, url: string, elements: string, selectorMap: Map<number, any> | undefined): string {
	const ids = new Set<number>();
	if (selectorMap) {
		for (const node of selectorMap.values()) {
			const id = Number(node?.backendNodeId);
			if (Number.isFinite(id)) ids.add(id);
		}
	}
	const prev = lastSeen.get(session as object);
	lastSeen.set(session as object, { url, ids });
	const samePage = !!prev && prev.url === url && prev.ids.size > 0;
	return elements.replace(INDEX_LINE, (_m, indent: string, idx: string) => {
		const id = Number(selectorMap?.get(Number(idx))?.backendNodeId);
		const isNew = samePage && Number.isFinite(id) && !prev!.ids.has(id);
		return `${indent}${isNew ? '*' : ''}[${idx}]`;
	});
}

function indicesIn(elements: string): Set<number> {
	const out = new Set<number>();
	for (const m of elements.matchAll(INDEX_LINE)) out.add(Number(m[2]));
	return out;
}

const OVERLAY_ID = 'zinley-step-index-overlay';
/** Passed to page.evaluate as a STRING on purpose: a bundler that keeps
 *  function names (esbuild keepNames / tsx) rewrites a function's source with
 *  `__name(...)` helpers that do not exist inside the page — the engine's own
 *  addHighlights fails exactly that way under such builds. */
const REMOVE_OVERLAY_SCRIPT = `(() => { const c = document.getElementById(${JSON.stringify(OVERLAY_ID)}); if (c) c.remove(); })()`;

/** Draw the `[index]` boxes and labels over the interactive elements — the
 *  same numbers the element list uses — using the page's own DOM. */
async function drawIndexOverlay(page: any, selectorMap: Map<number, any>, only?: Set<number>): Promise<boolean> {
	// `absolutePosition` is VIEWPORT-relative (measured: y=1241 for an element whose
	// document bounds are y=2321 at scrollY=1080); `snapshotNode.bounds` is
	// document-relative. The overlay is position:fixed, so only the latter needs
	// the scroll offset taken off.
	const boxes: Array<{ i: number; x: number; y: number; w: number; h: number; t: string; doc: boolean }> = [];
	for (const [index, node] of selectorMap.entries()) {
		if (only && !only.has(index)) continue;
		const vp = node?.absolutePosition;
		const p = vp || node?.snapshotNode?.bounds;
		if (!p || !(p.width > 0) || !(p.height > 0)) continue;
		boxes.push({ i: index, x: p.x, y: p.y, w: p.width, h: p.height, t: String(node?.nodeName || node?.tagName || '').toLowerCase(), doc: !vp });
	}
	if (boxes.length === 0) return false;
	const script = `(() => {
		const data = ${JSON.stringify(boxes)};
		const id = ${JSON.stringify(OVERLAY_ID)};
		const old = document.getElementById(id); if (old) old.remove();
		const sx = window.scrollX, sy = window.scrollY, vw = window.innerWidth, vh = window.innerHeight;
		const root = document.createElement('div');
		root.id = id;
		root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
		const colors = { a: '#2563eb', button: '#dc2626', input: '#059669', textarea: '#059669', select: '#7c3aed' };
		for (const b of data) {
			const x = b.doc ? b.x - sx : b.x, y = b.doc ? b.y - sy : b.y;
			if (x + b.w < 0 || y + b.h < 0 || x > vw || y > vh) continue;
			const c = colors[b.t] || '#ea580c';
			const box = document.createElement('div');
			box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid ' + c + ';background:' + c + '14;left:' + x + 'px;top:' + y + 'px;width:' + b.w + 'px;height:' + b.h + 'px;';
			const label = document.createElement('div');
			label.textContent = String(b.i);
			const above = y >= 14;
			label.style.cssText = 'position:absolute;left:0;' + (above ? 'top:-14px;' : 'top:0;') + 'padding:0 3px;font:bold 11px/14px system-ui,Arial,sans-serif;color:#fff;background:' + c + ';border-radius:2px;white-space:nowrap;';
			box.appendChild(label);
			root.appendChild(box);
		}
		document.documentElement.appendChild(root);
		return root.childElementCount;
	})()`;
	try {
		const drawn = await page.evaluate(script);
		return Number(drawn) > 0;
	} catch {
		return false;
	}
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
 * the page (a new URL, or an action the registry flags as sequence-ending:
 * navigate / switch / go_back / search …), because the indices the model
 * chose no longer apply. A click that navigates returns before the URL moves,
 * so between actions the page gets a short bounded settle before the check.
 * Whatever was skipped is named in `interrupted` — a batch never looks like
 * it ran to the end when it did not.
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
	const planned = Math.min(actions.length, max);
	const notRun = (i: number) => (i < planned - 1 ? ` The remaining ${planned - i - 1} action(s) were not run.` : '');
	for (let i = 0; i < planned; i++) {
		const { action, params } = actions[i];
		if (!registry.getAction(action)) {
			results.push({ action, ok: false, error: `Unknown action '${action}'. Available: ${[...registry.getActions().keys()].join(', ')}` });
			interrupted = notRun(i).trim() || undefined;
			break;
		}
		try {
			const r = await registry.execute(action, params ?? {}, context, { actionTimeoutS: opts.actionTimeoutS ?? 60 });
			// The engine answers a vanished index with a message and NO error
			// ("Element index 12 not available - page may have changed"); for a
			// step that is a failure — the next action must not run blind.
			const gone = !r.error && typeof r.extractedContent === 'string' && /^Element index \d+ not available/.test(r.extractedContent);
			const error = r.error || (gone ? String(r.extractedContent) : undefined);
			const message = error ? undefined : [r.extractedContent, r.longTermMemory].filter(Boolean).join('\n') || undefined;
			results.push({ action, ok: !error, message, error });
			if (error) {
				interrupted = notRun(i).trim() || undefined;
				break;
			}
		} catch (err: any) {
			const msg = err?.issues ? `Invalid params: ${JSON.stringify(err.issues)}` : String(err?.message || err);
			results.push({ action, ok: false, error: msg });
			interrupted = notRun(i).trim() || undefined;
			break;
		}
		if (i < planned - 1) {
			if (typeof (registry as any).terminatesSequence === 'function' && (registry as any).terminatesSequence(action)) {
				interrupted = `'${action}' changes the page or tab, so the indices you chose no longer apply;${notRun(i)} Look at the page first.`;
				break;
			}
			await settleBetweenActions(session);
			const urlAfter = await session.getCurrentPageUrl().catch(() => '');
			if (urlAfter && urlBefore && urlAfter !== urlBefore) {
				interrupted = `The page changed after '${action}' (${urlAfter});${notRun(i)} Look at the new page first.`;
				break;
			}
		}
	}
	if (actions.length > max && !interrupted) interrupted = `Only the first ${max} actions were run.`;
	if (results.some(r => r.ok)) await settleAfterActions(session);
	return { ok: results.length > 0 && results.every(r => r.ok), results, interrupted };
}

/** Between two actions of a batch: a click that navigates has returned but the
 *  URL has not moved yet. Short and bounded (≤ ~1.8 s); never throws. */
async function settleBetweenActions(session: BrowserSession): Promise<void> {
	try {
		await new Promise(resolve => setTimeout(resolve, 300));
		const page: any = session.getPageOrCurrent();
		await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => undefined);
	} catch {
		/* best effort */
	}
}

/**
 * Let the page catch up before it is read: a click that navigates, a submit,
 * a suggestion dropdown — reading the DOM the same millisecond returns the
 * old page and the model acts on stale indices. Bounded (≤ ~2 s), never throws.
 */
export async function settleAfterActions(session: BrowserSession): Promise<void> {
	try {
		const page: any = session.getPageOrCurrent();
		await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => undefined);
		const idle = (session as any).waitForNetworkIdle;
		// The engine's helper counts in SECONDS.
		if (typeof idle === 'function') await idle.call(session, { idleTime: 0.25, timeout: 1.2 }).catch(() => undefined);
		await new Promise(resolve => setTimeout(resolve, 150));
	} catch {
		/* best effort */
	}
}

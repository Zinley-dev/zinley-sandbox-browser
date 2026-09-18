/**
 * zbrowserd — the browser daemon that runs INSIDE the user's Daytona sandbox
 * ("Zinley's Computer").
 *
 * It owns ONE headful Chromium (patchright, persistent profile under the user's
 * workspace so logins survive stop/archive) on the sandbox's Xvfb display, and
 * exposes a tiny loopback HTTP API that the `zb` CLI calls. The backend never
 * opens a port here: every call arrives as `executeCommand("node zb.cjs …")`.
 *
 * Two ways to drive the browser:
 *   • task/*     — the autonomous browser-use Agent (same engine the desktop app
 *                  ships) runs a natural-language task with its own LLM loop.
 *   • browser/*  — single actions from the engine's registry (navigate, click,
 *                  input, extract, …) so the chat LLM can drive step by step.
 *
 * Human handoff: the Agent gets an extra action `request_user_help`. Calling it
 * pauses the run at the next step boundary and records `needsUser`; the backend
 * turns that into a "take over" card with the noVNC link and ENDS the turn. The
 * user's next message resumes via task/resume, which un-pauses the same Agent
 * with a memory note.
 *
 * Nothing in here is Daytona-specific — it runs on any Linux box with a DISPLAY.
 */
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { z } from 'zod';

import { Agent } from '../../browser-use-engine/agent/service.js';
import { BrowserSession } from '../../browser-use-engine/browser/session.js';
import { ActionRegistry, type ActionContext } from '../../browser-use-engine/actions/registry.js';
import { registerBuiltinActions } from '../../browser-use-engine/actions/builtin.js';
import { ChatSnowX } from '../../browser-use-engine/llm/snowx/chat.js';
import type { ActionResult } from '../../browser-use-engine/types/agent.js';
import { captureStepState, runStepActions, settleAfterActions, type StepAction } from '../../browser-use-engine/step-state.js';

import {
  ZB_DAEMON_PORT,
  ZB_DOWNLOADS_DIR,
  ZB_PROFILE_DIR,
  ZB_SHOTS_DIR,
  type ZbBrowserState,
  type ZbEndpoint,
  type ZbHealth,
  type ZbNeedsUser,
  type ZbResponse,
  type ZbTabInfo,
  type ZbTaskSnapshot,
  type ZbActResult,
} from './protocol';

declare const __ZB_VERSION__: string;
const VERSION = typeof __ZB_VERSION__ === 'string' ? __ZB_VERSION__ : 'dev';
/** The bundle's manifest hash, read from the directory this file runs from:
 *  the backend compares it with the runtime it just cloned. VERSION alone is
 *  the build date + engine commit and stayed the same across three runtime
 *  tags, so an old daemon kept serving after a re-clone. */
const BUNDLE_HASH: string | undefined = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')).hash || '') || undefined;
  } catch {
    return undefined;
  }
})();
const DOWNLOAD_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Third-party analytics/ads/beacons: never part of the page the model needs,
 *  a large share of the requests that keep "network idle" from arriving, and
 *  invisible to the user. Blocked at the context; the page itself is untouched. */
const BLOCKED_HOSTS = /(^|\.)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|facebook\.net|connect\.facebook\.net|hotjar\.com|fullstory\.com|segment\.io|segment\.com|mixpanel\.com|optimizely\.com|newrelic\.com|nr-data\.net|datadoghq\.com|browser-intake-datadoghq\.com|sentry\.io|bugsnag\.com|clarity\.ms|quantserve\.com|scorecardresearch\.com|criteo\.com|criteo\.net|taboola\.com|outbrain\.com|amplitude\.com|braze\.com|appsflyer\.com|adroll\.com|bing\.com\/bat|tiktok\.com\/i18n\/pixel|snap\.com\/tr|pinterest\.com\/ct|linkedin\.com\/px|adsrvr\.org|rubiconproject\.com|pubmatic\.com|openx\.net|casalemedia\.com|amazon-adsystem\.com)$/i;
const BLOCKED_PATHS = /\/(?:tr|pixel|beacon|collect|batch|track|analytics|gtm\.js|fbevents\.js|hotjar-[^/]+\.js)(?:[?/]|$)/i;

// ─── config (env, set by the backend when it launches the daemon) ───────────
const WORKSPACE = process.env.ZB_WORKSPACE || path.join(os.homedir(), 'workspace');
const PROFILE_DIR = path.join(WORKSPACE, ZB_PROFILE_DIR);
const DOWNLOADS_DIR = path.join(WORKSPACE, ZB_DOWNLOADS_DIR);
const SHOTS_DIR = path.join(WORKSPACE, ZB_SHOTS_DIR);
const PORT = Number(process.env.ZB_PORT || ZB_DAEMON_PORT);
const DISPLAY = process.env.DISPLAY || ':1';
const WINDOW_W = Number(process.env.ZB_WINDOW_W || 1280);
const WINDOW_H = Number(process.env.ZB_WINDOW_H || 800);
const MAX_ELEMENTS_CHARS = Number(process.env.ZB_MAX_ELEMENTS_CHARS || 16000);
/** JPEG quality of the step frame: the model reads ~1.4k tokens whatever the
 *  byte size, so lower is pure transfer savings until text gets mushy. */
const SHOT_QUALITY = Number(process.env.ZB_SHOT_QUALITY || 45);
const IDLE_EXIT_MS = Number(process.env.ZB_IDLE_EXIT_MS || 0); // 0 = never self-exit
/** File actions are disabled: the mutation lease on the backend assumes the
 *  browser only writes its own profile/downloads, never workspace files. */
const DISABLED_ACTIONS = ['write_file', 'read_file', 'replace_file'];

// The engine's telemetry/cloud sync must never phone home from a user sandbox.
process.env.ANONYMIZED_TELEMETRY = 'false';
process.env.BROWSER_USE_CLOUD_SYNC = 'false';
process.env.BROWSER_USE_CONFIG_DIR = process.env.BROWSER_USE_CONFIG_DIR || path.join(WORKSPACE, '.zinley', 'browseruse');

function log(msg: string): void {
  process.stdout.write(`[zbrowserd ${new Date().toISOString()}] ${msg}\n`);
}

// ─── state ──────────────────────────────────────────────────────────────────
interface TaskState extends ZbTaskSnapshot {
  agent?: Agent;
  runPromise?: Promise<void>;
  waiters: Array<() => void>;
}

class Daemon {
  private session: BrowserSession | null = null;
  private starting: Promise<BrowserSession> | null = null;
  /** Set when a browser error says the browser/context is gone: the next
   *  ensureBrowser relaunches instead of handing out a dead session. */
  private sessionDead = false;
  /** One note for the first state after a crash relaunch. */
  private restartNote: string | null = null;
  private registry: ActionRegistry;
  private task: TaskState | null = null;
  private llm: ChatSnowX | null = null;
  private token = '';
  private model = 'snowx-g5';
  private proxyBase?: string;
  private readonly startedAt = Date.now();
  private lastActivity = Date.now();
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    this.registry = this.buildRegistry();
  }

  // ── serialize every browser-touching call (GUI actions race otherwise) ──
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private buildRegistry(): ActionRegistry {
    const registry = new ActionRegistry();
    registerBuiltinActions(registry);
    for (const name of DISABLED_ACTIONS) registry.unregister(name);
    registry.register({
      name: 'request_user_help',
      description:
        'Pause and hand the browser to the user. Use for a login you were given no credentials for, a 2FA/OTP code you do not have, a captcha you cannot solve, ' +
        'payment/checkout confirmation, or a consent the user must give themselves. Credentials or codes the TASK gave you, you type; never guess or invent any. ' +
        'The user sees this exact browser window and will finish the step; you continue from the resulting page afterwards.',
      paramSchema: z.object({
        reason: z.string().describe('One sentence: what is blocking you (e.g. "Gmail asks for the password").'),
        what_to_do: z.string().describe('What the user should do in the browser (e.g. "Log in to Gmail, then tell me done").'),
      }),
      function: async (params: { reason: string; what_to_do: string }, context: ActionContext): Promise<ActionResult> => {
        let url: string | undefined;
        try {
          url = await context.browserSession.getCurrentPageUrl();
        } catch {
          /* page may be mid-navigation */
        }
        const needs: ZbNeedsUser = { reason: params.reason, whatToDo: params.what_to_do, url, since: Date.now() };
        if (this.task) {
          this.task.needsUser = needs;
          this.task.status = 'paused';
          this.task.lastMessage = `Waiting for the user: ${params.reason}`;
          this.task.agent?.pause();
          this.notifyWaiters();
        }
        log(`request_user_help: ${params.reason}`);
        return {
          extractedContent:
            `Paused. The user has been asked to: ${params.what_to_do}. ` +
            'When you continue, the user has finished that step — re-read the page state before acting.',
          longTermMemory: `Handed the browser to the user (${params.reason}).`,
          includeExtractedContentOnlyOnce: true,
        };
      },
    });
    return registry;
  }

  // ── browser ──
  private resolveExecutable(): string | undefined {
    if (process.env.ZB_CHROMIUM) return process.env.ZB_CHROMIUM;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { chromium } = require('patchright');
      const p = chromium.executablePath();
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* fall through */
    }
    for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  /** Chromium died (OOM, crash, killed): the session object outlives it and
   *  every call fails with "browser has been closed" until the box sleeps. */
  private sessionAlive(session: BrowserSession): boolean {
    if (this.sessionDead) return false;
    const b: any = (session as any).browser;
    if (b && typeof b.isConnected === 'function' && !b.isConnected()) return false;
    return true;
  }

  /** Called with any browser error: a closed-browser signature marks the
   *  session dead so the next call relaunches. */
  noteBrowserError(err: unknown): void {
    const msg = String((err as any)?.message || err || '');
    if (/(?:browser|context|page)(?:,| or)? (?:context or browser )?has been closed|Browser closed|Target closed|browserContext\.|Connection closed/i.test(msg)) {
      if (!this.sessionDead) log(`browser looks dead (${msg.slice(0, 100)}); it will be relaunched on the next call`);
      this.sessionDead = true;
    }
  }

  private pruneDownloads(): void {
    try {
      const cutoff = Date.now() - DOWNLOAD_MAX_AGE_MS;
      for (const f of fs.readdirSync(DOWNLOADS_DIR)) {
        const fp = path.join(DOWNLOADS_DIR, f);
        try {
          if (fs.statSync(fp).mtimeMs < cutoff) fs.rmSync(fp, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* best effort */
    }
  }

  async ensureBrowser(): Promise<BrowserSession> {
    if (this.session && this.sessionAlive(this.session)) return this.session;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (this.session) {
        log('relaunching chromium: the previous browser is gone');
        await this.closeBrowser();
        this.restartNote = 'The browser had died and was restarted (profile and logins kept) — the page you were on is gone: open it again with op="open".';
      }
      this.sessionDead = false;
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      this.pruneDownloads();
      process.env.DISPLAY = DISPLAY;
      const executablePath = this.resolveExecutable();
      log(`launching chromium display=${DISPLAY} exe=${executablePath || '(channel default)'} profile=${PROFILE_DIR}`);
      const session = new BrowserSession({
        headless: false,
        executablePath,
        userDataDir: PROFILE_DIR,
        downloadsPath: DOWNLOADS_DIR,
        acceptDownloads: true,
        args: [
          '--no-sandbox',
          '--disable-gpu',
          `--window-size=${WINDOW_W},${WINDOW_H}`,
          '--window-position=0,0',
          '--disable-session-crashed-bubble',
          '--hide-crash-restore-bubble',
          '--password-store=basic',
          // The profile is persistent: bound its cache so a box with a small
          // disk does not fill up over weeks of errands.
          '--disk-cache-size=104857600',
        ],
      });
      await session.start();
      await this.blockTrackers(session);
      this.session = session;
      return session;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** Route third-party trackers to a fast abort. Best effort; the page never notices. */
  private async blockTrackers(session: BrowserSession): Promise<void> {
    try {
      const context: any = (session as any).context;
      if (!context || typeof context.route !== 'function') return;
      let blocked = 0;
      await context.route('**/*', (route: any) => {
        try {
          const url = new URL(route.request().url());
          const pageHost = (() => {
            try {
              return new URL(route.request().frame()?.url() || '').hostname;
            } catch {
              return '';
            }
          })();
          const thirdParty = pageHost && !url.hostname.endsWith(pageHost.replace(/^www\./, ''));
          if (BLOCKED_HOSTS.test(url.hostname) || (thirdParty && BLOCKED_PATHS.test(url.pathname))) {
            blocked++;
            return route.abort('blockedbyclient');
          }
        } catch {
          /* fall through */
        }
        return route.continue();
      });
      log(`tracker blocking on (${blocked} blocked so far)`);
    } catch (err: any) {
      log(`tracker blocking unavailable: ${err?.message}`);
    }
  }

  async closeBrowser(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.sessionDead = false;
    if (s) await Promise.race([s.stop(), new Promise(r => setTimeout(r, 8000))]).catch(err => log(`browser stop failed: ${err?.message}`));
  }

  private async currentPage(session: BrowserSession) {
    return session.getPageOrCurrent();
  }

  /** JPEG screenshot of the current page. Written to a file under the workspace
   *  (the backend downloads it over sandbox.fs — a 100KB+ base64 blob does not
   *  fit reliably through a command's stdout) unless `inline` is requested. */
  async screenshotJpeg(session: BrowserSession, quality = 60, inline = false): Promise<{ path?: string; base64?: string } | null> {
    try {
      const page: any = await this.currentPage(session);
      const buf: Buffer = await page.screenshot({ type: 'jpeg', quality, scale: 'css', timeout: 15000 });
      if (inline) return { base64: buf.toString('base64') };
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      try {
        // keep the dir bounded: drop shots older than 1h
        const cutoff = Date.now() - 3600_000;
        for (const f of fs.readdirSync(SHOTS_DIR)) {
          const fp = path.join(SHOTS_DIR, f);
          if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
        }
      } catch {
        /* best effort */
      }
      const file = path.join(SHOTS_DIR, `shot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}.jpg`);
      fs.writeFileSync(file, buf);
      return { path: file };
    } catch (err: any) {
      log(`screenshot failed: ${err?.message}`);
      return null;
    }
  }

  /** The page as the agent's model would see it (see engine step-state.ts):
   *  tabs, viewport position, hints, `*[`-marked elements, numbered screenshot. */
  async browserState(session: BrowserSession, includeScreenshot: boolean, inlineScreenshot = false, inlineMax = 0): Promise<ZbBrowserState> {
    let st;
    try {
      st = await captureStepState(session, { screenshot: includeScreenshot, jpegQuality: SHOT_QUALITY, maxElementsChars: MAX_ELEMENTS_CHARS });
    } catch (err) {
      this.noteBrowserError(err);
      throw err;
    }
    if (this.restartNote) {
      st.notes = [this.restartNote, ...(st.notes ?? [])];
      this.restartNote = null;
    }
    for (const n of st.notes ?? []) this.noteBrowserError(n);
    let screenshotPath: string | undefined;
    let screenshot: string | null = null;
    if (st.screenshot) {
      // Inline when the caller can take it in the response (saves the backend a
      // file download per step); a frame above the caller's cap goes to disk.
      if (inlineScreenshot || (inlineMax > 0 && st.screenshot.length <= inlineMax)) screenshot = st.screenshot;
      else screenshotPath = this.writeShot(Buffer.from(st.screenshot, 'base64'));
    }
    return {
      url: st.url,
      title: st.title,
      tabs: st.tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
      elements: st.elements,
      elementsTruncated: st.elementsTruncated,
      interactiveCount: st.interactiveCount,
      pageInfo: st.pageInfo,
      notes: st.notes,
      delta: st.delta,
      screenshot,
      screenshotPath,
      screenshotMime: st.screenshot ? 'image/jpeg' : undefined,
      needsUser: this.task?.needsUser ?? null,
    };
  }

  /** Persist a screenshot under the workspace (the backend downloads it over sandbox.fs). */
  private writeShot(buf: Buffer): string | undefined {
    try {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      try {
        const cutoff = Date.now() - 3600_000;
        for (const f of fs.readdirSync(SHOTS_DIR)) {
          const fp = path.join(SHOTS_DIR, f);
          if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
        }
      } catch {
        /* best effort */
      }
      const file = path.join(SHOTS_DIR, `shot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}.jpg`);
      fs.writeFileSync(file, buf);
      return file;
    } catch (err: any) {
      log(`screenshot write failed: ${err?.message}`);
      return undefined;
    }
  }

  private ensureLlm(): ChatSnowX {
    if (!this.token) throw new Error('No API token configured (backend must pass token before starting a task).');
    if (!this.llm) {
      this.llm = new ChatSnowX({ model: this.model, firebaseToken: this.token, baseURL: this.proxyBase, timeout: 120000 });
    }
    return this.llm;
  }

  setToken(token: string, model?: string, proxyBase?: string): void {
    if (model) this.model = model;
    if (proxyBase) this.proxyBase = proxyBase;
    if (token && token !== this.token) {
      this.token = token;
      this.llm = new ChatSnowX({ model: this.model, firebaseToken: this.token, baseURL: this.proxyBase, timeout: 120000 });
      if (this.task?.agent) this.task.agent.llm = this.llm;
    }
  }

  // ── single actions / short batches ──
  async act(action: string, params: Record<string, unknown>, inlineScreenshot = false, batch?: StepAction[], inlineMax = 0): Promise<ZbActResult> {
    const session = await this.ensureBrowser();
    const actions: StepAction[] = batch && batch.length > 0 ? batch : [{ action, params }];
    const label = actions.map(a => a.action).join(' → ');
    if (this.task && this.task.status === 'running') {
      return { ok: false, action: label, error: 'An autonomous task is running. Stop or pause it before driving the browser directly.' };
    }
    for (const a of actions) {
      if (a.action === 'done' || a.action === 'request_user_help') {
        return { ok: false, action: label, error: `'${a.action}' is the browser agent's, not a step — use op="handoff" for the user and just stop calling when you are done.` };
      }
    }
    const context: ActionContext = {
      browserSession: session,
      llm: this.token ? this.ensureLlm() : undefined,
      pageExtractionLlm: this.token ? this.ensureLlm() : undefined,
    } as ActionContext;
    const run = await runStepActions(session, this.registry, actions, context, { actionTimeoutS: 60, max: 5 });
    for (const r of run.results) if (r.error) this.noteBrowserError(r.error);
    // What ran must reach the model even when the page cannot be read afterwards
    // (the site closed the tab, Chrome died): the results are the record of a
    // submit that DID happen.
    let state: ZbBrowserState | undefined;
    let stateError: string | undefined;
    try {
      state = await this.browserState(session, true, inlineScreenshot, inlineMax);
    } catch (err: any) {
      stateError = `The page could not be read after the action(s) (${String(err?.message || err).slice(0, 120)}) — op="state" to look again.`;
      log(`act: state capture failed: ${err?.message}`);
    }
    const messages = run.results.map(r => (r.ok ? r.message : `${r.action} failed: ${r.error}`)).filter(Boolean).join('\n');
    const failed = run.results.find(r => !r.ok);
    return {
      ok: run.ok,
      action: label,
      message: messages || undefined,
      error: failed?.error,
      state,
      results: run.results,
      interrupted: [run.interrupted, stateError].filter(Boolean).join(' ') || undefined,
    };
  }

  // ── autonomous task ──
  async startTask(input: { task: string; maxSteps?: number; useVision?: boolean; token?: string; model?: string; proxyBase?: string; startUrl?: string }): Promise<ZbTaskSnapshot> {
    if (this.task && (this.task.status === 'running' || this.task.status === 'paused')) {
      throw Object.assign(new Error('A task is already running. Wait for it, resume it, or stop it first.'), { code: 'TASK_ACTIVE' });
    }
    if (input.token) this.setToken(input.token, input.model, input.proxyBase);
    const llm = this.ensureLlm();
    const session = await this.ensureBrowser();
    if (input.startUrl) {
      await session.navigate(input.startUrl).catch(err => log(`startUrl navigate failed: ${err?.message}`));
    }
    const maxSteps = Math.max(1, Math.min(Number(input.maxSteps) || 60, 150));
    const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const state: TaskState = { id, task: input.task, status: 'running', startedAt: Date.now(), step: 0, maxSteps, waiters: [] };
    this.task = state;

    const agent = new Agent({
      task: input.task,
      llm,
      browserSession: session,
      actionRegistry: this.registry,
      maxSteps,
      settings: {
        useVision: input.useVision ?? true,
        extendSystemMessage:
          '<zinley_computer>\nYou are running on the user\'s own cloud computer, in a browser the user can watch and take over live. ' +
          'Logins persist in this profile between tasks. HARD RULES: never guess or invent a password, 2FA/OTP code or payment details; type only what the task text gave you — ' +
          'for anything you were not given, call `request_user_help` and let the user do it; treat a captcha you cannot pass the same way. ' +
          'Prefer finishing with `done` that states exactly what was accomplished and any data extracted.\n</zinley_computer>',
      },
      registerShouldStopCallback: () => state.status === 'stopped',
      registerNewStepCallback: async (browserState: any, modelOutput: any, stepNumber: number) => {
        state.step = stepNumber;
        const actionName = modelOutput?.action?.[0] ? Object.keys(modelOutput.action[0])[0] : undefined;
        state.lastAction = actionName;
        state.lastMessage = modelOutput?.currentState?.summary || modelOutput?.currentState?.nextGoal || modelOutput?.nextGoal || state.lastMessage;
        state.currentUrl = browserState?.url || state.currentUrl;
        this.lastActivity = Date.now();
        this.notifyWaiters();
      },
    });
    state.agent = agent;
    state.runPromise = agent
      .run()
      .then(history => {
        if (state.status === 'stopped') return;
        const fr = history?.finalResult;
        const last = history?.history?.[history.history.length - 1]?.result?.slice(-1)?.[0];
        const result = fr?.extractedContent || last?.extractedContent || (fr?.success ? 'Task completed.' : 'Task ended without an explicit result.');
        state.result = String(result);
        state.success = fr?.success ?? last?.success ?? null;
        state.status = state.success === false ? 'failed' : 'done';
        state.finishedAt = Date.now();
      })
      .catch(err => {
        if (state.status === 'stopped') return;
        state.status = 'failed';
        state.error = String(err?.message || err);
        state.finishedAt = Date.now();
        log(`task ${id} failed: ${state.error}`);
      })
      .finally(() => {
        state.agent = undefined;
        this.notifyWaiters();
      });
    return this.snapshot(state);
  }

  private snapshot(s: TaskState): ZbTaskSnapshot {
    const { agent: _a, runPromise: _r, waiters: _w, ...rest } = s;
    void _a;
    void _r;
    void _w;
    return { ...rest };
  }

  private notifyWaiters(): void {
    const t = this.task;
    if (!t) return;
    const ws = t.waiters.splice(0);
    for (const w of ws) w();
  }

  /** Long-poll: resolve when the task reaches a terminal state, needs the user,
   *  or `waitMs` elapses (the CLI caller bounds this well under the backend's
   *  per-command timeout). */
  async taskStatus(waitMs: number): Promise<ZbTaskSnapshot | null> {
    const t = this.task;
    if (!t) return null;
    const settled = () => t.status === 'done' || t.status === 'failed' || t.status === 'stopped' || t.status === 'paused';
    if (settled() || waitMs <= 0) return this.snapshot(t);
    const startStep = t.step;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, waitMs);
      t.waiters.push(() => {
        if (settled() || t.step !== startStep) {
          clearTimeout(timer);
          resolve();
        } else {
          t.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        }
      });
    });
    return this.snapshot(t);
  }

  pauseTask(reason?: string): ZbTaskSnapshot | null {
    const t = this.task;
    if (!t || t.status !== 'running') return t ? this.snapshot(t) : null;
    t.agent?.pause();
    t.status = 'paused';
    if (!t.needsUser) t.needsUser = { reason: reason || 'Paused by the assistant', whatToDo: reason || 'Take over in the browser, then say done.', since: Date.now() };
    this.notifyWaiters();
    return this.snapshot(t);
  }

  resumeTask(note?: string): { snapshot: ZbTaskSnapshot | null; restarted: boolean } {
    const t = this.task;
    if (!t || !t.agent || t.status !== 'paused') {
      // Nothing to resume in-process (daemon restarted, task finished, or never
      // started) — the backend decides whether to start a fresh task.
      return { snapshot: t ? this.snapshot(t) : null, restarted: false };
    }
    const done = t.needsUser?.whatToDo;
    t.needsUser = null;
    t.status = 'running';
    const memo =
      `${t.task}\n\n[Update from the user] The user has just handled: ${done || 'the step you asked for'}` +
      (note ? ` — they said: "${note}"` : '') +
      '. Re-read the current page state and continue the original task from here.';
    t.agent.addNewTask(memo);
    t.agent.resume();
    this.notifyWaiters();
    return { snapshot: this.snapshot(t), restarted: false };
  }

  async stopTask(): Promise<ZbTaskSnapshot | null> {
    const t = this.task;
    if (!t) return null;
    if (t.status === 'running' || t.status === 'paused') {
      t.status = 'stopped';
      t.finishedAt = Date.now();
      t.needsUser = null;
      t.agent?.stop();
      t.agent?.resume(); // unblock a paused loop so it observes `stopped`
      this.notifyWaiters();
      await Promise.race([t.runPromise ?? Promise.resolve(), new Promise(r => setTimeout(r, 8000))]);
    }
    return this.snapshot(t);
  }

  health(): ZbHealth {
    return {
      ok: true,
      version: VERSION,
      hash: BUNDLE_HASH,
      pid: process.pid,
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      browserOpen: !!this.session,
      display: DISPLAY,
      task: this.task ? this.snapshot(this.task) : null,
    };
  }

  touch(): void {
    this.lastActivity = Date.now();
  }
  idleMs(): number {
    return Date.now() - this.lastActivity;
  }
  hasActiveTask(): boolean {
    return !!this.task && (this.task.status === 'running' || this.task.status === 'paused');
  }

  // ── dispatcher ──
  async handle(endpoint: ZbEndpoint, body: any): Promise<unknown> {
    this.touch();
    switch (endpoint) {
      case 'health':
        return this.health();
      case 'browser/open':
        return this.serialized(async () => {
          const session = await this.ensureBrowser();
          // A navigation that times out still leaves a page (often the right
          // one, still loading): report it as a note and show what is there.
          let navError: string | undefined;
          if (body?.url && typeof body.url === 'string') {
            try {
              await session.navigate(body.url);
            } catch (err: any) {
              navError = `Opening ${body.url} did not complete (${String(err?.message || err).slice(0, 100)}) — the page below is what the browser shows now.`;
            }
            // Single-page apps keep rendering after "load": read the page once it is still.
            await settleAfterActions(session);
          }
          const state = await this.browserState(session, body?.screenshot !== false, body?.inline === true, Number(body?.inlineMax) || 0);
          if (navError) state.notes = [navError, ...(state.notes ?? [])];
          // The engine's own action reference — the exact parameters the agent's
          // model gets — minus the agent-loop-only actions. No URL: with one the
          // registry keeps only domain-scoped actions, and no builtin has a domain.
          state.actionsHelp = this.registry
            .getPromptDescription()
            .split('\n')
            .filter(line => !/^(?:done|request_user_help|write_file|read_file|replace_file|screenshot|save_as_pdf):/.test(line))
            .join('\n');
          return state;
        });
      case 'browser/state':
        return this.serialized(async () => this.browserState(await this.ensureBrowser(), body?.screenshot !== false, body?.inline === true, Number(body?.inlineMax) || 0));
      case 'browser/screenshot':
        return this.serialized(async () => {
          const session = await this.ensureBrowser();
          const quality = Math.max(20, Math.min(90, Number(body?.quality) || 60));
          const shot = await this.screenshotJpeg(session, quality, body?.inline === true);
          return { screenshot: shot?.base64 ?? null, screenshotPath: shot?.path, mime: 'image/jpeg', url: await session.getCurrentPageUrl().catch(() => '') };
        });
      case 'browser/act': {
        const batch: StepAction[] | undefined = Array.isArray(body?.actions)
          ? body.actions
              .filter((a: any) => a && typeof a.action === 'string' && a.action.trim())
              .map((a: any) => ({ action: String(a.action).trim(), params: a.params && typeof a.params === 'object' ? a.params : {} }))
          : undefined;
        if ((!batch || batch.length === 0) && (!body?.action || typeof body.action !== 'string')) throw new Error('action (or actions[]) is required');
        // `extract` reads the page with a model: the backend sends the user's
        // token with the step that needs it (a task start is the other source).
        if (typeof body?.token === 'string' && body.token) this.setToken(body.token, body.model, body.proxyBase);
        return this.serialized(() =>
          this.act(String(body?.action || batch![0].action), body?.params && typeof body.params === 'object' ? body.params : {}, body?.inline === true, batch, Number(body?.inlineMax) || 0),
        );
      }
      case 'browser/close':
        return this.serialized(async () => {
          await this.stopTask();
          await this.closeBrowser();
          return { closed: true };
        });
      case 'task/start':
        if (!body?.task || typeof body.task !== 'string') throw new Error('task is required');
        return this.startTask(body);
      case 'task/status':
        return this.taskStatus(Math.max(0, Math.min(Number(body?.waitMs) || 0, 55_000)));
      case 'task/pause':
        return this.pauseTask(body?.reason);
      case 'task/resume':
        return this.resumeTask(body?.note);
      case 'task/stop':
        return this.stopTask();
      case 'token':
        if (!body?.token || typeof body.token !== 'string') throw new Error('token is required');
        this.setToken(body.token, body.model, body.proxyBase);
        return { updated: true, model: this.model };
      case 'shutdown':
        setTimeout(() => {
          this.stopTask()
            .then(() => this.closeBrowser())
            .finally(() => process.exit(0));
        }, 50);
        return { shuttingDown: true };
      default:
        throw Object.assign(new Error(`Unknown endpoint '${endpoint}'`), { code: 'UNKNOWN_ENDPOINT' });
    }
  }
}

// ─── HTTP server (loopback only) ─────────────────────────────────────────────
const daemon = new Daemon();

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const endpoint = (req.url || '/').replace(/^\/+/, '').split('?')[0] as ZbEndpoint;
    let body: any = {};
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { ok: false, error: 'Invalid JSON body' });
    }
    try {
      const data = await daemon.handle(endpoint, body);
      send(res, 200, { ok: true, data });
    } catch (err: any) {
      send(res, 200, { ok: false, error: String(err?.message || err), code: err?.code });
    }
  });
});

function send(res: http.ServerResponse, status: number, payload: ZbResponse<unknown>): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${PORT} version=${VERSION} display=${DISPLAY} workspace=${WORKSPACE}`);
});

if (IDLE_EXIT_MS > 0) {
  setInterval(() => {
    if (!daemon.hasActiveTask() && daemon.idleMs() > IDLE_EXIT_MS) {
      log('idle — exiting');
      process.exit(0);
    }
  }, 30_000).unref();
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`${sig} received — closing browser`);
    daemon
      .stopTask()
      .then(() => daemon.closeBrowser())
      .finally(() => process.exit(0));
  });
}
process.on('unhandledRejection', err => log(`unhandledRejection: ${(err as any)?.message || err}`));
process.on('uncaughtException', err => log(`uncaughtException: ${err?.message}`));

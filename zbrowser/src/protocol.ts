/**
 * Wire contract between the backend (SandboxBrowserService) and the browser
 * daemon that runs INSIDE the user's Daytona sandbox (`sandbox-runtime/zbrowser`).
 *
 * This file is imported by BOTH sides (the daemon bundle pulls it in through a
 * relative path at build time), so it must stay dependency-free and pure:
 * types, constants, and tiny encode/parse helpers only.
 *
 * Transport: the backend never opens a port to the daemon. Every call is
 * `sandbox.process.executeCommand("node <zb.cjs> <endpoint> '<json>'")`; the
 * CLI talks to the daemon over 127.0.0.1 and prints exactly one line
 * `ZB_JSON:<json>` on stdout. Everything else on stdout/stderr is diagnostics.
 */

export const ZB_DAEMON_PORT = 7331;
export const ZB_JSON_PREFIX = 'ZB_JSON:';
/** noVNC (websockify) port started by Daytona's computerUse.start(). */
export const ZB_NOVNC_PORT = 6080;

/** Paths INSIDE the sandbox. The workspace dir is the only path documented to
 *  survive stop/archive/restore, so everything stateful lives under it. */
export const ZB_STATE_DIR = '.zinley';
export const ZB_PROFILE_DIR = `${ZB_STATE_DIR}/browser-profile`;
export const ZB_DOWNLOADS_DIR = `${ZB_STATE_DIR}/downloads`;
export const ZB_SHOTS_DIR = `${ZB_STATE_DIR}/shots`;
/** Upload mode: bundle files land under `<runtime dir>/<bundle hash>/`. */
export const ZB_RUNTIME_DIR = `${ZB_STATE_DIR}/zbrowser`;
/** Git mode (default): the public runtime repo is cloned here; the daemon runs
 *  from `<src dir>/bundle/`. A `.zb-ref` marker records `<repo>@<ref>`. */
export const ZB_SRC_DIR = `${ZB_STATE_DIR}/zbrowser-src`;
export const ZB_DEPS_DIR = `${ZB_STATE_DIR}/rt`;
export const ZB_LOG_FILE = `${ZB_STATE_DIR}/zbrowser.log`;

/** Machine-readable marker line appended to a handoff tool result. Clients
 *  (electron/native/hp) parse it into a card; SMS/Telegram delivery keeps the
 *  human line above it. Same convention as the `🎙️ <url>` voice line. */
export const ZB_HANDOFF_MARKER = 'ZB_HANDOFF';

export type ZbTaskStatus = 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';

export interface ZbNeedsUser {
  reason: string;
  whatToDo: string;
  url?: string;
  since: number;
}

export interface ZbTabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface ZbTaskSnapshot {
  id: string;
  task: string;
  status: ZbTaskStatus;
  startedAt: number;
  finishedAt?: number;
  step: number;
  maxSteps: number;
  lastAction?: string;
  lastMessage?: string;
  currentUrl?: string;
  needsUser?: ZbNeedsUser | null;
  result?: string | null;
  success?: boolean | null;
  error?: string | null;
}

export interface ZbHealth {
  ok: true;
  version: string;
  pid: number;
  uptimeS: number;
  browserOpen: boolean;
  display?: string;
  task?: ZbTaskSnapshot | null;
}

export interface ZbBrowserState {
  url: string;
  title: string;
  tabs: ZbTabInfo[];
  /** Indexed interactive elements in the engine's `[index]<tag>text</tag>` form. */
  elements: string;
  elementsTruncated: boolean;
  /** Inline base64 only when requested (`inline:true`); normally the daemon
   *  writes the JPEG under the workspace and returns `screenshotPath`. */
  screenshot?: string | null;
  screenshotPath?: string;
  screenshotMime?: string;
  needsUser?: ZbNeedsUser | null;
}

export interface ZbActResult {
  ok: boolean;
  action: string;
  message?: string;
  error?: string;
  state?: ZbBrowserState;
}

export type ZbEndpoint =
  | 'health'
  | 'browser/open'
  | 'browser/state'
  | 'browser/act'
  | 'browser/screenshot'
  | 'browser/close'
  | 'task/start'
  | 'task/status'
  | 'task/pause'
  | 'task/resume'
  | 'task/stop'
  | 'token'
  | 'shutdown';

export interface ZbOk<T> {
  ok: true;
  data: T;
}
export interface ZbErr {
  ok: false;
  error: string;
  code?: string;
}
export type ZbResponse<T> = ZbOk<T> | ZbErr;

/** Encode the one stdout line the backend parses. */
export function encodeZbLine(payload: unknown): string {
  // JSON.stringify leaves U+2028/U+2029 raw; some line splitters treat them as
  // newlines, which would cut the one line the backend parses.
  return `${ZB_JSON_PREFIX}${JSON.stringify(payload)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}`;
}

/** Find and parse the daemon's JSON line in a command's combined output. */
export function parseZbOutput<T = unknown>(output: string): ZbResponse<T> | null {
  if (typeof output !== 'string') return null;
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const at = line.indexOf(ZB_JSON_PREFIX);
    if (at === -1) continue;
    try {
      return JSON.parse(line.slice(at + ZB_JSON_PREFIX.length)) as ZbResponse<T>;
    } catch {
      return null;
    }
  }
  return null;
}

/** Payload carried on the ZB_HANDOFF marker line of a tool result. */
export interface ZbHandoffCard {
  v: 1;
  viewUrl: string;
  /** Shortened viewUrl for text channels (SMS/iMessage/Telegram). */
  shortUrl?: string;
  reason: string;
  whatToDo?: string;
  pageUrl?: string;
  pageTitle?: string;
  expiresAt: string;
  conversationId?: string;
}

/** Hosts of the takeover link — used to suppress link previews on chat apps. */
export const ZB_VIEW_URL_RE = /https?:\/\/[^\s"'<>]*proxy\.daytona\.app\/[^\s"'<>]*/i;

export function encodeHandoffLine(card: ZbHandoffCard): string {
  return `${ZB_HANDOFF_MARKER} ${JSON.stringify(card)}`;
}

export function parseHandoffLine(text: string): ZbHandoffCard | null {
  if (typeof text !== 'string') return null;
  const m = new RegExp(`^${ZB_HANDOFF_MARKER} (\\{.*\\})\\s*$`, 'm').exec(text);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return parsed && parsed.v === 1 && typeof parsed.viewUrl === 'string' ? (parsed as ZbHandoffCard) : null;
  } catch {
    return null;
  }
}

/** Strip the machine line for surfaces that must never show the bearer URL twice. */
export function stripHandoffLine(text: string): string {
  return text
    .replace(new RegExp(`^${ZB_HANDOFF_MARKER} \\{.*\\}\\s*$`, 'gm'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

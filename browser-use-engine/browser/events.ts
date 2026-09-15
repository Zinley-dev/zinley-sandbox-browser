/**
 * Event definitions for browser communication.
 * Port from browser_use/browser/events.py (578 lines)
 */

import { z } from 'zod';
import { BrowserStateSummary } from './views.js';
import { EnhancedDOMTreeNode } from '../dom/views.js';

// ============================================================================
// Event Timeout Helpers
// ============================================================================

function getTimeout(envVar: string, defaultValue: number): number | null {
	/**
	 * Safely parse environment variable timeout values with robust error handling.
	 *
	 * @param envVar - Environment variable name (e.g. 'TIMEOUT_NavigateToUrlEvent')
	 * @param defaultValue - Default timeout value as number (e.g. 15.0)
	 * @returns Parsed number value or the default if parsing fails
	 */
	const envValue = process.env[envVar];
	if (envValue) {
		try {
			const parsed = parseFloat(envValue);
			if (parsed < 0) {
				console.warn(`Warning: ${envVar}=${envValue} is negative, using default ${defaultValue}`);
				return defaultValue;
			}
			return parsed;
		} catch (error) {
			console.warn(`Warning: ${envVar}=${envValue} is not a valid number, using default ${defaultValue}`);
		}
	}

	return defaultValue;
}

// ============================================================================
// Event Timeouts (seconds)
// ============================================================================

export const TIMEOUTS = {
	NAVIGATE_TO_URL: getTimeout('TIMEOUT_NavigateToUrlEvent', 15.0),
	CLICK_ELEMENT: getTimeout('TIMEOUT_ClickElementEvent', 15.0),
	TYPE_TEXT: getTimeout('TIMEOUT_TypeTextEvent', 15.0),
	SCROLL: getTimeout('TIMEOUT_ScrollEvent', 8.0),
	SWITCH_TAB: getTimeout('TIMEOUT_SwitchTabEvent', 10.0),
	CLOSE_TAB: getTimeout('TIMEOUT_CloseTabEvent', 10.0),
	SCREENSHOT: getTimeout('TIMEOUT_ScreenshotEvent', 8.0),
	BROWSER_STATE_REQUEST: getTimeout('TIMEOUT_BrowserStateRequestEvent', 30.0),
	GO_BACK: getTimeout('TIMEOUT_GoBackEvent', 15.0),
	GO_FORWARD: getTimeout('TIMEOUT_GoForwardEvent', 15.0),
	REFRESH: getTimeout('TIMEOUT_RefreshEvent', 15.0),
	WAIT: getTimeout('TIMEOUT_WaitEvent', 60.0),
	SEND_KEYS: getTimeout('TIMEOUT_SendKeysEvent', 15.0),
	UPLOAD_FILE: getTimeout('TIMEOUT_UploadFileEvent', 30.0),
	GET_DROPDOWN_OPTIONS: getTimeout('TIMEOUT_GetDropdownOptionsEvent', 15.0),
	SELECT_DROPDOWN_OPTION: getTimeout('TIMEOUT_SelectDropdownOptionEvent', 8.0),
	SCROLL_TO_TEXT: getTimeout('TIMEOUT_ScrollToTextEvent', 15.0),
	BROWSER_START: getTimeout('TIMEOUT_BrowserStartEvent', 30.0),
	BROWSER_STOP: getTimeout('TIMEOUT_BrowserStopEvent', 45.0),
	BROWSER_LAUNCH: getTimeout('TIMEOUT_BrowserLaunchEvent', 30.0),
	BROWSER_KILL: getTimeout('TIMEOUT_BrowserKillEvent', 30.0),
	BROWSER_CONNECTED: getTimeout('TIMEOUT_BrowserConnectedEvent', 30.0),
	BROWSER_STOPPED: getTimeout('TIMEOUT_BrowserStoppedEvent', 30.0),
	TAB_CREATED: getTimeout('TIMEOUT_TabCreatedEvent', 30.0),
	TAB_CLOSED: getTimeout('TIMEOUT_TabClosedEvent', 10.0),
	AGENT_FOCUS_CHANGED: getTimeout('TIMEOUT_AgentFocusChangedEvent', 10.0),
	TARGET_CRASHED: getTimeout('TIMEOUT_TargetCrashedEvent', 10.0),
	NAVIGATION_STARTED: getTimeout('TIMEOUT_NavigationStartedEvent', 30.0),
	NAVIGATION_COMPLETE: getTimeout('TIMEOUT_NavigationCompleteEvent', 30.0),
	BROWSER_ERROR: getTimeout('TIMEOUT_BrowserErrorEvent', 30.0),
	SAVE_STORAGE_STATE: getTimeout('TIMEOUT_SaveStorageStateEvent', 45.0),
	STORAGE_STATE_SAVED: getTimeout('TIMEOUT_StorageStateSavedEvent', 30.0),
	LOAD_STORAGE_STATE: getTimeout('TIMEOUT_LoadStorageStateEvent', 45.0),
	STORAGE_STATE_LOADED: getTimeout('TIMEOUT_StorageStateLoadedEvent', 30.0),
	FILE_DOWNLOADED: getTimeout('TIMEOUT_FileDownloadedEvent', 30.0),
} as const;

// ============================================================================
// Event Names
// ============================================================================

export enum BrowserEventNames {
	// Agent/Tools -> BrowserSession Events (High-level browser actions)
	ELEMENT_SELECTED = 'ElementSelectedEvent',
	NAVIGATE_TO_URL = 'NavigateToUrlEvent',
	CLICK_ELEMENT = 'ClickElementEvent',
	TYPE_TEXT = 'TypeTextEvent',
	SCROLL = 'ScrollEvent',
	SWITCH_TAB = 'SwitchTabEvent',
	CLOSE_TAB = 'CloseTabEvent',
	SCREENSHOT = 'ScreenshotEvent',
	BROWSER_STATE_REQUEST = 'BrowserStateRequestEvent',
	GO_BACK = 'GoBackEvent',
	GO_FORWARD = 'GoForwardEvent',
	REFRESH = 'RefreshEvent',
	WAIT = 'WaitEvent',
	SEND_KEYS = 'SendKeysEvent',
	UPLOAD_FILE = 'UploadFileEvent',
	GET_DROPDOWN_OPTIONS = 'GetDropdownOptionsEvent',
	SELECT_DROPDOWN_OPTION = 'SelectDropdownOptionEvent',
	SCROLL_TO_TEXT = 'ScrollToTextEvent',

	// Browser lifecycle events
	BROWSER_START = 'BrowserStartEvent',
	BROWSER_STOP = 'BrowserStopEvent',
	BROWSER_LAUNCH = 'BrowserLaunchEvent',
	BROWSER_KILL = 'BrowserKillEvent',

	// DOM-related Events
	BROWSER_CONNECTED = 'BrowserConnectedEvent',
	BROWSER_STOPPED = 'BrowserStoppedEvent',
	TAB_CREATED = 'TabCreatedEvent',
	TAB_CLOSED = 'TabClosedEvent',
	AGENT_FOCUS_CHANGED = 'AgentFocusChangedEvent',
	TARGET_CRASHED = 'TargetCrashedEvent',
	NAVIGATION_STARTED = 'NavigationStartedEvent',
	NAVIGATION_COMPLETE = 'NavigationCompleteEvent',

	// Error Events
	BROWSER_ERROR = 'BrowserErrorEvent',

	// Storage State Events
	SAVE_STORAGE_STATE = 'SaveStorageStateEvent',
	STORAGE_STATE_SAVED = 'StorageStateSavedEvent',
	LOAD_STORAGE_STATE = 'LoadStorageStateEvent',
	STORAGE_STATE_LOADED = 'StorageStateLoadedEvent',

	// File Download Events
	FILE_DOWNLOADED = 'FileDownloadedEvent',

	// Watchdog Events
	ABOUT_BLANK_ANIMATION_SHOWN = 'AboutBlankAnimationShownEvent',
	DIALOG_OPENED = 'DialogOpenedEvent',
}

// ============================================================================
// Event Interfaces
// ============================================================================

export interface ElementSelectedEvent {
	node: EnhancedDOMTreeNode;
}

export interface NavigateToUrlEvent {
	url: string;
	waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
	timeoutMs?: number | null;
	newTab?: boolean;
}

export interface ClickElementEvent extends ElementSelectedEvent {
	node: EnhancedDOMTreeNode;
	button?: 'left' | 'right' | 'middle';
}

export interface TypeTextEvent extends ElementSelectedEvent {
	node: EnhancedDOMTreeNode;
	text: string;
	clear?: boolean;
	isSensitive?: boolean;
	sensitiveKeyName?: string | null;
}

export interface ScrollEvent {
	direction: 'up' | 'down' | 'left' | 'right';
	amount: number; // pixels
	node?: EnhancedDOMTreeNode | null; // None means scroll page
}

export interface SwitchTabEvent {
	targetId?: string | null; // None means switch to most recently opened tab
}

export interface CloseTabEvent {
	targetId: string;
}

export interface ScreenshotEvent {
	fullPage?: boolean;
	clip?: { x: number; y: number; width: number; height: number } | null;
}

export interface BrowserStateRequestEvent {
	includeDom?: boolean;
	includeScreenshot?: boolean;
	includeRecentEvents?: boolean;
}

export interface GoBackEvent {}

export interface GoForwardEvent {}

export interface RefreshEvent {}

export interface WaitEvent {
	seconds?: number;
	maxSeconds?: number;
}

export interface SendKeysEvent {
	keys: string; // e.g., "ctrl+a", "cmd+c", "Enter"
}

export interface UploadFileEvent extends ElementSelectedEvent {
	node: EnhancedDOMTreeNode;
	filePath: string;
}

export interface GetDropdownOptionsEvent extends ElementSelectedEvent {
	node: EnhancedDOMTreeNode;
}

export interface SelectDropdownOptionEvent extends ElementSelectedEvent {
	node: EnhancedDOMTreeNode;
	text: string; // The option text to select
}

export interface ScrollToTextEvent {
	text: string;
	direction?: 'up' | 'down';
}

// Browser lifecycle events
export interface BrowserStartEvent {
	cdpUrl?: string | null;
	launchOptions?: Record<string, any>;
}

export interface BrowserStopEvent {
	force?: boolean;
}

export interface BrowserLaunchResult {
	cdpUrl: string;
}

export interface BrowserLaunchEvent {}

export interface BrowserKillEvent {}

// DOM-related Events
export interface BrowserConnectedEvent {
	cdpUrl: string;
}

export interface BrowserStoppedEvent {
	reason?: string | null;
}

export interface TabCreatedEvent {
	targetId: string;
	url: string;
}

export interface TabClosedEvent {
	targetId: string;
}

export interface AgentFocusChangedEvent {
	targetId: string;
	url: string;
}

export interface TargetCrashedEvent {
	targetId: string;
	error: string;
}

export interface NavigationStartedEvent {
	targetId: string;
	url: string;
}

export interface NavigationCompleteEvent {
	targetId: string;
	url: string;
	status?: number | null;
	errorMessage?: string | null;
	loadingStatus?: string | null;
}

// Error Events
export interface BrowserErrorEvent {
	errorType: string;
	message: string;
	details?: Record<string, any>;
}

// Storage State Events
export interface SaveStorageStateEvent {
	path?: string | null;
}

export interface StorageStateSavedEvent {
	path: string;
	cookiesCount: number;
	originsCount: number;
}

export interface LoadStorageStateEvent {
	path?: string | null;
}

export interface StorageStateLoadedEvent {
	path: string;
	cookiesCount: number;
	originsCount: number;
}

// File Download Events
export interface FileDownloadedEvent {
	url: string;
	path: string;
	fileName: string;
	fileSize: number;
	fileType?: string | null;
	mimeType?: string | null;
	fromCache?: boolean;
	autoDownload?: boolean;
}

// Watchdog Events
export interface AboutBlankAnimationShownEvent {
	targetId: string;
	error?: string | null;
}

export interface DialogOpenedEvent {
	dialogType: string; // 'alert', 'confirm', 'prompt', or 'beforeunload'
	message: string;
	url: string;
	frameId?: string | null;
}

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

export const NavigateToUrlEventSchema = z.object({
	url: z.string(),
	waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
	timeoutMs: z.number().nullable().optional(),
	newTab: z.boolean().optional(),
});

export const ClickElementEventSchema = z.object({
	node: z.any(), // EnhancedDOMTreeNode
	button: z.enum(['left', 'right', 'middle']).optional(),
});

export const TypeTextEventSchema = z.object({
	node: z.any(), // EnhancedDOMTreeNode
	text: z.string(),
	clear: z.boolean().optional(),
	isSensitive: z.boolean().optional(),
	sensitiveKeyName: z.string().nullable().optional(),
});

export const ScrollEventSchema = z.object({
	direction: z.enum(['up', 'down', 'left', 'right']),
	amount: z.number(),
	node: z.any().nullable().optional(),
});

export const WaitEventSchema = z.object({
	seconds: z.number().default(3.0),
	maxSeconds: z.number().default(10.0),
});

export const SendKeysEventSchema = z.object({
	keys: z.string(),
});

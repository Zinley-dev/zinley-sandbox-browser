/**
 * Browser event definitions
 */

import { TIMEOUTS } from './base.js';

// ============================================================================
// DOM Types (simplified for events)
// ============================================================================

export interface DOMPosition {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Snapshot node data for paint order filtering (matches Python's EnhancedSnapshotNode)
 */
export interface SnapshotNodeData {
	isClickable?: boolean | null;
	cursorStyle?: string | null;
	bounds?: DOMPosition | null;
	clientRects?: DOMPosition | null;
	scrollRects?: DOMPosition | null;
	computedStyles?: Record<string, string> | null;
	paintOrder?: number | null;
}

/**
 * Simplified DOM tree node for events (differs from the full EnhancedDOMTreeNode in dom/views.ts)
 */
export interface EventDOMTreeNode {
	nodeId: number;
	backendNodeId: number;
	sessionId: string;
	frameId: string;
	targetId: string;
	nodeType: string;
	nodeName: string;
	nodeValue?: string;
	attributes?: Record<string, string>;
	isScrollable?: boolean;
	isVisible?: boolean;
	absolutePosition?: DOMPosition;
	/** Text content of the element */
	text?: string;
	/** ARIA role or computed role */
	role?: string;
	/** Whether this element is new since last extraction */
	isNew?: boolean;
	/** Whether this element is interactive (clickable, editable, etc.) */
	isInteractive?: boolean;
	/** Accessible name from accessibility tree */
	accessibleName?: string;
	/** Accessible description from accessibility tree */
	accessibleDescription?: string;
	/** LLM representation function */
	llmRepresentation?: (attributes?: string[]) => string;
	/** Snapshot node data for paint order filtering (matches Python) */
	snapshotNode?: SnapshotNodeData | null;
	/** Whether this element has JavaScript click listeners (matches Python has_js_click_listener) */
	hasJsClickListener?: boolean;
}

// Keep legacy alias for backwards compatibility
export type EnhancedDOMTreeNode = EventDOMTreeNode;

// ============================================================================
// Browser State Types
// ============================================================================

export interface TabInfo {
	targetId: string;
	url: string;
	title: string;
}

export interface BrowserStateSummary {
	url: string;
	title: string;
	tabs: TabInfo[];
	domTree?: any; // DOM tree structure
	selectorMap?: Map<number, EnhancedDOMTreeNode>; // Map of element indices to DOM nodes
	screenshot?: string; // Base64 screenshot
}

// ============================================================================
// Agent/Tools -> BrowserSession Events (High-level browser actions)
// ============================================================================

export interface NavigateToUrlEvent {
	url: string;
	waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
	timeoutMs?: number;
	newTab?: boolean;
	eventTimeout?: number;
}

export interface ClickElementEvent {
	node: EnhancedDOMTreeNode;
	button?: 'left' | 'right' | 'middle';
	eventTimeout?: number;
}

export interface TypeTextEvent {
	node: EnhancedDOMTreeNode;
	text: string;
	clear?: boolean;
	isSensitive?: boolean;
	sensitiveKeyName?: string;
	eventTimeout?: number;
}

export interface ScrollEvent {
	direction: 'up' | 'down' | 'left' | 'right';
	amount: number; // pixels
	node?: EnhancedDOMTreeNode | null; // null means scroll page
	eventTimeout?: number;
}

export interface SwitchTabEvent {
	targetId?: string | null; // null means switch to most recently opened tab
	eventTimeout?: number;
}

export interface CloseTabEvent {
	targetId: string;
	eventTimeout?: number;
}

export interface ScreenshotEvent {
	fullPage?: boolean;
	clip?: { x: number; y: number; width: number; height: number };
	eventTimeout?: number;
}

export interface BrowserStateRequestEvent {
	includeDom?: boolean;
	includeScreenshot?: boolean;
	includeRecentEvents?: boolean;
	eventTimeout?: number;
}

export interface GoBackEvent {
	eventTimeout?: number;
}

export interface GoForwardEvent {
	eventTimeout?: number;
}

export interface RefreshEvent {
	eventTimeout?: number;
}

export interface WaitEvent {
	seconds: number;
	maxSeconds?: number;
	eventTimeout?: number;
}

export interface SendKeysEvent {
	keys: string; // e.g., "Control+A", "Meta+C", "Enter"
	eventTimeout?: number;
}

export interface UploadFileEvent {
	node: EnhancedDOMTreeNode;
	filePath: string;
	eventTimeout?: number;
}

export interface GetDropdownOptionsEvent {
	node: EnhancedDOMTreeNode;
	eventTimeout?: number;
}

export interface SelectDropdownOptionEvent {
	node: EnhancedDOMTreeNode;
	text: string;
	eventTimeout?: number;
}

export interface ScrollToTextEvent {
	text: string;
	direction?: 'up' | 'down';
	eventTimeout?: number;
}

// ============================================================================
// Browser Lifecycle Events
// ============================================================================

export interface BrowserStartEvent {
	cdpUrl?: string;
	launchOptions?: Record<string, any>;
	eventTimeout?: number;
}

export interface BrowserStopEvent {
	force?: boolean;
	eventTimeout?: number;
}

export interface BrowserLaunchResult {
	success: boolean;
	cdpUrl?: string;
	error?: string;
}

// ============================================================================
// Internal Browser Events
// ============================================================================

export interface TabCreatedEvent {
	targetId: string;
	url: string;
}

export interface TabClosedEvent {
	targetId: string;
}

export interface NavigationStartedEvent {
	targetId: string;
	url: string;
}

export interface NavigationCompleteEvent {
	targetId: string;
	url: string;
}

export interface BrowserErrorEvent {
	error: string;
	targetId?: string;
}

export interface FileDownloadedEvent {
	path: string;
	url: string;
	mimeType: string;
}

// ============================================================================
// Event Name Constants
// ============================================================================

export const BrowserEventNames = {
	// High-level actions
	NAVIGATE_TO_URL: 'navigate_to_url',
	CLICK_ELEMENT: 'click_element',
	TYPE_TEXT: 'type_text',
	SCROLL: 'scroll',
	SWITCH_TAB: 'switch_tab',
	CLOSE_TAB: 'close_tab',
	SCREENSHOT: 'screenshot',
	BROWSER_STATE_REQUEST: 'browser_state_request',
	GO_BACK: 'go_back',
	GO_FORWARD: 'go_forward',
	REFRESH: 'refresh',
	WAIT: 'wait',
	SEND_KEYS: 'send_keys',
	UPLOAD_FILE: 'upload_file',
	GET_DROPDOWN_OPTIONS: 'get_dropdown_options',
	SELECT_DROPDOWN_OPTION: 'select_dropdown_option',
	SCROLL_TO_TEXT: 'scroll_to_text',

	// Lifecycle
	BROWSER_START: 'browser_start',
	BROWSER_STOP: 'browser_stop',

	// Internal
	TAB_CREATED: 'tab_created',
	TAB_CLOSED: 'tab_closed',
	NAVIGATION_STARTED: 'navigation_started',
	NAVIGATION_COMPLETE: 'navigation_complete',
	BROWSER_ERROR: 'browser_error',
	FILE_DOWNLOADED: 'file_downloaded',
} as const;

export type BrowserEventName = (typeof BrowserEventNames)[keyof typeof BrowserEventNames];

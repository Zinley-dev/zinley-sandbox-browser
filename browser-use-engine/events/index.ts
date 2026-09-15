/**
 * Event system exports
 */

export * from './base.js';
export {
	// DOM Types (simplified for events)
	type DOMPosition,
	type EventDOMTreeNode,
	// Don't export EnhancedDOMTreeNode to avoid conflict with dom/views.ts
	// Browser State Types
	type TabInfo,
	type BrowserStateSummary,
	// Event Types
	type NavigateToUrlEvent,
	type ClickElementEvent,
	type TypeTextEvent,
	type ScrollEvent,
	type SwitchTabEvent,
	type CloseTabEvent,
	type ScreenshotEvent,
	type BrowserStateRequestEvent,
	type GoBackEvent,
	type GoForwardEvent,
	type RefreshEvent,
	type WaitEvent,
	type SendKeysEvent,
	type UploadFileEvent,
	type GetDropdownOptionsEvent,
	type SelectDropdownOptionEvent,
	type ScrollToTextEvent,
	type BrowserStartEvent,
	type BrowserStopEvent,
	type BrowserLaunchResult,
	type TabCreatedEvent,
	type TabClosedEvent,
	type NavigationStartedEvent,
	type NavigationCompleteEvent,
	type BrowserErrorEvent,
	type FileDownloadedEvent,
	type BrowserEventName,
	// Constants
	BrowserEventNames,
} from './browser-events.js';

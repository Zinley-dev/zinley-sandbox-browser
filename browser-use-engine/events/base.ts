/**
 * Base event system using EventEmitter
 */

import { EventEmitter } from 'eventemitter3';

export interface BaseEventOptions {
	/** Timeout in seconds */
	eventTimeout?: number;
}

export class EventBus extends EventEmitter {
	private pendingEvents: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeout?: NodeJS.Timeout }> = new Map();

	/**
	 * Dispatch an event and wait for its result
	 */
	async dispatch<T = void>(eventName: string, payload: any, timeout?: number): Promise<T> {
		const eventId = `${eventName}_${Date.now()}_${Math.random()}`;

		return new Promise((resolve, reject) => {
			let timeoutHandle: NodeJS.Timeout | undefined;

			if (timeout && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					this.pendingEvents.delete(eventId);
					reject(new Error(`Event ${eventName} timed out after ${timeout}s`));
				}, timeout * 1000);
			}

			this.pendingEvents.set(eventId, { resolve, reject, timeout: timeoutHandle });

			// Emit the event with payload and event ID for response tracking
			this.emit(eventName, { ...payload, _eventId: eventId });
		});
	}

	/**
	 * Respond to an event with a result
	 */
	respondToEvent(eventId: string, result: any) {
		const pending = this.pendingEvents.get(eventId);
		if (pending) {
			if (pending.timeout) {
				clearTimeout(pending.timeout);
			}
			pending.resolve(result);
			this.pendingEvents.delete(eventId);
		}
	}

	/**
	 * Respond to an event with an error
	 */
	rejectEvent(eventId: string, error: Error) {
		const pending = this.pendingEvents.get(eventId);
		if (pending) {
			if (pending.timeout) {
				clearTimeout(pending.timeout);
			}
			pending.reject(error);
			this.pendingEvents.delete(eventId);
		}
	}
}

function getTimeout(envVar: string, defaultValue: number): number {
	const envValue = process.env[envVar];
	if (envValue) {
		const parsed = parseFloat(envValue);
		if (!isNaN(parsed) && parsed >= 0) {
			return parsed;
		}
		console.warn(`Warning: ${envVar}=${envValue} is not a valid number, using default ${defaultValue}`);
	}
	return defaultValue;
}

// Export timeout constants - MUST MATCH Python browser_use/browser/events.py exactly
export const TIMEOUTS = {
	NAVIGATE_TO_URL: getTimeout('TIMEOUT_NavigateToUrlEvent', 30.0),  // Python 0.13: 30s
	CLICK_ELEMENT: getTimeout('TIMEOUT_ClickElementEvent', 15.0),
	TYPE_TEXT: getTimeout('TIMEOUT_TypeTextEvent', 60.0),  // Python: 60s (was 15s - CRITICAL FIX)
	SCROLL: getTimeout('TIMEOUT_ScrollEvent', 8.0),
	SWITCH_TAB: getTimeout('TIMEOUT_SwitchTabEvent', 10.0),
	CLOSE_TAB: getTimeout('TIMEOUT_CloseTabEvent', 10.0),
	SCREENSHOT: getTimeout('TIMEOUT_ScreenshotEvent', 15.0),  // Python: 15s (was 8s - CRITICAL FIX)
	BROWSER_STATE_REQUEST: getTimeout('TIMEOUT_BrowserStateRequestEvent', 30.0),
	GO_BACK: getTimeout('TIMEOUT_GoBackEvent', 15.0),
	GO_FORWARD: getTimeout('TIMEOUT_GoForwardEvent', 15.0),
	REFRESH: getTimeout('TIMEOUT_RefreshEvent', 15.0),
	WAIT: getTimeout('TIMEOUT_WaitEvent', 60.0),
	SEND_KEYS: getTimeout('TIMEOUT_SendKeysEvent', 60.0),  // Python: 60s (was 15s - CRITICAL FIX)
	UPLOAD_FILE: getTimeout('TIMEOUT_UploadFileEvent', 30.0),
	GET_DROPDOWN_OPTIONS: getTimeout('TIMEOUT_GetDropdownOptionsEvent', 15.0),
	SELECT_DROPDOWN_OPTION: getTimeout('TIMEOUT_SelectDropdownOptionEvent', 8.0),
	SCROLL_TO_TEXT: getTimeout('TIMEOUT_ScrollToTextEvent', 15.0),
	BROWSER_START: getTimeout('TIMEOUT_BrowserStartEvent', 30.0),
	BROWSER_STOP: getTimeout('TIMEOUT_BrowserStopEvent', 45.0),
};

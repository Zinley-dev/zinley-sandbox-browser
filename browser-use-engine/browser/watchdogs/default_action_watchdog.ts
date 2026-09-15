/**
 * Default action watchdog for handling browser actions via CDP
 * Port from browser_use/browser/watchdogs/default_action_watchdog.py (2389 lines)
 */
import { EventEmitter } from 'events';
import { Page, CDPSession } from 'patchright';
import { getLogger } from '../../logging_config.js';
import {
	BrowserEventNames,
	ClickElementEvent,
	TypeTextEvent,
	ScrollEvent,
	SendKeysEvent,
	GoBackEvent,
	GoForwardEvent,
	RefreshEvent,
	WaitEvent,
	NavigateToUrlEvent,
	SwitchTabEvent,
	CloseTabEvent,
	UploadFileEvent,
	GetDropdownOptionsEvent,
	SelectDropdownOptionEvent,
	ScrollToTextEvent,
} from '../events.js';
import { EnhancedDOMTreeNode } from '../../events/browser-events.js';

const logger = getLogger('browser-use.default_action_watchdog');

export interface DefaultActionWatchdogOptions {
	/** Default timeout for actions in ms */
	actionTimeout?: number;
	/** Delay between key presses in ms */
	keyPressDelay?: number;
}

export class DefaultActionWatchdog {
	private isRunning: boolean = false;
	private page: Page | null = null;
	private cdpSession: CDPSession | null = null;
	private actionTimeout: number;
	private keyPressDelay: number;

	constructor(
		private eventBus: EventEmitter,
		options: DefaultActionWatchdogOptions = {}
	) {
		this.actionTimeout = options.actionTimeout ?? 15000;
		this.keyPressDelay = options.keyPressDelay ?? 50;
	}

	/**
	 * Set the page to use for actions
	 */
	setPage(page: Page): void {
		this.page = page;
	}

	/**
	 * Set the CDP session to use for actions
	 */
	setCDPSession(cdpSession: CDPSession): void {
		this.cdpSession = cdpSession;
	}

	// ============================================================================
	// Click Action
	// ============================================================================

	async handleClickElement(event: ClickElementEvent & { _eventId?: string }): Promise<any> {
		logger.debug(`Handling click element event for node: ${event.node?.nodeName}`);

		if (!this.cdpSession) {
			throw new Error('No CDP session available for click action');
		}

		const node = event.node;
		if (!node) {
			throw new Error('No node provided for click action');
		}

		try {
			// Check if element is a file input (should not be clicked)
			const tagName = (node.nodeName || '').toLowerCase();
			const elementType = (node.attributes?.type || '').toLowerCase();

			if (tagName === 'select') {
				throw new Error(`Cannot click on <select> elements. Use dropdown_options action instead.`);
			}

			if (tagName === 'input' && elementType === 'file') {
				throw new Error(`Cannot click on file input element. Use upload_file action instead.`);
			}

			// Get element position using CDP (includes scroll into view)
			const position = await this.getElementPosition(node);
			if (!position) {
				// Fallback to JavaScript click if can't get position
				logger.debug('Could not get position, falling back to JS click');
				if (node.backendNodeId) {
					await this.clickElementWithJS(node.backendNodeId);
					return { success: true, fallback: 'js' };
				}
				throw new Error(`Could not get position for element: ${node.nodeName}`);
			}

			const { x, y } = position;

			// Check for occlusion before clicking
			if (node.backendNodeId) {
				const isOccluded = await this.checkElementOcclusion(node.backendNodeId, x, y);
				if (isOccluded) {
					logger.debug('Element is occluded, falling back to JS click');
					await this.clickElementWithJS(node.backendNodeId);
					return { success: true, fallback: 'js_occluded' };
				}
			}

			// Move mouse to element first (more realistic interaction)
			await this.moveMouseToElement(x, y);

			// Perform click using CDP Input.dispatchMouseEvent with timeout handling (matching Python)
			// Python uses 1s timeout for mousePressed, 3s for mouseReleased
			try {
				await this.withTimeout(
					this.cdpSession.send('Input.dispatchMouseEvent', {
						type: 'mousePressed',
						x,
						y,
						button: event.button || 'left',
						clickCount: 1,
					}),
					1000, // 1 second timeout for mousePressed (matches Python)
				);
				await new Promise(resolve => setTimeout(resolve, 80)); // Wait between press and release
			} catch (error: any) {
				if (error.message === 'Timeout') {
					logger.debug('⏱️ Mouse down timed out (likely due to dialog), continuing...');
				} else {
					throw error;
				}
			}

			try {
				await this.withTimeout(
					this.cdpSession.send('Input.dispatchMouseEvent', {
						type: 'mouseReleased',
						x,
						y,
						button: event.button || 'left',
						clickCount: 1,
					}),
					3000, // 3 second timeout for mouseReleased (matches Python)
				);
			} catch (error: any) {
				if (error.message === 'Timeout') {
					logger.debug('⏱️ Mouse up timed out (possibly due to lag or dialog popup), continuing...');
				} else {
					throw error;
				}
			}

			logger.debug(`Clicked element at (${x}, ${y})`);
			return { x, y, success: true };
		} catch (error: any) {
			// Try JavaScript fallback for any error
			if (node.backendNodeId) {
				try {
					logger.debug(`CDP click failed, trying JS fallback: ${error.message}`);
					await this.clickElementWithJS(node.backendNodeId);
					return { success: true, fallback: 'js_error' };
				} catch (jsError: any) {
					logger.error(`JS click fallback also failed: ${jsError.message}`);
				}
			}
			logger.error(`Click action failed: ${error.message}`);
			throw error;
		}
	}

	// ============================================================================
	// Type Text Action
	// ============================================================================

	async handleTypeText(event: TypeTextEvent & { _eventId?: string }): Promise<any> {
		logger.debug(`Handling type text event: "${event.isSensitive ? '<sensitive>' : event.text}"`);

		if (!this.cdpSession) {
			throw new Error('No CDP session available for type action');
		}

		const node = event.node;
		if (!node) {
			// Type to current focus
			await this.typeToPage(event.text);
			return { success: true };
		}

		try {
			// Click to focus the element first
			const position = await this.getElementPosition(node);
			if (position) {
				await this.cdpSession.send('Input.dispatchMouseEvent', {
					type: 'mousePressed',
					x: position.x,
					y: position.y,
					button: 'left',
					clickCount: 1,
				});
				await this.cdpSession.send('Input.dispatchMouseEvent', {
					type: 'mouseReleased',
					x: position.x,
					y: position.y,
					button: 'left',
					clickCount: 1,
				});
			}

			// Clear existing text if requested using multi-strategy approach (matching Python)
			if (event.clear) {
				const cleared = await this.clearTextField(node, position);
				if (!cleared) {
					logger.warn('Text field clearing failed, typing may append to existing text');
				}
			}

			// Type the text character by character
			await this.typeToPage(event.text);

			const logText = event.isSensitive ? '<sensitive>' : event.text;
			logger.debug(`Typed "${logText}" into element`);
			return { success: true };
		} catch (error: any) {
			logger.error(`Type action failed: ${error.message}`);
			throw error;
		}
	}

	// ============================================================================
	// Scroll Action
	// ============================================================================

	async handleScroll(event: ScrollEvent & { _eventId?: string }): Promise<any> {
		logger.debug(`Handling scroll event: ${event.direction} by ${event.amount}px`);

		if (!this.cdpSession) {
			throw new Error('No CDP session available for scroll action');
		}

		try {
			// Calculate scroll deltas
			let deltaX = 0;
			let deltaY = 0;

			switch (event.direction) {
				case 'up':
					deltaY = -event.amount;
					break;
				case 'down':
					deltaY = event.amount;
					break;
				case 'left':
					deltaX = -event.amount;
					break;
				case 'right':
					deltaX = event.amount;
					break;
			}

			// Get scroll target position
			let x = 400; // Default center of viewport
			let y = 400;

			if (event.node) {
				const position = await this.getElementPosition(event.node);
				if (position) {
					x = position.x;
					y = position.y;
				}
			}

			// Dispatch scroll using Input.dispatchMouseEvent with wheel
			await this.cdpSession.send('Input.dispatchMouseEvent', {
				type: 'mouseWheel',
				x,
				y,
				deltaX,
				deltaY,
			});

			// Wait for layout to stabilize after scroll (fixes lazy-loaded content like Google Forms)
			await new Promise((resolve) => setTimeout(resolve, 150));

			logger.debug(`Scrolled ${event.direction} by ${event.amount}px`);
			return { success: true };
		} catch (error: any) {
			logger.error(`Scroll action failed: ${error.message}`);
			throw error;
		}
	}

	// ============================================================================
	// Send Keys Action
	// ============================================================================

	async handleSendKeys(event: SendKeysEvent & { _eventId?: string }): Promise<any> {
		logger.debug(`Handling send keys event: ${event.keys}`);

		if (!this.cdpSession) {
			throw new Error('No CDP session available for send keys action');
		}

		try {
			// Parse key combination (e.g., "ctrl+a", "Enter", "cmd+c")
			const keyParts = event.keys.split('+').map(k => k.trim().toLowerCase());
			const modifiers = this.getModifiers(keyParts);
			const key = keyParts[keyParts.length - 1];

			// Map special keys
			const keyInfo = this.getKeyInfo(key);

			// Send key down
			await this.cdpSession.send('Input.dispatchKeyEvent', {
				type: 'keyDown',
				modifiers,
				key: keyInfo.key,
				code: keyInfo.code,
				windowsVirtualKeyCode: keyInfo.keyCode,
			});

			// Send key up
			await this.cdpSession.send('Input.dispatchKeyEvent', {
				type: 'keyUp',
				modifiers,
				key: keyInfo.key,
				code: keyInfo.code,
				windowsVirtualKeyCode: keyInfo.keyCode,
			});

			logger.debug(`Sent keys: ${event.keys}`);
			return { success: true };
		} catch (error: any) {
			logger.error(`Send keys action failed: ${error.message}`);
			throw error;
		}
	}

	// ============================================================================
	// Navigation Actions
	// ============================================================================

	async handleNavigateToUrl(event: NavigateToUrlEvent & { _eventId?: string }): Promise<any> {
		logger.debug(`Handling navigate to URL: ${event.url}`);

		if (!this.page) {
			throw new Error('No page available for navigation');
		}

		try {
			const waitUntil = event.waitUntil || 'load';
			const timeout = event.timeoutMs || this.actionTimeout;

			await this.page.goto(event.url, {
				waitUntil: waitUntil as any,
				timeout,
			});

			logger.debug(`Navigated to: ${event.url}`);
			return { success: true, url: event.url };
		} catch (error: any) {
			logger.error(`Navigation failed: ${error.message}`);
			throw error;
		}
	}

	async handleGoBack(event: GoBackEvent & { _eventId?: string }): Promise<any> {
		logger.debug('Handling go back event');

		if (!this.page) {
			throw new Error('No page available for go back');
		}

		try {
			await this.page.goBack({ timeout: this.actionTimeout });
			logger.debug('Navigated back');
			return { success: true };
		} catch (error: any) {
			logger.error(`Go back failed: ${error.message}`);
			throw error;
		}
	}

	async handleGoForward(event: GoForwardEvent & { _eventId?: string }): Promise<any> {
		logger.debug('Handling go forward event');

		if (!this.page) {
			throw new Error('No page available for go forward');
		}

		try {
			await this.page.goForward({ timeout: this.actionTimeout });
			logger.debug('Navigated forward');
			return { success: true };
		} catch (error: any) {
			logger.error(`Go forward failed: ${error.message}`);
			throw error;
		}
	}

	async handleRefresh(event: RefreshEvent & { _eventId?: string }): Promise<any> {
		logger.debug('Handling refresh event');

		if (!this.page) {
			throw new Error('No page available for refresh');
		}

		try {
			await this.page.reload({ timeout: this.actionTimeout });
			logger.debug('Page refreshed');
			return { success: true };
		} catch (error: any) {
			logger.error(`Refresh failed: ${error.message}`);
			throw error;
		}
	}

	// ============================================================================
	// Wait Action
	// ============================================================================

	async handleWait(event: WaitEvent & { _eventId?: string }): Promise<any> {
		const seconds = event.seconds ?? 3;
		const maxSeconds = event.maxSeconds ?? 10;
		const waitTime = Math.min(seconds, maxSeconds);

		logger.debug(`Handling wait event: ${waitTime} seconds`);

		await new Promise(resolve => setTimeout(resolve, waitTime * 1000));

		logger.debug(`Waited for ${waitTime} seconds`);
		return { success: true, waitedSeconds: waitTime };
	}

	// ============================================================================
	// Dropdown Actions
	// ============================================================================

	async handleGetDropdownOptions(event: GetDropdownOptionsEvent & { _eventId?: string }): Promise<any> {
		logger.debug('Handling get dropdown options event');

		if (!this.cdpSession) {
			throw new Error('No CDP session available');
		}

		const node = event.node;
		if (!node) {
			throw new Error('No node provided for dropdown');
		}

		try {
			// Resolve node to get objectId first
			const resolveResult = await this.cdpSession.send('DOM.resolveNode', {
				backendNodeId: node.backendNodeId,
			});
			const objectId = (resolveResult as any)?.object?.objectId;

			if (!objectId) {
				throw new Error('Could not resolve dropdown element');
			}

			// Get options using CDP - supports native, ARIA, and custom dropdowns (like Python)
			const result = await this.cdpSession.send('Runtime.callFunctionOn', {
				functionDeclaration: `
					function() {
						const element = this;
						const tagName = element.tagName?.toUpperCase() || '';
						const options = [];

						// === NATIVE SELECT ELEMENT ===
						if (tagName === 'SELECT') {
							for (const opt of element.options) {
								options.push({
									index: opt.index,
									value: opt.value,
									text: opt.text.trim(),
									selected: opt.selected,
									disabled: opt.disabled,
								});
							}
							return {
								type: 'native',
								options,
								id: element.id || null,
								name: element.name || null,
							};
						}

						// === ARIA DROPDOWN (role="listbox", "menu", "combobox") ===
						const role = element.getAttribute('role')?.toLowerCase() || '';
						if (role === 'listbox' || role === 'menu' || role === 'combobox') {
							const items = element.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]');
							let index = 0;
							for (const item of items) {
								const isSelected = item.getAttribute('aria-selected') === 'true' ||
								                   item.getAttribute('aria-checked') === 'true';
								options.push({
									index: index++,
									text: item.textContent?.trim() || '',
									value: item.getAttribute('data-value') || item.textContent?.trim() || '',
									selected: isSelected,
									disabled: item.getAttribute('aria-disabled') === 'true',
								});
							}
							return {
								type: 'aria',
								role,
								options,
								id: element.id || null,
							};
						}

						// === CUSTOM DROPDOWN (Semantic UI, class-based) ===
						const classList = element.className?.toLowerCase() || '';
						const isCustomDropdown = classList.includes('dropdown') || classList.includes('select') || classList.includes('ui');

						if (isCustomDropdown) {
							const itemSelectors = [
								'.item', '.option', '.dropdown-item', '.menu-item',
								'[data-value]', 'li', 'a'
							];

							let items = [];
							for (const sel of itemSelectors) {
								items = element.querySelectorAll(sel);
								if (items.length > 0) break;
							}

							let index = 0;
							for (const item of items) {
								const text = item.textContent?.trim() || '';
								if (!text) continue;
								options.push({
									index: index++,
									text,
									value: item.getAttribute('data-value') || text,
									selected: item.classList.contains('selected') || item.classList.contains('active'),
									disabled: item.classList.contains('disabled'),
								});
							}

							if (options.length > 0) {
								return {
									type: 'custom',
									options,
									id: element.id || null,
								};
							}
						}

						// === RECURSIVE SEARCH (depth 4) for nested options ===
						function findOptions(el, depth) {
							if (depth > 4) return;
							for (const child of el.children || []) {
								if (child.getAttribute?.('data-value') || child.classList?.contains('item') || child.classList?.contains('option')) {
									const text = child.textContent?.trim() || '';
									if (text) {
										options.push({
											index: options.length,
											text,
											value: child.getAttribute('data-value') || text,
											selected: false,
										});
									}
								}
								findOptions(child, depth + 1);
							}
						}
						findOptions(element, 0);

						if (options.length > 0) {
							return {
								type: 'nested',
								options,
								id: element.id || null,
							};
						}

						return { type: 'unknown', error: 'Element is not a recognized dropdown type', options: [] };
					}
				`,
				objectId,
				returnByValue: true,
			});

			return (result as any)?.result?.value || { options: [] };
		} catch (error: any) {
			logger.error(`Get dropdown options failed: ${error.message}`);
			throw error;
		}
	}

	async handleSelectDropdownOption(event: SelectDropdownOptionEvent & { _eventId?: string }): Promise<any> {
		logger.debug(`Handling select dropdown option: ${event.text}`);

		if (!this.cdpSession) {
			throw new Error('No CDP session available');
		}

		const node = event.node;
		if (!node || !node.backendNodeId) {
			throw new Error('No node provided for dropdown');
		}

		const targetText = event.text;
		const targetTextLower = targetText.toLowerCase().trim();

		try {
			// Resolve node to get objectId (required for JS evaluation)
			const resolveResult = await this.cdpSession.send('DOM.resolveNode', {
				backendNodeId: node.backendNodeId,
			});
			const objectId = (resolveResult as any)?.object?.objectId;

			if (!objectId) {
				throw new Error('Could not resolve dropdown element');
			}

			// Python-style multi-type dropdown selection with framework event dispatching
			const result = await this.cdpSession.send('Runtime.callFunctionOn', {
				functionDeclaration: `
					function(targetTextLower) {
						const element = this;
						const tagName = element.tagName?.toUpperCase() || '';

						// === NATIVE SELECT ELEMENT ===
						if (tagName === 'SELECT') {
							for (let i = 0; i < element.options.length; i++) {
								const option = element.options[i];
								const optionText = option.text.trim().toLowerCase();
								const optionValue = option.value.toLowerCase();

								if (optionText === targetTextLower || optionValue === targetTextLower) {
									element.selectedIndex = i;
									element.value = option.value;

									// Dispatch framework events (Vue/React/Angular)
									element.focus();
									element.dispatchEvent(new Event('input', { bubbles: true }));
									element.dispatchEvent(new Event('change', { bubbles: true }));
									element.blur();

									return { success: true, type: 'native', selectedText: option.text };
								}
							}
							// Return available options if not found
							const availableOptions = Array.from(element.options).map(opt => ({
								text: opt.text.trim(),
								value: opt.value
							}));
							return { success: false, error: 'Option not found', availableOptions, type: 'native' };
						}

						// === ARIA DROPDOWN (role="listbox", "menu", "combobox") ===
						const role = element.getAttribute('role')?.toLowerCase() || '';
						if (role === 'listbox' || role === 'menu' || role === 'combobox') {
							// Find option items
							const items = element.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]');
							const availableOptions = [];

							for (const item of items) {
								const itemText = item.textContent?.trim() || '';
								availableOptions.push({ text: itemText });

								if (itemText.toLowerCase() === targetTextLower) {
									item.click();
									item.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
									return { success: true, type: 'aria', selectedText: itemText };
								}
							}
							return { success: false, error: 'Option not found in ARIA dropdown', availableOptions, type: 'aria' };
						}

						// === CUSTOM DROPDOWN (Semantic UI, class-based) ===
						const classList = element.className?.toLowerCase() || '';
						const isCustomDropdown = classList.includes('dropdown') || classList.includes('select') || classList.includes('ui');

						if (isCustomDropdown) {
							// Look for items in common dropdown structures
							const itemSelectors = [
								'.item', '.option', '.dropdown-item', '.menu-item',
								'[data-value]', 'li', 'a'
							];

							let items = [];
							for (const sel of itemSelectors) {
								items = element.querySelectorAll(sel);
								if (items.length > 0) break;
							}

							const availableOptions = [];
							for (const item of items) {
								const itemText = item.textContent?.trim() || '';
								if (!itemText) continue;
								availableOptions.push({ text: itemText });

								if (itemText.toLowerCase() === targetTextLower) {
									item.click();
									item.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
									// Also dispatch change on parent dropdown
									element.dispatchEvent(new Event('change', { bubbles: true }));
									return { success: true, type: 'custom', selectedText: itemText };
								}
							}

							if (availableOptions.length > 0) {
								return { success: false, error: 'Option not found in custom dropdown', availableOptions, type: 'custom' };
							}
						}

						// === RECURSIVE SEARCH (depth 4) ===
						function searchChildren(el, depth) {
							if (depth > 4) return null;
							const children = el.children || [];
							for (const child of children) {
								const childText = child.textContent?.trim() || '';
								if (childText.toLowerCase() === targetTextLower) {
									child.click();
									return { success: true, type: 'recursive', selectedText: childText };
								}
								const result = searchChildren(child, depth + 1);
								if (result) return result;
							}
							return null;
						}

						const recursiveResult = searchChildren(element, 0);
						if (recursiveResult) return recursiveResult;

						return { success: false, error: 'Element is not a recognized dropdown type', type: 'unknown' };
					}
				`,
				objectId,
				arguments: [{ value: targetTextLower }],
				returnByValue: true,
			});

			const selectResult = (result as any)?.result?.value;

			if (selectResult?.success) {
				logger.debug(`Selected option via ${selectResult.type}: ${selectResult.selectedText}`);
				return { success: true, type: selectResult.type, selectedText: selectResult.selectedText };
			} else {
				// Return detailed error with available options (like Python)
				const errorMsg = selectResult?.error || 'Failed to select option';
				const availableOptions = selectResult?.availableOptions || [];
				logger.warn(`Dropdown selection failed: ${errorMsg}`);

				if (availableOptions.length > 0) {
					const optionsList = availableOptions.map((opt: any) => `- ${opt.text}`).join('\n');
					return {
						success: false,
						error: errorMsg,
						shortTermMemory: `Available dropdown options:\n${optionsList}`,
						longTermMemory: `Couldn't select '${targetText}' as it's not one of the available options.`,
						availableOptions,
					};
				}

				throw new Error(errorMsg);
			}
		} catch (error: any) {
			logger.error(`Select dropdown option failed: ${error.message}`);
			throw error;
		}
	}

	// ============================================================================
	// File Upload Action
	// ============================================================================

	async handleUploadFile(event: UploadFileEvent & { _eventId?: string }): Promise<any> {
		logger.debug(`Handling upload file: ${event.filePath}`);

		if (!this.page) {
			throw new Error('No page available');
		}

		const node = event.node;
		if (!node) {
			throw new Error('No node provided for file upload');
		}

		// Validate that element is actually a file input (matching Python's is_file_input check)
		const tagName = (node.nodeName || '').toUpperCase();
		const inputType = (node.attributes?.type || '').toLowerCase();
		const isFileInput = tagName === 'INPUT' && inputType === 'file';

		if (!isFileInput) {
			const errorMsg = `Upload failed - element ${node.backendNodeId} is not a file input. Tag: ${tagName}, type: ${inputType}`;
			logger.error(errorMsg);
			throw new Error(errorMsg);
		}

		try {
			// Use CDP to set files directly (matching Python's DOM.setFileInputFiles approach)
			if (this.cdpSession && node.backendNodeId) {
				await this.cdpSession.send('DOM.setFileInputFiles', {
					files: [event.filePath], // Python wraps in array
					backendNodeId: node.backendNodeId,
				});
				logger.debug(`Uploaded file via CDP: ${event.filePath}`);
				return { success: true, filePath: event.filePath };
			}

			// Fallback to Playwright's file chooser handling
			const selector = `[data-backend-node-id="${node.backendNodeId}"]`;
			await this.page.setInputFiles(selector, event.filePath);

			logger.debug(`Uploaded file: ${event.filePath}`);
			return { success: true, filePath: event.filePath };
		} catch (error: any) {
			logger.error(`File upload failed: ${error.message}`);
			throw error;
		}
	}

	// ============================================================================
	// Scroll to Text Action
	// ============================================================================

	async handleScrollToText(event: ScrollToTextEvent & { _eventId?: string }): Promise<any> {
		logger.debug(`Handling scroll to text: "${event.text}"`);

		if (!this.page) {
			throw new Error('No page available');
		}

		try {
			// Find text on page and scroll to it
			const element = await this.page.$(`text="${event.text}"`);
			if (element) {
				await element.scrollIntoViewIfNeeded();
				logger.debug(`Scrolled to text: "${event.text}"`);
				return { success: true, found: true };
			}

			logger.debug(`Text not found: "${event.text}"`);
			return { success: false, found: false };
		} catch (error: any) {
			logger.error(`Scroll to text failed: ${error.message}`);
			throw error;
		}
	}

	// ============================================================================
	// Helper Methods
	// ============================================================================

	/**
	 * Get element position with scroll into view and viewport clamping (matching Python)
	 */
	private async getElementPosition(node: { backendNodeId?: number; absolutePosition?: { x: number; y: number; width: number; height: number } | null }): Promise<{ x: number; y: number } | null> {
		if (!this.cdpSession) return null;

		try {
			// Scroll element into view first
			if (node.backendNodeId) {
				try {
					await this.cdpSession.send('DOM.scrollIntoViewIfNeeded', {
						backendNodeId: node.backendNodeId,
					});
					await new Promise(resolve => setTimeout(resolve, 50));
				} catch {
					// Ignore scroll errors
				}
			}

			let centerX: number;
			let centerY: number;

			// Try to get position from node's absolutePosition
			if (node.absolutePosition) {
				const pos = node.absolutePosition;
				centerX = pos.x + pos.width / 2;
				centerY = pos.y + pos.height / 2;
			} else {
				// Fallback: use CDP to get box model
				const result = await this.cdpSession.send('DOM.getBoxModel', {
					backendNodeId: node.backendNodeId,
				});

				if (result?.model?.content) {
					const [x1, y1, x2, y2, x3, y3, x4, y4] = result.model.content;
					centerX = (x1 + x2 + x3 + x4) / 4;
					centerY = (y1 + y2 + y3 + y4) / 4;
				} else {
					return null;
				}
			}

			// Get viewport dimensions for clamping (matching Python exactly)
			let viewportWidth = 1280;
			let viewportHeight = 720;
			try {
				const layoutMetrics = await this.cdpSession.send('Page.getLayoutMetrics');
				viewportWidth = layoutMetrics?.visualViewport?.clientWidth || layoutMetrics?.layoutViewport?.clientWidth || 1280;
				viewportHeight = layoutMetrics?.visualViewport?.clientHeight || layoutMetrics?.layoutViewport?.clientHeight || 720;
			} catch {
				// Use defaults
			}

			// Ensure click point is within viewport bounds (Python: max(0, min(viewport_width - 1, center_x)))
			centerX = Math.max(0, Math.min(viewportWidth - 1, centerX));
			centerY = Math.max(0, Math.min(viewportHeight - 1, centerY));

			return { x: centerX, y: centerY };
		} catch (error) {
			return null;
		}
	}

	/**
	 * Check if an element is occluded by other elements at the given coordinates
	 * Port from Python's _check_element_occlusion
	 */
	private async checkElementOcclusion(backendNodeId: number, x: number, y: number): Promise<boolean> {
		if (!this.cdpSession) return false;

		try {
			// Resolve the target element
			const targetResult = await this.cdpSession.send('DOM.resolveNode', {
				backendNodeId,
			});

			if (!targetResult?.object?.objectId) {
				logger.debug('Could not resolve target element, assuming occluded');
				return true;
			}

			const objectId = targetResult.object.objectId;

			// Check if element at point is our target or contained by it
			const checkResult = await this.cdpSession.send('Runtime.callFunctionOn', {
				objectId,
				functionDeclaration: `
					function(x, y) {
						const elementAtPoint = document.elementFromPoint(x, y);
						if (!elementAtPoint) {
							return { isClickable: false };
						}
						// Check if target is the element or contains/is contained by it
						const isClickable = this === elementAtPoint ||
							this.contains(elementAtPoint) ||
							elementAtPoint.contains(this);
						return { isClickable };
					}
				`,
				arguments: [{ value: x }, { value: y }],
				returnByValue: true,
			});

			const isClickable = (checkResult as any)?.result?.value?.isClickable ?? false;
			if (!isClickable) {
				logger.debug('Element is occluded at coordinates');
			}
			return !isClickable;
		} catch (error) {
			logger.debug(`Occlusion check failed: ${error}, assuming not occluded`);
			return false;
		}
	}

	/**
	 * Helper to wrap a promise with a timeout (matching Python's asyncio.wait_for)
	 */
	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
		return Promise.race([
			promise,
			new Promise<T>((_, reject) =>
				setTimeout(() => reject(new Error('Timeout')), timeoutMs)
			),
		]);
	}

	/**
	 * Move mouse to element before clicking (for more realistic interaction)
	 */
	private async moveMouseToElement(x: number, y: number): Promise<void> {
		if (!this.cdpSession) return;

		try {
			await this.cdpSession.send('Input.dispatchMouseEvent', {
				type: 'mouseMoved',
				x,
				y,
			});
			await new Promise(resolve => setTimeout(resolve, 50));
		} catch (error) {
			// Ignore mouse move errors
		}
	}

	/**
	 * Click element using JavaScript (fallback for occluded elements)
	 */
	private async clickElementWithJS(backendNodeId: number): Promise<void> {
		if (!this.cdpSession) return;

		const result = await this.cdpSession.send('DOM.resolveNode', {
			backendNodeId,
		});

		if (!result?.object?.objectId) {
			throw new Error('Failed to resolve element for JS click');
		}

		await this.cdpSession.send('Runtime.callFunctionOn', {
			objectId: result.object.objectId,
			functionDeclaration: 'function() { this.click(); }',
		});
	}

	/**
	 * Type text to the page character by character with proper key events
	 * Port from Python's _type_to_page
	 */
	private async typeToPage(text: string): Promise<void> {
		if (!this.cdpSession) return;

		for (const char of text) {
			if (char === '\n') {
				// Handle newline as Enter key
				await this.cdpSession.send('Input.dispatchKeyEvent', {
					type: 'keyDown',
					key: 'Enter',
					code: 'Enter',
					windowsVirtualKeyCode: 13,
				});
				await this.cdpSession.send('Input.dispatchKeyEvent', {
					type: 'char',
					text: '\r',
					key: 'Enter', // Python includes 'key' in char events
				});
				await this.cdpSession.send('Input.dispatchKeyEvent', {
					type: 'keyUp',
					key: 'Enter',
					code: 'Enter',
					windowsVirtualKeyCode: 13,
				});
			} else {
				// Regular character - send keyDown, char, keyUp sequence
				const { modifiers, keyCode, code } = this.getCharKeyInfo(char);

				await this.cdpSession.send('Input.dispatchKeyEvent', {
					type: 'keyDown',
					key: char,
					code,
					modifiers,
					windowsVirtualKeyCode: keyCode,
				});
				await this.cdpSession.send('Input.dispatchKeyEvent', {
					type: 'char',
					text: char,
					key: char, // Python includes 'key' in char events
				});
				await this.cdpSession.send('Input.dispatchKeyEvent', {
					type: 'keyUp',
					key: char,
					code,
					modifiers,
					windowsVirtualKeyCode: keyCode,
				});
			}
			// 1ms delay between keystrokes (matching Python's actual delay)
			await new Promise(resolve => setTimeout(resolve, 1));
		}
	}

	/**
	 * Get character key info including modifiers and virtual key codes
	 * Port from Python's _get_char_modifiers_and_vk and _get_key_code_for_char
	 */
	private getCharKeyInfo(char: string): { modifiers: number; keyCode: number; code: string } {
		// Characters that require Shift modifier
		const shiftChars: Record<string, [string, number]> = {
			'!': ['Digit1', 49],
			'@': ['Digit2', 50],
			'#': ['Digit3', 51],
			'$': ['Digit4', 52],
			'%': ['Digit5', 53],
			'^': ['Digit6', 54],
			'&': ['Digit7', 55],
			'*': ['Digit8', 56],
			'(': ['Digit9', 57],
			')': ['Digit0', 48],
			'_': ['Minus', 189],
			'+': ['Equal', 187],
			'{': ['BracketLeft', 219],
			'}': ['BracketRight', 221],
			'|': ['Backslash', 220],
			':': ['Semicolon', 186],
			'"': ['Quote', 222],
			'<': ['Comma', 188],
			'>': ['Period', 190],
			'?': ['Slash', 191],
			'~': ['Backquote', 192],
		};

		// No-shift special characters
		const noShiftChars: Record<string, [string, number]> = {
			' ': ['Space', 32],
			'-': ['Minus', 189],
			'=': ['Equal', 187],
			'[': ['BracketLeft', 219],
			']': ['BracketRight', 221],
			'\\': ['Backslash', 220],
			';': ['Semicolon', 186],
			"'": ['Quote', 222],
			',': ['Comma', 188],
			'.': ['Period', 190],
			'/': ['Slash', 191],
			'`': ['Backquote', 192],
		};

		// Check if character requires Shift
		if (char in shiftChars) {
			const [code, keyCode] = shiftChars[char];
			return { modifiers: 8, keyCode, code }; // Shift = 8
		}

		// Uppercase letters require Shift
		if (/[A-Z]/.test(char)) {
			return { modifiers: 8, keyCode: char.charCodeAt(0), code: `Key${char}` };
		}

		// Lowercase letters
		if (/[a-z]/.test(char)) {
			return { modifiers: 0, keyCode: char.toUpperCase().charCodeAt(0), code: `Key${char.toUpperCase()}` };
		}

		// Numbers
		if (/[0-9]/.test(char)) {
			return { modifiers: 0, keyCode: char.charCodeAt(0), code: `Digit${char}` };
		}

		// Special characters without Shift
		if (char in noShiftChars) {
			const [code, keyCode] = noShiftChars[char];
			return { modifiers: 0, keyCode, code };
		}

		// Fallback
		return { modifiers: 0, keyCode: char.charCodeAt(0), code: `Key${char.toUpperCase()}` };
	}

	/**
	 * Clear text field using multiple strategies, starting with the most reliable.
	 * Port from Python's _clear_text_field - exact match of the 3-strategy approach.
	 */
	private async clearTextField(
		node: { backendNodeId?: number },
		position: { x: number; y: number } | null
	): Promise<boolean> {
		if (!this.cdpSession) return false;

		// Resolve node to get objectId (needed for JS strategies)
		let objectId: string | undefined;
		if (node.backendNodeId) {
			try {
				const result = await this.cdpSession.send('DOM.resolveNode', {
					backendNodeId: node.backendNodeId,
				});
				objectId = result?.object?.objectId;
			} catch {
				// Ignore resolution errors
			}
		}

		// Strategy 1: Direct JavaScript value setting (most reliable for modern web apps)
		if (objectId) {
			try {
				logger.debug('Clearing text field using JavaScript value setting');
				const cleared = await this.clearTextFieldWithJS(objectId);
				if (cleared) {
					// Verify clearing worked by checking the value
					const verifyResult = await this.cdpSession.send('Runtime.callFunctionOn', {
						objectId,
						functionDeclaration: 'function() { return this.value; }',
						returnByValue: true,
					});
					const currentValue = (verifyResult as any)?.result?.value ?? '';
					if (!currentValue) {
						logger.debug('Text field cleared successfully using JavaScript');
						return true;
					} else {
						logger.debug(`JavaScript clear partially failed, field still contains: "${currentValue}"`);
					}
				}
			} catch (e: any) {
				logger.debug(`JavaScript clear failed: ${e.message}`);
			}
		}

		// Strategy 2: Triple-click + Delete (fallback for stubborn fields)
		if (position) {
			try {
				logger.debug('Fallback: Clearing using triple-click + Delete');

				// Triple-click to select all text
				await this.cdpSession.send('Input.dispatchMouseEvent', {
					type: 'mousePressed',
					x: position.x,
					y: position.y,
					button: 'left',
					clickCount: 3,
				});
				await this.cdpSession.send('Input.dispatchMouseEvent', {
					type: 'mouseReleased',
					x: position.x,
					y: position.y,
					button: 'left',
					clickCount: 3,
				});

				// Delete selected text
				await this.cdpSession.send('Input.dispatchKeyEvent', {
					type: 'keyDown',
					key: 'Delete',
					code: 'Delete',
				});
				await this.cdpSession.send('Input.dispatchKeyEvent', {
					type: 'keyUp',
					key: 'Delete',
					code: 'Delete',
				});

				logger.debug('Text field cleared using triple-click + Delete');
				return true;
			} catch (e: any) {
				logger.debug(`Triple-click clear failed: ${e.message}`);
			}
		}

		// Strategy 3: Keyboard shortcuts (last resort)
		try {
			await this.selectAllAndDelete();
			logger.debug('Text field cleared using keyboard shortcuts');
			return true;
		} catch (e: any) {
			logger.debug(`All clearing strategies failed: ${e.message}`);
		}

		return false;
	}

	/**
	 * Select all and delete text using keyboard shortcuts
	 * Port from Python's Strategy 3 - uses Cmd on macOS, Ctrl elsewhere
	 */
	private async selectAllAndDelete(): Promise<void> {
		if (!this.cdpSession) return;

		// Use platform detection: Meta (Cmd) = 4 on macOS, Ctrl = 2 on other platforms
		const isMacOS = process.platform === 'darwin';
		const selectAllModifier = isMacOS ? 4 : 2; // Meta=4 (Cmd), Ctrl=2
		const modifierName = isMacOS ? 'Cmd' : 'Ctrl';

		logger.debug(`Last resort: Clearing using ${modifierName}+A + Backspace`);

		// Select all text (Ctrl/Cmd+A)
		await this.cdpSession.send('Input.dispatchKeyEvent', {
			type: 'keyDown',
			modifiers: selectAllModifier,
			key: 'a',
			code: 'KeyA',
		});
		await this.cdpSession.send('Input.dispatchKeyEvent', {
			type: 'keyUp',
			modifiers: selectAllModifier,
			key: 'a',
			code: 'KeyA',
		});

		await new Promise(resolve => setTimeout(resolve, 50));

		// Delete selected text (Backspace)
		await this.cdpSession.send('Input.dispatchKeyEvent', {
			type: 'keyDown',
			key: 'Backspace',
			code: 'Backspace',
		});
		await this.cdpSession.send('Input.dispatchKeyEvent', {
			type: 'keyUp',
			key: 'Backspace',
			code: 'Backspace',
		});
	}

	/**
	 * Clear text field using JavaScript (more reliable for React/Vue/Angular)
	 * Port from Python's _clear_text_field
	 */
	private async clearTextFieldWithJS(objectId: string): Promise<boolean> {
		if (!this.cdpSession) return false;

		try {
			await this.cdpSession.send('Runtime.callFunctionOn', {
				objectId,
				functionDeclaration: `
					function() {
						// Try to select all text first
						try {
							this.select();
						} catch (e) {
							// Some input types don't support select()
						}
						// Set value to empty
						this.value = "";
						// Dispatch events to notify frameworks like React
						this.dispatchEvent(new Event("input", { bubbles: true }));
						this.dispatchEvent(new Event("change", { bubbles: true }));
						return this.value;
					}
				`,
				returnByValue: true,
			});
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Trigger framework events after typing (React/Vue/Angular compatibility)
	 * Matches Python's comprehensive _trigger_framework_events implementation
	 */
	private async triggerFrameworkEvents(objectId: string): Promise<void> {
		if (!this.cdpSession) return;

		try {
			const frameworkEventsScript = `
				function() {
					const element = this;

					// Standard DOM event definitions
					const eventDefinitions = [
						// Input event - primary event for React controlled components
						{ type: 'input', options: { bubbles: true, cancelable: true } },
						// Change event - important for form validation and Vue v-model
						{ type: 'change', options: { bubbles: true, cancelable: false } },
						// Blur event - triggers validation in many frameworks
						{ type: 'blur', options: { bubbles: false, cancelable: false } },
					];

					// Dispatch standard events
					for (const eventDef of eventDefinitions) {
						try {
							// Create and dispatch as InputEvent for better framework compatibility
							if (eventDef.type === 'input') {
								const inputEvent = new InputEvent('input', {
									bubbles: true,
									cancelable: true,
									inputType: 'insertText',
									data: null,
								});
								element.dispatchEvent(inputEvent);
							} else {
								const event = new Event(eventDef.type, eventDef.options);
								element.dispatchEvent(event);
							}
						} catch (e) {
							console.warn('Event dispatch failed:', eventDef.type, e);
						}
					}

					// Special React synthetic event handling
					// React uses internal fiber properties for event system
					try {
						if (element.__reactFiber$ || element._reactRootContainer || window.React) {
							// Trigger React's synthetic event system
							const syntheticInputEvent = new Event('input', {
								bubbles: true,
								cancelable: true,
							});

							// Force React to process this as a synthetic event
							Object.defineProperty(syntheticInputEvent, 'nativeEvent', { value: syntheticInputEvent });
							element.dispatchEvent(syntheticInputEvent);
						}
					} catch (e) {
						console.warn('React synthetic event failed:', e);
					}

					// Special Vue reactivity trigger
					// Vue uses __vueParentComponent or __vue__ for component access
					try {
						if (element.__vue__ || element.__vueParentComponent) {
							// Vue often needs explicit input event with proper timing
							const vueEvent = new Event('input', { bubbles: true });
							setTimeout(() => element.dispatchEvent(vueEvent), 0);
						}
					} catch (e) {
						console.warn('Vue reactivity trigger failed:', e);
					}
				}
			`;

			await this.cdpSession.send('Runtime.callFunctionOn', {
				objectId,
				functionDeclaration: frameworkEventsScript,
			});
		} catch (e) {
			logger.warn(`Failed to trigger framework events: ${e}`);
			// Don't raise - framework events are a best-effort enhancement
		}
	}

	private getModifiers(keyParts: string[]): number {
		let modifiers = 0;
		for (const part of keyParts.slice(0, -1)) {
			switch (part) {
				case 'ctrl':
				case 'control':
					modifiers |= 2;
					break;
				case 'alt':
					modifiers |= 1;
					break;
				case 'shift':
					modifiers |= 8;
					break;
				case 'cmd':
				case 'meta':
				case 'command':
					modifiers |= 4;
					break;
			}
		}
		return modifiers;
	}

	private getKeyInfo(key: string): { key: string; code: string; keyCode: number } {
		const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
			enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
			tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
			escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
			backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
			delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
			arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
			arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
			arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
			arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
			home: { key: 'Home', code: 'Home', keyCode: 36 },
			end: { key: 'End', code: 'End', keyCode: 35 },
			pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
			pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
			space: { key: ' ', code: 'Space', keyCode: 32 },
			a: { key: 'a', code: 'KeyA', keyCode: 65 },
			c: { key: 'c', code: 'KeyC', keyCode: 67 },
			v: { key: 'v', code: 'KeyV', keyCode: 86 },
			x: { key: 'x', code: 'KeyX', keyCode: 88 },
			z: { key: 'z', code: 'KeyZ', keyCode: 90 },
		};

		return keyMap[key.toLowerCase()] || {
			key: key,
			code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
			keyCode: key.charCodeAt(0),
		};
	}

	// ============================================================================
	// Event Registration
	// ============================================================================

	async start(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;

		// Register all action event handlers
		this.eventBus.on(BrowserEventNames.CLICK_ELEMENT, async (event: any) => {
			try {
				const result = await this.handleClickElement(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.TYPE_TEXT, async (event: any) => {
			try {
				const result = await this.handleTypeText(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.SCROLL, async (event: any) => {
			try {
				const result = await this.handleScroll(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.SEND_KEYS, async (event: any) => {
			try {
				const result = await this.handleSendKeys(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.NAVIGATE_TO_URL, async (event: any) => {
			try {
				const result = await this.handleNavigateToUrl(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.GO_BACK, async (event: any) => {
			try {
				const result = await this.handleGoBack(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.GO_FORWARD, async (event: any) => {
			try {
				const result = await this.handleGoForward(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.REFRESH, async (event: any) => {
			try {
				const result = await this.handleRefresh(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.WAIT, async (event: any) => {
			try {
				const result = await this.handleWait(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.GET_DROPDOWN_OPTIONS, async (event: any) => {
			try {
				const result = await this.handleGetDropdownOptions(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.SELECT_DROPDOWN_OPTION, async (event: any) => {
			try {
				const result = await this.handleSelectDropdownOption(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.UPLOAD_FILE, async (event: any) => {
			try {
				const result = await this.handleUploadFile(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		this.eventBus.on(BrowserEventNames.SCROLL_TO_TEXT, async (event: any) => {
			try {
				const result = await this.handleScrollToText(event);
				if (event._eventId) {
					(this.eventBus as any).respondToEvent?.(event._eventId, result);
				}
			} catch (error) {
				if (event._eventId) {
					(this.eventBus as any).rejectEvent?.(event._eventId, error as Error);
				}
			}
		});

		logger.debug('[DefaultActionWatchdog] Started monitoring');
	}

	async stop(): Promise<void> {
		this.isRunning = false;
		this.page = null;
		this.cdpSession = null;
		logger.debug('[DefaultActionWatchdog] Stopped monitoring');
	}
}

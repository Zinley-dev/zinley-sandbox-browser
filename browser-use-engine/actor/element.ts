/**
 * Element operations for browser automation
 * Port from browser_use/actor/element.py
 */
import { CDPSession, Page } from 'patchright';
import {
	ModifierType,
	MouseButton,
	Position,
	BoundingBox,
	ElementInfo,
	getCharModifiersAndVK,
	getKeyCodeForChar,
} from './utils.js';

/**
 * Timeout helper that properly times out a promise (like Python's asyncio.wait_for).
 * Unlike Promise.race with sleep, this actually rejects with a timeout error.
 * The original promise may still complete in the background but its result is ignored.
 *
 * @param promise The promise to timeout
 * @param timeoutMs Timeout in milliseconds
 * @param errorMessage Optional error message for timeout
 * @returns The result of the promise if it completes in time
 * @throws Error if the timeout is reached
 */
async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	errorMessage = 'Operation timed out'
): Promise<T> {
	let timeoutId: NodeJS.Timeout;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(errorMessage));
		}, timeoutMs);
	});

	try {
		const result = await Promise.race([promise, timeoutPromise]);
		clearTimeout(timeoutId!);
		return result;
	} catch (error) {
		clearTimeout(timeoutId!);
		throw error;
	}
}

/**
 * Element operations using BackendNodeId and CDP
 */
export class Element {
	private cdpSession: CDPSession | null = null;

	constructor(
		private page: Page,
		private backendNodeId: number,
		private sessionId?: string
	) {}

	/**
	 * Get or create CDP session
	 */
	private async getCDPSession(): Promise<CDPSession> {
		if (!this.cdpSession) {
			const context = this.page.context();
			this.cdpSession = await context.newCDPSession(this.page);
		}
		return this.cdpSession;
	}

	/**
	 * Get DOM node ID from backend node ID
	 */
	private async getNodeId(): Promise<number> {
		const cdp = await this.getCDPSession();
		const result = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
			backendNodeIds: [this.backendNodeId],
		});
		return (result as any).nodeIds[0];
	}

	/**
	 * Get remote object ID for this element
	 */
	private async getRemoteObjectId(): Promise<string | null> {
		const cdp = await this.getCDPSession();
		const nodeId = await this.getNodeId();

		const result = await cdp.send('DOM.resolveNode', { nodeId });
		const objectId = (result as any).object?.objectId;
		return objectId || null;
	}

	/**
	 * Click the element using advanced CDP implementation with multiple fallback methods
	 */
	async click(
		button: MouseButton = 'left',
		clickCount: number = 1,
		modifiers?: ModifierType[]
	): Promise<void> {
		try {
			const cdp = await this.getCDPSession();

			// Get viewport dimensions for visibility checks
			const layoutMetrics = await cdp.send('Page.getLayoutMetrics');
			const viewport = (layoutMetrics as any).layoutViewport || (layoutMetrics as any).cssLayoutViewport || {};
			const viewportWidth = viewport.clientWidth || 1920;
			const viewportHeight = viewport.clientHeight || 1080;

			// Try multiple methods to get element geometry
			let quads: number[][] = [];

			// Method 1: Try DOM.getContentQuads first (best for inline elements and complex layouts)
			try {
				const contentQuadsResult = await cdp.send('DOM.getContentQuads', {
					backendNodeId: this.backendNodeId,
				});
				if ((contentQuadsResult as any).quads?.length > 0) {
					quads = (contentQuadsResult as any).quads;
				}
			} catch {
				// Ignore and try next method
			}

			// Method 2: Fall back to DOM.getBoxModel
			if (quads.length === 0) {
				try {
					const boxModel = await cdp.send('DOM.getBoxModel', {
						backendNodeId: this.backendNodeId,
					});
					if ((boxModel as any).model?.content) {
						const content = (boxModel as any).model.content;
						if (content.length >= 8) {
							quads = [[
								content[0], content[1], // x1, y1
								content[2], content[3], // x2, y2
								content[4], content[5], // x3, y3
								content[6], content[7], // x4, y4
							]];
						}
					}
				} catch {
					// Ignore and try next method
				}
			}

			// Method 3: Fall back to JavaScript getBoundingClientRect
			if (quads.length === 0) {
				try {
					const result = await cdp.send('DOM.resolveNode', {
						backendNodeId: this.backendNodeId,
					});
					const objectId = (result as any).object?.objectId;

					if (objectId) {
						const boundsResult = await cdp.send('Runtime.callFunctionOn', {
							functionDeclaration: `
								function() {
									const rect = this.getBoundingClientRect();
									return {
										x: rect.left,
										y: rect.top,
										width: rect.width,
										height: rect.height
									};
								}
							`,
							objectId,
							returnByValue: true,
						});

						const rect = (boundsResult as any).result?.value;
						if (rect) {
							const x = rect.x;
							const y = rect.y;
							const w = rect.width;
							const h = rect.height;
							quads = [[
								x, y,           // top-left
								x + w, y,       // top-right
								x + w, y + h,   // bottom-right
								x, y + h,       // bottom-left
							]];
						}
					}
				} catch {
					// Ignore and try JS click
				}
			}

			// If we still don't have quads, fall back to JS click
			if (quads.length === 0) {
				await this.jsClick();
				return;
			}

			// Find the largest visible quad within the viewport
			let bestQuad: number[] | null = null;
			let bestArea = 0;

			for (const quad of quads) {
				if (quad.length < 8) continue;

				// Calculate quad bounds
				const xs = [quad[0], quad[2], quad[4], quad[6]];
				const ys = [quad[1], quad[3], quad[5], quad[7]];
				const minX = Math.min(...xs);
				const maxX = Math.max(...xs);
				const minY = Math.min(...ys);
				const maxY = Math.max(...ys);

				// Check if quad intersects with viewport
				if (maxX < 0 || maxY < 0 || minX > viewportWidth || minY > viewportHeight) {
					continue; // Quad is completely outside viewport
				}

				// Calculate visible area (intersection with viewport)
				const visibleMinX = Math.max(0, minX);
				const visibleMaxX = Math.min(viewportWidth, maxX);
				const visibleMinY = Math.max(0, minY);
				const visibleMaxY = Math.min(viewportHeight, maxY);

				const visibleWidth = visibleMaxX - visibleMinX;
				const visibleHeight = visibleMaxY - visibleMinY;
				const visibleArea = visibleWidth * visibleHeight;

				if (visibleArea > bestArea) {
					bestArea = visibleArea;
					bestQuad = quad;
				}
			}

			// CRITICAL FIX: If no visible quad, scroll FIRST then re-fetch quads
			// This matches Python behavior - don't click at clamped viewport edge
			if (!bestQuad) {
				console.debug('🔄 No visible quad found, scrolling element into view first...');

				// Scroll element into view FIRST
				try {
					await cdp.send('DOM.scrollIntoViewIfNeeded', {
						backendNodeId: this.backendNodeId,
					});
					await this.sleep(100); // Wait longer for scroll to settle
				} catch {
					// Ignore scroll errors
				}

				// Re-fetch quads after scroll
				try {
					const postScrollQuads = await cdp.send('DOM.getContentQuads', {
						backendNodeId: this.backendNodeId,
					});
					if ((postScrollQuads as any)?.quads?.length > 0) {
						quads = (postScrollQuads as any).quads;

						// Re-evaluate visible quads
						for (const quad of quads) {
							if (quad.length < 8) continue;
							const xs = [quad[0], quad[2], quad[4], quad[6]];
							const ys = [quad[1], quad[3], quad[5], quad[7]];
							const minX = Math.min(...xs);
							const maxX = Math.max(...xs);
							const minY = Math.min(...ys);
							const maxY = Math.max(...ys);

							if (maxX < 0 || maxY < 0 || minX > viewportWidth || minY > viewportHeight) {
								continue;
							}

							const visibleMinX = Math.max(0, minX);
							const visibleMaxX = Math.min(viewportWidth, maxX);
							const visibleMinY = Math.max(0, minY);
							const visibleMaxY = Math.min(viewportHeight, maxY);
							const visibleArea = (visibleMaxX - visibleMinX) * (visibleMaxY - visibleMinY);

							if (visibleArea > bestArea) {
								bestArea = visibleArea;
								bestQuad = quad;
							}
						}
					}
				} catch {
					// Ignore re-fetch errors
				}

				// If STILL no visible quad after scroll, fall back to JS click
				if (!bestQuad) {
					console.debug('⚠️ Still no visible quad after scroll, falling back to JS click');
					await this.jsClick();
					return;
				}
			} else {
				// Element was already visible, still scroll to ensure it's in view
				try {
					await cdp.send('DOM.scrollIntoViewIfNeeded', {
						backendNodeId: this.backendNodeId,
					});
					await this.sleep(50);
				} catch {
					// Ignore scroll errors
				}
			}

			// Calculate center point of the best quad
			let centerX = (bestQuad[0] + bestQuad[2] + bestQuad[4] + bestQuad[6]) / 4;
			let centerY = (bestQuad[1] + bestQuad[3] + bestQuad[5] + bestQuad[7]) / 4;

			// Ensure click point is within viewport bounds (safety clamp)
			centerX = Math.max(0, Math.min(viewportWidth - 1, centerX));
			centerY = Math.max(0, Math.min(viewportHeight - 1, centerY));

			// Calculate modifier bitmask for CDP
			let modifierValue = 0;
			if (modifiers) {
				const modifierMap: Record<string, number> = { 'Alt': 1, 'Control': 2, 'Meta': 4, 'Shift': 8 };
				for (const mod of modifiers) {
					modifierValue |= modifierMap[mod] || 0;
				}
			}

			// Perform the click using CDP (matches Python actor/element.py lines 275-325)
			try {
				// Move mouse to element (like Python lines 277-285)
				await cdp.send('Input.dispatchMouseEvent', {
					type: 'mouseMoved',
					x: centerX,
					y: centerY,
				});
				await this.sleep(50);

				// Mouse down with proper timeout (like Python lines 288-306)
				// Python uses asyncio.wait_for with 1.0s timeout
				let mousePressedSuccess = false;
				try {
					await withTimeout(
						cdp.send('Input.dispatchMouseEvent', {
							type: 'mousePressed',
							x: centerX,
							y: centerY,
							button,
							clickCount,
							modifiers: modifierValue,
						}),
						1000, // 1 second timeout like Python
						'mousePressed timeout'
					);
					mousePressedSuccess = true;
				} catch {
					// Timeout is OK - click may have triggered a dialog (like Python line 305-306)
				}

				// Python: Only sleep 80ms if mousePressed succeeded (lines 304)
				if (mousePressedSuccess) {
					await this.sleep(80);
				}

				// Mouse up with proper timeout (like Python lines 308-325)
				// Python uses asyncio.wait_for with 3.0s timeout
				try {
					await withTimeout(
						cdp.send('Input.dispatchMouseEvent', {
							type: 'mouseReleased',
							x: centerX,
							y: centerY,
							button,
							clickCount,
							modifiers: modifierValue,
						}),
						3000, // 3 second timeout like Python
						'mouseReleased timeout'
					);
				} catch {
					// Timeout is OK (like Python line 324-325)
				}
			} catch {
				// Fall back to JavaScript click (like Python lines 327-347).
				// If this throws too, the outer catch reports the JS-click error.
				await this.jsClick();
			}
		} catch (e: any) {
			throw new Error(`Failed to click element: ${e.message}`);
		}
	}

	/**
	 * JavaScript click fallback
	 */
	private async jsClick(): Promise<void> {
		const cdp = await this.getCDPSession();

		const result = await cdp.send('DOM.resolveNode', {
			backendNodeId: this.backendNodeId,
		});

		const objectId = (result as any).object?.objectId;
		if (!objectId) {
			throw new Error('Failed to find DOM element based on backendNodeId, maybe page content changed?');
		}

		await cdp.send('Runtime.callFunctionOn', {
			functionDeclaration: 'function() { this.click(); }',
			objectId,
		});
		await this.sleep(100);
	}

	/**
	 * Fill the input element with text
	 */
	async fill(value: string, clear: boolean = true): Promise<void> {
		try {
			const cdp = await this.getCDPSession();
			let inputCoordinates: { x: number; y: number } | null = null;

			// Scroll element into view
			try {
				await cdp.send('DOM.scrollIntoViewIfNeeded', {
					backendNodeId: this.backendNodeId,
				});
				await this.sleep(10);
			} catch (e) {
				console.debug('Failed to scroll element into view:', e);
			}

			// Get object ID for the element
			const result = await cdp.send('DOM.resolveNode', {
				backendNodeId: this.backendNodeId,
			});
			const objectId = (result as any).object?.objectId;

			if (!objectId) {
				throw new Error('Failed to get object ID for element');
			}

			// Get element coordinates for focus
			try {
				const boundsResult = await cdp.send('Runtime.callFunctionOn', {
					functionDeclaration: 'function() { return this.getBoundingClientRect(); }',
					objectId,
					returnByValue: true,
				});
				const bounds = (boundsResult as any).result?.value;
				if (bounds) {
					inputCoordinates = {
						x: bounds.x + bounds.width / 2,
						y: bounds.y + bounds.height / 2,
					};
				}
			} catch (e) {
				console.debug('Could not get element coordinates:', e);
			}

			// Step 1: Focus the element
			await this.focusElementSimple(objectId, inputCoordinates);

			// Step 2: Clear existing text if requested
			if (clear) {
				await this.clearTextField(objectId);
			}

			// Step 3: Type the text character by character
			for (const char of value) {
				if (char === '\n') {
					// Send proper Enter key sequence
					await cdp.send('Input.dispatchKeyEvent', {
						type: 'keyDown',
						key: 'Enter',
						code: 'Enter',
						windowsVirtualKeyCode: 13,
					});
					await this.sleep(1);

					await cdp.send('Input.dispatchKeyEvent', {
						type: 'char',
						text: '\r',
						key: 'Enter',
					});

					await cdp.send('Input.dispatchKeyEvent', {
						type: 'keyUp',
						key: 'Enter',
						code: 'Enter',
						windowsVirtualKeyCode: 13,
					});
				} else {
					// Handle regular characters
					const [modifiers, vkCode, baseKey] = getCharModifiersAndVK(char);
					const keyCode = getKeyCodeForChar(baseKey);

					// keyDown
					await cdp.send('Input.dispatchKeyEvent', {
						type: 'keyDown',
						key: baseKey,
						code: keyCode,
						modifiers,
						windowsVirtualKeyCode: vkCode,
					});
					await this.sleep(1);

					// char event (crucial for text input)
					await cdp.send('Input.dispatchKeyEvent', {
						type: 'char',
						text: char,
						key: char,
					});

					// keyUp
					await cdp.send('Input.dispatchKeyEvent', {
						type: 'keyUp',
						key: baseKey,
						code: keyCode,
						modifiers,
						windowsVirtualKeyCode: vkCode,
					});
				}

				// Add 18ms delay between keystrokes
				await this.sleep(18);
			}
		} catch (e: any) {
			throw new Error(`Failed to fill element: ${e.message}`);
		}
	}

	/**
	 * Type text (alias for fill without clear)
	 */
	async type(text: string): Promise<void> {
		await this.fill(text, false);
	}

	/**
	 * Hover over the element
	 */
	async hover(): Promise<void> {
		const box = await this.getBoundingBox();
		if (!box) {
			throw new Error('Element is not visible or has no bounding box');
		}

		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;

		const cdp = await this.getCDPSession();
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved',
			x,
			y,
		});
	}

	/**
	 * Focus the element
	 */
	async focus(): Promise<void> {
		const cdp = await this.getCDPSession();
		const nodeId = await this.getNodeId();
		await cdp.send('DOM.focus', { nodeId });
	}

	/**
	 * Check or uncheck a checkbox/radio button
	 */
	async check(): Promise<void> {
		await this.click();
	}

	/**
	 * Select option(s) in a select element
	 */
	async selectOption(values: string | string[]): Promise<void> {
		const valuesArray = Array.isArray(values) ? values : [values];

		// Focus the element first
		try {
			await this.focus();
		} catch {
			console.debug('Failed to focus element');
		}

		const cdp = await this.getCDPSession();
		const nodeId = await this.getNodeId();

		// Request child nodes to get the options
		await cdp.send('DOM.requestChildNodes', {
			nodeId,
			depth: 1,
		});

		// Get the updated node description with children
		const describeResult = await cdp.send('DOM.describeNode', {
			nodeId,
			depth: 1,
		});

		const selectNode = (describeResult as any).node;

		// Find and select matching options
		for (const child of selectNode.children || []) {
			if ((child.nodeName || '').toLowerCase() === 'option') {
				// Get option attributes
				const attrs = child.attributes || [];
				const optionAttrs: Record<string, string> = {};
				for (let i = 0; i < attrs.length; i += 2) {
					if (i + 1 < attrs.length) {
						optionAttrs[attrs[i]] = attrs[i + 1];
					}
				}

				const optionValue = optionAttrs['value'] || '';
				const optionText = child.nodeValue || '';

				// Check if this option should be selected
				const shouldSelect = valuesArray.includes(optionValue) || valuesArray.includes(optionText);

				if (shouldSelect && child.nodeId) {
					// Get backend node ID for the option
					const optionDescribeResult = await cdp.send('DOM.describeNode', {
						nodeId: child.nodeId,
					});
					const optionBackendId = (optionDescribeResult as any).node.backendNodeId;

					// Create an Element for the option and click it
					const optionElement = new Element(this.page, optionBackendId, this.sessionId);
					await optionElement.click();
				}
			}
		}
	}

	/**
	 * Drag this element to another element or position
	 */
	async dragTo(
		target: Element | Position,
		sourcePosition?: Position,
		targetPosition?: Position
	): Promise<void> {
		const cdp = await this.getCDPSession();

		// Get source coordinates
		let sourceX: number;
		let sourceY: number;

		if (sourcePosition) {
			sourceX = sourcePosition.x;
			sourceY = sourcePosition.y;
		} else {
			const sourceBox = await this.getBoundingBox();
			if (!sourceBox) {
				throw new Error('Source element is not visible');
			}
			sourceX = sourceBox.x + sourceBox.width / 2;
			sourceY = sourceBox.y + sourceBox.height / 2;
		}

		// Get target coordinates
		let targetX: number;
		let targetY: number;

		if ('x' in target && 'y' in target && typeof target.x === 'number') {
			targetX = target.x;
			targetY = target.y;
		} else {
			const targetElement = target as Element;
			const targetBox = await targetElement.getBoundingBox();
			if (!targetBox) {
				throw new Error('Target element is not visible');
			}

			if (targetPosition) {
				targetX = targetBox.x + targetPosition.x;
				targetY = targetBox.y + targetPosition.y;
			} else {
				targetX = targetBox.x + targetBox.width / 2;
				targetY = targetBox.y + targetBox.height / 2;
			}
		}

		// Perform drag operation
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			x: sourceX,
			y: sourceY,
			button: 'left',
		});

		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved',
			x: targetX,
			y: targetY,
		});

		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			x: targetX,
			y: targetY,
			button: 'left',
		});
	}

	/**
	 * Get an attribute value
	 */
	async getAttribute(name: string): Promise<string | null> {
		const cdp = await this.getCDPSession();
		const nodeId = await this.getNodeId();
		const result = await cdp.send('DOM.getAttributes', { nodeId });

		const attributes = (result as any).attributes || [];
		for (let i = 0; i < attributes.length; i += 2) {
			if (attributes[i] === name) {
				return attributes[i + 1];
			}
		}
		return null;
	}

	/**
	 * Get the bounding box of the element
	 */
	async getBoundingBox(): Promise<BoundingBox | null> {
		try {
			const cdp = await this.getCDPSession();
			const nodeId = await this.getNodeId();
			const result = await cdp.send('DOM.getBoxModel', { nodeId });

			const model = (result as any).model;
			if (!model) return null;

			// Get content box (first 8 values are content quad: x1,y1,x2,y2,x3,y3,x4,y4)
			const content = model.content;
			if (!content || content.length < 8) return null;

			// Calculate bounding box from quad
			const xCoords = [content[0], content[2], content[4], content[6]];
			const yCoords = [content[1], content[3], content[5], content[7]];

			const x = Math.min(...xCoords);
			const y = Math.min(...yCoords);
			const width = Math.max(...xCoords) - x;
			const height = Math.max(...yCoords) - y;

			return { x, y, width, height };
		} catch {
			return null;
		}
	}

	/**
	 * Take a screenshot of this element and return base64 encoded image
	 */
	async screenshot(format: 'jpeg' | 'png' | 'webp' = 'png', quality?: number): Promise<string> {
		const box = await this.getBoundingBox();
		if (!box) {
			throw new Error('Element is not visible or has no bounding box');
		}

		const cdp = await this.getCDPSession();
		const params: any = {
			format,
			clip: {
				x: box.x,
				y: box.y,
				width: box.width,
				height: box.height,
				scale: 1.0,
			},
		};

		if (quality !== undefined && format === 'jpeg') {
			params.quality = quality;
		}

		const result = await cdp.send('Page.captureScreenshot', params);
		return (result as any).data;
	}

	/**
	 * Execute JavaScript code in the context of this element
	 */
	async evaluate(pageFunction: string, ...args: any[]): Promise<string> {
		const cdp = await this.getCDPSession();
		const objectId = await this.getRemoteObjectId();

		if (!objectId) {
			throw new Error('Element has no remote object ID (element may be detached from DOM)');
		}

		// Validate arrow function format
		const funcStr = pageFunction.trim();
		if (!funcStr.includes('=>')) {
			throw new Error(`JavaScript code must start with (...args) => format. Got: ${funcStr.substring(0, 50)}...`);
		}

		// Check if it's an async arrow function
		const isAsync = funcStr.startsWith('async');
		const asyncPrefix = isAsync ? 'async ' : '';

		// Parse arrow function
		let funcToParse = funcStr;
		if (isAsync) {
			funcToParse = funcToParse.substring(5).trim();
		}

		const arrowMatch = funcToParse.match(/^\s*\(([^)]*)\)\s*=>\s*(.+)$/s);
		if (!arrowMatch) {
			throw new Error(`Could not parse arrow function: ${funcStr.substring(0, 50)}...`);
		}

		const paramsStr = arrowMatch[1].trim();
		const body = arrowMatch[2].trim();

		// Convert to function declaration
		let functionDeclaration: string;
		if (!body.startsWith('{')) {
			functionDeclaration = `${asyncPrefix}function(${paramsStr}) { return ${body}; }`;
		} else {
			functionDeclaration = `${asyncPrefix}function(${paramsStr}) ${body}`;
		}

		// Build CallArgument list
		const callArguments = args.map(arg => ({ value: arg }));

		const params: any = {
			functionDeclaration,
			objectId,
			returnByValue: true,
			awaitPromise: true,
		};

		if (callArguments.length > 0) {
			params.arguments = callArguments;
		}

		const result = await cdp.send('Runtime.callFunctionOn', params);

		if ((result as any).exceptionDetails) {
			throw new Error(`JavaScript evaluation failed: ${JSON.stringify((result as any).exceptionDetails)}`);
		}

		const value = (result as any).result?.value;

		if (value === null || value === undefined) {
			return '';
		} else if (typeof value === 'string') {
			return value;
		} else {
			try {
				return typeof value === 'object' ? JSON.stringify(value) : String(value);
			} catch {
				return String(value);
			}
		}
	}

	/**
	 * Get basic information about the element
	 */
	async getBasicInfo(): Promise<ElementInfo> {
		try {
			const cdp = await this.getCDPSession();
			const nodeId = await this.getNodeId();
			const describeResult = await cdp.send('DOM.describeNode', { nodeId });

			const nodeInfo = (describeResult as any).node;
			const boundingBox = await this.getBoundingBox();

			// Get attributes as a proper dict
			const attributesList = nodeInfo.attributes || [];
			const attributesDict: Record<string, string> = {};
			for (let i = 0; i < attributesList.length; i += 2) {
				if (i + 1 < attributesList.length) {
					attributesDict[attributesList[i]] = attributesList[i + 1];
				}
			}

			return {
				backendNodeId: this.backendNodeId,
				nodeId,
				nodeName: nodeInfo.nodeName || '',
				nodeType: nodeInfo.nodeType || 0,
				nodeValue: nodeInfo.nodeValue || null,
				attributes: attributesDict,
				boundingBox,
				error: null,
			};
		} catch (e: any) {
			return {
				backendNodeId: this.backendNodeId,
				nodeId: null,
				nodeName: '',
				nodeType: 0,
				nodeValue: null,
				attributes: {},
				boundingBox: null,
				error: e.message,
			};
		}
	}

	// ============================================================================
	// Private helper methods
	// ============================================================================

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Focus element using multiple strategies
	 */
	private async focusElementSimple(
		objectId: string,
		inputCoordinates: { x: number; y: number } | null
	): Promise<boolean> {
		const cdp = await this.getCDPSession();

		try {
			// Strategy 1: CDP focus (most reliable)
			await cdp.send('DOM.focus', { backendNodeId: this.backendNodeId });
			return true;
		} catch (e) {
			console.debug('CDP focus failed:', e);
		}

		try {
			// Strategy 2: JavaScript focus
			await cdp.send('Runtime.callFunctionOn', {
				functionDeclaration: 'function() { this.focus(); }',
				objectId,
			});
			return true;
		} catch (e) {
			console.debug('JavaScript focus failed:', e);
		}

		try {
			// Strategy 3: Click to focus (last resort)
			if (inputCoordinates) {
				await cdp.send('Input.dispatchMouseEvent', {
					type: 'mousePressed',
					x: inputCoordinates.x,
					y: inputCoordinates.y,
					button: 'left',
					clickCount: 1,
				});
				await cdp.send('Input.dispatchMouseEvent', {
					type: 'mouseReleased',
					x: inputCoordinates.x,
					y: inputCoordinates.y,
					button: 'left',
					clickCount: 1,
				});
				return true;
			}
		} catch (e) {
			console.debug('Click focus failed:', e);
		}

		return false;
	}

	/**
	 * Clear text field using multiple strategies
	 */
	private async clearTextField(objectId: string): Promise<boolean> {
		const cdp = await this.getCDPSession();

		try {
			// Strategy 1: Direct JavaScript value setting (most reliable)
			await cdp.send('Runtime.callFunctionOn', {
				functionDeclaration: `
					function() {
						try {
							this.select();
						} catch (e) {
							// Some input types don't support select()
						}
						this.value = "";
						this.dispatchEvent(new Event("input", { bubbles: true }));
						this.dispatchEvent(new Event("change", { bubbles: true }));
						return this.value;
					}
				`,
				objectId,
				returnByValue: true,
			});

			// Verify clearing worked
			const verifyResult = await cdp.send('Runtime.callFunctionOn', {
				functionDeclaration: 'function() { return this.value; }',
				objectId,
				returnByValue: true,
			});

			const currentValue = (verifyResult as any).result?.value || '';
			if (!currentValue) {
				return true;
			}
		} catch (e) {
			console.debug('JavaScript clear failed:', e);
		}

		try {
			// Strategy 2: Triple-click + Delete (fallback)
			const boundsResult = await cdp.send('Runtime.callFunctionOn', {
				functionDeclaration: 'function() { return this.getBoundingClientRect(); }',
				objectId,
				returnByValue: true,
			});

			const bounds = (boundsResult as any).result?.value;
			if (bounds) {
				const centerX = bounds.x + bounds.width / 2;
				const centerY = bounds.y + bounds.height / 2;

				// Triple-click to select all
				await cdp.send('Input.dispatchMouseEvent', {
					type: 'mousePressed',
					x: centerX,
					y: centerY,
					button: 'left',
					clickCount: 3,
				});
				await cdp.send('Input.dispatchMouseEvent', {
					type: 'mouseReleased',
					x: centerX,
					y: centerY,
					button: 'left',
					clickCount: 3,
				});

				// Delete selected text
				await cdp.send('Input.dispatchKeyEvent', {
					type: 'keyDown',
					key: 'Delete',
					code: 'Delete',
				});
				await cdp.send('Input.dispatchKeyEvent', {
					type: 'keyUp',
					key: 'Delete',
					code: 'Delete',
				});

				return true;
			}
		} catch (e) {
			console.debug('Triple-click clear failed:', e);
		}

		console.warn('All text clearing strategies failed');
		return false;
	}
}

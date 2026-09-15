/**
 * Page operations for browser automation
 * Port from browser_use/actor/page.py
 */
import { CDPSession, Page as PlaywrightPage } from 'patchright';
import { Element } from './element.js';
import { Mouse } from './mouse.js';
import { getKeyInfo } from './utils.js';

/**
 * Page operations (tab or iframe) using CDP
 */
export class Page {
	private cdpSession: CDPSession | null = null;
	private _mouse: Mouse | null = null;

	constructor(
		private page: PlaywrightPage,
		private targetId?: string,
		private sessionId?: string
	) {}

	/**
	 * Get or create CDP session
	 */
	private async getCDPSession(): Promise<CDPSession> {
		if (!this.cdpSession) {
			const context = this.page.context();
			this.cdpSession = await context.newCDPSession(this.page);

			// Enable necessary domains
			await Promise.all([
				this.cdpSession.send('Page.enable'),
				this.cdpSession.send('DOM.enable'),
				this.cdpSession.send('Runtime.enable'),
				this.cdpSession.send('Network.enable'),
			]);
		}
		return this.cdpSession;
	}

	/**
	 * Get the mouse interface for this page
	 */
	async getMouse(): Promise<Mouse> {
		if (!this._mouse) {
			this._mouse = new Mouse(this.page, this.sessionId, this.targetId);
		}
		return this._mouse;
	}

	/**
	 * Reload the page
	 */
	async reload(): Promise<void> {
		const cdp = await this.getCDPSession();
		await cdp.send('Page.reload');
	}

	/**
	 * Get an element by its backend node ID
	 */
	async getElement(backendNodeId: number): Promise<Element> {
		return new Element(this.page, backendNodeId, this.sessionId);
	}

	/**
	 * Execute JavaScript in the page
	 */
	async evaluate(pageFunction: string, ...args: any[]): Promise<string> {
		const cdp = await this.getCDPSession();

		// Clean and fix common JavaScript string parsing issues
		pageFunction = this.fixJavaScriptString(pageFunction);

		// Enforce arrow function format
		if (!pageFunction.startsWith('(') || !pageFunction.includes('=>')) {
			throw new Error(`JavaScript code must start with (...args) => format. Got: ${pageFunction.substring(0, 50)}...`);
		}

		// Build the expression - call the arrow function with provided args
		let expression: string;
		if (args.length > 0) {
			const argStrs = args.map(arg => JSON.stringify(arg));
			expression = `(${pageFunction})(${argStrs.join(', ')})`;
		} else {
			expression = `(${pageFunction})()`;
		}

		const result = await cdp.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});

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
	 * Fix common JavaScript string parsing issues
	 */
	private fixJavaScriptString(jsCode: string): string {
		jsCode = jsCode.trim();

		// Remove obvious Python string wrapper quotes if they exist
		if ((jsCode.startsWith('"') && jsCode.endsWith('"')) || (jsCode.startsWith("'") && jsCode.endsWith("'"))) {
			const inner = jsCode.slice(1, -1);
			if (inner.includes('() =>') || (inner.split('"').length + inner.split("'").length <= 2)) {
				jsCode = inner;
			}
		}

		// Fix clearly escaped quotes
		if (jsCode.includes('\\"') && jsCode.split('\\"').length > jsCode.split('"').length) {
			jsCode = jsCode.replace(/\\"/g, '"');
		}
		if (jsCode.includes("\\'") && jsCode.split("\\'").length > jsCode.split("'").length) {
			jsCode = jsCode.replace(/\\'/g, "'");
		}

		return jsCode.trim();
	}

	/**
	 * Take a screenshot and return base64 encoded image
	 */
	async screenshot(format: 'jpeg' | 'png' | 'webp' = 'png', quality?: number): Promise<string> {
		const cdp = await this.getCDPSession();

		const params: any = { format };
		if (quality !== undefined && format === 'jpeg') {
			params.quality = quality;
		}

		const result = await cdp.send('Page.captureScreenshot', params);
		return (result as any).data;
	}

	/**
	 * Press a key on the page
	 */
	async press(key: string): Promise<void> {
		const cdp = await this.getCDPSession();

		// Handle key combinations like "Control+A"
		if (key.includes('+')) {
			const parts = key.split('+');
			const modifiers = parts.slice(0, -1);
			const mainKey = parts[parts.length - 1];

			// Calculate modifier bitmask
			let modifierValue = 0;
			const modifierMap: Record<string, number> = { 'Alt': 1, 'Control': 2, 'Meta': 4, 'Shift': 8 };
			for (const mod of modifiers) {
				modifierValue |= modifierMap[mod] || 0;
			}

			// Press modifier keys
			for (const mod of modifiers) {
				const [code, vkCode] = getKeyInfo(mod);
				const params: any = { type: 'keyDown', key: mod, code };
				if (vkCode !== null) {
					params.windowsVirtualKeyCode = vkCode;
				}
				await cdp.send('Input.dispatchKeyEvent', params);
			}

			// Press main key with modifiers bitmask
			const [mainCode, mainVkCode] = getKeyInfo(mainKey);
			const mainDownParams: any = {
				type: 'keyDown',
				key: mainKey,
				code: mainCode,
				modifiers: modifierValue,
			};
			if (mainVkCode !== null) {
				mainDownParams.windowsVirtualKeyCode = mainVkCode;
			}
			await cdp.send('Input.dispatchKeyEvent', mainDownParams);

			const mainUpParams: any = {
				type: 'keyUp',
				key: mainKey,
				code: mainCode,
				modifiers: modifierValue,
			};
			if (mainVkCode !== null) {
				mainUpParams.windowsVirtualKeyCode = mainVkCode;
			}
			await cdp.send('Input.dispatchKeyEvent', mainUpParams);

			// Release modifier keys in reverse order
			for (const mod of modifiers.slice().reverse()) {
				const [code, vkCode] = getKeyInfo(mod);
				const releaseParams: any = { type: 'keyUp', key: mod, code };
				if (vkCode !== null) {
					releaseParams.windowsVirtualKeyCode = vkCode;
				}
				await cdp.send('Input.dispatchKeyEvent', releaseParams);
			}
		} else {
			// Simple key press
			const [code, vkCode] = getKeyInfo(key);

			const keyDownParams: any = { type: 'keyDown', key, code };
			if (vkCode !== null) {
				keyDownParams.windowsVirtualKeyCode = vkCode;
			}
			await cdp.send('Input.dispatchKeyEvent', keyDownParams);

			const keyUpParams: any = { type: 'keyUp', key, code };
			if (vkCode !== null) {
				keyUpParams.windowsVirtualKeyCode = vkCode;
			}
			await cdp.send('Input.dispatchKeyEvent', keyUpParams);
		}
	}

	/**
	 * Set the viewport size
	 */
	async setViewportSize(width: number, height: number): Promise<void> {
		const cdp = await this.getCDPSession();
		await cdp.send('Emulation.setDeviceMetricsOverride', {
			width,
			height,
			deviceScaleFactor: 1.0,
			mobile: false,
		});
	}

	/**
	 * Get the current URL
	 */
	async getUrl(): Promise<string> {
		return this.page.url();
	}

	/**
	 * Get the current title
	 */
	async getTitle(): Promise<string> {
		return this.page.title();
	}

	/**
	 * Navigate to a URL
	 */
	async goto(url: string): Promise<void> {
		const cdp = await this.getCDPSession();
		await cdp.send('Page.navigate', { url });
	}

	/**
	 * Alias for goto
	 */
	async navigate(url: string): Promise<void> {
		await this.goto(url);
	}

	/**
	 * Navigate back in history
	 */
	async goBack(): Promise<void> {
		const cdp = await this.getCDPSession();

		try {
			const history = await cdp.send('Page.getNavigationHistory');
			const currentIndex = (history as any).currentIndex;
			const entries = (history as any).entries;

			if (currentIndex <= 0) {
				throw new Error('Cannot go back - no previous entry in history');
			}

			const previousEntryId = entries[currentIndex - 1].id;
			await cdp.send('Page.navigateToHistoryEntry', { entryId: previousEntryId });
		} catch (e: any) {
			throw new Error(`Failed to navigate back: ${e.message}`);
		}
	}

	/**
	 * Navigate forward in history
	 */
	async goForward(): Promise<void> {
		const cdp = await this.getCDPSession();

		try {
			const history = await cdp.send('Page.getNavigationHistory');
			const currentIndex = (history as any).currentIndex;
			const entries = (history as any).entries;

			if (currentIndex >= entries.length - 1) {
				throw new Error('Cannot go forward - no next entry in history');
			}

			const nextEntryId = entries[currentIndex + 1].id;
			await cdp.send('Page.navigateToHistoryEntry', { entryId: nextEntryId });
		} catch (e: any) {
			throw new Error(`Failed to navigate forward: ${e.message}`);
		}
	}

	/**
	 * Get elements by CSS selector
	 */
	async getElementsByCssSelector(selector: string): Promise<Element[]> {
		const cdp = await this.getCDPSession();

		// Get document first
		const docResult = await cdp.send('DOM.getDocument');
		const documentNodeId = (docResult as any).root.nodeId;

		// Query selector all
		const result = await cdp.send('DOM.querySelectorAll', {
			nodeId: documentNodeId,
			selector,
		});

		const elements: Element[] = [];

		// Convert node IDs to backend node IDs
		for (const nodeId of (result as any).nodeIds || []) {
			const describeResult = await cdp.send('DOM.describeNode', { nodeId });
			const backendNodeId = (describeResult as any).node.backendNodeId;
			elements.push(new Element(this.page, backendNodeId, this.sessionId));
		}

		return elements;
	}

	/**
	 * Scroll the page
	 */
	async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number = 500): Promise<void> {
		const mouse = await this.getMouse();

		let deltaX = 0;
		let deltaY = 0;

		switch (direction) {
			case 'up':
				deltaY = -amount;
				break;
			case 'down':
				deltaY = amount;
				break;
			case 'left':
				deltaX = -amount;
				break;
			case 'right':
				deltaX = amount;
				break;
		}

		await mouse.scroll(undefined, undefined, deltaX, deltaY);
	}

	/**
	 * Wait for a specified number of milliseconds
	 */
	async wait(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Get viewport info
	 */
	async getViewportInfo(): Promise<{
		width: number;
		height: number;
		scrollX: number;
		scrollY: number;
		devicePixelRatio: number;
	}> {
		const cdp = await this.getCDPSession();

		try {
			const metrics = await cdp.send('Page.getLayoutMetrics');

			// IMPORTANT: Use CSS viewport instead of device pixel viewport (matches Python)
			const visualViewport = (metrics as any).visualViewport || {};
			const cssVisualViewport = (metrics as any).cssVisualViewport || {};
			const cssLayoutViewport = (metrics as any).cssLayoutViewport || (metrics as any).layoutViewport || {};

			// Use CSS pixels (what JavaScript sees) instead of device pixels
			const width = cssVisualViewport.clientWidth || cssLayoutViewport.clientWidth || 1920;
			const height = cssVisualViewport.clientHeight || cssLayoutViewport.clientHeight || 1080;

			// Calculate device pixel ratio correctly (matches Python)
			// DPR = visualViewport.clientWidth (device pixels) / cssVisualViewport.clientWidth (CSS pixels)
			const deviceWidth = visualViewport.clientWidth || width;
			const cssWidth = cssVisualViewport.clientWidth || width;
			const devicePixelRatio = cssWidth > 0 ? deviceWidth / cssWidth : 1;

			return {
				width,
				height,
				scrollX: cssVisualViewport.pageX || 0,
				scrollY: cssVisualViewport.pageY || 0,
				devicePixelRatio,
			};
		} catch {
			const viewport = this.page.viewportSize();
			return {
				width: viewport?.width || 1920,
				height: viewport?.height || 1080,
				scrollX: 0,
				scrollY: 0,
				devicePixelRatio: 1,
			};
		}
	}

	/**
	 * Close the CDP session
	 */
	async close(): Promise<void> {
		if (this.cdpSession) {
			await this.cdpSession.detach();
			this.cdpSession = null;
		}
	}

	/**
	 * Get target info for this page
	 */
	async getTargetInfo(): Promise<any> {
		const cdp = await this.getCDPSession();
		const result = await cdp.send('Target.getTargetInfo');
		return (result as any).targetInfo;
	}

	/**
	 * Get an element by a natural language prompt using LLM.
	 *
	 * @param prompt - Description of the element to find
	 * @param llm - Language model to use for finding the element
	 * @returns The element if found, null otherwise
	 */
	async getElementByPrompt(prompt: string, llm?: any): Promise<Element | null> {
		if (!llm) {
			throw new Error('LLM not provided');
		}

		// Get the DOM tree
		const domContent = await this.page.evaluate(() => {
			const elements: Array<{ index: number; tag: string; text: string; attributes: Record<string, string> }> = [];
			let indexCounter = 0;

			function isInteractive(el: HTMLElement): boolean {
				const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS'];
				if (interactiveTags.includes(el.tagName)) return true;
				if (el.getAttribute('role') && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch'].includes(el.getAttribute('role')!)) return true;
				if (el.getAttribute('onclick') || el.getAttribute('tabindex')) return true;
				if (el.getAttribute('contenteditable') === 'true') return true;
				return false;
			}

			function isVisible(el: HTMLElement): boolean {
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return false;
				const style = window.getComputedStyle(el);
				if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
				return true;
			}

			function extractElements(el: HTMLElement, depth: number = 0) {
				if (depth > 30) return;

				if (isInteractive(el) && isVisible(el)) {
					const attrs: Record<string, string> = {};
					for (const attr of ['id', 'class', 'name', 'type', 'role', 'aria-label', 'placeholder', 'href', 'value']) {
						const val = el.getAttribute(attr);
						if (val) attrs[attr] = val;
					}

					let text = '';
					if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
						text = (el as HTMLInputElement).value || (el as HTMLInputElement).placeholder || '';
					} else {
						text = el.innerText?.trim().substring(0, 100) || '';
					}

					elements.push({
						index: indexCounter++,
						tag: el.tagName.toLowerCase(),
						text,
						attributes: attrs,
					});
				}

				for (const child of Array.from(el.children)) {
					extractElements(child as HTMLElement, depth + 1);
				}
			}

			extractElements(document.body);
			return elements;
		});

		// Format elements for LLM
		let llmRepresentation = '';
		for (const el of domContent) {
			let attrStr = '';
			if (Object.keys(el.attributes).length > 0) {
				attrStr = ' ' + Object.entries(el.attributes).map(([k, v]) => `${k}="${v}"`).join(' ');
			}
			llmRepresentation += `[${el.index}]<${el.tag}${attrStr}>${el.text}</${el.tag}>\n`;
		}

		const systemMessage = {
			role: 'system',
			content: `You are an AI created to find an element on a page by a prompt.

<browser_state>
Interactive Elements: All interactive elements will be provided in format as [index]<type>text</type> where
- index: Numeric identifier for interaction
- type: HTML element type (button, input, etc.)
- text: Element description

Examples:
[33]<div>User form</div>
[35]<button aria-label='Submit form'>Submit</button>

Note that:
- Only elements with numeric indexes in [] are interactive
</browser_state>

Your task is to find an element index (if any) that matches the prompt (written in <prompt> tag).

If none of the elements matches, return null for element_highlight_index.

Respond with JSON in the format: {"element_highlight_index": <number or null>}`
		};

		const userMessage = {
			role: 'user',
			content: `<browser_state>
${llmRepresentation}
</browser_state>

<prompt>
${prompt}
</prompt>`
		};

		try {
			const response = await llm.ainvoke([systemMessage, userMessage]);
			const content = response.completion || response.content || response;

			let elementIndex: number | null = null;

			// Try to parse the response
			if (typeof content === 'object' && content.element_highlight_index !== undefined) {
				elementIndex = content.element_highlight_index;
			} else if (typeof content === 'string') {
				// Try to extract JSON from string
				const jsonMatch = content.match(/\{[^}]*"element_highlight_index"\s*:\s*(\d+|null)[^}]*\}/);
				if (jsonMatch) {
					const parsed = JSON.parse(jsonMatch[0]);
					elementIndex = parsed.element_highlight_index;
				}
			}

			if (elementIndex === null || elementIndex === undefined) {
				return null;
			}

			// Find the element by index
			const matchingElement = domContent.find(el => el.index === elementIndex);
			if (!matchingElement) {
				return null;
			}

			// Get the backend node ID for the element at this index
			const backendNodeId = await this.page.evaluate((idx) => {
				let counter = 0;

				function isInteractive(el: HTMLElement): boolean {
					const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS'];
					if (interactiveTags.includes(el.tagName)) return true;
					if (el.getAttribute('role') && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch'].includes(el.getAttribute('role')!)) return true;
					if (el.getAttribute('onclick') || el.getAttribute('tabindex')) return true;
					if (el.getAttribute('contenteditable') === 'true') return true;
					return false;
				}

				function isVisible(el: HTMLElement): boolean {
					const rect = el.getBoundingClientRect();
					if (rect.width === 0 || rect.height === 0) return false;
					const style = window.getComputedStyle(el);
					if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
					return true;
				}

				function findElement(el: HTMLElement, depth: number = 0): HTMLElement | null {
					if (depth > 30) return null;

					if (isInteractive(el) && isVisible(el)) {
						if (counter === idx) {
							return el;
						}
						counter++;
					}

					for (const child of Array.from(el.children)) {
						const found = findElement(child as HTMLElement, depth + 1);
						if (found) return found;
					}
					return null;
				}

				const el = findElement(document.body);
				if (!el) return null;

				// Get backend node ID using CDP internals
				return (el as any).__backendNodeId || null;
			}, elementIndex);

			if (!backendNodeId) {
				// Fallback: use CSS selector to find the element
				return null;
			}

			return new Element(this.page, backendNodeId, this.sessionId);
		} catch (error) {
			console.debug('Error in getElementByPrompt:', error);
			return null;
		}
	}

	/**
	 * Get an element by prompt, throwing an error if not found.
	 *
	 * @param prompt - Description of the element to find
	 * @param llm - Language model to use for finding the element
	 * @returns The element
	 * @throws Error if element is not found
	 */
	async mustGetElementByPrompt(prompt: string, llm?: any): Promise<Element> {
		const element = await this.getElementByPrompt(prompt, llm);
		if (element === null) {
			throw new Error(`No element found for prompt: ${prompt}`);
		}
		return element;
	}

	/**
	 * Extract structured content from the current page using LLM.
	 *
	 * @param prompt - Description of what content to extract
	 * @param outputSchema - Zod schema or class defining the expected output structure
	 * @param llm - Language model to use for extraction
	 * @returns The structured output
	 */
	async extractContent<T>(prompt: string, outputSchema: any, llm?: any): Promise<T> {
		if (!llm) {
			throw new Error('LLM not provided');
		}

		// Extract clean markdown from the page
		const { content } = await this.extractCleanMarkdown();

		const systemPrompt = `
You are an expert at extracting structured data from the markdown of a webpage.

<input>
You will be given a query and the markdown of a webpage that has been filtered to remove noise and advertising content.
</input>

<instructions>
- You are tasked to extract information from the webpage that is relevant to the query.
- You should ONLY use the information available in the webpage to answer the query. Do not make up information or provide guess from your own knowledge.
- If the information relevant to the query is not available in the page, your response should mention that.
- If the query asks for all items, products, etc., make sure to directly list all of them.
- Return the extracted content in the exact structured format specified.
</instructions>

<output>
- Your output should present ALL the information relevant to the query in the specified structured format.
- Do not answer in conversational format - directly output the relevant information in the structured format.
</output>`.trim();

		const promptContent = `<query>\n${prompt}\n</query>\n\n<webpage_content>\n${content}\n</webpage_content>`;

		try {
			const response = await llm.ainvoke(
				[
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: promptContent },
				],
				outputSchema
			);

			return response.completion as T;
		} catch (error: any) {
			throw new Error(`Failed to extract content: ${error.message}`);
		}
	}

	/**
	 * Extract clean markdown from the current page.
	 *
	 * @param extractLinks - Whether to include links in the output
	 * @returns Object with content and stats
	 */
	async extractCleanMarkdown(extractLinks: boolean = false): Promise<{ content: string; stats: Record<string, any> }> {
		const result = await this.page.evaluate((includeLinks) => {
			// Simple markdown extraction from page content
			function getTextContent(el: HTMLElement, depth: number = 0): string {
				if (depth > 20) return '';

				const tagName = el.tagName?.toLowerCase();

				// Skip script, style, hidden elements
				if (['script', 'style', 'noscript', 'svg', 'path'].includes(tagName)) {
					return '';
				}

				const style = window.getComputedStyle(el);
				if (style.display === 'none' || style.visibility === 'hidden') {
					return '';
				}

				let text = '';

				// Handle headings
				if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
					const level = parseInt(tagName[1]);
					const prefix = '#'.repeat(level) + ' ';
					text += '\n' + prefix + el.innerText.trim() + '\n';
					return text;
				}

				// Handle paragraphs
				if (tagName === 'p') {
					text += '\n' + el.innerText.trim() + '\n';
					return text;
				}

				// Handle links
				if (tagName === 'a' && includeLinks) {
					const href = el.getAttribute('href');
					const linkText = el.innerText.trim();
					if (href && linkText) {
						return `[${linkText}](${href})`;
					}
				}

				// Handle list items
				if (tagName === 'li') {
					text += '- ' + el.innerText.trim() + '\n';
					return text;
				}

				// Recurse into children
				for (const child of Array.from(el.children)) {
					text += getTextContent(child as HTMLElement, depth + 1);
				}

				// If no children processed, get text content directly
				if (text === '' && el.innerText) {
					text = el.innerText.trim();
				}

				return text;
			}

			const content = getTextContent(document.body);

			// Clean up the content
			const cleanedContent = content
				.replace(/\n{3,}/g, '\n\n')  // Remove excessive newlines
				.replace(/[ \t]+/g, ' ')      // Normalize spaces
				.trim();

			return {
				content: cleanedContent,
				stats: {
					length: cleanedContent.length,
					lineCount: cleanedContent.split('\n').length,
				},
			};
		}, extractLinks);

		return result;
	}
}

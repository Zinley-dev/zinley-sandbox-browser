/**
 * Mouse operations for browser automation
 * Port from browser_use/actor/mouse.py
 */
import { CDPSession, Page } from 'patchright';
import { MouseButton } from './utils.js';

/**
 * Resolve the (x, y) point a scroll event should be dispatched at.
 *
 * An explicit 0 must be honored as "left/top edge", not treated as "unset".
 * Only a genuinely missing (undefined/null) coordinate falls back to the
 * viewport center. Port of `_resolve_scroll_anchor` in browser_use/actor/mouse.py.
 */
export function resolveScrollAnchor(
	x: number | null | undefined,
	y: number | null | undefined,
	viewportWidth: number,
	viewportHeight: number
): [number, number] {
	const scrollX = x != null ? x : viewportWidth / 2;
	const scrollY = y != null ? y : viewportHeight / 2;
	return [scrollX, scrollY];
}

/**
 * Mouse operations for a target using CDP
 */
export class Mouse {
	private cdpSession: CDPSession | null = null;
	private currentX: number = 0;
	private currentY: number = 0;

	constructor(
		private page: Page,
		private sessionId?: string,
		private targetId?: string
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
	 * Click at the specified coordinates
	 */
	async click(x: number, y: number, button: MouseButton = 'left', clickCount: number = 1): Promise<void> {
		const cdp = await this.getCDPSession();

		// Move to position first
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved',
			x,
			y,
		});
		this.currentX = x;
		this.currentY = y;

		// Mouse press
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			x,
			y,
			button,
			clickCount,
		});

		// Small delay between press and release
		await this.sleep(50);

		// Mouse release
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			x,
			y,
			button,
			clickCount,
		});
	}

	/**
	 * Double click at the specified coordinates
	 */
	async dblclick(x: number, y: number, button: MouseButton = 'left'): Promise<void> {
		await this.click(x, y, button, 2);
	}

	/**
	 * Press mouse button down
	 */
	async down(button: MouseButton = 'left', clickCount: number = 1): Promise<void> {
		const cdp = await this.getCDPSession();

		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			x: this.currentX,
			y: this.currentY,
			button,
			clickCount,
		});
	}

	/**
	 * Release mouse button
	 */
	async up(button: MouseButton = 'left', clickCount: number = 1): Promise<void> {
		const cdp = await this.getCDPSession();

		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			x: this.currentX,
			y: this.currentY,
			button,
			clickCount,
		});
	}

	/**
	 * Move mouse to the specified coordinates
	 */
	async move(x: number, y: number, steps: number = 1): Promise<void> {
		const cdp = await this.getCDPSession();

		if (steps <= 1) {
			// Direct movement
			await cdp.send('Input.dispatchMouseEvent', {
				type: 'mouseMoved',
				x,
				y,
			});
			this.currentX = x;
			this.currentY = y;
		} else {
			// Smooth movement with interpolation
			const startX = this.currentX;
			const startY = this.currentY;

			for (let i = 1; i <= steps; i++) {
				const progress = i / steps;
				const currentX = startX + (x - startX) * progress;
				const currentY = startY + (y - startY) * progress;

				await cdp.send('Input.dispatchMouseEvent', {
					type: 'mouseMoved',
					x: currentX,
					y: currentY,
				});

				// Small delay between steps for smooth animation
				if (i < steps) {
					await this.sleep(10);
				}
			}

			this.currentX = x;
			this.currentY = y;
		}
	}

	/**
	 * Scroll the page using robust CDP methods.
	 *
	 * `x`/`y` are the point the scroll event is dispatched at. An explicit 0 is
	 * honored as the left/top edge; only a missing (undefined/null) coordinate
	 * falls back to the viewport center (upstream `_resolve_scroll_anchor`).
	 */
	async scroll(x?: number | null, y?: number | null, deltaX?: number, deltaY?: number): Promise<void> {
		const cdp = await this.getCDPSession();

		const scrollDeltaX = deltaX ?? 0;
		const scrollDeltaY = deltaY ?? 0;

		// Viewport dimensions, used only to resolve coordinates the caller left unset
		let viewportWidth = 0;
		let viewportHeight = 0;
		if (x == null || y == null) {
			try {
				const layoutMetrics = await cdp.send('Page.getLayoutMetrics');
				const viewport = (layoutMetrics as any).layoutViewport || {};
				viewportWidth = viewport.clientWidth || 0;
				viewportHeight = viewport.clientHeight || 0;
			} catch {
				viewportWidth = 0;
				viewportHeight = 0;
			}
		}

		const [scrollX, scrollY] = resolveScrollAnchor(x, y, viewportWidth, viewportHeight);

		// Method 1: Try mouse wheel event (most reliable)
		try {
			await cdp.send('Input.dispatchMouseEvent', {
				type: 'mouseWheel',
				x: scrollX,
				y: scrollY,
				deltaX: scrollDeltaX,
				deltaY: scrollDeltaY,
			});
			return;
		} catch {
			// Fall through to next method
		}

		// Method 2: Try synthesizeScrollGesture
		try {
			await cdp.send('Input.synthesizeScrollGesture', {
				x: scrollX,
				y: scrollY,
				xDistance: -scrollDeltaX,
				yDistance: -scrollDeltaY,
			});
			return;
		} catch {
			// Fall through to next method
		}

		// Method 3: JavaScript fallback
		try {
			await cdp.send('Runtime.evaluate', {
				expression: `window.scrollBy(${scrollDeltaX}, ${scrollDeltaY})`,
				returnByValue: true,
			});
		} catch (e: any) {
			throw new Error(`Failed to scroll: ${e.message}`);
		}
	}

	/**
	 * Scroll up
	 */
	async scrollUp(amount: number = 500): Promise<void> {
		await this.scroll(undefined, undefined, 0, -amount);
	}

	/**
	 * Scroll down
	 */
	async scrollDown(amount: number = 500): Promise<void> {
		await this.scroll(undefined, undefined, 0, amount);
	}

	/**
	 * Scroll left
	 */
	async scrollLeft(amount: number = 500): Promise<void> {
		await this.scroll(undefined, undefined, -amount, 0);
	}

	/**
	 * Scroll right
	 */
	async scrollRight(amount: number = 500): Promise<void> {
		await this.scroll(undefined, undefined, amount, 0);
	}

	/**
	 * Drag from one position to another
	 */
	async drag(
		startX: number,
		startY: number,
		endX: number,
		endY: number,
		steps: number = 10
	): Promise<void> {
		// Move to start position
		await this.move(startX, startY);

		// Press mouse button
		await this.down();

		// Move to end position smoothly
		await this.move(endX, endY, steps);

		// Release mouse button
		await this.up();
	}

	/**
	 * Get current mouse position
	 */
	getPosition(): { x: number; y: number } {
		return { x: this.currentX, y: this.currentY };
	}

	/**
	 * Helper to sleep
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

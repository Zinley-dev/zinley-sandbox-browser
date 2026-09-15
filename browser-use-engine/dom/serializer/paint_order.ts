/**
 * Paint order filtering utilities
 * Port from browser_use/dom/serializer/paint_order.py - EXACT MATCH
 *
 * Helper class for maintaining a union of rectangles (used for order of elements calculation)
 */

import type { SimplifiedNode } from '../views.js';

/**
 * Closed axis-aligned rectangle with (x1,y1) bottom-left, (x2,y2) top-right.
 * Matches Python's Rect dataclass exactly.
 */
interface Rect {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

/**
 * Create a Rect from coordinates
 */
function createRect(x1: number, y1: number, x2: number, y2: number): Rect {
	return { x1, y1, x2, y2 };
}

/**
 * Calculate area of a rectangle
 */
function rectArea(r: Rect): number {
	return (r.x2 - r.x1) * (r.y2 - r.y1);
}

/**
 * Check if two rectangles intersect
 */
function rectsIntersect(a: Rect, b: Rect): boolean {
	return !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);
}

/**
 * Check if rectangle a contains rectangle b
 */
function rectContains(a: Rect, b: Rect): boolean {
	return a.x1 <= b.x1 && a.y1 <= b.y1 && a.x2 >= b.x2 && a.y2 >= b.y2;
}

/**
 * Maintains a *disjoint* set of rectangles.
 * No external dependencies - fine for a few thousand rectangles.
 * Matches Python's RectUnionPure exactly.
 */
class RectUnionPure {
	/**
	 * Safety cap: with complex overlapping layers, each add() can fragment existing rects into up
	 * to 4 pieces each. On heavy pages (20k+ elements) this can cause exponential growth. 5000 is
	 * generous for normal pages but prevents runaway memory/CPU. Once hit, contains() keeps
	 * working but add() stops accepting rects (nothing new is hidden).
	 */
	static MAX_RECTS = 5000;

	private _rects: Rect[] = [];

	get size(): number {
		return this._rects.length;
	}

	/**
	 * Return list of up to 4 rectangles = a \ b.
	 * Assumes a intersects b.
	 */
	private _splitDiff(a: Rect, b: Rect): Rect[] {
		const parts: Rect[] = [];

		// Bottom slice
		if (a.y1 < b.y1) {
			parts.push(createRect(a.x1, a.y1, a.x2, b.y1));
		}
		// Top slice
		if (b.y2 < a.y2) {
			parts.push(createRect(a.x1, b.y2, a.x2, a.y2));
		}

		// Middle (vertical) strip: y overlap is [max(a.y1,b.y1), min(a.y2,b.y2)]
		const yLo = Math.max(a.y1, b.y1);
		const yHi = Math.min(a.y2, b.y2);

		// Left slice
		if (a.x1 < b.x1) {
			parts.push(createRect(a.x1, yLo, b.x1, yHi));
		}
		// Right slice
		if (b.x2 < a.x2) {
			parts.push(createRect(b.x2, yLo, a.x2, yHi));
		}

		return parts;
	}

	/**
	 * True iff r is fully covered by the current union.
	 */
	contains(r: Rect): boolean {
		if (this._rects.length === 0) {
			return false;
		}

		let stack = [r];
		for (const s of this._rects) {
			const newStack: Rect[] = [];
			for (const piece of stack) {
				if (rectContains(s, piece)) {
					// piece completely gone
					continue;
				}
				if (rectsIntersect(piece, s)) {
					newStack.push(...this._splitDiff(piece, s));
				} else {
					newStack.push(piece);
				}
			}
			if (newStack.length === 0) {
				// everything eaten – covered
				return true;
			}
			stack = newStack;
		}
		return false; // something survived
	}

	/**
	 * Insert r unless it is already covered.
	 * Returns True if the union grew.
	 */
	add(r: Rect): boolean {
		// Safety cap: stop accepting new rects to prevent exponential explosion
		if (this._rects.length >= RectUnionPure.MAX_RECTS) {
			return false;
		}

		if (this.contains(r)) {
			return false;
		}

		let pending = [r];
		let i = 0;
		while (i < this._rects.length) {
			const s = this._rects[i];
			const newPending: Rect[] = [];
			let changed = false;
			for (const piece of pending) {
				if (rectsIntersect(piece, s)) {
					newPending.push(...this._splitDiff(piece, s));
					changed = true;
				} else {
					newPending.push(piece);
				}
			}
			pending = newPending;
			// s unchanged; proceed with next existing rectangle
			i++;
		}

		// Any left-over pieces are new, non-overlapping areas
		this._rects.push(...pending);
		return true;
	}
}

/**
 * Calculates which elements should be removed based on the paint order parameter.
 * Matches Python's PaintOrderRemover exactly.
 */
export class PaintOrderRemover {
	constructor(private root: SimplifiedNode) {}

	/**
	 * Identify the CDP session and iframe document owning a node's snapshot. Paint orders are only
	 * comparable within one document, so rect unions are kept per (session, iframe) context.
	 */
	static documentContext(node: SimplifiedNode): string {
		const originalNode = node.originalNode;
		let parent = originalNode.parentNode;
		while (parent) {
			const tag = parent.nodeName?.toLowerCase();
			if (tag === 'iframe' || tag === 'frame') {
				return `${originalNode.sessionId ?? ''}|${parent.frameId ?? ''}`;
			}
			parent = parent.parentNode;
		}
		return `${originalNode.sessionId ?? ''}|`;
	}

	/**
	 * Calculate paint order and mark covered elements with ignoredByPaintOrder flag.
	 */
	calculatePaintOrder(): void {
		const allSimplifiedNodesWithPaintOrder: SimplifiedNode[] = [];

		// Collect all nodes with paint order and bounds
		const collectPaintOrder = (node: SimplifiedNode): void => {
			if (
				node.originalNode.snapshotNode &&
				node.originalNode.snapshotNode.paintOrder !== undefined &&
				node.originalNode.snapshotNode.paintOrder !== null &&
				node.originalNode.snapshotNode.bounds
			) {
				allSimplifiedNodesWithPaintOrder.push(node);
			}

			for (const child of node.children) {
				collectPaintOrder(child);
			}
		};

		collectPaintOrder(this.root);

		// Group nodes by paint order
		const groupedByPaintOrder = new Map<number, SimplifiedNode[]>();

		for (const node of allSimplifiedNodesWithPaintOrder) {
			if (
				node.originalNode.snapshotNode &&
				node.originalNode.snapshotNode.paintOrder !== undefined &&
				node.originalNode.snapshotNode.paintOrder !== null
			) {
				const paintOrder = node.originalNode.snapshotNode.paintOrder;
				if (!groupedByPaintOrder.has(paintOrder)) {
					groupedByPaintOrder.set(paintOrder, []);
				}
				groupedByPaintOrder.get(paintOrder)!.push(node);
			}
		}

		// One union per (session, iframe document): paint orders of different documents are unrelated
		const rectUnions = new Map<string, RectUnionPure>();
		const unionFor = (context: string): RectUnionPure => {
			let union = rectUnions.get(context);
			if (!union) {
				union = new RectUnionPure();
				rectUnions.set(context, union);
			}
			return union;
		};

		// Process paint orders in descending order (highest first)
		const sortedPaintOrders = Array.from(groupedByPaintOrder.keys()).sort((a, b) => b - a);

		for (const paintOrder of sortedPaintOrders) {
			const nodes = groupedByPaintOrder.get(paintOrder)!;
			const rectsToAdd: [string, Rect][] = [];

			for (const node of nodes) {
				if (!node.originalNode.snapshotNode?.bounds) {
					continue; // shouldn't happen by how we filter them out in the first place
				}

				const bounds = node.originalNode.snapshotNode.bounds;
				const rect = createRect(
					bounds.x,
					bounds.y,
					bounds.x + bounds.width,
					bounds.y + bounds.height
				);
				const context = PaintOrderRemover.documentContext(node);

				if (unionFor(context).contains(rect)) {
					node.ignoredByPaintOrder = true;
				}

				// Don't add to the union if opacity is less than 0.8 or background-color is transparent
				const computedStyles = node.originalNode.snapshotNode.computedStyles;
				if (computedStyles) {
					const bgColor = computedStyles['background-color'] || 'rgba(0, 0, 0, 0)';
					const opacity = parseFloat(computedStyles['opacity'] || '1');

					if (bgColor === 'rgba(0, 0, 0, 0)') {
						continue;
					}

					if (opacity < 0.8) {
						// this is highly vibes based number (matches Python)
						continue;
					}
				} else {
					// No computed styles, assume transparent
					continue;
				}

				rectsToAdd.push([context, rect]);
			}

			for (const [context, rect] of rectsToAdd) {
				unionFor(context).add(rect);
			}
		}
	}
}

/**
 * Apply paint order filtering to a tree.
 * Creates a PaintOrderRemover and runs calculatePaintOrder.
 *
 * @param root Root node of the tree
 * @returns The same tree with ignoredByPaintOrder flags set
 */
export function applyPaintOrderFiltering(root: SimplifiedNode | null): SimplifiedNode | null {
	if (!root) return null;

	const remover = new PaintOrderRemover(root);
	remover.calculatePaintOrder();

	return root;
}

// Legacy exports for backwards compatibility
export { RectUnionPure };

/**
 * Anthropic prompt caching strategy — `system_and_3` layout.
 *
 * TypeScript port of `agent/prompt_caching.py` from the Hermes Agent
 * (Nous Research). Places up to 4 `cache_control` breakpoints — the system
 * prompt plus the last 3 non-system messages — so Anthropic bills repeated
 * prefixes at 0.1× the input-token rate (a ~75% input-cost reduction on
 * multi-turn sessions within a single session window).
 *
 * Pure functions — no class state, no client dependency. Mirrors the wire
 * shape locally because the installed `@anthropic-ai/sdk` (0.32.1) does not
 * yet type `cache_control`; the field is still accepted by `/v1/messages`.
 *
 * See: docs/reports/ai-harness-cache-compact-deepdive.html#prompt-caching
 */

import type Anthropic from '@anthropic-ai/sdk';

/**
 * Cache lifetime. `'5m'` is the default ephemeral TTL accepted on the standard
 * endpoint. `'1h'` requires the `extended-cache-ttl-2025-04-11` beta header and
 * a newer SDK, so it is only emitted when explicitly requested.
 */
export type CacheTtl = '5m' | '1h';

/** Ephemeral `cache_control` marker as accepted on the wire. */
export interface CacheControlEphemeral {
	type: 'ephemeral';
	ttl?: '1h';
}

/** A text block carrying an optional cache marker (SDK type lacks the field). */
export interface CacheableTextBlock {
	type: 'text';
	text: string;
	cache_control?: CacheControlEphemeral;
}

export interface CacheControlResult {
	/** System prompt normalized to blocks with a trailing cache marker, or undefined. */
	system?: CacheableTextBlock[];
	/** Deep-cloned messages with up to 3 trailing cache markers attached. */
	messages: Anthropic.MessageParam[];
}

/**
 * Breakpoint placement strategy.
 *
 * - `'system_and_3'`: 1 BP on system + last 3 messages (multi-turn chat default).
 * - `'system_only'`: 1 BP on system; messages are not marked. Use when the
 *   request shape is effectively `[system, state]` and the state message is
 *   rebuilt every iteration — the 3 message BPs would just churn cache
 *   creation on a non-stable suffix without ever reading back.
 */
export type CacheStrategy = 'system_and_3' | 'system_only';

/** Anthropic allows at most 4 `cache_control` breakpoints per request. */
const MAX_BREAKPOINTS = 4;

function _buildMarker(ttl: CacheTtl): CacheControlEphemeral {
	const marker: CacheControlEphemeral = { type: 'ephemeral' };
	if (ttl === '1h') {
		marker.ttl = '1h';
	}
	return marker;
}

/** Normalize the system prompt to blocks and mark the last block as cacheable. */
function _markSystem(
	system: string | CacheableTextBlock[],
	marker: CacheControlEphemeral
): CacheableTextBlock[] {
	if (typeof system === 'string') {
		return [{ type: 'text', text: system, cache_control: marker }];
	}
	if (system.length === 0) {
		return system;
	}
	const blocks = system.map((b) => ({ ...b }));
	blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: marker };
	return blocks;
}

/**
 * Attach a cache marker to the last content block of one (already-cloned)
 * message. A plain-string body is wrapped into a single text block so the
 * marker has somewhere to live. Returns true when a breakpoint was placed.
 */
function _markMessage(message: Anthropic.MessageParam, marker: CacheControlEphemeral): boolean {
	// SDK types omit cache_control; treat content structurally.
	const content = message.content as unknown;

	if (typeof content === 'string') {
		if (content.length === 0) {
			return false;
		}
		(message as { content: unknown }).content = [
			{ type: 'text', text: content, cache_control: marker },
		];
		return true;
	}

	if (Array.isArray(content) && content.length > 0) {
		const last = content[content.length - 1] as Record<string, unknown>;
		last.cache_control = marker;
		return true;
	}

	return false;
}

/**
 * Apply a `cache_control` strategy to an Anthropic request.
 *
 * Unlike the Python original — which operates on one message list that
 * includes a `system` role at index 0 — the Anthropic API separates the
 * `system` prompt from `messages`. So one breakpoint is spent on the system
 * prompt (when present) and, in `'system_and_3'`, the remaining breakpoints
 * walk backward from the newest message, marking those that have cacheable
 * content. In `'system_only'` no message BPs are placed.
 *
 * @param system  System prompt (string or block array), or undefined.
 * @param messages  The non-system messages sent in the request.
 * @param ttl  Cache TTL; defaults to `'5m'`.
 * @param strategy  Breakpoint placement strategy; defaults to `'system_and_3'`.
 * @returns Deep-cloned, marker-annotated `system` and `messages`. Inputs are
 *          left untouched.
 */
export function applyAnthropicCacheControl(
	system: string | CacheableTextBlock[] | undefined,
	messages: Anthropic.MessageParam[],
	ttl: CacheTtl = '5m',
	strategy: CacheStrategy = 'system_and_3'
): CacheControlResult {
	const marker = _buildMarker(ttl);
	const clonedMessages = structuredClone(messages) as Anthropic.MessageParam[];

	let breakpointsUsed = 0;
	let cachedSystem: CacheableTextBlock[] | undefined;

	const hasSystem =
		system !== undefined &&
		system !== '' &&
		(typeof system === 'string' || system.length > 0);
	if (hasSystem) {
		cachedSystem = _markSystem(system as string | CacheableTextBlock[], marker);
		breakpointsUsed += 1;
	}

	if (strategy === 'system_only') {
		return { system: cachedSystem, messages: clonedMessages };
	}

	const remaining = MAX_BREAKPOINTS - breakpointsUsed;
	let placed = 0;
	for (let i = clonedMessages.length - 1; i >= 0 && placed < remaining; i--) {
		if (_markMessage(clonedMessages[i], marker)) {
			placed += 1;
		}
	}

	return { system: cachedSystem, messages: clonedMessages };
}

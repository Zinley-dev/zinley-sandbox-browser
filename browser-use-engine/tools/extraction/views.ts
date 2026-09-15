/**
 * Models for the structured extraction subsystem.
 * Port of browser_use/tools/extraction/views.py (Python browser-use 0.13.10).
 */

import { z } from 'zod';

/** Metadata about a structured extraction, stored in ActionResult.metadata. */
export interface ExtractionResult {
	/** The validated extraction payload */
	data: Record<string, unknown>;
	/** The JSON Schema that was enforced */
	schemaUsed: Record<string, unknown>;
	/** True if content was truncated before extraction */
	isPartial: boolean;
	/** URL the content was extracted from */
	sourceUrl: string | null;
	/** Content processing statistics */
	contentStats: Record<string, unknown>;
}

export const ExtractionResultSchema = z
	.object({
		data: z.record(z.unknown()),
		schemaUsed: z.record(z.unknown()),
		isPartial: z.boolean().default(false),
		sourceUrl: z.string().nullable().default(null),
		contentStats: z.record(z.unknown()).default({}),
	})
	.strict();

export function createExtractionResult(init: {
	data: Record<string, unknown>;
	schemaUsed: Record<string, unknown>;
	isPartial?: boolean;
	sourceUrl?: string | null;
	contentStats?: Record<string, unknown>;
}): ExtractionResult {
	return {
		data: init.data,
		schemaUsed: init.schemaUsed,
		isPartial: init.isPartial ?? false,
		sourceUrl: init.sourceUrl ?? null,
		contentStats: init.contentStats ?? {},
	};
}

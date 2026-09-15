/**
 * Utilities for creating optimized Zod schemas for LLM usage
 * Port from browser_use/llm/schema.py (synced with 0.13.10)
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface SchemaOptimizerOptions {
	/** Remove minItems from the schema (for providers that reject it) */
	removeMinItems?: boolean;
	/** Remove default values from the schema (for providers that reject them) */
	removeDefaults?: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, any> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export class SchemaOptimizer {
	/**
	 * Create the most optimized schema by flattening all $ref/$defs while preserving
	 * FULL descriptions and ALL action definitions. Also ensures OpenAI strict mode compatibility.
	 */
	static createOptimizedJsonSchema(model: z.ZodType, options: SchemaOptimizerOptions = {}): Record<string, any> {
		const removeMinItems = options.removeMinItems ?? false;
		const removeDefaults = options.removeDefaults ?? false;

		// Generate original schema using zod-to-json-schema
		const originalSchema = zodToJsonSchema(model, {
			$refStrategy: 'none', // Don't use $ref, inline everything
		});

		// Extract $defs for reference resolution
		const defsLookup = (originalSchema as any).$defs || (originalSchema as any).definitions || {};

		const optimizeSchema = (obj: any, defs?: Record<string, any>, inProperties: boolean = false): any => {
			if (isPlainObject(obj)) {
				const optimized: Record<string, any> = {};
				let flattenedRef: Record<string, any> | null = null;

				// Skip unnecessary fields (including $schema for OpenAI strict mode)
				const skipFields = ['additionalProperties', '$defs', 'definitions', '$schema'];

				for (const [key, value] of Object.entries(obj)) {
					// Keys inside `properties` are user field names, not schema keywords.
					if (inProperties) {
						optimized[key] = optimizeSchema(value, defs);
						continue;
					}

					if (skipFields.includes(key)) {
						continue;
					}

					// Skip metadata "title"
					if (key === 'title') {
						continue;
					}

					// Preserve FULL descriptions without truncation, skip empty ones
					if (key === 'description') {
						if (value) {
							optimized[key] = value;
						}
					}
					// Handle type field - must recursively process in case value contains $ref
					else if (key === 'type') {
						optimized[key] = isPlainObject(value) || Array.isArray(value) ? optimizeSchema(value, defs) : value;
					}
					// FLATTEN: Resolve $ref by inlining the actual definition
					else if (key === '$ref' && defs) {
						const refPath = (value as string).split('/').pop();
						if (refPath && defs[refPath]) {
							const referencedDef = defs[refPath];
							flattenedRef = optimizeSchema(referencedDef, defs);
						}
					}
					// Skip minItems/min_items and default if requested (check BEFORE processing)
					else if ((key === 'minItems' || key === 'min_items') && removeMinItems) {
						continue;
					} else if (key === 'default' && removeDefaults) {
						continue;
					}
					// Keep all anyOf structures (action unions) and resolve any $refs within
					else if (key === 'anyOf' && Array.isArray(value)) {
						optimized[key] = value.map((item) => optimizeSchema(item, defs));
					}
					// Recursively optimize nested structures
					else if (key === 'properties' || key === 'items') {
						optimized[key] = optimizeSchema(value, defs, key === 'properties');
					}
					// Keep essential validation fields
					else if (
						['required', 'minimum', 'maximum', 'minItems', 'min_items', 'maxItems', 'pattern', 'default'].includes(key)
					) {
						optimized[key] = isPlainObject(value) || Array.isArray(value) ? optimizeSchema(value, defs) : value;
					}
					// Recursively process all other fields
					else {
						optimized[key] = isPlainObject(value) || Array.isArray(value) ? optimizeSchema(value, defs) : value;
					}
				}

				// If we have a flattened reference, merge it with the optimized properties
				if (flattenedRef !== null) {
					const result = { ...flattenedRef };
					for (const [key, value] of Object.entries(optimized)) {
						if (key === 'description' && !('description' in result)) {
							result[key] = value;
						} else if (key !== 'description') {
							result[key] = value;
						}
					}
					return result;
				}

				// CRITICAL: Add additionalProperties: false to ALL objects for OpenAI strict mode
				if (optimized.type === 'object') {
					optimized.additionalProperties = false;
				}
				return optimized;
			} else if (Array.isArray(obj)) {
				return obj.map((item) => optimizeSchema(item, defs, inProperties));
			}
			return obj;
		};

		// Create optimized schema with flattening
		const optimizedResult = optimizeSchema(originalSchema, defsLookup);

		if (!isPlainObject(optimizedResult)) {
			throw new Error('Optimized schema result is not a dictionary');
		}

		const optimizedSchema: Record<string, any> = optimizedResult;

		// Additional pass to ensure ALL objects have additionalProperties: false
		const ensureAdditionalPropertiesFalse = (obj: any): void => {
			if (isPlainObject(obj)) {
				// If it's an object type, ensure additionalProperties is false
				if (obj.type === 'object') {
					obj.additionalProperties = false;
				}

				// Recursively apply to all values
				for (const value of Object.values(obj)) {
					if (typeof value === 'object' && value !== null) {
						ensureAdditionalPropertiesFalse(value);
					}
				}
			} else if (Array.isArray(obj)) {
				for (const item of obj) {
					if (typeof item === 'object' && item !== null) {
						ensureAdditionalPropertiesFalse(item);
					}
				}
			}
		};

		ensureAdditionalPropertiesFalse(optimizedSchema);
		this.ensureArraysHaveItems(optimizedSchema);
		this.makeStrictCompatible(optimizedSchema);

		// Final pass to remove minItems/min_items and default values if requested
		if (removeMinItems || removeDefaults) {
			const removeForbiddenFields = (obj: any): void => {
				if (isPlainObject(obj)) {
					if (removeMinItems) {
						delete obj.minItems;
						delete obj.min_items;
					}
					if (removeDefaults) {
						delete obj.default;
					}
					for (const value of Object.values(obj)) {
						if (typeof value === 'object' && value !== null) {
							removeForbiddenFields(value);
						}
					}
				} else if (Array.isArray(obj)) {
					for (const item of obj) {
						if (typeof item === 'object' && item !== null) {
							removeForbiddenFields(item);
						}
					}
				}
			};

			removeForbiddenFields(optimizedSchema);
		}

		return optimizedSchema;
	}

	/**
	 * Ensure all arrays have an 'items' property (required for OpenAI strict mode)
	 */
	private static ensureArraysHaveItems(schema: any): void {
		if (Array.isArray(schema)) {
			for (const item of schema) {
				if (typeof item === 'object' && item !== null) {
					this.ensureArraysHaveItems(item);
				}
			}
			return;
		}
		if (!isPlainObject(schema)) {
			return;
		}

		// If it's an array type without items, add empty items schema
		if (schema.type === 'array' && !('items' in schema)) {
			schema.items = {};
		}

		// Recursively apply to all values
		for (const value of Object.values(schema)) {
			if (typeof value === 'object' && value !== null) {
				this.ensureArraysHaveItems(value);
			}
		}
	}

	/**
	 * Ensure all properties are required for OpenAI strict mode
	 */
	private static makeStrictCompatible(schema: any): void {
		if (Array.isArray(schema)) {
			for (const item of schema) {
				this.makeStrictCompatible(item);
			}
			return;
		}
		if (!isPlainObject(schema)) {
			return;
		}

		// First recursively apply to nested objects
		for (const [key, value] of Object.entries(schema)) {
			if (typeof value === 'object' && value !== null && key !== 'required') {
				this.makeStrictCompatible(value);
			}
		}

		// For objects with type: "object", ensure they have properties and required
		if (schema.type === 'object') {
			// If no properties exist, add empty properties object
			if (!('properties' in schema)) {
				schema.properties = {};
			}
			// Set required to all property keys (empty array if no properties)
			schema.required = Object.keys(schema.properties);
		}
	}

	/**
	 * Create Gemini-optimized schema, preserving explicit `required` arrays so Gemini
	 * respects mandatory fields defined by the caller.
	 */
	static createGeminiOptimizedSchema(model: z.ZodType): Record<string, any> {
		return this.createOptimizedJsonSchema(model);
	}
}

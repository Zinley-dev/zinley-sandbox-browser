/**
 * Converts a JSON Schema object into a runtime zod schema for structured extraction.
 * Port of browser_use/tools/extraction/schema_utils.py (Python browser-use 0.13.10).
 *
 * Only the plain subset of JSON Schema is supported: objects with `properties`,
 * arrays with `items`, primitives, `enum` (relaxed to string) and `nullable`.
 * Composition keywords ($ref, allOf, anyOf, oneOf, ...) throw.
 */

import { z } from 'zod';

type JsonSchema = Record<string, any>;

/** Keywords that indicate composition/reference patterns we don't support. */
export const UNSUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
	'$ref',
	'allOf',
	'anyOf',
	'oneOf',
	'not',
	'$defs',
	'definitions',
	'if',
	'then',
	'else',
	'dependentSchemas',
	'dependentRequired',
]);

const PRIMITIVE_DEFAULTS: Record<string, unknown> = {
	string: '',
	number: 0.0,
	integer: 0,
	boolean: false,
};

export class UnsupportedSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsupportedSchemaError';
	}
}

function checkUnsupported(schema: JsonSchema): void {
	for (const kw of UNSUPPORTED_SCHEMA_KEYWORDS) {
		if (kw in schema) {
			throw new UnsupportedSchemaError(`Unsupported JSON Schema keyword: ${kw}`);
		}
	}
}

function assertSchemaObject(schema: unknown, where: string): JsonSchema {
	if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
		throw new UnsupportedSchemaError(`${where} must be a JSON Schema object`);
	}
	return schema as JsonSchema;
}

function resolvePrimitive(jsonType: string): z.ZodTypeAny {
	switch (jsonType) {
		case 'string':
			return z.string();
		case 'number':
			return z.number();
		case 'integer':
			return z.number().int();
		case 'boolean':
			return z.boolean();
		case 'null':
			return z.null();
		default:
			return z.string();
	}
}

/** Recursively resolve a JSON Schema node to a zod type. */
function resolveType(schema: JsonSchema, name: string): z.ZodTypeAny {
	checkUnsupported(schema);

	const jsonType = typeof schema.type === 'string' ? schema.type : 'string';

	// Enums — constrain to string (a literal union would be stricter but LLMs are flaky)
	if ('enum' in schema) {
		return z.string();
	}

	// Object with properties → nested object model
	if (jsonType === 'object') {
		const properties = schema.properties;
		if (properties && typeof properties === 'object' && Object.keys(properties).length > 0) {
			return buildModel(schema, name);
		}
		return z.record(z.unknown());
	}

	// Array
	if (jsonType === 'array') {
		const itemsSchema = schema.items;
		if (itemsSchema && typeof itemsSchema === 'object') {
			return z.array(resolveType(assertSchemaObject(itemsSchema, `${name}.items`), `${name}_item`));
		}
		return z.array(z.unknown());
	}

	// Primitive
	const base = resolvePrimitive(jsonType);
	if (schema.nullable === true) {
		return base.nullable();
	}
	return base;
}

/** Build a strict zod object from an object-type JSON Schema node. */
function buildModel(schema: JsonSchema, name: string): z.ZodTypeAny {
	checkUnsupported(schema);

	const properties: Record<string, unknown> = schema.properties ?? {};
	const requiredFields = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
	const shape: Record<string, z.ZodTypeAny> = {};

	for (const [propName, rawPropSchema] of Object.entries(properties)) {
		const propSchema = assertSchemaObject(rawPropSchema, `${name}.${propName}`);
		let propType = resolveType(propSchema, `${name}_${propName}`);

		if (!requiredFields.has(propName)) {
			if ('default' in propSchema) {
				propType = propType.default(propSchema.default);
			} else if (propSchema.nullable === true) {
				// resolveType already made the type nullable
				propType = propType.default(null);
			} else {
				// Non-required, non-nullable, no explicit default.
				// Use a type-appropriate zero value for primitives/arrays; fall back to
				// null for enums and nested objects where no constructible default exists.
				const jsonType = typeof propSchema.type === 'string' ? propSchema.type : 'string';
				if ('enum' in propSchema) {
					propType = propType.nullable().default(null);
				} else if (jsonType in PRIMITIVE_DEFAULTS) {
					propType = propType.default(PRIMITIVE_DEFAULTS[jsonType]);
				} else if (jsonType === 'array') {
					propType = propType.default([]);
				} else {
					propType = propType.nullable().default(null);
				}
			}
		}

		if (typeof propSchema.description === 'string') {
			propType = propType.describe(propSchema.description);
		}

		shape[propName] = propType;
	}

	return z.object(shape).strict();
}

/**
 * Convert a JSON Schema object to a runtime zod object schema.
 *
 * The schema must be `{"type": "object", "properties": {...}, ...}`.
 * Unsupported keywords ($ref, allOf, anyOf, oneOf, etc.) throw.
 */
export function schemaDictToZod(schema: unknown): z.ZodTypeAny {
	const root = assertSchemaObject(schema, 'Top-level schema');
	checkUnsupported(root);

	if (root.type !== 'object') {
		throw new UnsupportedSchemaError(
			`Top-level schema must have type "object", got ${JSON.stringify(root.type ?? null)}`
		);
	}

	const properties = root.properties;
	if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
		throw new UnsupportedSchemaError('Top-level schema must have at least one property');
	}

	const modelName = typeof root.title === 'string' && root.title ? root.title : 'DynamicExtractionModel';
	return buildModel(root, modelName);
}

/** Python-name alias for readers coming from the upstream code base. */
export const schemaDictToPydanticModel = schemaDictToZod;

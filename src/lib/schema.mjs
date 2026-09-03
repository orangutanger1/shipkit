// A JSON Schema validator covering only the keywords schema/*.json actually
// use. Shipkit ships no runtime dependencies, and ajv is a large one to add for
// gate code that must stay auditable, so the subset lives here.
//
// Errors accumulate rather than throw: a gate that reports one problem per run
// makes fixing a generated artifact an N-round trip.

/** @typedef {Record<string, any>} Schema */
/** @typedef {{path: string, message: string}} Issue */

/** @type {Record<string, (v: any) => boolean>} */
const TYPES = {
	object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
	array: Array.isArray,
	string: (v) => typeof v === 'string',
	number: (v) => typeof v === 'number' && Number.isFinite(v),
	integer: (v) => Number.isInteger(v),
	boolean: (v) => typeof v === 'boolean',
	null: (v) => v === null,
};

/** @type {Record<string, (v: string) => boolean>} */
const FORMATS = {
	'date-time': (v) => !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v),
	uri: (v) => /^[a-z][a-z0-9+.-]*:\S*$/i.test(v),
	sha256: (v) => /^[0-9a-f]{64}$/.test(v),
};

/** @type {(v: unknown) => string} */
function typeOf(v) {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	return typeof v;
}

/**
 * Resolve a local `#/$defs/x` pointer against the document root.
 * @type {(node: Schema, root: Schema) => Schema}
 */
function deref(node, root) {
	let seen = 0;
	while (node && typeof node.$ref === 'string') {
		if (++seen > 8) throw new Error(`circular $ref at ${node.$ref}`);
		const target = node.$ref.replace(/^#\//, '').split('/').reduce((acc, part) => acc?.[decodeURIComponent(part)], root);
		if (!target) throw new Error(`unresolvable $ref ${node.$ref}`);
		node = target;
	}
	return node;
}

/** @type {(out: Issue[], path: string, schema: Schema, value: any) => boolean} */
function pushType(out, path, schema, value) {
	const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
	if (allowed.some((t) => TYPES[t]?.(value))) return true;
	out.push({ path, message: `expected ${allowed.join(' or ')}, got ${typeOf(value)}` });
	return false;
}

/** @type {(out: Issue[], path: string, schema: Schema, value: string) => void} */
function checkString(out, path, schema, value) {
	if (schema.minLength !== undefined && value.length < schema.minLength) {
		out.push({ path, message: `shorter than ${schema.minLength} characters` });
	}
	if (schema.maxLength !== undefined && value.length > schema.maxLength) {
		out.push({ path, message: `longer than ${schema.maxLength} characters` });
	}
	if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
		out.push({ path, message: `does not match ${schema.pattern}` });
	}
	const format = FORMATS[schema.format];
	if (format && !format(value)) out.push({ path, message: `not a valid ${schema.format}` });
}

/** @type {(out: Issue[], path: string, schema: Schema, value: number) => void} */
function checkNumber(out, path, schema, value) {
	if (schema.minimum !== undefined && value < schema.minimum) out.push({ path, message: `below minimum ${schema.minimum}` });
	if (schema.maximum !== undefined && value > schema.maximum) out.push({ path, message: `above maximum ${schema.maximum}` });
}

/** @type {(out: Issue[], path: string, schema: Schema, value: any[], root: Schema) => void} */
function checkArray(out, path, schema, value, root) {
	if (schema.minItems !== undefined && value.length < schema.minItems) {
		out.push({ path, message: `needs at least ${schema.minItems} item(s), has ${value.length}` });
	}
	if (schema.maxItems !== undefined && value.length > schema.maxItems) {
		out.push({ path, message: `has ${value.length} items, limit is ${schema.maxItems}` });
	}
	if (schema.uniqueItems) {
		const seen = new Set(value.map((v) => JSON.stringify(v)));
		if (seen.size !== value.length) out.push({ path, message: 'contains duplicate items' });
	}
	if (schema.items) for (const [i, item] of value.entries()) walk(out, `${path}[${i}]`, schema.items, item, root);
}

/** @type {(out: Issue[], path: string, schema: Schema, value: Record<string, any>, root: Schema) => void} */
function checkObject(out, path, schema, value, root) {
	for (const key of schema.required ?? []) {
		if (!Object.hasOwn(value, key)) out.push({ path: `${path}.${key}`, message: 'is required' });
	}
	const count = Object.keys(value).length;
	if (schema.minProperties !== undefined && count < schema.minProperties) {
		out.push({ path, message: `needs at least ${schema.minProperties} propert(ies), has ${count}` });
	}
	const patterns = Object.entries(schema.patternProperties ?? {}).map(([p, sub]) => [new RegExp(p), sub]);
	for (const [key, sub] of Object.entries(value)) {
		const at = `${path}.${key}`;
		const declared = schema.properties?.[key];
		if (declared) {
			walk(out, at, declared, sub, root);
			continue;
		}
		const matched = patterns.filter(([re]) => re.test(key));
		if (matched.length) {
			for (const [, subSchema] of matched) walk(out, at, subSchema, sub, root);
			continue;
		}
		if (schema.additionalProperties === false) out.push({ path: at, message: 'is not a known property' });
		else if (typeof schema.additionalProperties === 'object') walk(out, at, schema.additionalProperties, sub, root);
	}
}

/** @type {(out: Issue[], path: string, schema: Schema, value: any, root: Schema) => void} */
function checkComposites(out, path, schema, value, root) {
	for (const sub of schema.allOf ?? []) walk(out, path, sub, value, root);
	if (schema.anyOf && !schema.anyOf.some((/** @type {Schema} */ sub) => walk([], path, sub, value, root).length === 0)) {
		out.push({ path, message: 'matches none of the allowed shapes' });
	}
	if (schema.oneOf) {
		const hits = schema.oneOf.filter((/** @type {Schema} */ sub) => walk([], path, sub, value, root).length === 0).length;
		if (hits !== 1) out.push({ path, message: `matches ${hits} of the allowed shapes, expected exactly 1` });
	}
}

/**
 * Returns `out`, so a composite keyword can score against a throwaway array.
 * @type {(out: Issue[], path: string, schema: Schema, value: any, root: Schema) => Issue[]}
 */
function walk(out, path, schema, value, root) {
	const node = deref(schema, root);
	if (node.type !== undefined && !pushType(out, path, node, value)) return out;
	if (node.enum && !node.enum.some((/** @type {unknown} */ v) => JSON.stringify(v) === JSON.stringify(value))) {
		out.push({ path, message: `must be one of: ${node.enum.join(', ')}` });
	}
	if (Object.hasOwn(node, 'const') && JSON.stringify(node.const) !== JSON.stringify(value)) {
		out.push({ path, message: `must be ${JSON.stringify(node.const)}` });
	}
	if (typeof value === 'string') checkString(out, path, node, value);
	if (typeof value === 'number') checkNumber(out, path, node, value);
	if (Array.isArray(value)) checkArray(out, path, node, value, root);
	if (TYPES.object(value)) checkObject(out, path, node, value, root);
	checkComposites(out, path, node, value, root);
	return out;
}

/**
 * Validate a document against a schema.
 * @param {Schema} schema
 * @param {unknown} value
 * @returns {Issue[]} empty when valid
 */
export function validate(schema, value) {
	return walk([], '$', schema, value, schema);
}

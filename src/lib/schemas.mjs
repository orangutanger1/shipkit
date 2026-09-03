// Loader for schema/*.json. The schema files are the single contract — editors,
// CI's ajv step and the runtime gates all read the same bytes, so there is no
// second hand-written validator to drift from them.
import { readFile } from 'node:fs/promises';
import { ShipError } from '../log.mjs';
import { validate } from './schema.mjs';

/** @typedef {import('./schema.mjs').Schema} Schema */

/** Artifacts a gate validates, in pipeline order. */
export const SCHEMAS = /** @type {const} */ ([
	'product-brief',
	'research-plan',
	'research-reference',
	'research-reviews',
	'research-themes',
	'research-patterns',
	'design-system',
	'ux-spec',
	'qa-report',
	'ship.config',
	'screenshot-spec',
]);

/** @type {Map<string, Schema>} */
const cache = new Map();

/**
 * @param {string} name one of {@link SCHEMAS}
 * @returns {Promise<Schema>}
 */
export async function loadSchema(name) {
	const hit = cache.get(name);
	if (hit) return hit;
	if (!SCHEMAS.includes(/** @type {any} */ (name))) {
		throw new ShipError(`no schema named "${name}"`, { hint: `known schemas: ${SCHEMAS.join(', ')}` });
	}
	const url = new URL(`../../schema/${name}.schema.json`, import.meta.url);
	const schema = JSON.parse(await readFile(url, 'utf8'));
	cache.set(name, schema);
	return schema;
}

/**
 * Validate a parsed artifact, naming the file in every message.
 * @param {string} name one of {@link SCHEMAS}
 * @param {unknown} value
 * @param {string} label the file the value came from
 * @returns {Promise<string[]>} empty when valid
 */
export async function checkArtifact(name, value, label) {
	const schema = await loadSchema(name);
	return validate(schema, value).map((i) => `${label} ${i.path.replace(/^\$\.?/, '') || '(root)'} ${i.message}`);
}

/**
 * The same, as a gate: throws on the first invalid document with every issue
 * listed, because fixing one error per run is how a generated artifact takes
 * ten rounds to land.
 * @param {string} name
 * @param {unknown} value
 * @param {string} label
 */
export async function assertArtifact(name, value, label) {
	const issues = await checkArtifact(name, value, label);
	if (issues.length) throw new ShipError(`${label} does not match the ${name} schema`, { hint: issues.join('\n') });
}

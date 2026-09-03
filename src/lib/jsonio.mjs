// JSON file I/O with the three read contracts the codebase actually needs,
// so each call site states whether a missing or malformed file is an error
// or an absence.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ShipError } from '../log.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./util.mjs').JsonArray} JsonArray */

/**
 * The file should exist; a malformed one is a hard error. A primitive body
 * (bare string/number) reads as `null` — every real document is an object.
 * @param {string} file
 * @returns {Promise<JsonObject|JsonArray|null>} null when the file does not exist
 */
export async function readJSONIfExists(file) {
	if (!existsSync(file)) return null;
	try {
		const value = JSON.parse(await readFile(file, 'utf8'));
		return value !== null && typeof value === 'object' ? value : null;
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err instanceof Error ? err.message : String(err) });
	}
}

/**
 * The file is optional input; anything unreadable reads as absent.
 * @param {string} file
 * @returns {Promise<JsonObject|JsonArray|null>}
 */
export async function readJSONOrNull(file) {
	try {
		const value = JSON.parse(await readFile(file, 'utf8'));
		return value !== null && typeof value === 'object' ? value : null;
	} catch {
		return null;
	}
}

/**
 * The file must exist and be valid; either failure is a hard error.
 * @param {string} file
 * @returns {Promise<JsonObject|JsonArray>}
 */
export async function readJSONStrict(file) {
	const parsed = await readJSONIfExists(file);
	if (parsed === null)
		throw new ShipError(`${file} does not exist`, { hint: 'run the command that produces it first' });
	return parsed;
}

/**
 * Write pretty (tab-indented) JSON, creating parent directories. Returns the path.
 * @param {string} file
 * @param {Json} data
 * @returns {Promise<string>}
 */
export async function writeJSON(file, data) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, '\t')}\n`);
	return file;
}

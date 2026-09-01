// JSON file I/O with the three read contracts the codebase actually needs,
// so each call site states whether a missing or malformed file is an error
// or an absence.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ShipError } from '../log.mjs';

/**
 * The file should exist; a malformed one is a hard error.
 * @returns {Promise<null|object|array>} null when the file does not exist
 */
export async function readJSONIfExists(file) {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

/**
 * The file is optional input; anything unreadable reads as absent.
 * @returns {Promise<null|object|array>}
 */
export async function readJSONOrNull(file) {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return null;
	}
}

/** The file must exist and be valid; either failure is a hard error. */
export async function readJSONStrict(file) {
	if (!existsSync(file))
		throw new ShipError(`${file} does not exist`, { hint: 'run the command that produces it first' });
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

/** Write pretty (tab-indented) JSON, creating parent directories. Returns the path. */
export async function writeJSON(file, data) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, '\t')}\n`);
	return file;
}

// Figma, treated as a quota you spend once.
//
// The render endpoint (`GET /v1/images`) is the scarce one: on the starter plan
// it serves a handful of exports and then 429s for the rest of the day. Every
// design input this pipeline needs — the mockup layer PNGs, the reference
// render, the node geometry — is therefore fetched once and committed under
// store/, and the renderer reads the committed copy forever after. Losing those
// files blocks re-rendering until the quota resets, which is why they are build
// inputs in git and not a cache directory.
//
// The cost of that trade is staleness: a design edit lands in Figma and nothing
// on disk notices. That is what `check` answers, and it answers it without
// touching the render endpoint at all — `GET /v1/files/:key?depth=1` returns the
// file's `version` and `lastModified` for one cheap call, so drift detection is
// free even on a day when exports are exhausted.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ShipError, warn } from '../log.mjs';

const API = 'https://api.figma.com/v1';

/** Personal access token: env first, then the key file the MCP servers share. */
export async function figmaToken() {
	const env = process.env.FIGMA_API_KEY || process.env.FIGMA_TOKEN;
	if (env) return env.trim();
	const file = join(homedir(), '.omp', 'figma.key');
	if (existsSync(file)) {
		const key = (await readFile(file, 'utf8')).trim();
		if (key) return key;
	}
	return null;
}

/** A 429 is not an error here — it is the expected steady state. Flag it. */
class FigmaQuotaError extends Error {
	/** @param {string} endpoint */
	constructor(endpoint) {
		super(`Figma rate-limited ${endpoint}`);
		this.quota = true;
	}
}

/** @param {string} path @param {string} token @returns {Promise<any>} */
async function api(path, token) {
	const res = await fetch(`${API}${path}`, { headers: { 'X-Figma-Token': token } });
	if (res.status === 429) throw new FigmaQuotaError(path);
	if (!res.ok)
		throw new ShipError(`Figma ${res.status} on ${path}`, {
			hint: (await res.text().catch(() => '')).slice(0, 300),
		});
	return res.json();
}

/**
 * File version + last edit, one cheap call. This is deliberately NOT the render
 * endpoint: drift has to be detectable on a quota-exhausted day, otherwise the
 * committed exports rot silently — the one real weakness of caching them.
 */
/**
 * @param {string} fileKey
 * @param {string} token
 * @returns {Promise<{version: string, lastModified: string, name: string}>}
 */
export async function fileMeta(fileKey, token) {
	const body = await api(`/files/${fileKey}?depth=1`, token);
	return { version: body.version, lastModified: body.lastModified, name: body.name };
}

/**
 * Export node images. This is the quota. Callers must be prepared for
 * `FigmaQuotaError` and must have something on disk to fall back to.
 */
/**
 * @param {string} fileKey
 * @param {string[]} ids
 * @param {string} token
 * @param {{format?: string, scale?: number}} [opts]
 * @returns {Promise<Record<string, string|null>>}
 */
export async function renderNodes(fileKey, ids, token, { format = 'png', scale = 1 } = {}) {
	const body = await api(
		`/images/${fileKey}?ids=${ids.map(encodeURIComponent).join(',')}&format=${format}&scale=${scale}`,
		token,
	);
	if (body.err) throw new ShipError(`Figma export failed: ${body.err}`);
	return body.images ?? {};
}

/** Download exported URLs into `dir` as `<name>.png`. */
/** @param {Record<string, string|null>} images @param {string} dir @returns {Promise<string[]>} */
export async function downloadImages(images, dir) {
	await mkdir(dir, { recursive: true });
	/** @type {string[]} */
	const written = [];
	for (const [name, url] of Object.entries(images)) {
		if (!url) {
			warn(`figma: no export URL for ${name}`);
			continue;
		}
		const res = await fetch(url);
		if (!res.ok) {
			warn(`figma: ${res.status} downloading ${name}`);
			continue;
		}
		const file = join(dir, `${name.replace(/[^\w.-]/g, '_')}.png`);
		await writeFile(file, Buffer.from(await res.arrayBuffer()));
		written.push(file);
	}
	return written;
}

/**
 * Has the design moved since the committed exports were taken?
 * `null` when the spec has never recorded a version — an old spec is not drift,
 * it is an unknown, and reporting it as drift would train operators to ignore it.
 */
/**
 * @param {{source?: {version?: string|number|null}}|null|undefined} spec
 * @param {{version: string}} meta
 * @returns {{known: string|number|null, live: string, drifted: boolean|null}}
 */
export function driftOf(spec, meta) {
	const known = spec?.source?.version ?? null;
	if (!known) return { known: null, live: meta.version, drifted: null };
	return { known, live: meta.version, drifted: String(known) !== String(meta.version) };
}

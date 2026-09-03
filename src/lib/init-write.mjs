// ship init writers: everything the command writes to disk, each through the
// single `put` funnel so --dry-run cannot be forgotten at a call site.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { SHIPKIT_ROOT } from '../config.mjs';
import { isDryRun } from '../exec.mjs';
import { ShipError, c, good, info, note, warn } from '../log.mjs';
import { readJSONOrNull } from './jsonio.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** A ship.config.json field mergeFill filled in. */
/** @typedef {{path: string, from: Json, to: Json}} ConfigChange */

/** @param {Json|undefined} v @returns {v is JsonObject} */
const isJsonObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @type {Record<string, string>} */
const NPM_SCRIPTS = {
	ship: 'ship',
	'ship:doctor': 'ship doctor',
	'ship:status': 'ship status',
	'ship:preflight': 'ship preflight',
	'ship:meta': 'ship meta',
	'ship:aso': 'ship aso',
	'ship:build': 'ship build',
	'ship:submit': 'ship submit',
	'ship:ota': 'ship ota',
	'ship:release': 'ship release',
};

const GITIGNORE_LINES = ['.asc/reports/', 'aso/**/candidates.json'];

/** @param {string} text @returns {void} */
export function preview(text) {
	for (const line of text.replace(/\n$/, '').split('\n')) process.stdout.write(`    ${c.dim(line)}\n`);
}

/** @param {Json|undefined} v @returns {string} */
export const shown = (v) =>
	v === null || v === undefined || v === '' ? c.dim('—') : Array.isArray(v) ? v.join(', ') : String(v);

/** Single write funnel so --dry-run cannot be forgotten at a call site.
 * @param {string} file
 * @param {string} content
 * @param {string} root
 * @param {{intent?: 'write'|'create'}} [opts]
 * @returns {Promise<boolean>}
 */
async function put(file, content, root, { intent = 'write' } = {}) {
	const label = relative(root, file) || basename(file);
	if (isDryRun()) {
		note(`${c.yellow(`would ${intent}`)} ${label}`);
		return false;
	}
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, content);
	good(`${intent === 'create' ? 'created' : 'wrote'} ${label}`);
	return true;
}

/**
 * Fill holes in `existing` from `detected`, recording every change.
 * A hole is null / undefined / '' / []. Anything else a human decided.
 *
 * @param {JsonObject} existing
 * @param {JsonObject} detected
 * @param {ConfigChange[]} changes
 * @param {string[]} [path]
 * @returns {JsonObject}
 */
export function mergeFill(existing, detected, changes, path = []) {
	const out = { ...existing };
	for (const [k, v] of Object.entries(detected)) {
		const cur = out[k];
		const at = [...path, k];
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			out[k] = mergeFill(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}, v, changes, at);
			continue;
		}
		const empty = cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && cur.length === 0);
		if (!empty) continue;
		const blank = v === undefined || v === null || (Array.isArray(v) && v.length === 0);
		if (blank) {
			if (cur === undefined) out[k] = v ?? null;
			continue;
		}
		out[k] = v;
		changes.push({ path: at.join('.'), from: cur, to: v });
	}
	return out;
}

/** Servers shipkit owns and therefore refreshes; anything else in the file survives.
 * @returns {Promise<{file: string, servers: JsonObject, schema: Json}>}
 */
export async function shipkitServers() {
	const file = join(SHIPKIT_ROOT, 'mcp', 'servers.json');
	const doc = await readJSONOrNull(file);
	if (!isJsonObject(doc) || !doc.mcpServers)
		throw new ShipError(`${file} has no "mcpServers" block`, { hint: 'shipkit install looks incomplete' });
	return { file, servers: /** @type {JsonObject} */ (doc.mcpServers), schema: doc.$schema };
}

/** Detect a JSON file's own indentation so a merge does not reformat the diff.
 * @param {string|null|undefined} text
 * @param {string} [fallback]
 * @returns {string}
 */
function indentOf(text, fallback = '\t') {
	const m = /\n([\t ]+)"/.exec(text ?? '');
	return m ? m[1] : fallback;
}

/** @param {string} root @param {JsonObject} servers @param {Json} schema @returns {Promise<void>} */
export async function writeMcpServers(root, servers, schema) {
	const ompFile = join(root, '.omp', 'mcp.json');
	const ompRaw = await readMcpFile(ompFile);
	const ompIndent = ompRaw == null ? '\t' : indentOf(ompRaw);
	/** @type {JsonObject} */
	const ompDoc = /** @type {JsonObject} */ ((await readJSONOrNull(ompFile)) ?? {});
	const kept = Object.keys(/** @type {JsonObject} */ (ompDoc.mcpServers) ?? {}).filter((k) => !(k in servers));
	// Shipkit-owned entries are refreshed; anything the operator added stays.
	const ompNext = {
		$schema: ompDoc.$schema ?? schema,
		...ompDoc,
		mcpServers: { .../** @type {JsonObject} */ (ompDoc.mcpServers), ...servers },
	};
	const ompText = `${JSON.stringify(ompNext, null, ompIndent)}\n`;
	info(`${Object.keys(servers).join(', ')}${kept.length ? ` ${c.dim(`(keeping ${kept.join(', ')})`)}` : ''}`);
	if (ompText === `${JSON.stringify(ompDoc, null, ompIndent)}\n`) note('.omp/mcp.json unchanged');
	else if (isDryRun()) {
		note(`${c.yellow('would write')} .omp/mcp.json`);
		preview(ompText);
	} else await put(ompFile, ompText, root);

	// Claude Code / Cursor read .mcp.json at the repo root; same servers, own file.
	const claudeFile = join(root, '.mcp.json');
	const claudeRaw = await readMcpFile(claudeFile);
	const claudeIndent = claudeRaw == null ? ompIndent : indentOf(claudeRaw);
	/** @type {JsonObject} */
	const claudeDoc = /** @type {JsonObject} */ ((await readJSONOrNull(claudeFile)) ?? {});
	const claudeNext = { ...claudeDoc, mcpServers: { .../** @type {JsonObject} */ (claudeDoc.mcpServers), ...servers } };
	const claudeText = `${JSON.stringify(claudeNext, null, claudeIndent)}\n`;
	if (claudeText === `${JSON.stringify(claudeDoc, null, claudeIndent)}\n`) note('.mcp.json unchanged');
	else if (isDryRun()) note(`${c.yellow('would write')} .mcp.json ${c.dim('(same mcpServers block)')}`);
	else await put(claudeFile, claudeText, root);
}

/** @param {string} file @returns {Promise<string|null>} */
async function readMcpFile(file) {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return null;
	}
}

/** @param {string} appPath @param {string} root @param {boolean} force @returns {Promise<void>} */
export async function writeNpmScripts(appPath, root, force) {
	const pkgFile = join(appPath, 'package.json');
	let pkgText;
	try {
		pkgText = await readFile(pkgFile, 'utf8');
	} catch {
		warn(`no package.json in ${relative(root, pkgFile)} — skipping scripts`);
		return;
	}
	// JSON.parse preserves insertion order for string keys, so mutating in
	// place and re-stringifying keeps the operator's diff to the new lines.
	/** @type {{scripts?: Record<string, string>}} */
	const pkg = JSON.parse(pkgText);
	pkg.scripts ??= {};
	const added = [];
	const clashes = [];
	for (const [key, cmd] of Object.entries(NPM_SCRIPTS)) {
		if (pkg.scripts[key] === cmd) continue;
		if (pkg.scripts[key] !== undefined && !force) {
			clashes.push(key);
			continue;
		}
		pkg.scripts[key] = cmd;
		added.push(key);
	}
	if (clashes.length) note(`kept existing: ${clashes.join(', ')} ${c.dim('(--force to replace)')}`);
	if (!added.length) {
		good('all ship scripts present');
		return;
	}
	const text = `${JSON.stringify(pkg, null, indentOf(pkgText))}${pkgText.endsWith('\n') ? '\n' : ''}`;
	if (isDryRun()) {
		note(`${c.yellow('would write')} ${relative(root, pkgFile)}`);
		preview(added.map((k) => `"${k}": "${NPM_SCRIPTS[k]}",`).join('\n'));
	} else await put(pkgFile, text, root);
}

/** @param {string} root @param {string} storeDir @returns {Promise<void>} */
export async function ensureDirectories(root, storeDir) {
	const dirs = [join(storeDir, 'staged'), join(root, 'aso'), join(root, '.asc', 'reports')];
	const missing = dirs.filter((d) => !existsSync(d));
	if (!missing.length) {
		good('store/staged, aso, .asc/reports all present');
		return;
	}
	for (const d of missing) {
		if (isDryRun()) note(`${c.yellow('would create')} ${relative(root, d)}/`);
		else {
			await mkdir(d, { recursive: true });
			good(`created ${relative(root, d)}/`);
		}
	}
}

/** @param {string} root @returns {Promise<void>} */
export async function updateGitignore(root) {
	const giFile = join(root, '.gitignore');
	let giText = '';
	try {
		giText = await readFile(giFile, 'utf8');
	} catch {
		/* a repo without one gets a fresh file */
	}
	const have = new Set(giText.split('\n').map((l) => l.trim()));
	const need = GITIGNORE_LINES.filter((l) => !have.has(l));
	if (!need.length) {
		good('already ignores ship artefacts');
		return;
	}
	const prefix = giText === '' ? '' : giText.endsWith('\n') ? '' : '\n';
	const block = `${prefix}\n# shipkit\n${need.join('\n')}\n`;
	if (isDryRun()) {
		note(`${c.yellow('would append')} .gitignore`);
		preview(need.join('\n'));
	} else await put(giFile, giText + block, root, { intent: giText ? 'write' : 'create' });
}

// Process execution + the asc / eas / npx wrappers every command shares.
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { c, ShipError, note } from './log.mjs';

/** @typedef {import('./lib/util.mjs').Json} Json */
/** @typedef {import('./lib/util.mjs').JsonObject} JsonObject */
/** @typedef {import('./lib/util.mjs').JsonArray} JsonArray */
/** What asc (--output json) answers with: an object, an array, or nothing. */
/** @typedef {JsonObject|JsonArray} AscPayload */
/**
 * One JSON:API resource as `asc` returns it. Apple's attribute bag differs per
 * endpoint and carries far more than shipkit reads, so the bag itself stays
 * open — but the envelope around it does not, and a `data`/`included` typo is
 * the failure this catches.
 * @typedef {{id?: string, type?: string, attributes?: Record<string, any>, relationships?: Record<string, any>}} AscResource
 */
/** @typedef {{data?: AscResource[], included?: AscResource[]}} AscList */
/** @typedef {{data?: AscResource}} AscOne */
/**
 * `asc auth status` and `asc ads auth status`. Two commands, one shape: the
 * stored credentials, which one is active, and whatever the CLI wants to warn
 * about.
 * @typedef {{name?: string, keyId?: string, isDefault?: boolean, validation?: string, org?: string}} AscCredential
 * @typedef {{credentials?: AscCredential[], warnings?: string[], storage?: string, active?: AscCredential & {org?: string, orgId?: string}}} AscAuth
 */
/**
 * What `asc status` aggregates: one bag per area of the release. Naming the
 * areas is what stops a misspelled one from reading as a silent `undefined`.
 * @typedef {{app?: Record<string, any>, appstore?: Record<string, any>, builds?: Record<string, any>, testflight?: Record<string, any>, submission?: Record<string, any>, review?: Record<string, any>, phasedRelease?: Record<string, any>, summary?: Record<string, any>, links?: Record<string, string>}} AscDash
 */

let DRY_RUN = false;
let VERBOSE = false;
/** @param {string|boolean|undefined} v */
export function setDryRun(v) {
	DRY_RUN = !!v;
}
/** @returns {boolean} */
export function isDryRun() {
	return DRY_RUN;
}
/** @param {string|boolean|undefined} v */
export function setVerbose(v) {
	VERBOSE = !!v;
}

/** Options for {@link run}. */
/** @typedef {{cwd?: string, env?: Record<string, string>, capture?: boolean, inherit?: boolean, allowFail?: boolean, mutating?: boolean}} RunOpts */
/** What {@link run} resolves with on a completed (or allowed-failure) process. */
/** @typedef {{code: number, stdout: string, stderr: string, skipped?: boolean}} RunResult */

/**
 * Run a command.
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunOpts} [opts]
 * @returns {Promise<RunResult>}
 */
export function run(cmd, args = [], opts = {}) {
	const { cwd, env, capture = true, inherit = false, allowFail = false, mutating = false } = opts;
	if (mutating && DRY_RUN) {
		note(`${c.yellow('dry-run')} ${cmd} ${args.join(' ')}`);
		return Promise.resolve({ code: 0, stdout: '', stderr: '', skipped: true });
	}
	if (VERBOSE) note(`${c.dim('$')} ${cmd} ${args.join(' ')}`);
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		if (!inherit && child.stdout && child.stderr) {
			child.stdout.on('data', (d) => {
				stdout += d;
				if (!capture) process.stdout.write(d);
			});
			child.stderr.on('data', (d) => {
				stderr += d;
				if (!capture) process.stderr.write(d);
			});
		}
		child.on('error', (err) =>
			'code' in err && err.code === 'ENOENT'
				? reject(new ShipError(`${cmd} not found on PATH`, { hint: `install ${cmd}` }))
				: reject(err),
		);
		child.on('close', (code) => {
			if (code !== 0 && !allowFail) {
				reject(
					new ShipError(`${cmd} ${args.slice(0, 3).join(' ')} exited ${code}`, {
						hint: (stderr || stdout).trim().split('\n').slice(-6).join('\n'),
					}),
				);
			} else resolve({ code: code ?? 0, stdout, stderr });
		});
	});
}

/**
 * Parse JSON, salvaging output that asc occasionally prefixes with a warning
 * line. `undefined` means unparseable — distinct from a valid `null` body.
 * @param {string} text
 * @returns {AscPayload|undefined}
 */
function parseJSON(text) {
	const t = String(text).trim();
	if (!t) return undefined;
	try {
		return /** @type {AscPayload} */ (JSON.parse(t));
	} catch {
		/* fall through to salvage */
	}
	const start = t.search(/[[{]/);
	if (start >= 0) {
		try {
			return /** @type {AscPayload} */ (JSON.parse(t.slice(start)));
		} catch {
			/* unparseable */
		}
	}
	return undefined;
}

/**
 * Run a command whose stdout is JSON. Returns `fallback` on empty/unparseable output.
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunOpts & {fallback?: AscPayload|null}} [opts]
 * @returns {Promise<AscPayload|null|undefined>}
 */
async function runJSON(cmd, args, opts = {}) {
	const { fallback, ...rest } = opts;
	const res = await run(cmd, args, { ...rest, allowFail: rest.allowFail ?? fallback !== undefined });
	if (res.skipped) return fallback;
	const text = res.stdout.trim();
	if (!text) {
		if (fallback !== undefined) return fallback;
		throw new ShipError(`${cmd} produced no JSON output`, { hint: res.stderr.trim() });
	}
	const value = parseJSON(text);
	if (value !== undefined) return value;
	if (fallback !== undefined) return fallback;
	throw new ShipError(`${cmd} returned non-JSON output`, { hint: text.slice(0, 400) });
}

/** The `asc` binary, overridable for tests via SHIP_ASC_BIN. */
/** @typedef {string} AscBin */
/** @type {AscBin} */
export const ASC = process.env.SHIP_ASC_BIN || 'asc';

/**
 * `asc` with `--output json`. `mutating: true` participates in --dry-run.
 * @param {string[]} args
 * @param {RunOpts & {fallback?: AscPayload|null}} [opts]
 * @returns {Promise<AscPayload|null|undefined>}
 */
export function asc(args, opts = {}) {
	return runJSON(ASC, [...args, '--output', 'json'], opts);
}

/**
 * `asc` for a write, surfacing the exit status the JSON body cannot carry.
 * `asc(…, {fallback: null, allowFail: true})` returns `null` for a rejected
 * call, a skipped dry-run and a quiet success alike, so a caller that sees only
 * the parsed value cannot tell an upload that happened from one that was
 * refused. Never throws on a non-zero exit — the caller decides whether one
 * failure among N aborts the batch.
 * @param {string[]} args
 * @param {RunOpts} [opts]
 * @returns {Promise<{ok: boolean, skipped: boolean, code: number, data: AscPayload|null, stderr: string}>}
 */
export async function ascMutate(args, opts = {}) {
	const res = await run(ASC, [...args, '--output', 'json'], {
		...opts,
		mutating: true,
		allowFail: true,
	});
	if (res.skipped) return { ok: true, skipped: true, code: 0, data: null, stderr: '' };
	return {
		ok: res.code === 0,
		skipped: false,
		code: res.code,
		data: parseJSON(res.stdout) ?? null,
		stderr: (res.stderr || res.stdout).trim(),
	};
}

/**
 * `eas`, preferring the project's own pinned copy.
 *
 * `npx --yes eas-cli@latest` re-downloads eas-cli whenever the npx cache turns
 * over, so any local modification to it — notably a shortened App Store Connect
 * token lifetime, which some machines need because eas-cli asks Apple for
 * exactly the 1200 s ceiling and a clock a second fast makes every token 401 —
 * silently disappears. A project that pins eas-cli as a devDependency gets that
 * copy; everyone else still gets npx.
 * @param {string[]} args
 * @param {RunOpts} [opts]
 * @returns {Promise<RunResult>}
 */
export function eas(args, opts = {}) {
	const cwd = opts.cwd ?? process.cwd();
	const local = join(cwd, 'node_modules', '.bin', 'eas');
	const spec = existsSync(local)
		? { command: local, args: [...args] }
		: { command: 'npx', args: ['--yes', 'eas-cli@latest', ...args] };
	return run(spec.command, spec.args, { inherit: true, capture: false, ...opts });
}

/**
 * Fetch JSON with a clear error surface. A non-JSON body (proxy HTML, empty
 * 204) comes back as a string so the caller can decide, instead of throwing.
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Json|string|null>}
 */
export async function fetchJSON(url, init = {}) {
	const res = await fetch(url, init);
	const text = await res.text();
	let body;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	if (!res.ok) {
		throw new ShipError(`${init.method ?? 'GET'} ${url} → ${res.status}`, {
			hint: typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300),
		});
	}
	return /** @type {Json|string|null} */ (body);
}

/**
 * Absolute path of `bin` if it resolves on PATH, else null.
 * @param {string} bin
 * @returns {Promise<string|null>}
 */
export async function which(bin) {
	if (bin.includes('/')) return existsSync(bin) ? bin : null;
	for (const dir of (process.env.PATH ?? '').split(':')) {
		if (!dir) continue;
		const p = join(dir, bin);
		try {
			await access(p, constants.X_OK);
			return p;
		} catch {
			/* next */
		}
	}
	return null;
}

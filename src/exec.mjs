// Process execution + the asc / eas / npx wrappers every command shares.
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { c, ShipError, note } from './log.mjs';

let DRY_RUN = false;
let VERBOSE = false;
export function setDryRun(v) {
	DRY_RUN = !!v;
}
export function isDryRun() {
	return DRY_RUN;
}
export function setVerbose(v) {
	VERBOSE = !!v;
}

/**
 * Run a command.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, capture?:boolean, inherit?:boolean, allowFail?:boolean, mutating?:boolean}} opts
 * @returns {Promise<{code:number, stdout:string, stderr:string, skipped?:boolean}>}
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
		if (!inherit) {
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
			err.code === 'ENOENT'
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
 */
function parseJSON(text) {
	const t = String(text).trim();
	if (!t) return undefined;
	try {
		return JSON.parse(t);
	} catch {
		/* fall through to salvage */
	}
	const start = t.search(/[[{]/);
	if (start >= 0) {
		try {
			return JSON.parse(t.slice(start));
		} catch {
			/* unparseable */
		}
	}
	return undefined;
}

/** Run a command whose stdout is JSON. Returns `fallback` on empty/unparseable output. */
export async function runJSON(cmd, args, opts = {}) {
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

export const ASC = process.env.SHIP_ASC_BIN || 'asc';

/** `asc` with `--output json`. `mutating: true` participates in --dry-run. */
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
 * @returns {Promise<{ok:boolean, skipped:boolean, code:number, data:unknown, stderr:string}>}
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

/** `asc` with human output streamed to the terminal. */
export function ascRaw(args, opts = {}) {
	return run(ASC, args, { inherit: true, capture: false, ...opts });
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
 */
export function eas(args, opts = {}) {
	const cwd = opts.cwd ?? process.cwd();
	const local = join(cwd, 'node_modules', '.bin', 'eas');
	const spec = existsSync(local)
		? { command: local, args: [...args] }
		: { command: 'npx', args: ['--yes', 'eas-cli@latest', ...args] };
	return run(spec.command, spec.args, { inherit: true, capture: false, ...opts });
}

/** Fetch JSON with a clear error surface. */
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
	return body;
}

/** Absolute path of `bin` if it resolves on PATH, else null. */
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

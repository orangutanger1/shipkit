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
	try {
		return JSON.parse(text);
	} catch {
		// asc occasionally prefixes warnings; salvage the first balanced JSON value.
		const start = text.search(/[[{]/);
		if (start >= 0) {
			try {
				return JSON.parse(text.slice(start));
			} catch {
				/* fall through */
			}
		}
		if (fallback !== undefined) return fallback;
		throw new ShipError(`${cmd} returned non-JSON output`, { hint: text.slice(0, 400) });
	}
}

export const ASC = process.env.SHIP_ASC_BIN || 'asc';

/** `asc` with `--output json`. `mutating: true` participates in --dry-run. */
export function asc(args, opts = {}) {
	return runJSON(ASC, [...args, '--output', 'json'], opts);
}
/** `asc` with human output streamed to the terminal. */
export function ascRaw(args, opts = {}) {
	return run(ASC, args, { inherit: true, capture: false, ...opts });
}

/** `eas` via npx so no global install is required. */
export function eas(args, opts = {}) {
	return run('npx', ['--yes', 'eas-cli@latest', ...args], { inherit: true, capture: false, ...opts });
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

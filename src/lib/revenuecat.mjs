// RevenueCat v2 REST client.
// The MCP server at https://mcp.revenuecat.ai/mcp covers conversational work;
// this client covers the deterministic, scriptable half (gates, dashboards, CI).
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fetchJSON } from '../exec.mjs';
import { ShipError } from '../log.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('../config.mjs').Config} Config */
/**
 * Anything a RC v2 list endpoint answers with, viewed as a row. `id` is the one
 * field every catalogue object carries and the only one narrowed here; the rest
 * stay as loose as the payload allows.
 * @typedef {JsonObject & {
 *   id: string, type?: Json, name?: Json, lookup_key?: Json, is_current?: Json,
 *   display_name?: Json, app_id?: Json, store_identifier?: Json, position?: Json,
 *   app_store?: JsonObject & {bundle_id?: Json}, bundle_id?: Json,
 *   keySource?: string,
 * }} RcRow
 */

const BASE = 'https://api.revenuecat.com/v2';
export const KEY_FILE = join(homedir(), '.omp', 'revenuecat.key');
const KEY_DIR = join(homedir(), '.omp', 'revenuecat');

/** @param {Json|undefined} v @returns {v is RcRow} */
const isRow = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * View any JSON value as a {@link RcRow}: objects pass through untouched,
 * anything else reads as an empty row — exactly what property access on a
 * scalar would have yielded.
 * @param {Json|undefined} v
 * @returns {RcRow}
 */
const asRow = (v) => (isRow(v) ? v : /** @type {RcRow} */ ({}));

/** @type {string|null|undefined} */
let cachedKey;
/**
 * Secret v2 key from the environment, else the ambient `~/.omp/revenuecat.key`.
 *
 * `REVENUECAT_API_KEY` is read too because it is the name the MCP server and
 * most shells already export — an ambient key under a name this client ignored
 * is how a wrong-account credential stays invisible instead of being validated.
 * This function does not know which project it is for; anything project-scoped
 * must go through {@link useKeyForProject}.
 *
 * @param {{optional?: boolean}} [opts]
 * @returns {Promise<string|null>}
 */
export async function apiKey({ optional = false } = {}) {
	if (cachedKey !== undefined) return cachedKey;
	let key = (process.env.REVENUECAT_V2_KEY || process.env.REVENUECAT_API_KEY || '').trim();
	if (!key) {
		try {
			key = (await readFile(KEY_FILE, 'utf8')).trim();
		} catch {
			key = '';
		}
	}
	cachedKey = key || null;
	if (!cachedKey && !optional)
		throw new ShipError('no RevenueCat v2 API key', {
			hint: `set REVENUECAT_V2_KEY or write the key to ${KEY_FILE} (per project: ${KEY_DIR}/<name>.key)`,
		});
	return cachedKey;
}

/**
 * Where this repo's key is expected to live. `revenuecat.key` in
 * ship.config.json names it; otherwise the repo directory name is the only
 * honest guess, and naming the guess is what makes the failure actionable.
 *
 * @param {Config} cfg
 * @returns {string}
 */
function expectedKeyFile(cfg) {
	const named = cfg?.revenuecat?.key;
	if (named) return named.includes('/') ? named : join(KEY_DIR, `${named}.key`);
	const repo = basename(cfg?.root ?? '') || 'project';
	return join(KEY_DIR, `${repo}.key`);
}

/**
 * Point the client at whichever account owns this repo's project.
 *
 * RevenueCat scopes a secret key to one project, and this machine has three
 * (`~/.omp/revenuecat/{barn,car,tour}.key`) behind a single ambient
 * `~/.omp/revenuecat.key`. When the ambient key was barn's, `ship rc audit` for
 * glovebox reported `no RevenueCat project matches "projf0d996da"` — which reads
 * exactly like a misconfigured repo and is in fact a healthy paywall behind the
 * wrong credential. A gate that fails for a reason the operator cannot
 * distinguish from real breakage is worse than no gate.
 *
 * The documented per-project path (`revenuecat.key`, else the repo directory
 * name) is tried first, then the ambient key, then every key in the directory —
 * and each candidate is *validated* against the configured project before it is
 * used. An explicitly named key that cannot see the project is a hard failure
 * naming the file, not a silent 403 fifty lines later.
 *
 * @param {Config} cfg
 * @returns {Promise<{key: string|null, source: string, switched: boolean}>}
 */
export async function useKeyForProject(cfg) {
	const want = cfg?.revenuecat?.projectId;
	if (!want) return { key: await apiKey(), source: 'ambient', switched: false };

	/**
	 * @param {string} file
	 * @returns {Promise<string>}
	 */
	const read = async (file) => {
		try {
			return (await readFile(file, 'utf8')).trim();
		} catch {
			return '';
		}
	};

	// An explicit name in ship.config.json is an instruction, so a mismatch is an
	// error rather than a reason to go looking for a key that happens to work.
	const named = cfg.revenuecat?.key;
	if (named) {
		const file = expectedKeyFile(cfg);
		const key = await read(file);
		if (!key) throw new ShipError(`revenuecat.key "${named}" points at no readable key`, { hint: `expected ${file}` });
		if (!(await keySees(key, want)))
			throw new ShipError(`the key at ${file} cannot see project "${want}"`, {
				hint: `revenuecat.key names it, so ship will not substitute another — check the project id in ${cfg.file ?? 'ship.config.json'}, or replace that key`,
			});
		cachedKey = key;
		return { key, source: file, switched: true };
	}

	const guess = expectedKeyFile(cfg);
	const guessed = await read(guess);
	if (guessed && (await keySees(guessed, want))) {
		cachedKey = guessed;
		return { key: guessed, source: guess, switched: true };
	}

	const ambient = await apiKey({ optional: true });
	if (ambient && (await keySees(ambient, want))) return { key: ambient, source: 'ambient', switched: false };

	/** @type {string[]} */
	let names = [];
	try {
		names = (await readdir(KEY_DIR)).filter((f) => f.endsWith('.key')).sort();
	} catch {
		names = [];
	}
	for (const name of names) {
		const key = await read(join(KEY_DIR, name));
		if (!key || key === ambient || key === guessed) continue;
		if (await keySees(key, want)) {
			cachedKey = key;
			return { key, source: join(KEY_DIR, name), switched: true };
		}
	}
	throw new ShipError(`no RevenueCat key can see project "${want}"`, {
		hint: names.length
			? `expected ${guess}; tried the ambient key and ${names.join(', ')} in ${KEY_DIR} — add the key for this project there, or name it as revenuecat.key in ship.config.json`
			: `expected ${guess} — set REVENUECAT_V2_KEY, or drop the project's key there`,
	});
}

/**
 * Can this key see that project? Wrong-account keys 401 rather than answer.
 *
 * @param {string} key
 * @param {string} projectId
 * @returns {Promise<boolean>}
 */
async function keySees(key, projectId) {
	try {
		const page = await fetchJSON(`${BASE}/projects`, {
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		});
		const items = typeof page === 'object' && page !== null && Array.isArray(page.items) ? page.items : [];
		return items.some((p) => asRow(p).id === projectId || asRow(p).name === projectId);
	} catch {
		return false;
	}
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<Json|string|null>}
 */
async function rc(path, init = {}) {
	const key = await apiKey();
	return fetchJSON(`${BASE}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
	});
}

/**
 * Follow `next_page` links so callers never paginate by hand. RC v2 answers
 * with next_page as an absolute URL — appending it to BASE used to produce
 * `https://api.revenuecat.com/v2https://…` and a TypeError on page 2, so any
 * project past one page of products failed. Relative values (if a payload ever
 * carries one) are joined with BASE as before.
 *
 * @param {string} path
 * @returns {Promise<RcRow[]>}
 */
async function all(path) {
	/** @type {RcRow[]} */
	const items = [];
	/** @type {Json|null} */
	let next = path;
	while (next) {
		const url = typeof next === 'string' && /^https?:\/\//i.test(next) ? next : `${BASE}${next}`;
		const page = await fetchJSON(url, {
			headers: { Authorization: `Bearer ${await apiKey()}`, 'Content-Type': 'application/json' },
		});
		const pageRow = asRow(page);
		for (const item of Array.isArray(pageRow.items) ? pageRow.items : []) {
			const row = rcRowOf(item);
			if (row) items.push(row);
		}
		next = pageRow.next_page ?? null;
	}
	return items;
}

/**
 * One RC v2 catalogue object. A row without a string `id` cannot be addressed
 * by anything downstream, so it is dropped rather than guessed at.
 * @param {Json} r
 * @returns {RcRow|null}
 */
const rcRowOf = (r) => {
	const row = asRow(r);
	return typeof row.id === 'string' ? { ...row, id: row.id } : null;
};

/** @returns {Promise<RcRow[]>} */
export const listProjects = () => all('/projects');
/**
 * @param {string} projectId
 * @returns {Promise<RcRow[]>}
 */
export const listApps = (projectId) => all(`/projects/${projectId}/apps`);
/**
 * @param {string} projectId
 * @returns {Promise<RcRow[]>}
 */
export const listEntitlements = (projectId) => all(`/projects/${projectId}/entitlements`);
/**
 * @param {string} projectId
 * @returns {Promise<RcRow[]>}
 */
export const listOfferings = (projectId) => all(`/projects/${projectId}/offerings`);
/**
 * @param {string} projectId
 * @returns {Promise<RcRow[]>}
 */
export const listProducts = (projectId) => all(`/projects/${projectId}/products`);
/**
 * @param {string} projectId
 * @param {string} offeringId
 * @returns {Promise<RcRow[]>}
 */
export const listPackages = (projectId, offeringId) =>
	all(`/projects/${projectId}/offerings/${offeringId}/packages`);

/**
 * v2 nests the store identity under the store block; older payloads flatten it.
 * @param {RcRow|undefined} [app]
 * @returns {Json}
 */
export const bundleOf = (app) => asRow(app).app_store?.bundle_id ?? asRow(app).bundle_id ?? '';

/**
 * The project's own money, from `/metrics/overview` — the only endpoint in the
 * v2 API that answers "did any of this convert". The catalogue endpoints above
 * describe what you *could* sell.
 *
 * RevenueCat returns an array of `{id, value}` whose ids have changed before, so
 * every metric is looked up by several plausible ids and a miss is `null` rather
 * than 0: "no data" and "zero revenue" lead to opposite decisions about whether
 * to keep buying installs.
 *
 * @param {string} projectId
 * @returns {Promise<{project: string, period: Json|null, customers: number|null, trials: number|null, subscriptions: number|null, revenue: number|null, mrr: number|null, metrics: Json}>}
 */
export async function overviewMetrics(projectId) {
	const body = await rc(`/projects/${projectId}/metrics/overview`);
	const metrics = asRow(body).metrics;
	const by = new Map((Array.isArray(metrics) ? metrics : []).map((m) => [asRow(m).id, Number(asRow(m).value)]));
	/**
	 * @param {...string} ids
	 * @returns {number|null}
	 */
	const pick = (...ids) => {
		for (const id of ids) {
			const v = by.get(id);
			if (typeof v === 'number' && Number.isFinite(v)) return v;
		}
		return null;
	};
	return {
		project: projectId,
		period: asRow(Array.isArray(metrics) ? metrics[0] : undefined).period ?? null,
		customers: pick('new_customers', 'active_users', 'active_subscribers'),
		trials: pick('active_trials', 'new_trials'),
		subscriptions: pick('active_subscriptions', 'new_subscriptions'),
		revenue: pick('revenue'),
		mrr: pick('mrr'),
		metrics: metrics ?? [],
	};
}

/**
 * Resolve the configured project, tolerating a name instead of an id.
 *
 * Selecting the credential is part of resolving the project, not a separate
 * step a caller can forget: every `ship rc` subcommand and `ship preflight`
 * reaches the right account without knowing that more than one exists.
 *
 * @param {Config} cfg
 * @returns {Promise<RcRow|null>}
 */
export async function resolveProject(cfg) {
	const want = cfg.revenuecat?.projectId;
	const chosen = await useKeyForProject(cfg);
	const projects = await listProjects();
	if (!projects.length) throw new ShipError('RevenueCat account has no projects');
	if (!want) return projects.length === 1 ? projects[0] : null;
	const project = projects.find((p) => p.id === want || p.name === want) ?? null;
	if (project) project.keySource = chosen.source;
	return project;
}

/**
 * Monetisation wiring audit: the checks that actually break paywalls in production.
 *
 * @param {Config} cfg
 * @param {RcRow} project
 * @returns {Promise<{level:'ok'|'warn'|'fail', name:string, detail:string}[]>}
 */
export async function auditProject(cfg, project) {
	const rows = [];
	const add = (level, name, detail = '') => rows.push({ level, name, detail });

	const [apps, entitlements, offerings, products] = await Promise.all([
		listApps(project.id),
		listEntitlements(project.id),
		listOfferings(project.id),
		listProducts(project.id),
	]);

	const iosApp = apps.find((a) => a.type === 'app_store' || a.type === 'ios');
	const iosBundle = bundleOf(iosApp);
	if (!iosApp) add('fail', 'app_store app', 'no App Store app configured in this project');
	else if (iosBundle && iosBundle !== cfg.bundleId)
		add('fail', 'bundle id', `RevenueCat has ${iosBundle}, repo builds ${cfg.bundleId}`);
	else add('ok', 'app_store app', iosApp.id);

	const wanted = cfg.revenuecat?.entitlement;
	if (!wanted) add('warn', 'entitlement', 'ship.config.json revenuecat.entitlement is unset');
	else if (!entitlements.some((e) => e.lookup_key === wanted || e.id === wanted))
		add(
			'fail',
			'entitlement',
			`"${wanted}" not found — have: ${entitlements.map((e) => e.lookup_key).join(', ') || '(none)'}`,
		);
	else add('ok', 'entitlement', wanted);

	const current = offerings.find((o) => o.is_current);
	if (!current) add('fail', 'current offering', 'no offering marked current — paywall renders empty');
	else {
		const packages = await listPackages(project.id, current.id);
		if (!packages.length) add('fail', 'current offering', `"${current.lookup_key}" has no packages`);
		else add('ok', 'current offering', `${current.lookup_key} (${packages.length} packages)`);
	}

	if (!products.length) add('fail', 'products', 'no products configured');
	else {
		const unattached = products.filter((p) => !p.app_id);
		add(
			unattached.length ? 'warn' : 'ok',
			'products',
			`${products.length} total${unattached.length ? `, ${unattached.length} not attached to an app` : ''}`,
		);
	}
	return rows;
}

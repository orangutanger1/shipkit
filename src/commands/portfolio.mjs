// ship portfolio — the only command that is not about one repo.
//
// Three operational facts shape this module:
//
//  1. Every other command loads `ship.config.json` for the repo you are standing
//     in, but nobody ships one app. The failure this prevents is an app quietly
//     eating attention — a slot on the account, a subscription to RevenueCat, a
//     line in the Apple Ads budget — because you forgot it exists. So the sunset
//     rule is a gate that prints the three numbers that triggered it rather than
//     a score: revenue under the floor AND older than 90 days AND no release in
//     60 days. Two out of three is a slow month; all three is a dead app.
//  2. A portfolio dashboard is read by someone who has *not* configured every
//     app: one repo has no asc.appId, another has no RevenueCat project, a third
//     has a hand-edited config that no longer parses. A table that throws on the
//     first of those is worse than no table, because you stop running it. Every
//     cell degrades to an error string and the row still renders.
//  3. N apps × (asc status + versions + RevenueCat + Apple Ads) is a lot of
//     round trips, and ASC rate-limits. The work runs through a hand-rolled
//     bounded pool — four at a time by default, no dependency, no unbounded
//     Promise.all that opens twenty sockets and gets throttled for it.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CONFIG_NAME, loadConfig } from '../config.mjs';
import { asc, fetchJSON } from '../exec.mjs';
import { apiKey, listProjects } from '../lib/revenuecat.mjs';
import { ShipError, c, good, heading, info, note, table, warn } from '../log.mjs';

export const help = `
${c.bold('ship portfolio')} ${c.dim('— every app at once: revenue, spend, staleness, sunset candidates')}

${c.dim('usage:')} ship portfolio [subcommand] [flags]

  ${c.cyan('(default)')}  dashboard: review state, version, days since release, revenue, spend, verdict
  ${c.cyan('add')}        ${c.dim('<path>')} register an app repo ${c.dim('(idempotent)')}
  ${c.cyan('rm')}         ${c.dim('<path|name>')} unregister an app
  ${c.cyan('list')}       registered apps, no network

${c.bold('Flags')}
  ${c.cyan('--scan <dir>')}       discover ship.config.json under <dir> and register what it finds
  ${c.cyan('--depth <n>')}        scan depth ${c.dim('(default: 4; skips node_modules, .git, ios, android)')}
  ${c.cyan('--floor <n>')}        monthly revenue floor for the sunset gate ${c.dim('(default: 10)')}
  ${c.cyan('--concurrency <n>')}  apps inspected at once ${c.dim('(default: 4)')}
  ${c.cyan('--strict')}           exit 1 when any row failed to collect
  ${c.cyan('--json')}             machine-readable output

${c.dim(`Registry: ${join('~', '.omp', 'shipkit-portfolio.json')} (override with SHIP_PORTFOLIO_FILE)`)}
${c.dim('Sunset = revenue < floor AND age > 90d AND no release in 60d. All three, or it stays.')}
`;

const DAY = 86_400_000;
const DASH = '—';
const AGE_DAYS = 90;
const RELEASE_DAYS = 60;
const DEFAULT_FLOOR = 10;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DEPTH = 4;

/** RevenueCat v2 aggregate metrics; the REST client exposes catalogue, not money. */
const RC_METRICS = (projectId) => `https://api.revenuecat.com/v2/projects/${projectId}/metrics/overview`;

const emit = (data) => {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
	return 0;
};

const money = (n) => (n === null || n === undefined ? DASH : `$${Number(n).toFixed(2)}`);
const num = (v, fallback) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
};
const daysBetween = (iso, now) => {
	const t = typeof iso === 'number' ? iso : Date.parse(iso ?? '');
	return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null;
};

/* ------------------------------------------------------------- registry -- */

export function registryFile() {
	return process.env.SHIP_PORTFOLIO_FILE || join(homedir(), '.omp', 'shipkit-portfolio.json');
}

/** Tolerate a bare string per app, a missing name, and duplicate paths. */
export function normaliseRegistry(raw) {
	const seen = new Set();
	const apps = [];
	for (const entry of Array.isArray(raw?.apps) ? raw.apps : []) {
		const path = typeof entry === 'string' ? entry : entry?.path;
		if (typeof path !== 'string' || !path.trim()) continue;
		const abs = resolve(path.trim());
		if (seen.has(abs)) continue;
		seen.add(abs);
		const name = typeof entry === 'object' && entry?.name ? String(entry.name) : basename(abs);
		apps.push({ path: abs, name });
	}
	return { apps };
}

export async function readRegistry(file = registryFile()) {
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') return { apps: [] };
		throw new ShipError(`cannot read ${file}`, { hint: err.message });
	}
	try {
		return normaliseRegistry(JSON.parse(text));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

export async function writeRegistry(reg, file = registryFile()) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify({ apps: reg.apps }, null, 2)}\n`);
	return file;
}

/** Idempotent by resolved path: re-adding refreshes the name, never duplicates. */
export function addEntry(reg, { path, name }) {
	const abs = resolve(path);
	const existed = reg.apps.some((a) => a.path === abs);
	const apps = reg.apps
		.filter((a) => a.path !== abs)
		.concat({ path: abs, name: name || basename(abs) })
		.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
	return { registry: { apps }, existed };
}

/** Remove by registered path or by name — you remember one or the other, never both. */
export function removeEntry(reg, key) {
	const abs = resolve(key);
	const hit = (a) => a.path === abs || a.name === key || basename(a.path) === key;
	const removed = reg.apps.filter(hit);
	return { registry: { apps: reg.apps.filter((a) => !hit(a)) }, removed };
}

/* ----------------------------------------------------------------- scan -- */

/** Generated, vendored, or another toolchain's repo entirely. */
const SKIP_DIRS = new Set([
	'node_modules', '.git', 'ios', 'android', 'Pods', '.expo', 'build', 'dist', 'vendor', 'coverage',
]);

/**
 * Directories holding a ship.config.json, at most `depth` levels below `dir`.
 * An app repo is a leaf: nothing below a config is another app, and descending
 * into one costs a full node_modules walk for nothing.
 */
export async function scanConfigs(dir, { depth = DEFAULT_DEPTH } = {}) {
	const root = resolve(dir);
	const found = [];
	const walk = async (current, level) => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((e) => e.isFile() && e.name === CONFIG_NAME)) {
			found.push(current);
			return;
		}
		if (level >= depth) return;
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
			await walk(join(current, e.name), level + 1);
		}
	};
	await walk(root, 0);
	return found.sort();
}

/* ----------------------------------------------------------------- pool -- */

/**
 * Bounded-concurrency map preserving input order. `limit` runners share one
 * cursor; a runner takes the next index only when its previous item settled, so
 * in-flight work never exceeds `limit`.
 */
export async function pool(items, limit, worker) {
	const out = new Array(items.length);
	const width = Math.max(1, Math.min(num(limit, DEFAULT_CONCURRENCY) | 0 || DEFAULT_CONCURRENCY, items.length));
	let next = 0;
	const runner = async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await worker(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: width }, runner));
	return out;
}

/* --------------------------------------------------------------- sunset -- */

/**
 * The kill rule, pure and boundary-explicit. Every gate carries the number that
 * decided it so the table can show its work: "sunset" without the arithmetic is
 * an opinion, and nobody deletes an app on an opinion.
 *
 * A gate whose input is unknown cannot pass. When the known gates all pass and
 * something is missing, the verdict is `unknown` — never a sunset by omission.
 */
export function sunsetVerdict({ revenue, ageDays, daysSinceRelease }, { floor = DEFAULT_FLOOR } = {}) {
	const known = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
	const gates = [
		{
			name: 'revenue',
			value: known(revenue) ? Number(revenue) : null,
			threshold: floor,
			pass: known(revenue) && Number(revenue) < floor,
			detail: known(revenue)
				? `${money(revenue)}/mo ${Number(revenue) < floor ? '<' : '>='} ${money(floor)} floor`
				: `revenue unknown (floor ${money(floor)})`,
		},
		{
			name: 'age',
			value: known(ageDays) ? Number(ageDays) : null,
			threshold: AGE_DAYS,
			pass: known(ageDays) && Number(ageDays) > AGE_DAYS,
			detail: known(ageDays)
				? `${ageDays}d old ${Number(ageDays) > AGE_DAYS ? '>' : '<='} ${AGE_DAYS}d`
				: 'age unknown',
		},
		{
			name: 'release',
			value: known(daysSinceRelease) ? Number(daysSinceRelease) : null,
			threshold: RELEASE_DAYS,
			pass: known(daysSinceRelease) && Number(daysSinceRelease) > RELEASE_DAYS,
			detail: known(daysSinceRelease)
				? `${daysSinceRelease}d since release ${Number(daysSinceRelease) > RELEASE_DAYS ? '>' : '<='} ${RELEASE_DAYS}d`
				: 'last release unknown',
		},
	];
	const missing = gates.filter((g) => g.value === null);
	const verdict = gates.every((g) => g.pass)
		? 'sunset'
		: missing.length && gates.every((g) => g.pass || g.value === null)
			? 'unknown'
			: 'keep';
	return { verdict, sunset: verdict === 'sunset', floor, gates };
}

/** One line naming only the gates that fired, with their numbers. */
export const sunsetReason = (v) =>
	v.gates
		.filter((g) => g.pass)
		.map((g) => g.detail)
		.join(' · ');

/* ------------------------------------------------------------ collectors -- */

/** Never let one probe reject the row; the message *is* the cell. */
async function settle(fn) {
	try {
		return { value: await fn(), error: null };
	} catch (err) {
		return { value: null, error: err?.message ?? String(err) };
	}
}

/** Cache an async call so N apps share one credential check / project list. */
function memo(fn) {
	let promise;
	return () => (promise ??= fn());
}

/** Apple Ads buries report rows under reportingDataResponse; find them anywhere. */
function reportRows(payload) {
	const seen = new Set();
	const stack = [payload];
	while (stack.length) {
		const node = stack.pop();
		if (!node || typeof node !== 'object' || seen.has(node)) continue;
		seen.add(node);
		if (Array.isArray(node.row)) return node.row;
		for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
	}
	return [];
}

/** Money arrives as {amount,currency}; counts arrive as strings. Both become numbers. */
const metric = (v) => Number(typeof v === 'object' && v !== null ? v.amount : v) || 0;

/** ASC: review state, live version, newest build, first and last release dates. */
async function ascProbe(cfg, appId) {
	if (!appId) return { skipped: 'no asc.appId in ship.config.json' };
	const [dash, list] = await Promise.all([
		asc(['status', '--app', appId, '--platform', 'IOS', '--include', 'app,builds,appstore,review'], {
			fallback: null,
		}),
		asc(['versions', 'list', '--app', appId, '--platform', 'IOS', '--limit', '50'], {
			fallback: null,
		}),
	]);
	if (!dash && !list) throw new ShipError('App Store Connect unavailable');
	const versions = (list?.data ?? [])
		.map((v) => ({
			version: v.attributes?.versionString ?? null,
			state: v.attributes?.appStoreState ?? v.attributes?.appVersionState ?? null,
			created: Date.parse(v.attributes?.createdDate ?? ''),
		}))
		.filter((v) => Number.isFinite(v.created))
		.sort((a, b) => b.created - a.created);
	// A version that never reached sale is not a release; drafts are how a dead
	// app looks busy. Fall back to the newest version only when nothing shipped.
	const released = versions.find((v) => v.state === 'READY_FOR_SALE') ?? versions[0] ?? null;
	return {
		state: dash?.appstore?.state ?? dash?.review?.state ?? released?.state ?? null,
		version: dash?.appstore?.version ?? released?.version ?? null,
		build: dash?.builds?.latest?.buildNumber ?? dash?.builds?.latest?.version ?? null,
		lastReleaseAt: released?.created ?? null,
		firstReleaseAt: versions.length ? versions[versions.length - 1].created : null,
	};
}

/** RevenueCat monthly money: MRR when the project reports it, else 28-day revenue. */
async function revenueProbe(cfg, projects) {
	const key = await apiKey({ optional: true });
	if (!key) return { monthly: null, skipped: 'no RevenueCat API key' };
	const list = await projects();
	const want = cfg.revenuecat?.projectId;
	const project = want
		? (list.find((p) => p.id === want || p.name === want) ?? null)
		: list.length === 1
			? list[0]
			: null;
	if (!project)
		return {
			monthly: null,
			skipped: want ? `no RevenueCat project "${want}"` : 'no revenuecat.projectId',
		};
	const body = await fetchJSON(RC_METRICS(project.id), {
		headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
	});
	const by = new Map((body?.metrics ?? []).map((m) => [m.id, Number(m.value)]));
	const mrr = by.get('mrr');
	const rev28 = by.get('revenue');
	const monthly = Number.isFinite(mrr) ? mrr : Number.isFinite(rev28) ? rev28 : null;
	return { monthly, mrr: Number.isFinite(mrr) ? mrr : null, revenue28d: Number.isFinite(rev28) ? rev28 : null, project: project.id };
}

/** Apple Ads spend over the last 30 days, to sit beside a monthly revenue figure. */
async function adsProbe(cfg, credentialed) {
	const auth = await credentialed();
	if (!auth?.ok) return { spend: null, skipped: 'no Apple Ads credentials' };
	const org = cfg.ads?.orgId ?? process.env.ASC_ADS_ORG_ID ?? auth.org ?? null;
	if (!org) return { spend: null, skipped: 'no ads.orgId' };
	const report = await asc(
		[
			'ads', 'reports', 'preset',
			'--level', 'campaigns',
			'--last-days', '30',
			'--granularity', 'MONTHLY',
			'--fields', 'campaignName,localSpend,totalInstalls',
			'--org', String(org),
		],
		{ fallback: null },
	);
	if (!report) throw new ShipError('Apple Ads report unavailable');
	const rows = reportRows(report);
	let spend = 0;
	let installs = 0;
	for (const row of rows) {
		const t = row.total ?? row.granularity?.[0] ?? {};
		spend += metric(t.localSpend);
		installs += metric(t.totalInstalls ?? t.installs);
	}
	return { spend, installs, campaigns: rows.length, org: String(org) };
}

/** Real probes, sharing one credential check and one project list across all apps. */
export function liveContext({ floor = DEFAULT_FLOOR, now = Date.now() } = {}) {
	const projects = memo(() => listProjects());
	const credentialed = memo(async () => {
		const auth = await asc(['ads', 'auth', 'status'], { fallback: null });
		const creds = auth?.credentials ?? [];
		if (!creds.length) return { ok: false };
		const active = auth?.active ?? {};
		return { ok: true, org: active.org ?? active.orgId ?? null };
	});
	return {
		floor,
		now,
		ascFor: (cfg, appId) => ascProbe(cfg, appId),
		revenueFor: (cfg) => revenueProbe(cfg, projects),
		adsFor: (cfg) => adsProbe(cfg, credentialed),
	};
}

/**
 * One dashboard row. Returns — never throws. A config that will not parse is a
 * row with an error, because the whole point is seeing the app you forgot.
 */
export async function collectRow(entry, ctx) {
	const base = {
		name: entry.name,
		path: entry.path,
		error: null,
		errors: {},
		state: null,
		version: null,
		build: null,
		ageDays: null,
		daysSinceRelease: null,
		revenue: null,
		spend: null,
	};
	const fail = (message) => {
		const row = { ...base, error: message };
		return { ...row, ...verdictOf(row, ctx) };
	};
	const file = join(entry.path, CONFIG_NAME);
	if (!existsSync(file)) return fail(`no ${CONFIG_NAME} in ${entry.path}`);

	let cfg;
	try {
		cfg = await loadConfig(entry.path);
	} catch (err) {
		return fail(err?.message ?? String(err));
	}

	const appId = cfg.asc?.appId ? String(cfg.asc.appId) : (process.env.ASC_APP_ID ?? null);
	const [ascRes, revRes, adsRes] = await Promise.all([
		settle(() => ctx.ascFor(cfg, appId)),
		settle(() => ctx.revenueFor(cfg)),
		settle(() => ctx.adsFor(cfg)),
	]);

	const row = {
		...base,
		name: cfg.name || entry.name,
		bundleId: cfg.bundleId ?? null,
		appId,
		state: ascRes.value?.state ?? null,
		version: ascRes.value?.version ?? null,
		build: ascRes.value?.build ?? null,
		ageDays: daysBetween(ascRes.value?.firstReleaseAt, ctx.now),
		daysSinceRelease: daysBetween(ascRes.value?.lastReleaseAt, ctx.now),
		revenue: numOrNull(revRes.value?.monthly),
		spend: numOrNull(adsRes.value?.spend),
		errors: {
			...(ascRes.error ? { asc: ascRes.error } : {}),
			...(revRes.error ? { revenue: revRes.error } : {}),
			...(adsRes.error ? { ads: adsRes.error } : {}),
		},
		skipped: {
			...(ascRes.value?.skipped ? { asc: ascRes.value.skipped } : {}),
			...(revRes.value?.skipped ? { revenue: revRes.value.skipped } : {}),
			...(adsRes.value?.skipped ? { ads: adsRes.value.skipped } : {}),
		},
	};
	return { ...row, ...verdictOf(row, ctx) };
}

const numOrNull = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

function verdictOf(row, ctx) {
	const sunset = sunsetVerdict(row, { floor: ctx.floor });
	return { sunset: sunset.sunset, verdict: row.error ? 'error' : sunset.verdict, gates: sunset.gates };
}

/** A row nobody can act on: the config broke, or a probe failed outright. */
const errored = (row) => !!row.error || Object.keys(row.errors ?? {}).length > 0;

/* ------------------------------------------------------------ subcommands -- */

async function cmdAdd(args, flags) {
	const file = registryFile();
	let reg = await readRegistry(file);
	const targets = [];

	if (flags.scan !== undefined && flags.scan !== true)
		targets.push(...(await scanConfigs(String(flags.scan), { depth: num(flags.depth, DEFAULT_DEPTH) })));
	for (const a of args) {
		const abs = resolve(a);
		targets.push(basename(abs) === CONFIG_NAME ? dirname(abs) : abs);
	}
	if (!targets.length)
		throw new ShipError('portfolio add: nothing to add', {
			hint: 'ship portfolio add <path>  |  ship portfolio add --scan ~/code',
		});

	const results = [];
	for (const path of targets) {
		const cfgFile = join(path, CONFIG_NAME);
		if (!existsSync(cfgFile)) {
			results.push({ path, added: false, error: `no ${CONFIG_NAME} in ${path}` });
			continue;
		}
		let name = basename(path);
		try {
			name = (await loadConfig(path)).name || name;
		} catch {
			// An unparseable config is still an app worth listing; the dashboard
			// will say so in red. Registering it is how you notice.
		}
		const next = addEntry(reg, { path, name });
		reg = next.registry;
		results.push({ path, name, added: !next.existed });
	}
	await writeRegistry(reg, file);

	if (flags.json) return emit({ registry: file, results, apps: reg.apps });
	for (const r of results) {
		if (r.error) warn(r.error);
		else if (r.added) good(`added ${r.name} ${c.dim(r.path)}`);
		else note(`already registered: ${r.name} ${c.dim(r.path)}`);
	}
	info(`${reg.apps.length} app${reg.apps.length === 1 ? '' : 's'} in ${file}`);
	return 0;
}

async function cmdRm(args, flags) {
	if (!args.length) throw new ShipError('portfolio rm: needs a path or a name');
	const file = registryFile();
	let reg = await readRegistry(file);
	const removed = [];
	const missing = [];
	for (const key of args) {
		const next = removeEntry(reg, key);
		if (!next.removed.length) missing.push(key);
		else removed.push(...next.removed);
		reg = next.registry;
	}
	await writeRegistry(reg, file);

	if (flags.json) return emit({ registry: file, removed, missing, apps: reg.apps });
	for (const r of removed) good(`removed ${r.name} ${c.dim(r.path)}`);
	for (const key of missing) warn(`not registered: ${key}`);
	return missing.length && !removed.length ? 1 : 0;
}

async function cmdList(flags) {
	const file = registryFile();
	const reg = await readRegistry(file);
	if (flags.json) return emit({ registry: file, apps: reg.apps });
	heading(`Portfolio (${reg.apps.length})`);
	table(reg.apps, [
		{ header: 'app', get: (a) => a.name },
		{ header: 'path', get: (a) => a.path },
		{ header: 'config', get: (a) => (existsSync(join(a.path, CONFIG_NAME)) ? c.green('ok') : c.red('missing')) },
	]);
	note(file);
	return 0;
}

/* ------------------------------------------------------------- dashboard -- */

function renderDashboard(rows, { floor, registry }) {
	heading(`Portfolio (${rows.length})`);
	table(rows, [
		{ header: 'app', get: (r) => r.name },
		{ header: 'review', get: (r) => reviewCell(r) },
		{ header: 'version', get: (r) => versionCell(r) },
		{ header: 'released', get: (r) => (r.daysSinceRelease === null ? c.dim(DASH) : `${r.daysSinceRelease}d ago`) },
		{ header: 'age', get: (r) => (r.ageDays === null ? c.dim(DASH) : `${r.ageDays}d`) },
		{ header: 'revenue/mo', get: (r) => (r.revenue === null ? c.dim(DASH) : money(r.revenue)) },
		{ header: 'ad spend', get: (r) => (r.spend === null ? c.dim(DASH) : money(r.spend)) },
		{ header: 'verdict', get: (r) => verdictCell(r) },
	]);

	const sunset = rows.filter((r) => r.sunset);
	const broken = rows.filter((r) => errored(r));
	const totals = totalsOf(rows);

	process.stdout.write('\n');
	info(
		`${rows.length} app${rows.length === 1 ? '' : 's'} · ${c.bold(money(totals.revenue))}/mo revenue · ${c.bold(money(totals.spend))} ads (30d) · net ${c.bold(money(totals.revenue - totals.spend))}`,
	);

	for (const r of sunset) {
		warn(`sunset candidate: ${r.name}`);
		note(sunsetReason(r) || `all three gates passed at a ${money(floor)} floor`);
	}
	if (!sunset.length && rows.length) good(`no sunset candidates at a ${money(floor)}/mo floor`);

	for (const r of broken) {
		const detail = r.error ?? Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join(' · ');
		warn(`${r.name} — ${detail}`);
	}
	const skipped = rows.filter((r) => !errored(r) && Object.keys(r.skipped ?? {}).length);
	for (const r of skipped)
		note(c.dim(`${r.name}: ${Object.entries(r.skipped).map(([k, v]) => `${k} ${v}`).join(' · ')}`));
	note(registry);
}

function reviewCell(r) {
	if (r.error) return c.red('error');
	if (r.errors?.asc) return c.red('error');
	const s = r.state;
	if (!s) return c.dim(DASH);
	if (s === 'READY_FOR_SALE') return c.green(s);
	if (/REJECT/.test(s)) return c.red(s);
	if (s === 'WAITING_FOR_REVIEW' || s === 'IN_REVIEW' || s.startsWith('PENDING_')) return c.yellow(s);
	return s;
}

function versionCell(r) {
	if (!r.version) return c.dim(DASH);
	return r.build ? `${r.version} ${c.dim(`(${r.build})`)}` : r.version;
}

function verdictCell(r) {
	if (r.verdict === 'error') return c.red('error');
	if (r.verdict === 'sunset') return c.red('sunset');
	if (r.verdict === 'unknown') return c.yellow('unknown');
	return c.green('keep');
}

function totalsOf(rows) {
	return {
		apps: rows.length,
		revenue: rows.reduce((s, r) => s + (r.revenue ?? 0), 0),
		spend: rows.reduce((s, r) => s + (r.spend ?? 0), 0),
		sunset: rows.filter((r) => r.sunset).length,
		errors: rows.filter((r) => errored(r)).length,
	};
}

async function cmdDashboard(flags) {
	const file = registryFile();
	let reg = await readRegistry(file);

	// --scan on the dashboard registers what it finds first: the app you forgot
	// is by definition the one that never got added by hand.
	if (flags.scan !== undefined && flags.scan !== true) {
		const found = await scanConfigs(String(flags.scan), { depth: num(flags.depth, DEFAULT_DEPTH) });
		for (const path of found) {
			let name = basename(path);
			try {
				name = (await loadConfig(path)).name || name;
			} catch {
				/* unparseable config still belongs in the table */
			}
			reg = addEntry(reg, { path, name }).registry;
		}
		await writeRegistry(reg, file);
	}

	if (!reg.apps.length) {
		if (flags.json) return emit({ registry: file, apps: [], totals: totalsOf([]) });
		heading('Portfolio (0)');
		note('no apps registered — `ship portfolio add <path>` or `ship portfolio --scan ~/code`');
		return 0;
	}

	const floor = num(flags.floor, DEFAULT_FLOOR);
	const ctx = liveContext({ floor, now: Date.now() });
	const rows = await pool(reg.apps, num(flags.concurrency, DEFAULT_CONCURRENCY), (entry) =>
		collectRow(entry, ctx).catch((err) => ({
			name: entry.name,
			path: entry.path,
			error: err?.message ?? String(err),
			errors: {},
			verdict: 'error',
			sunset: false,
			state: null,
			version: null,
			build: null,
			ageDays: null,
			daysSinceRelease: null,
			revenue: null,
			spend: null,
		})),
	);

	const totals = totalsOf(rows);
	if (flags.json)
		emit({ generatedAt: new Date().toISOString(), registry: file, floor, totals, apps: rows });
	else renderDashboard(rows, { floor, registry: file });

	// Exit code is a gate only when asked for: a portfolio with one unconfigured
	// repo is the normal state, and a dashboard that exits 1 every morning is a
	// dashboard nobody reads.
	return flags.strict && totals.errors ? 1 : 0;
}

export async function run({ args, flags }) {
	const [sub, ...rest] = args;
	switch (sub) {
		case 'add':
			return cmdAdd(rest, flags);
		case 'rm':
		case 'remove':
			return cmdRm(rest, flags);
		case 'list':
		case 'ls':
			return cmdList(flags);
		case undefined:
			return cmdDashboard(flags);
		default:
			throw new ShipError(`portfolio: unknown subcommand "${sub}"`, {
				hint: 'subcommands: add, rm, list — or no subcommand for the dashboard',
			});
	}
}

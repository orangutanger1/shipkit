// ship portfolio — the only command that is not about one repo.
//
// Three operational facts shape this module:
//
//  1. Every other command loads `ship.config.json` for the repo you are standing
//     in, but nobody ships one app. The failure this prevents is an app quietly
//     eating attention — a slot on the account, a subscription to RevenueCat, a
//     line in the Apple Ads budget — because you forgot it exists. So the sunset
//     rule is a gate that prints the three numbers that triggered it rather than
//     a score. Two out of three is a slow month; all three is a dead app.
//  2. A portfolio dashboard is read by someone who has *not* configured every
//     app. Every cell degrades to an error string and the row still renders
//     (see lib/portfolio-probes.mjs).
//  3. N apps × (asc status + versions + RevenueCat + Apple Ads) is a lot of
//     round trips, and ASC rate-limits. The work runs through a bounded pool —
//     four at a time by default, no unbounded Promise.all that opens twenty
//     sockets and gets throttled for it.
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CONFIG_NAME, loadConfig } from '../config.mjs';
import { ShipError, c, good, heading, info, note, table, warn } from '../log.mjs';
import { DASH, moneyOrDash, num } from '../lib/fmt.mjs';
import { emit } from '../lib/output.mjs';
import {
	addEntry,
	normaliseRegistry,
	readRegistry,
	removeEntry,
	scanConfigs,
	writeRegistry,
	registryFile,
} from '../lib/portfolio-registry.mjs';
import {
	collectRow,
	errored,
	liveContext,
	pool,
	sunsetReason,
	sunsetVerdict,
} from '../lib/portfolio-probes.mjs';

// Behaviour lives in lib/; these re-exports keep the module's public surface.
export {
	addEntry,
	normaliseRegistry,
	readRegistry,
	removeEntry,
	scanConfigs,
	writeRegistry,
};
export { collectRow, pool, sunsetReason, sunsetVerdict };

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

const DEFAULT_FLOOR = 10;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DEPTH = 4;

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
		{ header: 'revenue/mo', get: (r) => (r.revenue === null ? c.dim(DASH) : moneyOrDash(r.revenue)) },
		{ header: 'ad spend', get: (r) => (r.spend === null ? c.dim(DASH) : moneyOrDash(r.spend)) },
		{ header: 'verdict', get: (r) => verdictCell(r) },
	]);

	const sunset = rows.filter((r) => r.sunset);
	const broken = rows.filter((r) => errored(r));
	const totals = totalsOf(rows);

	process.stdout.write('\n');
	info(
		`${rows.length} app${rows.length === 1 ? '' : 's'} · ${c.bold(moneyOrDash(totals.revenue))}/mo revenue · ${c.bold(moneyOrDash(totals.spend))} ads (30d) · net ${c.bold(moneyOrDash(totals.revenue - totals.spend))}`,
	);

	for (const r of sunset) {
		warn(`sunset candidate: ${r.name}`);
		note(sunsetReason(r) || `all three gates passed at a ${moneyOrDash(floor)} floor`);
	}
	if (!sunset.length && rows.length) good(`no sunset candidates at a ${moneyOrDash(floor)}/mo floor`);

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
	if (flags.json) emit({ generatedAt: new Date().toISOString(), registry: file, floor, totals, apps: rows });
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

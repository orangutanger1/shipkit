// ASC plumbing for `ship price`: capability discovery, live price reads, the
// plan file, and the dry-run-aware mutation wrapper. Everything here talks to
// `asc`, the filesystem, or RevenueCat; the numbers it carries are pure and
// live in lib/pricing.mjs, and the commands that print them in
// commands/price.mjs.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ShipError } from '../log.mjs';
import { ASC, asc, ascMutate as execAscMutate, run as exec, which } from '../exec.mjs';
import { num, round2 } from './fmt.mjs';
import { rowsOf } from './asc-report.mjs';
import { MIN_PROCEEDS_USD, normaliseTerritory, trialDaysOf } from './pricing.mjs';
import { apiKey, listOfferings, resolveProject } from './revenuecat.mjs';

// ─── asc capability discovery ────────────────────────────────────────────────

const helpCache = new Map();

/**
 * Subcommands the installed asc advertises under a command. asc prints them as
 * an indented two-column block, either after a `SUBCOMMANDS` header or, at the
 * top level, under `... COMMANDS` group headers with a colon after the name.
 */
export async function subcommandsOf(path) {
	const key = path.join(' ');
	if (helpCache.has(key)) return helpCache.get(key);
	const res = await exec(ASC, [...path, '--help'], { allowFail: true });
	const found = new Set();
	for (const line of `${res.stdout}\n${res.stderr}`.split('\n')) {
		const m = /^ {2,}([a-z][a-z0-9-]*):?\s{2,}\S/.exec(line);
		if (m) found.add(m[1]);
	}
	helpCache.set(key, found);
	return found;
}

/**
 * Fail on a missing capability by naming it. An `asc` too old for territory
 * pricing is a normal state; dumping its usage screen at the user is not an
 * answer to "why did ship price stop".
 */
export async function requireAsc(path) {
	const parent = path.slice(0, -1);
	const leaf = path[path.length - 1];
	const have = await subcommandsOf(parent);
	if (have.has(leaf)) return;
	throw new ShipError(`the installed asc has no \`${path.join(' ')}\` command`, {
		hint:
			`\`asc ${parent.join(' ')} --help\` offers: ${[...have].join(', ') || '(nothing this tool recognises)'}\n` +
			'ship price needs `asc pricing current`, `asc pricing schedule` and `asc subscriptions pricing prices`. Update asc, then retry.',
	});
}

// ─── live reads ──────────────────────────────────────────────────────────────

const idOf = (v) => (typeof v === 'string' ? v : (v?.id ?? v?.data?.id ?? null));

/**
 * Normalise one live price row. Territories arrive as alpha-3 ids on the raw
 * JSON:API shape and as names or codes on the flattened one; prices arrive as
 * strings. A row we cannot read is dropped, never guessed — an unreadable price
 * must not become a price we overwrite unguarded.
 */
export function livePrice(r) {
	const a = r?.attributes ?? {};
	const price = num(a.customerPrice ?? r?.customerPrice ?? a.price ?? r?.price, Number.NaN);
	const territory = normaliseTerritory(
		idOf(r?.territory) ??
			idOf(a.territory) ??
			r?.territoryCode ??
			a.territoryCode ??
			idOf(r?.relationships?.territory?.data) ??
			'',
	);
	if (!territory || !Number.isFinite(price)) return null;
	return {
		territory,
		price,
		currency: a.currency ?? a.currencyCode ?? r?.currency ?? r?.currencyCode ?? null,
	};
}

/** Territory → live price, first reading wins. */
export const priceMap = (payload) => {
	const map = new Map();
	for (const r of rowsOf(payload)) {
		const p = livePrice(r);
		if (p && !map.has(p.territory)) map.set(p.territory, p);
	}
	return map;
};

/** Subscriptions in the app, flattened to the fields the readers below need. */
export async function listSubscriptions(appId) {
	const payload = await asc(['subscriptions', 'list', '--app', appId, '--paginate'], { fallback: null });
	return rowsOf(payload)
		.map((s) => ({
			id: s?.id ?? s?.attributes?.id ?? null,
			productId: s?.productId ?? s?.attributes?.productId ?? null,
			name: s?.name ?? s?.attributes?.name ?? s?.attributes?.referenceName ?? null,
			// null, never a default: a period we cannot read must not audit as a
			// monthly, and an absent trial must not read as "no trial".
			period: s?.attributes?.subscriptionPeriod ?? s?.subscriptionPeriod ?? null,
			trialDays: trialDaysOf(s),
		}))
		.filter((s) => s.id || s.productId);
}

export async function resolveSubscription(appId, flags) {
	if (flags.subscription) return String(flags.subscription);
	const subs = await listSubscriptions(appId);
	if (!subs.length)
		throw new ShipError('this app has no subscriptions', {
			hint: 'pass --app-price to price the app itself, or --subscription <id> if asc cannot list them',
		});
	if (subs.length > 1)
		throw new ShipError(`this app has ${subs.length} subscriptions; name the one to price`, {
			hint: `--subscription ${subs.map((s) => s.productId ?? s.id).join(' | ')}`,
		});
	return subs[0].id ?? subs[0].productId;
}

/**
 * Live per-territory prices for a subscription. Throws rather than guessing.
 * asc emits `{data:[...]}` for raw API payloads and a bare array once unwrapped
 * — except `subscriptions pricing prices list`, which names its own envelope
 * `prices`. Missing that key is why a per-territory read looks empty on an app
 * whose prices are all set; rowsOf knows that envelope, so the read does not.
 */
export async function subscriptionPrices(subId, appId) {
	const payload = await asc([
		'subscriptions', 'pricing', 'prices', 'list',
		'--subscription-id', subId, '--app', appId, '--resolved', '--paginate',
	]);
	return priceMap(payload);
}

// ─── the plan file ───────────────────────────────────────────────────────────

export const planFileOf = (cfg) => join(cfg.paths.pricing, 'plan.json');

export async function readPlanFile(cfg) {
	const file = planFileOf(cfg);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

/**
 * The floor is a business rule, not a constant: a subscription that nets less
 * than a third of what you pay for an install can never repay one, so the ads
 * target sets the floor whenever it is configured.
 */
export function floorFor(cfg, flags) {
	if (flags.floor !== undefined) return Math.max(0, num(flags.floor, MIN_PROCEEDS_USD));
	const cpi = num(cfg.ads?.targetCpi, 0);
	return cpi > 0 ? Math.max(MIN_PROCEEDS_USD, round2(cpi / 3)) : MIN_PROCEEDS_USD;
}

/**
 * A mutation that participates in --dry-run and treats a non-zero exit as
 * fatal. exec.mjs's `ascMutate` returns `ok:false` and lets every caller decide
 * whether one failure among N aborts the batch; `ship price apply` refuses
 * half-applied batches, so here a failed asc call always aborts, carrying the
 * tail of asc's own output as the hint. Returns the exec result — call sites
 * read `.skipped`.
 */
export async function ascMutate(args) {
	const res = await execAscMutate(args);
	if (!res.skipped && !res.ok)
		throw new ShipError(`asc ${args.slice(0, 4).join(' ')} exited ${res.code}`, {
			hint: res.stderr.split('\n').slice(-8).join('\n'),
		});
	return res;
}

// ─── audit gathering ─────────────────────────────────────────────────────────

/**
 * The App Store Connect half. Returns `subs: null` — not an empty list — when we
 * could not read ASC at all: "this app has no subscriptions" and "this machine
 * has no credentials" are different answers, and only the first is a finding.
 */
export async function ladderSubscriptions(appId) {
	if (!appId) return { subs: null, why: 'no App Store Connect app id — set asc.appId in ship.config.json' };
	if (!(await which(ASC))) return { subs: null, why: 'asc is not on PATH — see `ship doctor`' };
	const auth = await asc(['auth', 'status'], { fallback: null });
	if (!auth?.credentials?.length) return { subs: null, why: 'no App Store Connect credentials — `asc auth login`' };
	const subs = await listSubscriptions(appId).catch(() => null);
	if (!subs) return { subs: null, why: '`asc subscriptions list` did not answer' };
	// One price read per subscription: every edge of the ladder is argued in the
	// US number, and an unreadable one stays null so the audit can say so.
	await Promise.all(
		subs.map(async (s) => {
			const prices = await subscriptionPrices(s.id ?? s.productId, appId).catch(() => null);
			s.priceUsd = prices?.get('US')?.price ?? null;
		}),
	);
	return { subs, why: null };
}

/** The RevenueCat half. A missing key is a skip, never a failure of this command. */
export async function ladderOfferings(cfg) {
	if (!(await apiKey({ optional: true }))) return { offerings: null, why: 'no RevenueCat v2 key — see `ship doctor`' };
	try {
		const project = await resolveProject(cfg);
		if (!project) return { offerings: null, why: 'no revenuecat.projectId in ship.config.json' };
		return { offerings: await listOfferings(project.id), why: null };
	} catch (err) {
		return { offerings: null, why: `offerings unreadable — ${err.message}` };
	}
}

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
import { strOrNull } from './util.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./util.mjs').Flags} Flags */
/** @typedef {import('../exec.mjs').AscPayload} AscPayload */
/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('./pricing.mjs').PricedRow} PricedRow */
/** @typedef {import('./pricing.mjs').LivePrice} LivePrice */
/** @typedef {import('./revenuecat.mjs').RcRow} RcRow */
/** Every JSON scalar, i.e. exactly what `num` coerces. */
/** @typedef {string|number|boolean|null} Num */
/**
 * One row of an asc payload, viewed loosely: report rows, list rows and
 * subscription rows share one view whose fields are as loose as the payload
 * allows. `attributes`/`data` recurse because JSON:API nests them.
 * @typedef {JsonObject & {
 *   attributes?: Row, data?: Row, id?: Json, type?: Json,
 *   customerPrice?: Num, price?: Num, territory?: Json, territoryCode?: Json,
 *   currency?: Json, currencyCode?: Json, productId?: Json, name?: Json,
 *   referenceName?: Json, subscriptionPeriod?: Json,
 *   relationships?: JsonObject & {territory?: Row},
 * }} Row
 */
/**
 * One subscription flattened to the fields the price readers need. `id`,
 * `productId` and `name` are narrowed at the read boundary: ASC carries them
 * as strings or not at all.
 * @typedef {{
 *   id: string|null, productId: string|null, name: string|null,
 *   period: Json|null, trialDays: number|null, priceUsd?: number|null,
 * }} SubscriptionRow
 */
/** One live per-territory price reading, as `priceMap` collects it. */
/** @typedef {{territory: string, price: number, currency: Json|null}} PriceRow */

/** @param {Json|undefined} v @returns {v is Row} */
const isRow = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * View any JSON value as a {@link Row}: objects pass through untouched,
 * anything else reads as an empty row — exactly what property access on a
 * scalar would have yielded.
 * @param {Json|undefined} v
 * @returns {Row}
 */
const asRow = (v) => (isRow(v) ? v : {});

// ─── asc capability discovery ────────────────────────────────────────────────

/** @type {Map<string, Set<string>>} */
const helpCache = new Map();

/**
 * Subcommands the installed asc advertises under a command. asc prints them as
 * an indented two-column block, either after a `SUBCOMMANDS` header or, at the
 * top level, under `... COMMANDS` group headers with a colon after the name.
 *
 * @param {string[]} path
 * @returns {Promise<Set<string>>}
 */
async function subcommandsOf(path) {
	const key = path.join(' ');
	const cached = helpCache.get(key);
	if (cached) return cached;
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
 *
 * @param {string[]} path
 * @returns {Promise<void>}
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

/** The id of a JSON:API reference: `{id}` itself, `{data:{id}}`, or a bare string. */
/**
 * @param {Json|undefined} v
 * @returns {Json|null}
 */
const idOf = (v) => {
	if (typeof v === 'string') return v;
	const row = asRow(v);
	return row.id ?? asRow(row.data).id ?? null;
};

/**
 * Normalise one live price row. Territories arrive as alpha-3 ids on the raw
 * JSON:API shape and as names or codes on the flattened one; prices arrive as
 * strings. A row we cannot read is dropped, never guessed — an unreadable price
 * must not become a price we overwrite unguarded.
 *
 * @param {Json} r
 * @returns {PriceRow|null}
 */
function livePrice(r) {
	const row = asRow(r);
	const a = asRow(row.attributes);
	const price = num(a.customerPrice ?? row.customerPrice ?? a.price ?? row.price, Number.NaN);
	const territory = normaliseTerritory(
		idOf(row.territory) ??
			idOf(a.territory) ??
			row.territoryCode ??
			a.territoryCode ??
			idOf(row.relationships?.territory?.data) ??
			'',
	);
	if (!territory || !Number.isFinite(price)) return null;
	return {
		territory,
		price,
		currency: a.currency ?? a.currencyCode ?? row.currency ?? row.currencyCode ?? null,
	};
}

/**
 * Territory → live price, first reading wins.
 * @param {Json|undefined} payload
 * @returns {Map<string, PriceRow>}
 */
export const priceMap = (payload) => {
	/** @type {Map<string, PriceRow>} */
	const map = new Map();
	for (const r of rowsOf(payload)) {
		const p = livePrice(r);
		if (p && !map.has(p.territory)) map.set(p.territory, p);
	}
	return map;
};

/**
 * Subscriptions in the app, flattened to the fields the readers below need.
 * @param {string} appId
 * @returns {Promise<SubscriptionRow[]>}
 */
export async function listSubscriptions(appId) {
	const payload = await asc(['subscriptions', 'list', '--app', appId, '--paginate'], { fallback: null });
	return rowsOf(payload)
		.map((s) => {
			const row = asRow(s);
			const a = asRow(row.attributes);
			return {
				id: strOrNull(row.id ?? a.id),
				productId: strOrNull(row.productId ?? a.productId),
				name: strOrNull(row.name ?? a.name ?? a.referenceName),
				// null, never a default: a period we cannot read must not audit as a
				// monthly, and an absent trial must not read as "no trial".
				period: row.subscriptionPeriod ?? a.subscriptionPeriod ?? null,
				trialDays: trialDaysOf(s),
			};
		})
		.filter((s) => s.id || s.productId);
}

/**
 * @param {string} appId
 * @param {Flags} flags
 * @returns {Promise<string>}
 */
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
	// The `.filter` above guarantees a subscription carries an id or a product id.
	return /** @type {string} */ (subs[0].id ?? subs[0].productId);
}

/**
 * Live per-territory prices for a subscription. Throws rather than guessing.
 * asc emits `{data:[...]}` for raw API payloads and a bare array once unwrapped
 * — except `subscriptions pricing prices list`, which names its own envelope
 * `prices`. Missing that key is why a per-territory read looks empty on an app
 * whose prices are all set; rowsOf knows that envelope, so the read does not.
 *
 * @param {string} subId
 * @param {string} appId
 * @returns {Promise<Map<string, PriceRow>>}
 */
export async function subscriptionPrices(subId, appId) {
	const payload = await asc([
		'subscriptions', 'pricing', 'prices', 'list',
		'--subscription-id', subId, '--app', appId, '--resolved', '--paginate',
	]);
	return priceMap(payload);
}

// ─── the plan file ───────────────────────────────────────────────────────────

/**
 * @param {Config} cfg
 * @returns {string}
 */
export const planFileOf = (cfg) => join(cfg.paths.pricing, 'plan.json');

/**
 * plan.json as `ship price plan` wrote it: the derived table plus its
 * provenance.
 * @typedef {import('./pricing.mjs').DerivedPlan & {
 *   generatedAt: string,
 *   app: {name: string, bundleId: string, appId: string|null},
 *   conventions: Record<string, {label: string, why: string}>,
 * }} PlanDoc
 */

/**
 * @param {Config} cfg
 * @returns {Promise<PlanDoc|null>}
 */
export async function readPlanFile(cfg) {
	const file = planFileOf(cfg);
	if (!existsSync(file)) return null;
	try {
		return /** @type {PlanDoc} */ (JSON.parse(await readFile(file, 'utf8')));
	} catch (/** @type {any} */ err) {
		// Only readFile and JSON.parse throw in here, and both throw Errors.
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

/**
 * The floor is a business rule, not a constant: a subscription that nets less
 * than a third of what you pay for an install can never repay one, so the ads
 * target sets the floor whenever it is configured.
 *
 * @param {Config} cfg
 * @param {Flags} flags
 * @returns {number}
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
 *
 * @param {string[]} args
 * @returns {Promise<{ok: boolean, skipped: boolean, code: number, data: AscPayload|null, stderr: string}>}
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
 *
 * @param {string|null} appId
 * @returns {Promise<{subs: SubscriptionRow[], why: null} | {subs: null, why: string}>}
 */
export async function ladderSubscriptions(appId) {
	if (!appId) return { subs: null, why: 'no App Store Connect app id — set asc.appId in ship.config.json' };
	if (!(await which(ASC))) return { subs: null, why: 'asc is not on PATH — see `ship doctor`' };
	const auth = await asc(['auth', 'status'], { fallback: null });
	const authRow = asRow(auth);
	if (!Array.isArray(authRow.credentials) || !authRow.credentials.length)
		return { subs: null, why: 'no App Store Connect credentials — `asc auth login`' };
	// `asc(…, {fallback: null})` answers null for every failure it can survive, so
	// listSubscriptions resolves to a list or throws past this function entirely.
	const subs = await listSubscriptions(appId);
	// One price read per subscription: every edge of the ladder is argued in the
	// US number, and an unreadable one stays null so the audit can say so.
	await Promise.all(
		subs.map(async (s) => {
			// listSubscriptions' filter guarantees one of the two is a string.
			const prices = await subscriptionPrices(/** @type {string} */ (s.id ?? s.productId), appId).catch(() => null);
			s.priceUsd = prices?.get('US')?.price ?? null;
		}),
	);
	return { subs, why: null };
}

/**
 * The RevenueCat half. A missing key is a skip, never a failure of this command.
 * @param {Config} cfg
 * @returns {Promise<{offerings: RcRow[]|null, why: string|null}>}
 */
export async function ladderOfferings(cfg) {
	if (!(await apiKey({ optional: true }))) return { offerings: null, why: 'no RevenueCat v2 key — see `ship doctor`' };
	try {
		const project = await resolveProject(cfg);
		if (!project) return { offerings: null, why: 'no revenuecat.projectId in ship.config.json' };
		return { offerings: await listOfferings(project.id), why: null };
	} catch (err) {
		return { offerings: null, why: `offerings unreadable — ${err instanceof Error ? err.message : String(err)}` };
	}
}

// `ship status` — the sections App Store Connect cannot see: RevenueCat wiring,
// Apple Ads spend, staged-listing depth, and OTA safety. These are the places
// where a release is broken while every ASC console looks green.
import { asc } from '../exec.mjs';
import { LIMITS } from '../config.mjs';
import { ShipError, c, note } from '../log.mjs';
import { metric, reportRows } from './asc-report.mjs';
import { DASH } from './fmt.mjs';
import { keywordList, readStaged } from './locales.mjs';
import { otaSafety } from './native.mjs';
import { kvTable } from './output.mjs';
import { median, objOrEmpty, strOrNull } from './util.mjs';
import { apiKey, listEntitlements, listOfferings, listPackages, listProducts, resolveProject } from './revenuecat.mjs';

/** @typedef {import('./status-asc.mjs').StatusCtx} StatusCtx */
/**
 * "Not wired up" is as real an answer as a number, so each section answers with
 * a union rather than one bag of optionals — the renderer returns early on the
 * empty arm and the compiler knows the rest of the fields are there.
 * @typedef {{skipped: string}} RevenueSkipped
 * @typedef {{project: {id: string, name: string}, offerings: number, currentOffering: {lookup_key: string, packages: number}|null, entitlement: string|null, entitlementPresent: boolean|null, entitlements: string[], products: number}} RevenueFull
 * @typedef {RevenueSkipped|RevenueFull} RevenueData
 */
/**
 * @typedef {{configured: false, storage: Json}} AdsUnconfigured
 * @typedef {{configured: true, org: null}} AdsNoOrg
 * @typedef {{configured: true, org: string, campaigns: number, spend: number, installs: number, taps: number, impressions: number, cpi: number|null}} AdsFull
 * @typedef {AdsUnconfigured|AdsNoOrg|AdsFull} AdsData
 */
/** @typedef {import('./util.mjs').Json} Json */

/* -------------------------------------------------------------- revenue -- */

/** @param {StatusCtx} ctx @returns {Promise<RevenueData>} */
export async function collectRevenue(ctx) {
	if (!(await apiKey({ optional: true }))) return { skipped: 'no RevenueCat API key' };
	const project = await resolveProject(ctx.cfg);
	if (!project) return { skipped: 'no RevenueCat project selected' };
	const [offerings, entitlements, products] = await Promise.all([
		listOfferings(project.id),
		listEntitlements(project.id),
		listProducts(project.id),
	]);
	const current = offerings.find((o) => o.is_current) ?? null;
	// An offering with zero packages renders an empty paywall; the count is the
	// whole point of putting RevenueCat on this dashboard.
	const packages = current ? await listPackages(project.id, current.id) : [];
	const wanted = ctx.cfg.revenuecat?.entitlement ?? null;
	return {
		project: { id: project.id, name: strOrNull(project.name) ?? project.id },
		offerings: offerings.length,
		currentOffering: current ? { lookup_key: strOrNull(current.lookup_key) ?? DASH, packages: packages.length } : null,
		entitlement: wanted,
		entitlementPresent: wanted ? entitlements.some((e) => e.lookup_key === wanted) : null,
		entitlements: entitlements.map((e) => strOrNull(e.lookup_key) ?? DASH),
		products: products.length,
	};
}

/** @param {RevenueData} d */
export function renderRevenue(d) {
	if ('skipped' in d) {
		note(c.dim(`skipped — ${d.skipped}`));
		return;
	}
	const offering = d.currentOffering
		? `${d.currentOffering.lookup_key} ${d.currentOffering.packages ? c.green(`${d.currentOffering.packages} packages`) : c.red('0 packages')}`
		: c.red('none marked current');
	const entitlement = d.entitlement
		? d.entitlementPresent
			? c.green(d.entitlement)
			: c.red(`${d.entitlement} (missing)`)
		: c.dim('unset');
	kvTable([
		['project', `${d.project.name} ${c.dim(d.project.id)}`],
		['current offering', offering],
		['entitlement', entitlement],
		['products', d.products ? String(d.products) : c.red('0')],
	]);
}

/* ------------------------------------------------------------------ ads -- */

/** @param {StatusCtx} ctx @returns {Promise<AdsData>} */
export async function collectAds(ctx) {
	const auth = objOrEmpty(await asc(['ads', 'auth', 'status'], { fallback: null }));
	const credentials = auth.credentials;
	if (!Array.isArray(credentials) || !credentials.length) return { configured: false, storage: auth.storage ?? null };

	const active = objOrEmpty(auth.active);
	const org = ctx.cfg.ads?.orgId ?? process.env.ASC_ADS_ORG_ID ?? active.org ?? active.orgId ?? null;
	if (!org) return { configured: true, org: null };

	const report = await asc(
		[
			'ads', 'reports', 'preset',
			'--level', 'campaigns',
			'--last-days', '7',
			'--granularity', 'DAILY',
			'--fields', 'campaignName,impressions,taps,localSpend,totalInstalls',
			'--org', String(org),
		],
		{ fallback: null },
	);
	const rows = reportRows(report);
	const totals = { spend: 0, installs: 0, taps: 0, impressions: 0 };
	for (const row of rows) {
		const r = objOrEmpty(row);
		const t = objOrEmpty(r.total ?? (Array.isArray(r.granularity) ? r.granularity[0] : null));
		totals.spend += metric(t.localSpend);
		totals.installs += metric(t.totalInstalls ?? t.installs);
		totals.taps += metric(t.taps);
		totals.impressions += metric(t.impressions);
	}
	return {
		configured: true,
		org: String(org),
		campaigns: rows.length,
		...totals,
		cpi: totals.installs ? totals.spend / totals.installs : null,
	};
}

/** @param {AdsData} d */
export function renderAds(d) {
	if (!d.configured) {
		note(c.dim('not configured — `asc ads auth login --name N --client-id X --team-id Y --key-id Z --private-key ./k.pem --org ORG`'));
		return;
	}
	if (!d.org) {
		note(c.yellow('credentials stored but no org id — set ads.orgId in ship.config.json (`asc ads auth discover`)'));
		return;
	}
	kvTable([
		['campaigns', String(d.campaigns)],
		['spend (7d)', d.spend.toFixed(2)],
		['installs (7d)', String(d.installs)],
		['taps (7d)', String(d.taps)],
		['cpi', d.cpi === null ? c.dim(DASH) : d.cpi.toFixed(2)],
	]);
}

/* -------------------------------------------------------------- listing -- */

/** @param {StatusCtx} ctx */
export async function collectListing(ctx) {
	const staged = await readStaged(ctx.cfg);
	const locales = staged.map((entry) => {
		// ASC indexes the comma-joined string, so trailing spaces after commas are
		// wasted slots. Measure what Apple measures, not what the file contains.
		const used = keywordList(entry.data?.keywords).join(',').length;
		return { locale: entry.locale, used, terms: keywordList(entry.data?.keywords).length };
	});
	const lengths = locales.map((l) => l.used);
	return {
		locales: locales.length,
		limit: LIMITS.keywords,
		min: lengths.length ? Math.min(...lengths) : 0,
		median: median(lengths),
		max: lengths.length ? Math.max(...lengths) : 0,
		underfilled: locales.filter((l) => l.used < LIMITS.keywords * 0.8).map((l) => l.locale),
		byLocale: locales,
	};
}

/** @param {Awaited<ReturnType<typeof collectListing>>} d */
export function renderListing(d) {
	if (!d.locales) {
		note(c.dim('no staged listings — `ship meta stage`'));
		return;
	}
	const pctOf = (/** @type {number} */ n) => `${n}/${d.limit} ${c.dim(`(${Math.round((n / d.limit) * 100)}%)`)}`;
	note(`${d.locales} staged locale${d.locales === 1 ? '' : 's'}`);
	kvTable([
		['keywords min', pctOf(d.min)],
		['keywords median', pctOf(d.median)],
		['keywords max', pctOf(d.max)],
	]);
	// Unused keyword characters are free impressions being thrown away.
	if (d.underfilled.length) note(c.yellow(`under 80% of the keyword field: ${d.underfilled.join(', ')}`));
}

/* ------------------------------------------------------------------ ota -- */

/** @param {StatusCtx} ctx */
export async function collectOta(ctx) {
	const version = await ctx.version();
	if (!version) throw new ShipError('cannot determine app version');
	const safety = await otaSafety(ctx.cfg, version);
	return {
		safe: safety.safe,
		reason: safety.reason,
		added: safety.added,
		removed: safety.removed,
		changed: safety.changed,
		configChanged: safety.configChanged,
		lockVersion: safety.lock?.version ?? null,
	};
}

/** @param {Awaited<ReturnType<typeof collectOta>>} d */
export function renderOta(d) {
	note(d.safe ? c.green(`OTA safe — ${d.reason}`) : c.yellow(`native build required — ${d.reason}`));
	/** @type {[string, string[]][]} */
	const drift = [
		['added', d.added],
		['removed', d.removed],
		['changed', d.changed],
		['config', d.configChanged],
	];
	for (const [label, list] of drift) if (list.length) note(`${label}: ${list.join(', ')}`);
}

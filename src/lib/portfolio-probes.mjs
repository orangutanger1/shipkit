// ship portfolio probes: the per-app collectors (ASC, RevenueCat, Apple Ads)
// and the sunset gate. Every probe degrades to a `{skipped}` or an error
// string rather than rejecting — a dashboard that throws on the first
// unconfigured app is a dashboard nobody runs.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_NAME, loadConfig } from '../config.mjs';
import { asc, fetchJSON } from '../exec.mjs';
import { ShipError } from '../log.mjs';
import { metric, reportRows } from './asc-report.mjs';
import { daysElapsed } from './dates.mjs';
import { moneyOrDash, num } from './fmt.mjs';
import { apiKey, listProjects } from './revenuecat.mjs';
import { memo, settle } from './util.mjs';

const AGE_DAYS = 90;
const RELEASE_DAYS = 60;
const DEFAULT_FLOOR = 10;
const DEFAULT_CONCURRENCY = 4;

/** RevenueCat v2 aggregate metrics; the REST client exposes catalogue, not money. */
const RC_METRICS = (projectId) => `https://api.revenuecat.com/v2/projects/${projectId}/metrics/overview`;

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
				? `${moneyOrDash(revenue)}/mo ${Number(revenue) < floor ? '<' : '>='} ${moneyOrDash(floor)} floor`
				: `revenue unknown (floor ${moneyOrDash(floor)})`,
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

const numOrNull = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** ASC: review state, live version, newest build, first and last release dates. */
async function ascProbe(appId) {
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
		ascFor: (appId) => ascProbe(appId),
		revenueFor: (cfg) => revenueProbe(cfg, projects),
		adsFor: (cfg) => adsProbe(cfg, credentialed),
	};
}

function verdictOf(row, ctx) {
	const sunset = sunsetVerdict(row, { floor: ctx.floor });
	return { sunset: sunset.sunset, verdict: row.error ? 'error' : sunset.verdict, gates: sunset.gates };
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
	if (!existsSync(join(entry.path, CONFIG_NAME))) return fail(`no ${CONFIG_NAME} in ${entry.path}`);

	let cfg;
	try {
		cfg = await loadConfig(entry.path);
	} catch (err) {
		return fail(err?.message ?? String(err));
	}

	const appId = cfg.asc?.appId ? String(cfg.asc.appId) : (process.env.ASC_APP_ID ?? null);
	const [ascRes, revRes, adsRes] = await Promise.all([
		settle(() => ctx.ascFor(appId)),
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
		ageDays: daysElapsed(ascRes.value?.firstReleaseAt, ctx.now),
		daysSinceRelease: daysElapsed(ascRes.value?.lastReleaseAt, ctx.now),
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

/** A row nobody can act on: the config broke, or a probe failed outright. */
export const errored = (row) => !!row.error || Object.keys(row.errors ?? {}).length > 0;

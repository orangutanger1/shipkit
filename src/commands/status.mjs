// ship status — the one pane that replaces four browser tabs.
//
// `asc status` already aggregates app + builds + TestFlight + App Store version +
// submission + review + phased release into a single call, so this command does
// not hand-assemble any of that. It spends its budget on the three things App
// Store Connect cannot see: RevenueCat wiring, staged-listing depth, and OTA
// safety — the places where a release is broken but every console looks green.
//
// Every section is independently fault-isolated. A dashboard that dies whole
// because one endpoint 403s is worse than no dashboard: you stop trusting it and
// go back to opening tabs. A dead section prints a dim line and the rest render.
import { LIMITS, loadConfig, readExpoConfig, resolveVersion } from '../config.mjs';
import { asc } from '../exec.mjs';
import { keywordList, readStaged } from '../lib/locales.mjs';
import { otaSafety } from '../lib/native.mjs';
import {
	apiKey,
	listEntitlements,
	listOfferings,
	listPackages,
	listProducts,
	resolveProject,
} from '../lib/revenuecat.mjs';
import { ShipError, c, heading, note, table } from '../log.mjs';

export const help = `
${c.bold('ship status')} ${c.dim('— release dashboard: ASC, TestFlight, RevenueCat, ads, listing, OTA')}

${c.dim('usage:')} ship status [flags]

${c.bold('Sections')}
  ${c.cyan('app')}         identity: name, bundle id, ASC app id, version, EAS project
  ${c.cyan('review')}      newest 3 App Store versions and their review states
  ${c.cyan('builds')}      newest 5 builds: processing state, upload and expiry
  ${c.cyan('testflight')}  beta groups and tester counts
  ${c.cyan('revenue')}     RevenueCat project, current offering, entitlement, catalogue
  ${c.cyan('ads')}         Apple Ads last-7-day spend, installs, derived CPI
  ${c.cyan('listing')}     staged locales and keyword-field utilisation
  ${c.cyan('ota')}         whether the next update can ship over the air

${c.bold('Flags')}
  ${c.cyan('--section <name>')}  render one section instead of all
  ${c.cyan('--json')}            one object containing every section

${c.dim('Read-only. Exit code is always 0 — gates live in `ship doctor` and `ship preflight`.')}
`;

/** Cache an async call so sibling sections share one network round trip. */
function memo(fn) {
	let promise;
	return () => (promise ??= fn());
}

const DASH = '—';
const dim = (s) => (s ? String(s) : c.dim(DASH));

/** ASC timestamps are ISO with an offset; minutes are the useful resolution. */
const when = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') : DASH);

const DAY = 86_400_000;
const daysUntil = (iso) => (iso ? Math.round((Date.parse(iso) - Date.now()) / DAY) : null);

/**
 * Colour the review state the way you would read it: green means done, yellow
 * means Apple owns the ball, red means you do.
 */
function stateColour(state) {
	const s = String(state ?? '');
	if (!s) return c.dim(DASH);
	if (s === 'READY_FOR_SALE') return c.green(s);
	if (/REJECTED/.test(s)) return c.red(s);
	if (s === 'WAITING_FOR_REVIEW' || s === 'IN_REVIEW' || s.startsWith('PENDING_')) return c.yellow(s);
	return s;
}

const median = (nums) => {
	if (!nums.length) return 0;
	const sorted = [...nums].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/** Every section that needs an app id gets the same failure with the same fix. */
function needAppId(ctx) {
	if (!ctx.appId)
		throw new ShipError('no App Store Connect app id', {
			hint: 'set asc.appId in ship.config.json (find it with `asc apps list`)',
		});
	return ctx.appId;
}

/* ------------------------------------------------------------------ app -- */

async function collectApp(ctx) {
	const { cfg } = ctx;
	const [dash, expo, version] = await Promise.all([ctx.dash(), ctx.expo(), ctx.version()]);
	const view = ctx.appId
		? await asc(['apps', 'view', '--id', ctx.appId], { fallback: null })
		: null;
	const attrs = view?.data?.attributes ?? {};
	return {
		name: attrs.name ?? dash?.app?.name ?? cfg.name,
		configName: cfg.name,
		bundleId: attrs.bundleId ?? dash?.app?.bundleId ?? cfg.bundleId,
		configBundleId: cfg.bundleId,
		appId: ctx.appId,
		sku: attrs.sku ?? null,
		primaryLocale: attrs.primaryLocale ?? cfg.asc.primaryLocale,
		version,
		easProjectId: cfg.eas.projectId ?? expo?.extra?.eas?.projectId ?? null,
		easChannel: cfg.eas.channel,
		health: dash?.summary?.health ?? null,
		nextAction: dash?.summary?.nextAction ?? null,
		links: dash?.links ?? null,
	};
}

function renderApp(d) {
	const rows = [
		['name', dim(d.name)],
		['bundle id', dim(d.bundleId)],
		['asc app id', d.appId ? d.appId : c.yellow('unset')],
		['version', dim(d.version)],
		['primary locale', dim(d.primaryLocale)],
		['eas project', d.easProjectId ? `${d.easProjectId} ${c.dim(`(${d.easChannel})`)}` : c.dim('none')],
	];
	table(rows, [
		{ header: 'field', get: (r) => r[0] },
		{ header: 'value', get: (r) => r[1] },
	]);
	// A bundle id that drifted from the config is why a build uploads to the
	// wrong app and then "disappears" from TestFlight.
	if (d.bundleId && d.configBundleId && d.bundleId !== d.configBundleId)
		note(c.red(`ASC bundle id is ${d.bundleId} but ship.config.json says ${d.configBundleId}`));
	if (d.nextAction) {
		const paint = d.health === 'green' ? c.green : d.health === 'red' ? c.red : c.yellow;
		note(`${paint('next')} ${d.nextAction}`);
	}
	for (const [label, url] of Object.entries(d.links ?? {})) note(`${label}: ${url}`);
}

/* --------------------------------------------------------------- review -- */

async function collectReview(ctx) {
	const appId = needAppId(ctx);
	const dash = await ctx.dash();
	// asc status carries only the live version; the previous two are the context
	// that tells you whether this release is stuck or simply young.
	const list = await asc(
		['versions', 'list', '--app', appId, '--platform', 'IOS', '--limit', '3'],
		{ fallback: { data: [] } },
	);
	const versions = (list?.data ?? [])
		.map((v) => ({
			id: v.id,
			versionString: v.attributes?.versionString ?? DASH,
			appStoreState: v.attributes?.appStoreState ?? v.attributes?.appVersionState ?? DASH,
			releaseType: v.attributes?.releaseType ?? DASH,
			createdDate: v.attributes?.createdDate ?? null,
		}))
		.sort((a, b) => Date.parse(b.createdDate ?? 0) - Date.parse(a.createdDate ?? 0))
		.slice(0, 3);
	return {
		current: dash?.appstore?.state ?? versions[0]?.appStoreState ?? null,
		currentVersion: dash?.appstore?.version ?? versions[0]?.versionString ?? null,
		submissionInFlight: dash?.submission?.inFlight ?? null,
		blockingIssues: dash?.submission?.blockingIssues ?? [],
		reviewState: dash?.review?.state ?? null,
		reviewSubmitted: dash?.review?.submittedDate ?? null,
		phasedRelease: dash?.phasedRelease?.configured ?? null,
		versions,
	};
}

function renderReview(d) {
	table(d.versions, [
		{ header: 'version', get: (v) => v.versionString },
		{ header: 'state', get: (v) => stateColour(v.appStoreState) },
		{ header: 'release', get: (v) => v.releaseType },
		{ header: 'created', get: (v) => when(v.createdDate) },
	]);
	if (d.reviewState)
		note(`submission ${stateColour(d.reviewState)}${d.reviewSubmitted ? ` since ${when(d.reviewSubmitted)}` : ''}`);
	else if (d.submissionInFlight === false) note('no submission in flight');
	for (const issue of d.blockingIssues) note(c.red(`blocker: ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`));
	if (d.phasedRelease) note('phased release configured');
}

/* --------------------------------------------------------------- builds -- */

async function collectBuilds(ctx) {
	const appId = needAppId(ctx);
	// `attributes.version` on a build is the BUILD NUMBER; the marketing version
	// lives on the included preReleaseVersion. Getting this backwards is the
	// classic "why does every build say 1.0" bug.
	const list = await asc(
		['builds', 'list', '--app', appId, '--limit', '5', '--processing-state', 'all'],
		{ fallback: { data: [] } },
	);
	const pre = new Map(
		(list?.included ?? [])
			.filter((i) => i.type === 'preReleaseVersions')
			.map((i) => [i.id, i.attributes?.version ?? null]),
	);
	return (list?.data ?? [])
		.map((b) => ({
			id: b.id,
			version: pre.get(b.relationships?.preReleaseVersion?.data?.id) ?? null,
			buildNumber: b.attributes?.version ?? DASH,
			processingState: b.attributes?.processingState ?? DASH,
			uploadedDate: b.attributes?.uploadedDate ?? null,
			expirationDate: b.attributes?.expirationDate ?? null,
			expiresInDays: daysUntil(b.attributes?.expirationDate),
		}))
		.sort((a, b) => Date.parse(b.uploadedDate ?? 0) - Date.parse(a.uploadedDate ?? 0));
}

function renderBuilds(rows) {
	table(rows, [
		{ header: 'version', get: (b) => b.version ?? c.dim(DASH) },
		{ header: 'build', get: (b) => b.buildNumber },
		{ header: 'state', get: (b) => (b.processingState === 'VALID' ? c.green(b.processingState) : b.processingState === 'FAILED' ? c.red(b.processingState) : c.yellow(b.processingState)) },
		{ header: 'uploaded', get: (b) => when(b.uploadedDate) },
		{
			header: 'expires',
			// TestFlight builds expire after 90 days and silently stop installing;
			// the countdown is the only warning anyone ever gets.
			get: (b) =>
				b.expiresInDays === null
					? c.dim(DASH)
					: `${when(b.expirationDate)} ${b.expiresInDays <= 14 ? c.yellow(`(${b.expiresInDays}d)`) : c.dim(`(${b.expiresInDays}d)`)}`,
		},
	]);
}

/* ----------------------------------------------------------- testflight -- */

async function collectTestFlight(ctx) {
	const appId = needAppId(ctx);
	const [groupsRes, testersRes, dash] = await Promise.all([
		asc(['testflight', 'groups', 'list', '--app', appId], { fallback: { data: [] } }),
		asc(['testflight', 'testers', 'list', '--app', appId], { fallback: { data: [] } }),
		ctx.dash(),
	]);
	const groups = (groupsRes?.data ?? []).map((g) => ({
		name: g.attributes?.name ?? DASH,
		internal: !!g.attributes?.isInternalGroup,
		allBuilds: !!g.attributes?.hasAccessToAllBuilds,
	}));
	const testers = testersRes?.data ?? [];
	const byState = {};
	for (const t of testers) {
		const state = t.attributes?.state ?? 'UNKNOWN';
		byState[state] = (byState[state] ?? 0) + 1;
	}
	return {
		groups,
		testers: testers.length,
		byState,
		betaReviewState: dash?.testflight?.betaReviewState ?? null,
		betaSubmittedDate: dash?.testflight?.submittedDate ?? null,
	};
}

function renderTestFlight(d) {
	if (!d.groups.length && !d.testers) {
		note(c.dim('no beta groups or testers — nothing is being tested'));
		return;
	}
	table(d.groups, [
		{ header: 'group', get: (g) => g.name },
		{ header: 'kind', get: (g) => (g.internal ? 'internal' : c.yellow('external')) },
		{ header: 'all builds', get: (g) => (g.allBuilds ? 'yes' : c.dim('no')) },
	]);
	const breakdown = Object.entries(d.byState)
		.map(([state, n]) => `${n} ${state.toLowerCase()}`)
		.join(', ');
	note(`${d.testers} tester${d.testers === 1 ? '' : 's'}${breakdown ? ` (${breakdown})` : ''}`);
	if (d.betaReviewState)
		note(`beta review ${d.betaReviewState === 'APPROVED' ? c.green(d.betaReviewState) : c.yellow(d.betaReviewState)}${d.betaSubmittedDate ? ` since ${when(d.betaSubmittedDate)}` : ''}`);
}

/* -------------------------------------------------------------- revenue -- */

async function collectRevenue(ctx) {
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
		project: { id: project.id, name: project.name },
		offerings: offerings.length,
		currentOffering: current ? { lookup_key: current.lookup_key, packages: packages.length } : null,
		entitlement: wanted,
		entitlementPresent: wanted ? entitlements.some((e) => e.lookup_key === wanted) : null,
		entitlements: entitlements.map((e) => e.lookup_key),
		products: products.length,
	};
}

function renderRevenue(d) {
	if (d.skipped) {
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
	table(
		[
			['project', `${d.project.name} ${c.dim(d.project.id)}`],
			['current offering', offering],
			['entitlement', entitlement],
			['products', d.products ? String(d.products) : c.red('0')],
		],
		[
			{ header: 'field', get: (r) => r[0] },
			{ header: 'value', get: (r) => r[1] },
		],
	);
}

/* ------------------------------------------------------------------ ads -- */

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

async function collectAds(ctx) {
	const auth = await asc(['ads', 'auth', 'status'], { fallback: null });
	const credentials = auth?.credentials ?? [];
	if (!credentials.length) return { configured: false, storage: auth?.storage ?? null };

	const active = auth?.active ?? {};
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
		const t = row.total ?? row.granularity?.[0] ?? {};
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

function renderAds(d) {
	if (!d.configured) {
		note(c.dim('not configured — `asc ads auth login --name N --client-id X --team-id Y --key-id Z --private-key ./k.pem --org ORG`'));
		return;
	}
	if (!d.org) {
		note(c.yellow('credentials stored but no org id — set ads.orgId in ship.config.json (`asc ads auth discover`)'));
		return;
	}
	table(
		[
			['campaigns', String(d.campaigns)],
			['spend (7d)', d.spend.toFixed(2)],
			['installs (7d)', String(d.installs)],
			['taps (7d)', String(d.taps)],
			['cpi', d.cpi === null ? c.dim(DASH) : d.cpi.toFixed(2)],
		],
		[
			{ header: 'metric', get: (r) => r[0] },
			{ header: 'value', get: (r) => r[1] },
		],
	);
}

/* -------------------------------------------------------------- listing -- */

async function collectListing(ctx) {
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

function renderListing(d) {
	if (!d.locales) {
		note(c.dim('no staged listings — `ship meta stage`'));
		return;
	}
	const pct = (n) => `${n}/${d.limit} ${c.dim(`(${Math.round((n / d.limit) * 100)}%)`)}`;
	note(`${d.locales} staged locale${d.locales === 1 ? '' : 's'}`);
	table(
		[
			['keywords min', pct(d.min)],
			['keywords median', pct(d.median)],
			['keywords max', pct(d.max)],
		],
		[
			{ header: 'field', get: (r) => r[0] },
			{ header: 'value', get: (r) => r[1] },
		],
	);
	// Unused keyword characters are free impressions being thrown away.
	if (d.underfilled.length)
		note(c.yellow(`under 80% of the keyword field: ${d.underfilled.join(', ')}`));
}

/* ------------------------------------------------------------------ ota -- */

async function collectOta(ctx) {
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

function renderOta(d) {
	note(d.safe ? c.green(`OTA safe — ${d.reason}`) : c.yellow(`native build required — ${d.reason}`));
	const drift = [
		['added', d.added],
		['removed', d.removed],
		['changed', d.changed],
		['config', d.configChanged],
	].filter(([, list]) => list.length);
	for (const [label, list] of drift) note(`${label}: ${list.join(', ')}`);
}

/* ----------------------------------------------------------------------- */

const SECTIONS = [
	{ name: 'app', title: 'App', collect: collectApp, render: renderApp },
	{ name: 'review', title: 'Review', collect: collectReview, render: renderReview },
	{ name: 'builds', title: 'Builds', collect: collectBuilds, render: renderBuilds },
	{ name: 'testflight', title: 'TestFlight', collect: collectTestFlight, render: renderTestFlight },
	{ name: 'revenue', title: 'Revenue', collect: collectRevenue, render: renderRevenue },
	{ name: 'ads', title: 'Ads', collect: collectAds, render: renderAds },
	{ name: 'listing', title: 'Listing', collect: collectListing, render: renderListing },
	{ name: 'ota', title: 'OTA', collect: collectOta, render: renderOta },
];

export async function run({ args, flags }) {
	if (args.length)
		throw new ShipError(`status: unexpected argument "${args[0]}"`, {
			hint: `status has no subcommands — use --section <${SECTIONS.map((s) => s.name).join('|')}>`,
		});

	const want = flags.section === undefined ? null : String(flags.section).toLowerCase();
	if (want !== null && !SECTIONS.some((s) => s.name === want))
		throw new ShipError(`status: unknown section "${flags.section}"`, {
			hint: `sections: ${SECTIONS.map((s) => s.name).join(', ')}`,
		});

	const cfg = await loadConfig();
	const ctx = {
		cfg,
		appId: cfg.asc.appId ? String(cfg.asc.appId) : (process.env.ASC_APP_ID ?? null),
		expo: memo(() => readExpoConfig(cfg).catch(() => null)),
		dash: memo(async () =>
			ctx.appId
				? asc(
						[
							'status',
							'--app', ctx.appId,
							'--platform', 'IOS',
							'--include', 'app,builds,testflight,appstore,submission,review,phased-release,links',
						],
						{ fallback: null },
					)
				: null,
		),
		version: memo(async () => {
			const explicit = await resolveVersion(cfg, flags.version === true ? undefined : flags.version).catch(
				() => null,
			);
			if (explicit) return explicit;
			const dash = await ctx.dash();
			return dash?.appstore?.version ?? dash?.builds?.latest?.version ?? null;
		}),
	};

	const chosen = want === null ? SECTIONS : SECTIONS.filter((s) => s.name === want);
	const results = await Promise.all(
		chosen.map(async (section) => {
			try {
				return { section, data: await section.collect(ctx) };
			} catch (err) {
				return { section, error: err.message };
			}
		}),
	);

	if (flags.json) {
		const out = {};
		for (const { section, data, error } of results) out[section.name] = error ? { error } : data;
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		return 0;
	}

	for (const { section, data, error } of results) {
		heading(section.title);
		if (error) {
			note(c.dim(`unavailable — ${error}`));
			continue;
		}
		try {
			section.render(data, ctx);
		} catch (err) {
			note(c.dim(`could not render — ${err.message}`));
		}
	}

	// Always 0: this is a read-only pane, not a gate. `ship doctor` and
	// `ship preflight` own the exit codes that CI keys off.
	return 0;
}

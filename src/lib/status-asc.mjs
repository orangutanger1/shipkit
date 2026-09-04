// `ship status` — the ASC-backed sections: app identity, review, builds,
// TestFlight. `asc status` already aggregates these; the sections only reshape
// what it returns and colour it the way you would read it.
import { asc } from '../exec.mjs';
import { ShipError, c, note, table } from '../log.mjs';
import { daysUntil } from './dates.mjs';
import { DASH } from './fmt.mjs';
import { kvTable } from './output.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../exec.mjs').AscDash} AscDash */
/** @typedef {import('../exec.mjs').AscList} AscList */
/** @typedef {import('../exec.mjs').AscOne} AscOne */
/** @typedef {import('./util.mjs').Json} Json */
/**
 * What `commands/status.mjs` hands every section: the config, the app id, and
 * three memoised reads the sections share so siblings never repeat a network
 * call.
 * @typedef {{
 *   cfg: Config,
 *   appId: string|null,
 *   dash: () => Promise<AscDash|null>,
 *   expo: () => Promise<Record<string, any>|null>,
 *   version: () => Promise<string|null>,
 * }} StatusCtx
 */

/** ASC timestamps are ISO with an offset; minutes are the useful resolution. */
/** @type {(iso: unknown) => string} */
const when = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') : DASH);

/** @type {(s: unknown) => string} */
const dim = (s) => (s ? String(s) : c.dim(DASH));

/** Every section that needs an app id gets the same failure with the same fix. */
/** @param {StatusCtx} ctx @returns {string} */
function needAppId(ctx) {
	if (!ctx.appId)
		throw new ShipError('no App Store Connect app id', {
			hint: 'set asc.appId in ship.config.json (find it with `asc apps list`)',
		});
	return ctx.appId;
}

/**
 * Colour the review state the way you would read it: green means done, yellow
 * means Apple owns the ball, red means you do.
 */
/** @param {unknown} state @returns {string} */
function stateColour(state) {
	const s = String(state ?? '');
	if (!s) return c.dim(DASH);
	if (s === 'READY_FOR_SALE') return c.green(s);
	if (/REJECTED/.test(s)) return c.red(s);
	if (s === 'WAITING_FOR_REVIEW' || s === 'IN_REVIEW' || s.startsWith('PENDING_')) return c.yellow(s);
	return s;
}

/* ------------------------------------------------------------------ app -- */

/** @param {StatusCtx} ctx */
export async function collectApp(ctx) {
	const { cfg } = ctx;
	const [dash, expo, version] = await Promise.all([ctx.dash(), ctx.expo(), ctx.version()]);
	const view = ctx.appId ? /** @type {AscOne|null} */ (await asc(['apps', 'view', '--id', ctx.appId], { fallback: null })) : null;
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

/** @param {Awaited<ReturnType<typeof collectApp>>} d */
export function renderApp(d) {
	kvTable([
		['name', dim(d.name)],
		['bundle id', dim(d.bundleId)],
		['asc app id', d.appId ? d.appId : c.yellow('unset')],
		['version', dim(d.version)],
		['primary locale', dim(d.primaryLocale)],
		['eas project', d.easProjectId ? `${d.easProjectId} ${c.dim(`(${d.easChannel})`)}` : c.dim('none')],
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

/** @param {StatusCtx} ctx */
export async function collectReview(ctx) {
	const appId = needAppId(ctx);
	const dash = await ctx.dash();
	// asc status carries only the live version; the previous two are the context
	// that tells you whether this release is stuck or simply young.
	const list = /** @type {AscList} */ (
		await asc(['versions', 'list', '--app', appId, '--platform', 'IOS', '--limit', '3'], { fallback: { data: [] } })
	);
	const versions = (list?.data ?? [])
		.map((v) => ({
			id: v.id,
			versionString: v.attributes?.versionString ?? DASH,
			appStoreState: v.attributes?.appStoreState ?? v.attributes?.appVersionState ?? DASH,
			releaseType: v.attributes?.releaseType ?? DASH,
			createdDate: v.attributes?.createdDate ?? null,
		}))
		.sort((a, b) => Date.parse(b.createdDate ?? '') - Date.parse(a.createdDate ?? ''))
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

/** @param {Awaited<ReturnType<typeof collectReview>>} d */
export function renderReview(d) {
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

/** @param {StatusCtx} ctx */
export async function collectBuilds(ctx) {
	const appId = needAppId(ctx);
	// `attributes.version` on a build is the BUILD NUMBER; the marketing version
	// lives on the included preReleaseVersion. Getting this backwards is the
	// classic "why does every build say 1.0" bug.
	const list = /** @type {AscList} */ (
		await asc(['builds', 'list', '--app', appId, '--limit', '5', '--processing-state', 'all'], { fallback: { data: [] } })
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
		.sort((a, b) => Date.parse(b.uploadedDate ?? '') - Date.parse(a.uploadedDate ?? ''));
}

/** @param {Awaited<ReturnType<typeof collectBuilds>>} rows */
export function renderBuilds(rows) {
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

/** @param {StatusCtx} ctx */
export async function collectTestFlight(ctx) {
	const appId = needAppId(ctx);
	const [groupsRes, testersRes, dash] = await Promise.all([
		/** @type {Promise<AscList>} */ (asc(['testflight', 'groups', 'list', '--app', appId], { fallback: { data: [] } })),
		/** @type {Promise<AscList>} */ (asc(['testflight', 'testers', 'list', '--app', appId], { fallback: { data: [] } })),
		ctx.dash(),
	]);
	const groups = (groupsRes?.data ?? []).map((g) => ({
		name: g.attributes?.name ?? DASH,
		internal: !!g.attributes?.isInternalGroup,
		allBuilds: !!g.attributes?.hasAccessToAllBuilds,
	}));
	const testers = testersRes?.data ?? [];
	/** @type {Record<string, number>} */
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

/** @param {Awaited<ReturnType<typeof collectTestFlight>>} d */
export function renderTestFlight(d) {
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

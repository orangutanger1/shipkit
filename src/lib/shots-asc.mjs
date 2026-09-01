// App Store Connect screenshot management — everything in the shots workflow
// that speaks to `asc` rather than to the local filesystem: version and
// localization ids, what Apple already has attached, the per-group cap
// arithmetic, normalising asc's validate findings, and the two upload paths
// with their cap pre-flight and result reporting.
//
// The offline half (measuring image headers, scanning the store tree, the
// render pipeline) lives in src/commands/shots.mjs and its sibling libs.
import { asc, ascMutate } from '../exec.mjs';
import { ShipError, c, info, note, step, warn } from '../log.mjs';

/** Apple caps a single locale/displayType group at 10 images. */
export const MAX_PER_GROUP = 10;

/**
 * Directory names are human-written; asc device types are not. Fold both onto
 * one key so `iphone-6.5`, `IPHONE_65` and asc's `APP_IPHONE_65` all meet.
 *
 * The prefix has to go before the separators do: stripping `APP` from a
 * flattened `APPLETV` leaves `LETV`, so an `APPLE_TV` directory could never
 * match asc's own `APP_APPLE_TV`. Anchor on the separator instead.
 */
export const typeKey = (s) =>
	String(s)
		.toUpperCase()
		.replace(/^(?:APP|IMESSAGE_APP)[_-]/, '')
		.replace(/[^A-Z0-9]/g, '');

/** The directory name an operator writes for an asc display type: APP_IPHONE_65 → IPHONE_65. */
export const dirNameOf = (displayType) => String(displayType).replace(/^(?:APP|IMESSAGE_APP)_/, '');

export const dimsOf = (row) =>
	(row.dimensions ?? []).map((d) => ({ width: Number(d.width), height: Number(d.height) }));

export const fmtDims = (dims) => dims.map((d) => `${d.width}x${d.height}`).join('  ');

/**
 * `asc screenshots sizes` → [{displayType, family, dimensions:[{width,height}]}].
 * Memoized: `upload` gates on `validate`, and asking Apple the same question
 * twice in one process is a round-trip that can also rate-limit.
 */
const SIZE_ROWS = new Map();
export async function fetchSizes({ all = true } = {}) {
	if (SIZE_ROWS.has(all)) return SIZE_ROWS.get(all);
	const args = ['screenshots', 'sizes'];
	if (all) args.push('--all');
	const data = await asc(args, { fallback: null });
	const rows = Array.isArray(data) ? data : (data?.sizes ?? data?.data ?? []);
	if (!Array.isArray(rows) || !rows.length)
		throw new ShipError('asc screenshots sizes returned nothing', {
			hint: 'is the asc CLI on PATH and up to date?',
		});
	SIZE_ROWS.set(all, rows);
	return rows;
}

/**
 * appStoreVersion id for this app+version, resolved once per process. An upload
 * across N locales asked ASC the same question N times, and ASC answers a burst
 * with 429s.
 */
const VERSION_IDS = new Map();
export async function versionId(appId, version) {
	const key = `${appId}\u0000${version}`;
	if (!VERSION_IDS.has(key)) {
		const versions = await asc(
			['versions', 'list', '--app', appId, '--version', version, '--platform', 'IOS'],
			{ fallback: null, allowFail: true },
		);
		const id = versions?.data?.[0]?.id;
		if (id) VERSION_IDS.set(key, id);
		else return null;
	}
	return VERSION_IDS.get(key);
}

/**
 * Resolve the appStoreVersionLocalization id. It is the only handle asc accepts
 * for a single-locale upload: app-scoped fan-out demands that the immediate
 * children of --path be locale directories, so it cannot be narrowed to one.
 */
export async function localizationId(appId, version, locale) {
	const vid = await versionId(appId, version);
	if (!vid)
		throw new ShipError(`app ${appId} has no ${version} version`, {
			hint: 'create the version in ASC first (`ship meta stage` then `ship meta apply`)',
		});
	const locs = await asc(['localizations', 'list', '--version', vid, '--locale', locale], {
		fallback: null,
		allowFail: true,
	});
	const id = locs?.data?.find((l) => l.attributes?.locale === locale)?.id ?? locs?.data?.[0]?.id;
	if (!id)
		throw new ShipError(`version ${version} has no ${locale} localization`, {
			hint: '`ship meta apply` creates the localizations before screenshots can attach to them',
		});
	return id;
}

/**
 * What App Store Connect already has attached, per display type. The local tree
 * cannot see this, and it is the half of the arithmetic Apple's cap is applied
 * to — uploads happen from other machines, and an earlier run of this command
 * counts too.
 * @returns {Promise<Map<string, {n:number, dims:Set<string>}>>}
 */
export async function remoteSets(appId, version, locale) {
	const vlid = await localizationId(appId, version, locale);
	const res = await asc(['screenshots', 'list', '--version-localization', vlid], {
		fallback: null,
		allowFail: true,
	});
	const byType = new Map();
	for (const s of Array.isArray(res?.sets) ? res.sets : []) {
		const key = typeKey(s.set?.attributes?.screenshotDisplayType ?? '');
		if (!key) continue;
		const shots = Array.isArray(s.screenshots) ? s.screenshots : [];
		const entry = byType.get(key) ?? { n: 0, dims: new Set() };
		entry.n += shots.length;
		for (const shot of shots) {
			const a = shot.attributes?.imageAsset;
			if (a?.width && a?.height) entry.dims.add(`${a.width}x${a.height}`);
		}
		byType.set(key, entry);
	}
	return byType;
}

/**
 * Whether pushing `local` files into a set that already holds `remote` is safe.
 *
 * `--skip-existing` dedupes on bytes, not filenames, so a re-render is new
 * content even at identical dimensions: it lands *beside* the old set rather
 * than replacing it. Two ways that hurts, in order of how quietly it happens:
 * a set over Apple's cap is rejected at submission, and a set holding two
 * generations of the same frame is a listing nobody proofread. `--replace`
 * clears first, so it is exempt from both.
 *
 * The cap arithmetic is deliberately pessimistic: identical bytes really are
 * skipped, but nothing here knows the remote checksums, and guessing low turns
 * a caught error into a rejection.
 * @returns {{over:boolean, total:number, appending:boolean, mixed:string[]}}
 */
export function capVerdict({ remote = 0, local, remoteDims = [], localDims = [], replace = false } = {}) {
	if (replace) return { over: false, total: local, appending: false, mixed: [] };
	const total = remote + local;
	const mixed = remote > 0 ? remoteDims.filter((d) => !localDims.includes(d)) : [];
	return { over: total > MAX_PER_GROUP, total, appending: remote > 0, mixed };
}

/**
 * `asc screenshots validate` shapes vary by version — a `valid` boolean, an
 * `errors`/`warnings` pair, or a `results` array. Normalise defensively rather
 * than trusting one shape, and stay silent when it says nothing is wrong.
 * @returns {{level:'fail'|'warn', message:string}[]}
 */
export function ascFindings(res) {
	if (!res || typeof res !== 'object') return [];
	const out = [];
	const push = (level, v) => {
		const message = typeof v === 'string' ? v : (v?.message ?? v?.detail ?? JSON.stringify(v));
		if (message) out.push({ level, message });
	};
	for (const v of res.errors ?? []) push('fail', v);
	for (const v of res.warnings ?? []) push('warn', v);
	for (const r of res.results ?? []) {
		for (const v of r.errors ?? []) push('fail', resultText(r, v));
		for (const v of r.warnings ?? []) push('warn', resultText(r, v));
	}
	if (res.valid === false && !out.length) push('fail', res.message ?? res.reason ?? 'asc reported the path invalid');
	return out;
}

/** A `results[]` row names the file it is about; a bare error/warning does not. */
const resultText = (r, v) => `${r.file ?? r.path ?? ''} ${typeof v === 'string' ? v : (v?.message ?? '')}`.trim();

/**
 * Cap pre-flight: ask Apple what is attached before adding to it. Skipped when
 * --replace clears the set anyway, and when --force says the operator has
 * decided. A set that would land over the cap, or hold two generations of the
 * same frame at different dimensions, is a blocker; a mere append is a warning.
 */
export async function capPreflight({ appId, version, groups, replace, force }) {
	if (replace || force) return;
	const blockers = [];
	for (const locale of new Set(groups.map((g) => g.locale))) {
		const remote = await remoteSets(appId, version, locale);
		for (const g of groups.filter((x) => x.locale === locale)) {
			const at = remote.get(typeKey(g.displayType)) ?? { n: 0, dims: new Set() };
			const localDims = [...new Set(g.files.map((f) => `${f.width}x${f.height}`))];
			const v = capVerdict({ remote: at.n, local: g.count, remoteDims: [...at.dims], localDims, replace: false });
			const label = `${locale}/${g.displayType}`;
			if (v.over)
				blockers.push(`${label}: ${at.n} attached + ${g.count} local = ${v.total}, Apple accepts ${MAX_PER_GROUP}`);
			else if (v.mixed.length)
				blockers.push(`${label}: attached set is ${v.mixed.join(', ')}, these are ${localDims.join(', ')}`);
			else if (v.appending)
				warn(`${label}: ${at.n} already attached — identical bytes are skipped, anything re-rendered is added beside them`);
		}
	}
	if (blockers.length)
		throw new ShipError(`refusing to append to ${blockers.length} set${blockers.length === 1 ? '' : 's'}`, {
			hint: `${blockers.join('\n')}\n--replace swaps each set for what is on disk; --force appends anyway`,
		});
}

/**
 * Upload path one: a named locale set, one localization id per locale, resolved
 * once and reused across its display types. asc's app-scoped fan-out cannot be
 * narrowed to a locale — it demands that the immediate children of --path be
 * locale directories — so each group is pushed against its own localization.
 */
export async function uploadPerLocale({ appId, version, groups, mode }) {
	const results = [];
	for (const locale of new Set(groups.map((g) => g.locale))) {
		const vlid = await localizationId(appId, version, locale);
		for (const g of groups.filter((x) => x.locale === locale)) {
			step(`upload ${g.locale}/${g.displayType} ${c.dim(`${g.count} file${g.count === 1 ? '' : 's'}`)}`);
			const res = await ascMutate(
				['screenshots', 'upload', '--version-localization', vlid, '--path', g.dir, '--device-type', g.displayType, ...mode],
			);
			if (!res.ok) warn(`${g.locale}/${g.displayType}: ${res.stderr || `asc exited ${res.code}`}`);
			results.push({ locale: g.locale, displayType: g.displayType, count: g.count, ok: res.ok, result: res.data });
		}
	}
	return results;
}

/**
 * Upload path two, app-scoped: one call per display type. asc fans out across
 * the locale directories under store/screenshots itself, and only files under a
 * matching display type directory are uploaded. Our layout is exactly what it
 * expects.
 */
export async function uploadAppScoped({ appId, version, platform, root, groups, mode }) {
	const results = [];
	for (const displayType of new Set(groups.map((g) => g.displayType))) {
		const mine = groups.filter((g) => g.displayType === displayType);
		const count = mine.reduce((n, g) => n + g.count, 0);
		step(`upload ${displayType} ${c.dim(`${mine.length} locale${mine.length === 1 ? '' : 's'}, ${count} file${count === 1 ? '' : 's'}`)}`);
		const res = await ascMutate([
			'screenshots',
			'upload',
			'--app',
			appId,
			'--version',
			version,
			'--platform',
			platform,
			'--path',
			root,
			'--device-type',
			displayType,
			...mode,
		]);
		if (!res.ok) warn(`${displayType}: ${res.stderr || `asc exited ${res.code}`}`);
		results.push({ locales: mine.map((g) => g.locale), displayType, count, ok: res.ok, result: res.data });
	}
	return results;
}

/**
 * How an upload row names itself. The per-locale path owns one pair; the
 * app-scoped path is one call covering every locale on disk, so name the
 * display type and count them rather than concatenating fifteen tags.
 */
const uploadLabel = (r) =>
	r.locale
		? `${r.locale}/${r.displayType}`
		: `${r.displayType} (${(r.locales ?? []).length} locale${(r.locales ?? []).length === 1 ? '' : 's'})`;

/**
 * Failure aggregation. An upload that asc refused must not read as a success:
 * nothing downstream re-checks, `ship preflight` only samples the primary
 * locale, and CI gates on the exit code. Report every attempt, then fail on any
 * rejection.
 */
export function reportUpload({ appId, version, results, flags }) {
	const failed = results.filter((r) => !r.ok);
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ app: appId, version, ok: !failed.length, uploads: results }, null, 2)}\n`);
		return failed.length ? 1 : 0;
	}
	const done = results.length - failed.length;
	info(`${done}/${results.length} upload${results.length === 1 ? '' : 's'} → app ${appId} version ${version}`);
	if (failed.length)
		throw new ShipError(`${failed.length} upload${failed.length === 1 ? '' : 's'} rejected by asc`, {
			hint: `failed: ${failed.map(uploadLabel).join(', ')}`,
		});
	note('verify with `asc screenshots list --version-localization <id>` or in ASC');
	return 0;
}

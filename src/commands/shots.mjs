// Screenshots — file-driven, because this host cannot make one.
//
// There is no macOS, no Xcode, no simulator here: capture is IMPOSSIBLE on Linux
// and this command will never pretend otherwise. Every subcommand reads PNG/JPEG
// files that already exist on disk, measures them by parsing their own headers,
// and hands them to `asc`. Capture happens elsewhere (a Mac, a device, a
// designer's export); shipkit's job is to prove the pixels are legal and upload
// them.
//
// Directory names carry the display type, and getting that wrong is the common
// failure: /home/myen/tour's 13 captures at docs/ad-assets/slides-src/*.png are
// 1170x2532, which is IPHONE_58 — dropping them into an IPHONE_65 directory
// fails validate. `ship shots validate` names the directory they belong in.
//
// Sizes are never hardcoded. `asc screenshots sizes` is the only source of truth
// for what Apple accepts; Apple changes it whenever a new device ships.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { asc, ascMutate } from '../exec.mjs';
import { loadConfig, requireAppId, resolveVersion } from '../config.mjs';
import { Report, ShipError, c, heading, info, note, step, table, warn } from '../log.mjs';

export const help = `
${c.bold('ship shots')} ${c.dim('— App Store screenshots, from files on disk')}

${c.dim('usage:')} ship shots [subcommand] [flags]

  ${c.cyan('sizes')}     ${c.dim('default')} display types and pixel dimensions Apple accepts (live from asc)
  ${c.cyan('plan')}      scan store/screenshots, measure every image, write .asc/screenshots.json
  ${c.cyan('validate')}  gate — wrong pixel size, empty group, or >10 images per group exits 1
  ${c.cyan('upload')}    push each locale/displayType group to a version localisation

${c.bold('Flags')}
  ${c.cyan('--all')}             ${c.dim('sizes')} every display type, including tv/vision/desktop
  ${c.cyan('--locale <l,…>')}    ${c.dim('validate, upload')} only these locales ${c.dim('(comma-separated)')}
  ${c.cyan('--display-type <t,…>')} ${c.dim('validate, upload')} only these display types ${c.dim('(e.g. IPHONE_65,IPHONE_67)')}
  ${c.cyan('--version <v>')}     ${c.dim('upload')} target version (default: app.json)
  ${c.cyan('--force')}           ${c.dim('upload')} upload even though validate failed
  ${c.cyan('--replace')}         ${c.dim('upload')} clear the existing set first (default: skip by checksum)
  ${c.cyan('--json')}            machine-readable output
  ${c.cyan('--dry-run')}         ${c.dim('upload')} print the asc calls, change nothing

${c.bold('Layout')} ${c.dim('store/screenshots/<locale>/<displayType>/*.png')}
${c.dim('  e.g. store/screenshots/en-US/IPHONE_65/01-home.png')}

${c.dim('Capture is not possible on Linux — no simulator. Bring the images yourself.')}
`;

const IMAGE_RE = /\.(png|jpe?g)$/i;

/** Apple caps a single locale/displayType group at 10 images. */
const MAX_PER_GROUP = 10;

/**
 * Pixel dimensions straight out of the file header. No image library, no
 * `file(1)`, no trusting the filename — the only number that matters is the one
 * Apple's uploader will read.
 *
 * PNG: fixed layout, IHDR is always the first chunk, so width/height are
 * big-endian uint32 at byte 16 and 20.
 * JPEG: variable — walk the segment chain from the SOI until a Start-Of-Frame
 * marker, whose payload carries precision, height, then width as uint16.
 * @param {Buffer} buffer
 * @returns {{width:number, height:number, format:'png'|'jpeg'}|null}
 */
export function readImageSize(buffer) {
	if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
	}
	if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
		// Every SOFn except C4 (huffman tables), C8 (reserved) and CC (arithmetic
		// coding conditioning) — those three share the Cx range but are not frames.
		const SOF = new Set([
			0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
		]);
		let i = 2;
		while (i + 1 < buffer.length) {
			if (buffer[i] !== 0xff) {
				i += 1; // resync: some encoders pad between segments
				continue;
			}
			const marker = buffer[i + 1];
			if (marker === 0xff) {
				i += 1; // fill byte
				continue;
			}
			// Standalone markers carry no length payload.
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
				i += 2;
				continue;
			}
			if (i + 3 >= buffer.length) break;
			const length = buffer.readUInt16BE(i + 2);
			if (SOF.has(marker)) {
				if (i + 9 > buffer.length) break;
				return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5), format: 'jpeg' };
			}
			if (length < 2) break;
			i += 2 + length;
		}
	}
	return null;
}

/**
 * Directory names are human-written; asc device types are not. Fold both onto
 * one key so `iphone-6.5`, `IPHONE_65` and asc's `APP_IPHONE_65` all meet.
 *
 * The prefix has to go before the separators do: stripping `APP` from a
 * flattened `APPLETV` leaves `LETV`, so an `APPLE_TV` directory could never
 * match asc's own `APP_APPLE_TV`. Anchor on the separator instead.
 */
const typeKey = (s) =>
	String(s)
		.toUpperCase()
		.replace(/^(?:APP|IMESSAGE_APP)[_-]/, '')
		.replace(/[^A-Z0-9]/g, '');

/** The directory name an operator writes for an asc display type: APP_IPHONE_65 → IPHONE_65. */
const dirNameOf = (displayType) => String(displayType).replace(/^(?:APP|IMESSAGE_APP)_/, '');

/**
 * `asc screenshots sizes` → [{displayType, family, dimensions:[{width,height}]}].
 * Memoized: `upload` gates on `validate`, and asking Apple the same question
 * twice in one process is a round-trip that can also rate-limit.
 */
const SIZE_ROWS = new Map();
async function fetchSizes({ all = true } = {}) {
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

const dimsOf = (row) =>
	(row.dimensions ?? []).map((d) => ({ width: Number(d.width), height: Number(d.height) }));

const fmtDims = (dims) => dims.map((d) => `${d.width}x${d.height}`).join('  ');

/**
 * Walk store/screenshots/<locale>/<displayType>/*.{png,jpg,jpeg} and measure
 * every file. Missing tree is a hard error: a version with no screenshots is
 * unsubmittable, so silence would be the wrong answer.
 */
async function scan(cfg) {
	const root = join(cfg.paths.store, 'screenshots');
	if (!existsSync(root))
		throw new ShipError(`no screenshots directory: ${relative(cfg.root, root) || root}`, {
			hint: 'mkdir -p store/screenshots/en-US/IPHONE_65 and drop your captures in (Apple rejects a version with zero iPhone screenshots)',
		});

	const locales = [];
	for (const localeEnt of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!localeEnt.isDirectory()) continue;
		const localeDir = join(root, localeEnt.name);
		const groups = [];
		for (const typeEnt of (await readdir(localeDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (!typeEnt.isDirectory()) continue;
			const dir = join(localeDir, typeEnt.name);
			const files = [];
			for (const name of (await readdir(dir)).sort()) {
				if (!IMAGE_RE.test(name)) continue;
				const buf = await readFile(join(dir, name));
				const size = readImageSize(buf);
				files.push({
					file: name,
					path: join(dir, name),
					bytes: buf.length,
					width: size?.width ?? null,
					height: size?.height ?? null,
					format: size?.format ?? null,
				});
			}
			groups.push({
				displayType: typeEnt.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
				dirName: typeEnt.name,
				dir,
				relDir: relative(cfg.root, dir),
				count: files.length,
				files,
			});
		}
		locales.push({ locale: localeEnt.name, dir: localeDir, groups });
	}
	if (!locales.length)
		throw new ShipError(`${relative(cfg.root, root) || root} has no locale directories`, {
			hint: 'expected store/screenshots/<locale>/<displayType>/*.png',
		});
	return { root, locales };
}

/**
 * Requested scope. Both flags take a comma-separated list, so one invocation
 * covers several locales and several display types; absent means "everything on
 * disk". Display types are folded through `typeKey` so `iphone-6.5` matches
 * `IPHONE_65`.
 */
export function scopeOf(flags) {
	const list = (v) =>
		typeof v === 'string'
			? v.split(',').map((s) => s.trim()).filter(Boolean)
			: [];
	const locales = list(flags.locale);
	const types = list(flags['display-type']);
	return {
		locales: locales.length ? new Set(locales) : null,
		types: types.length ? new Set(types.map(typeKey)) : null,
	};
}

const scopeLabel = (scope) =>
	[
		scope.locales ? [...scope.locales].join(',') : null,
		scope.types ? [...scope.types].join(',') : null,
	]
		.filter(Boolean)
		.join(' · ');

/**
 * Every group on disk, flattened, narrowed to `scope`. Unknown names are not
 * silently dropped: the caller reports an empty match as an error.
 */
const flatGroups = (plan, scope = { locales: null, types: null }) =>
	plan.locales
		.filter((l) => !scope.locales || scope.locales.has(l.locale))
		.flatMap((l) =>
			l.groups
				.filter((g) => !scope.types || scope.types.has(typeKey(g.displayType)))
				.map((g) => ({ ...g, locale: l.locale })),
		);

/**
 * Names the operator asked for that no directory answers — a typo, not an empty
 * store. Kind-tagged, because a missing locale and a missing display type are
 * different mistakes, and checked as pairs once both axes exist: `--locale a,b
 * --display-type X,Y` asks for four groups, and three of them being on disk is
 * still an incomplete upload. An entirely absent axis is reported alone, since
 * it already explains every pair it breaks.
 */
export function unmatched(groups, scope) {
	const has = (locale, type) =>
		groups.some((g) => (!locale || g.locale === locale) && (!type || typeKey(g.displayType) === type));
	const miss = [];
	for (const l of scope.locales ?? []) if (!has(l, null)) miss.push(`locale ${l}`);
	for (const t of scope.types ?? []) if (!has(null, t)) miss.push(`display type ${t}`);
	if (miss.length || !scope.locales || !scope.types) return miss;
	for (const l of scope.locales)
		for (const t of scope.types) if (!has(l, t)) miss.push(`${l}/${t}`);
	return miss;
}

async function sizes({ flags }) {
	const rows = await fetchSizes({ all: !!flags.all });
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
		return 0;
	}
	heading(`Accepted screenshot sizes ${c.dim(flags.all ? '(all families)' : '(iOS defaults — --all for everything)')}`);
	table(rows, [
		{ header: 'DISPLAY TYPE', get: (r) => r.displayType },
		{ header: 'FAMILY', get: (r) => r.family ?? '' },
		{ header: 'PIXEL DIMENSIONS', get: (r) => fmtDims(dimsOf(r)) },
	]);
	note(`${rows.length} display type${rows.length === 1 ? '' : 's'} — source: asc screenshots sizes`);
	note('directory name for `ship shots plan` = display type without the APP_ prefix, e.g. IPHONE_65');
	return 0;
}

async function plan({ flags }) {
	const cfg = await loadConfig();
	const found = await scan(cfg);
	const out = {
		generatedAt: new Date().toISOString(),
		app: cfg.name,
		root: relative(cfg.root, found.root),
		locales: found.locales.map((l) => ({
			locale: l.locale,
			groups: l.groups.map((g) => ({
				displayType: g.displayType,
				dir: g.relDir,
				count: g.count,
				files: g.files.map(({ path: _path, ...f }) => f),
			})),
		})),
	};
	const groups = flatGroups(found);
	out.totals = {
		locales: found.locales.length,
		groups: groups.length,
		files: groups.reduce((n, g) => n + g.count, 0),
	};

	const file = join(cfg.root, '.asc', 'screenshots.json');
	await mkdir(join(cfg.root, '.asc'), { recursive: true });
	await writeFile(file, `${JSON.stringify(out, null, '\t')}\n`);

	if (flags.json) {
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		return 0;
	}
	heading(`Screenshot inventory ${c.dim(out.root)}`);
	table(groups, [
		{ header: 'LOCALE', get: (g) => g.locale },
		{ header: 'DISPLAY TYPE', get: (g) => g.displayType },
		{ header: 'N', get: (g) => g.count },
		{ header: 'DIMENSIONS', get: (g) => [...new Set(g.files.map((f) => (f.width ? `${f.width}x${f.height}` : 'unreadable')))].join(' ') },
	]);
	for (const l of found.locales) {
		const n = l.groups.reduce((acc, g) => acc + g.count, 0);
		info(`${c.bold(l.locale)}: ${n} image${n === 1 ? '' : 's'} across ${l.groups.length} display type${l.groups.length === 1 ? '' : 's'}`);
	}
	const unreadable = groups.flatMap((g) => g.files.filter((f) => !f.width).map((f) => `${g.locale}/${g.displayType}/${f.file}`));
	if (unreadable.length) warn(`unreadable image header: ${unreadable.join(', ')}`);
	note(`wrote ${relative(cfg.root, file)}`);
	return 0;
}

/**
 * Offline gate. Everything here fails a submission at Apple, so it fails here
 * first: wrong pixel size, an empty group, or more than ten images.
 * `asc screenshots validate` runs per group on top, and its findings fold in.
 *
 * `--locale`/`--display-type` narrow it to the same groups `upload` would push,
 * so a broken locale nobody is uploading cannot block the ones that are.
 *
 * `pre` lets `upload` hand over the config and inventory it already read, so
 * gating an upload does not walk the tree and measure every file twice.
 */
async function validate({ flags }, pre = {}) {
	const cfg = pre.cfg ?? (await loadConfig());
	const scope = scopeOf(flags);
	const [found, sizeRows] = await Promise.all([pre.found ?? scan(cfg), fetchSizes({ all: true })]);
	const accepted = new Map(sizeRows.map((r) => [typeKey(r.displayType), dimsOf(r)]));
	const scoped = flatGroups(found, scope);
	const label0 = scopeLabel(scope);

	const report = new Report(`Screenshots — ${cfg.name}${label0 ? ` ${c.dim(`(${label0})`)}` : ''}`);
	for (const name of unmatched(scoped, scope))
		report.fail(name, 'no screenshot directory on disk — see `ship shots plan`');
	for (const g of scoped) {
		const label = `${g.locale}/${g.displayType}`;
		const dims = accepted.get(typeKey(g.displayType));
		if (!dims) {
			report.fail(label, `unknown display type — see \`ship shots sizes --all\``);
			continue;
		}
		if (g.count === 0) {
			report.fail(label, 'no images — Apple requires at least one per display type it lists');
			continue;
		}
		if (g.count > MAX_PER_GROUP) report.fail(label, `${g.count} images, Apple accepts at most ${MAX_PER_GROUP}`);

		const wrong = g.files.filter((f) => !dims.some((d) => d.width === f.width && d.height === f.height));
		for (const f of wrong) {
			// A capture that fits no size at all is a bad export; one that fits a
			// *different* display type is just in the wrong directory, and saying
			// which one turns a rejection into a `mv`.
			const fits = sizeRows
				.filter((r) => dimsOf(r).some((d) => d.width === f.width && d.height === f.height))
				.map((r) => dirNameOf(r.displayType));
			const suggestion = fits.length ? ` — move it to ${[...new Set(fits)].join(' or ')}/` : '';
			report.fail(
				`${label}/${f.file}`,
				`${f.width ?? '?'}x${f.height ?? '?'} — accepted: ${fmtDims(dims)}${suggestion}`,
			);
		}
		if (!wrong.length && g.count <= MAX_PER_GROUP)
			report.ok(label, `${g.count} × ${g.files[0].width}x${g.files[0].height}`);

		// asc knows things we don't (alpha channel, colour space, aspect rules).
		const res = await asc(['screenshots', 'validate', '--path', g.dir, '--device-type', g.displayType], {
			fallback: null,
			allowFail: true,
		});
		for (const finding of ascFindings(res)) {
			if (finding.level === 'fail') report.fail(`asc ${label}`, finding.message);
			else report.warn(`asc ${label}`, finding.message);
		}
	}
	return report.print({ json: flags.json });
}

/**
 * `asc screenshots validate` shapes vary by version — a `valid` boolean, an
 * `errors`/`warnings` pair, or a `results` array. Normalise defensively rather
 * than trusting one shape, and stay silent when it says nothing is wrong.
 */
function ascFindings(res) {
	if (!res || typeof res !== 'object') return [];
	const out = [];
	const push = (level, v) => {
		const message = typeof v === 'string' ? v : (v?.message ?? v?.detail ?? JSON.stringify(v));
		if (message) out.push({ level, message });
	};
	for (const v of res.errors ?? []) push('fail', v);
	for (const v of res.warnings ?? []) push('warn', v);
	for (const r of res.results ?? []) {
		for (const v of r.errors ?? []) push('fail', `${r.file ?? r.path ?? ''} ${typeof v === 'string' ? v : (v?.message ?? '')}`.trim());
		for (const v of r.warnings ?? []) push('warn', `${r.file ?? r.path ?? ''} ${typeof v === 'string' ? v : (v?.message ?? '')}`.trim());
	}
	if (res.valid === false && !out.length) push('fail', res.message ?? res.reason ?? 'asc reported the path invalid');
	return out;
}

/**
 * appStoreVersion id for this app+version, resolved once per process. An upload
 * across N locales asked ASC the same question N times, and ASC answers a burst
 * with 429s.
 */
const VERSION_IDS = new Map();
async function versionId(appId, version) {
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
async function remoteSets(appId, version, locale) {
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
 * How an upload row names itself. The per-locale path owns one pair; the
 * app-scoped path is one call covering every locale on disk, so name the
 * display type and count them rather than concatenating fifteen tags.
 */
const uploadLabel = (r) =>
	r.locale
		? `${r.locale}/${r.displayType}`
		: `${r.displayType} (${(r.locales ?? []).length} locale${(r.locales ?? []).length === 1 ? '' : 's'})`;

async function upload({ flags }) {
	const cfg = await loadConfig();
	const found = await scan(cfg);

	if (!flags.force) {
		const code = await validate({ flags: { ...flags, json: false } }, { cfg, found });
		if (code !== 0)
			throw new ShipError('screenshots failed validation — refusing to upload', {
				hint: 'fix the failures above, or re-run with --force',
			});
	}

	const appId = requireAppId(cfg);
	const version = await resolveVersion(cfg, flags.version);

	const scope = scopeOf(flags);
	const groups = flatGroups(found, scope);
	const missing = unmatched(groups, scope);
	if (missing.length)
		throw new ShipError(`no screenshots on disk for ${missing.join(', ')}`, {
			hint: 'run `ship shots plan` to see which locales and display types exist on disk',
		});
	if (!groups.length)
		throw new ShipError('no screenshot groups match the requested scope', {
			hint: 'run `ship shots plan` to see which locales and display types exist on disk',
		});

	// Re-running an upload appends duplicates unless told otherwise, and a set
	// silently grown past 10 is rejected at submission. Skip by checksum by
	// default; --replace clears the set first.
	const mode = flags.replace ? ['--replace'] : ['--skip-existing'];

	// Ask Apple what is attached before adding to it. Skipped when --replace
	// clears the set anyway, and when --force says the operator has decided.
	if (!flags.replace && !flags.force) {
		const blockers = [];
		for (const locale of new Set(groups.map((g) => g.locale))) {
			const remote = await remoteSets(appId, version, locale);
			for (const g of groups.filter((x) => x.locale === locale)) {
				const at = remote.get(typeKey(g.displayType)) ?? { n: 0, dims: new Set() };
				const localDims = [...new Set(g.files.map((f) => `${f.width}x${f.height}`))];
				const v = capVerdict({
					remote: at.n,
					local: g.count,
					remoteDims: [...at.dims],
					localDims,
					replace: false,
				});
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

	const results = [];

	if (scope.locales) {
		// A named locale set cannot use asc's app-scoped fan-out — that walks
		// every locale directory under --path. One localization id per locale,
		// resolved once and reused across its display types.
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
	} else {
		// One call per display type: asc fans out across the locale directories
		// under store/screenshots itself, and only files under a matching display
		// type directory are uploaded. Our layout is exactly what it expects.
		const root = join(cfg.paths.store, 'screenshots');
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
				cfg.asc.platform ?? 'IOS',
				'--path',
				root,
				'--device-type',
				displayType,
				...mode,
			]);
			if (!res.ok) warn(`${displayType}: ${res.stderr || `asc exited ${res.code}`}`);
			results.push({ locales: mine.map((g) => g.locale), displayType, count, ok: res.ok, result: res.data });
		}
	}

	// An upload that asc refused must not read as a success: nothing downstream
	// re-checks, `ship preflight` only samples the primary locale, and CI gates
	// on the exit code. Report every attempt, then fail on any rejection.
	const failed = results.filter((r) => !r.ok);
	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({ app: appId, version, ok: !failed.length, uploads: results }, null, 2)}\n`,
		);
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

const SUB = { sizes, plan, validate, upload };

export async function run({ args, flags }) {
	const [sub = 'sizes', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`shots: unknown subcommand "${sub}"`, {
			hint: `try: ${Object.keys(SUB).join(', ')}`,
		});
	return fn({ args: rest, flags });
}

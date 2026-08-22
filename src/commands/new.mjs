// ship new — scaffold an Expo managed iOS app that is real on the first run.
//
// The scaffold is deliberately small but never a stub: it installs, it boots,
// it renders, and it already talks to RevenueCat. Every "we'll wire that later"
// placeholder we ever left in a generated app came back as a launch-day bug —
// an empty paywall, a missing runtimeVersion, a TestFlight build that replaced
// somebody's dev client. So the template carries the wiring, and `ship new`
// hands the tree straight to `ship init` so the app is pipeline-ready in one
// command rather than two.
//
// `--from` is the other half of `ship scout brief`. The brief already holds the
// winning term, what it scored, who owns it and a listing drafted from that
// evidence; without a way to spend it, the app still gets named after whatever
// directory somebody was standing in, and the research is re-done from memory
// three days later. So the brief names the app, fills store/staged/en-US.json
// with the reasoning attached, and seeds aso.seeds with the terms that found it.
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CONFIG_NAME, SHIPKIT_ROOT, saveConfig } from '../config.mjs';
import { isDryRun } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, warn } from '../log.mjs';

export const help = `
${c.bold('ship new')} ${c.dim('— scaffold a new Expo iOS app, wired to the pipeline')}

${c.dim('usage:')} ship new ${c.cyan('<slug>')} [flags]
${c.dim('   or:')} ship new ${c.dim('[<slug>]')} ${c.cyan('--from')} ${c.dim('scout/us/<term>-brief.json')}

${c.bold('Flags')}
  ${c.cyan('--from <brief>')}      scout brief that names the app and pre-fills its listing
  ${c.cyan('--dir <path>')}        target directory ${c.dim('(default: ./<slug>)')}
  ${c.cyan('--name <string>')}     display name ${c.dim("(default: the brief's name, else title-cased slug)")}
  ${c.cyan('--bundle-id <id>')}    iOS bundle identifier ${c.dim('(default: com.<slug>.app)')}
  ${c.cyan('--force')}             write into a non-empty directory
  ${c.cyan('--dry-run')}           list the files without writing them

${c.dim('Produces: expo-router app, RevenueCat paywall wiring, EAS profiles,')}
${c.dim('a staged en-US listing, and ship.config.json via `ship init`.')}
${c.dim('The dev build gets a .dev bundle id so TestFlight never eats your dev client.')}
${c.dim('With --from the slug, display name, staged listing and aso.seeds come from the brief.')}
`;

const TEMPLATE_ROOT = join(SHIPKIT_ROOT, 'templates', 'app');

/**
 * npm strips a literal `.gitignore` out of any published tree, so dotfiles are
 * stored prefixed and get their dot back here. Exact names only — `_layout.tsx`
 * is an expo-router convention, not a dotfile.
 */
const DOTFILES = { _gitignore: '.gitignore', _npmrc: '.npmrc' };

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const BUNDLE_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** Every placeholder the template may reference. Unknown ones are left alone. */
const fill = (text, vars) => text.replace(/__([A-Z_]+)__/g, (m, key) => (key in vars ? vars[key] : m));

const titleCase = (slug) =>
	slug
		.split('-')
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(' ');

/** Relative paths of every template file, depth-first, directories implied. */
async function* walk(dir, base = dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(abs, base);
		else yield relative(base, abs);
	}
}

/** Template-relative path → on-disk path, un-prefixing dotfiles as it goes. */
const outputName = (rel) =>
	rel
		.split('/')
		.map((seg) => DOTFILES[seg] ?? seg)
		.join('/');

/** The one staged listing the template ships, and the one `--from` overwrites. */
const STAGED_LISTING = 'store/staged/en-US.json';

/**
 * Brief → app slug. `brief.slug` is scout's filename stem, which is already
 * sanitised, but a legacy brief may only carry the term — and either way the
 * result has to pass the same rule a hand-typed slug does, because it becomes
 * an npm package name and an Expo slug. A term with nothing latin left in it
 * (and no scout slug to fall back on) is asked for rather than guessed.
 */
export function slugFromBrief(brief) {
	const slug = String(brief?.slug || brief?.term || '')
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+/, '')
		.slice(0, 40)
		.replace(/-+$/, '');
	if (!slug)
		throw new ShipError(`new: cannot derive a slug from "${brief?.term ?? ''}"`, {
			hint: 'pass one: ship new my-app --from <brief>',
		});
	return slug;
}

/**
 * The brief's listing, keeping the template's field limits and keyword rules:
 * the drafted 100 characters are a first draft, and the notes that say how to
 * spend them are why the draft is editable by someone who did not write it.
 */
function stagedFromBrief(templateText, listing) {
	const { notes = {} } = JSON.parse(templateText);
	const merged = {
		...listing,
		notes: { ...listing.notes, limits: notes.limits, keywordRules: notes.keywordRules },
	};
	return `${JSON.stringify(merged, null, '\t')}\n`;
}

/**
 * The terms that produced the winning one, into `aso.seeds` — `ship aso harvest`
 * in this repo then starts from that row instead of a blank array. Written after
 * `ship init` rather than before it: init only fills holes, and --force replaces
 * whatever was on disk before it ran.
 */
async function seedAso(targetDir, brief) {
	const seeds = [
		...new Set(
			[...(brief.seeds ?? []), brief.term]
				.map((s) => String(s ?? '').trim().toLocaleLowerCase())
				.filter(Boolean),
		),
	];
	const file = join(targetDir, CONFIG_NAME);
	if (!seeds.length || !existsSync(file)) return;
	step('Research → ship.config.json');
	const cfg = JSON.parse(await readFile(file, 'utf8'));
	if (cfg.aso?.seeds?.length) {
		note(`aso.seeds already set — kept ${cfg.aso.seeds.join(', ')}`);
		return;
	}
	cfg.aso = { ...cfg.aso, seeds };
	await saveConfig(cfg, file);
	good(`aso.seeds ← ${seeds.join(', ')}`);
}

export async function run({ args, flags }) {
	// scout.mjs owns the brief format and drags in the whole storefront client;
	// only --from pays for loading it.
	const scout = flags.from ? await import('./scout.mjs') : null;
	const brief = scout ? await scout.readBrief(flags.from) : null;
	const listing = brief ? scout.listingFromBrief(brief) : null;

	const slug = args[0] ?? (brief ? slugFromBrief(brief) : null);
	if (!slug)
		throw new ShipError('new: a slug is required', {
			hint: 'ship new my-app --bundle-id com.acme.myapp, or ship new --from <scout brief>',
		});
	if (!SLUG_RE.test(slug))
		throw new ShipError(`new: invalid slug "${slug}"`, {
			hint: 'lowercase letters, digits and hyphens; must start alphanumeric',
		});

	const name = flags.name ?? brief?.listing?.name ?? titleCase(slug);
	// Expo URL schemes must be a single alphanumeric token — hyphens break deep links.
	const scheme = slug.replace(/[^a-z0-9]/g, '');
	const bundleId = flags['bundle-id'] ?? flags.bundleId ?? `com.${scheme}.app`;
	if (!BUNDLE_RE.test(bundleId))
		throw new ShipError(`new: invalid bundle id "${bundleId}"`, {
			hint: 'reverse-DNS, e.g. com.acme.myapp',
		});

	const raw = flags.dir ?? slug;
	const targetDir = isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);

	if (existsSync(targetDir)) {
		const existing = await readdir(targetDir);
		if (existing.length && !flags.force)
			throw new ShipError(`new: ${targetDir} is not empty (${existing.length} entries)`, {
				hint: 'pick another --dir, or pass --force to write into it',
			});
	}
	if (!existsSync(TEMPLATE_ROOT))
		throw new ShipError(`new: template tree missing at ${TEMPLATE_ROOT}`, {
			hint: 'reinstall shipkit — templates/app ships with the CLI',
		});

	const vars = { SLUG: slug, NAME: name, BUNDLE_ID: bundleId, SCHEME: scheme };
	const dry = isDryRun();

	heading(`New app — ${name}`);
	info(`slug       ${c.cyan(slug)}`);
	info(`bundle id  ${c.cyan(bundleId)}`);
	info(`scheme     ${c.cyan(scheme)}`);
	info(`directory  ${c.cyan(targetDir)}`);
	if (brief) {
		info(`brief      ${c.cyan(relative(process.cwd(), brief.file) || brief.file)}`);
		info(
			`term       ${c.cyan(brief.term)} ${c.dim(`(demand ${brief.demand} · competition ${brief.competition} · opportunity ${brief.opportunity})`)}`,
		);
		if (brief.verdict?.go === false)
			warn(
				`the brief is a NO-GO on ${brief.verdict.reasons.map((r) => r.gate).join(', ')} — scaffolding anyway`,
			);
	}

	step(dry ? 'Files that would be written' : 'Writing scaffold');
	const written = [];
	for await (const rel of walk(TEMPLATE_ROOT)) {
		const out = outputName(rel);
		const dest = join(targetDir, out);
		if (!dry) {
			const template = await readFile(join(TEMPLATE_ROOT, rel), 'utf8');
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(
				dest,
				listing && out === STAGED_LISTING ? stagedFromBrief(template, listing) : fill(template, vars),
			);
		}
		written.push(out);
	}
	written.sort();
	for (const f of written) note(f);
	good(`${written.length} files${dry ? ' (dry run)' : ''}`);
	if (listing && !dry)
		note(`${STAGED_LISTING} drafted from "${brief.term}" — edit it, then \`ship meta lint\``);

	// Lazy import: init.mjs is a peer command and resolving it at module load
	// would couple `ship new`'s parse-time to it.
	step('Wiring ship.config.json');
	const init = await import('./init.mjs');
	const code = await init.run({ args: [], flags: { ...flags, dir: targetDir, app: targetDir } });
	if (code) return code;

	if (brief && !dry) await seedAso(targetDir, brief);

	if (!flags['bundle-id'] && !flags.bundleId)
		warn(`bundle id was derived as ${bundleId} — change it before the first EAS build`);

	heading('Next');
	for (const cmd of [
		`cd ${targetDir} && npm install`,
		'eas init',
		'ship doctor',
		'ship aso harvest',
		'ship build',
	])
		process.stdout.write(`  ${c.green('$')} ${cmd}\n`);
	note('eas init fills extra.eas.projectId in app.json; ship doctor fails until it does.');
	process.stdout.write('\n');
	return 0;
}

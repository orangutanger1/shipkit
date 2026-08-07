// ship new — scaffold an Expo managed iOS app that is real on the first run.
//
// The scaffold is deliberately small but never a stub: it installs, it boots,
// it renders, and it already talks to RevenueCat. Every "we'll wire that later"
// placeholder we ever left in a generated app came back as a launch-day bug —
// an empty paywall, a missing runtimeVersion, a TestFlight build that replaced
// somebody's dev client. So the template carries the wiring, and `ship new`
// hands the tree straight to `ship init` so the app is pipeline-ready in one
// command rather than two.
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { SHIPKIT_ROOT } from '../config.mjs';
import { isDryRun } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, warn } from '../log.mjs';

export const help = `
${c.bold('ship new')} ${c.dim('— scaffold a new Expo iOS app, wired to the pipeline')}

${c.dim('usage:')} ship new ${c.cyan('<slug>')} [flags]

${c.bold('Flags')}
  ${c.cyan('--dir <path>')}        target directory ${c.dim('(default: ./<slug>)')}
  ${c.cyan('--name <string>')}     display name ${c.dim('(default: title-cased slug)')}
  ${c.cyan('--bundle-id <id>')}    iOS bundle identifier ${c.dim('(default: com.<slug>.app)')}
  ${c.cyan('--force')}             write into a non-empty directory
  ${c.cyan('--dry-run')}           list the files without writing them

${c.dim('Produces: expo-router app, RevenueCat paywall wiring, EAS profiles,')}
${c.dim('a staged en-US listing, and ship.config.json via `ship init`.')}
${c.dim('The dev build gets a .dev bundle id so TestFlight never eats your dev client.')}
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

export async function run({ args, flags }) {
	const [slug] = args;
	if (!slug)
		throw new ShipError('new: a slug is required', {
			hint: 'ship new my-app --bundle-id com.acme.myapp',
		});
	if (!SLUG_RE.test(slug))
		throw new ShipError(`new: invalid slug "${slug}"`, {
			hint: 'lowercase letters, digits and hyphens; must start alphanumeric',
		});

	const name = flags.name ?? titleCase(slug);
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

	step(dry ? 'Files that would be written' : 'Writing scaffold');
	const written = [];
	for await (const rel of walk(TEMPLATE_ROOT)) {
		const out = outputName(rel);
		const dest = join(targetDir, out);
		if (!dry) {
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(dest, fill(await readFile(join(TEMPLATE_ROOT, rel), 'utf8'), vars));
		}
		written.push(out);
	}
	written.sort();
	for (const f of written) note(f);
	good(`${written.length} files${dry ? ' (dry run)' : ''}`);

	// Lazy import: init.mjs is a peer command and resolving it at module load
	// would couple `ship new`'s parse-time to it.
	step('Wiring ship.config.json');
	const init = await import('./init.mjs');
	const code = await init.run({ args: [], flags: { ...flags, dir: targetDir, app: targetDir } });
	if (code) return code;

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

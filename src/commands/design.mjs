// ship design — the contract between the evidence and the implementation.
// Node drafts what it can derive and gates what the agent wrote; choosing a
// hue and naming a direction is the only agent work.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig } from '../config.mjs';
import { ShipError, c, good, heading, note, step, table, warn } from '../log.mjs';
import { readJSONIfExists, readJSONStrict, writeJSON } from '../lib/jsonio.mjs';
import { resolveFlows } from '../lib/research-plan.mjs';
import { loadRun, resolveSlug } from '../lib/research-run.mjs';
import { checkSystem } from '../lib/design-system.mjs';
import { checkSpec } from '../lib/design-spec.mjs';
import { reviewSources, tally } from '../lib/design-review.mjs';
import { draftSpec, draftSystem, draftTodo } from '../lib/design-draft.mjs';
import { assertArtifact, checkArtifact } from '../lib/schemas.mjs';
import { resolveSubcommand, strOf } from '../lib/util.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */

export const help = `
${c.bold('ship design')} ${c.dim('— the token and screen contracts the implementation may not leave')}

  ${c.cyan('system')}    draft design/system.json, or gate the one on disk
  ${c.cyan('spec')}      draft design/ux.json over the researched flows
  ${c.cyan('review')}    the same rules against the implementation, not the spec

${c.bold('Flags')}
  ${c.cyan('--check')}     gate only; never write a draft
  ${c.cyan('--force')}     overwrite an artifact that already exists
  ${c.cyan('--flows a,b')} spec: which flows to lay out (default: research.flows)
  ${c.cyan('--slug')}      which research run to resolve citations against
  ${c.cyan('--json')}      print the artifact or the violations instead of a table

${c.dim('Artifacts: design/system.json · design/ux.json · design/components.json')}
${c.dim('Every token cites a ref_, a claim_, or a HIG rule. Uncited is invented.')}
`;

/** Source files `review` reads. Everything else in an app repo is not UI. */
const SOURCE = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP = new Set(['node_modules', '.git', '.expo', 'ios', 'android', 'dist', 'build', 'coverage']);

/**
 * Reference and claim ids the newest research run holds, so a citation can be
 * resolved. Empty when there is no run: an unprovable citation downgrades the
 * check to shape rather than failing every token in the file.
 * @type {(cfg: Config, slug?: string) => Promise<Set<string>>}
 */
async function knownCitations(cfg, slug) {
	if (!existsSync(cfg.paths.research)) return new Set();
	try {
		const run = await loadRun(cfg.paths.research, await resolveSlug(cfg.paths.research, slug));
		return new Set([
			...run.references.map((r) => r?.id),
			...(run.patterns?.claims ?? []).map((/** @type {any} */ claim) => claim?.id).filter(Boolean),
		]);
	} catch {
		return new Set();
	}
}

/**
 * A draft is refused before its schema is, so the message is the one the reader
 * can act on.
 * @type {(what: string, file: string, doc: any) => void}
 */
function refuseDraft(what, file, doc) {
	const todo = draftTodo(doc);
	if (todo.length)
		throw new ShipError(`design ${what}: ${file} is still a draft`, { hint: `fill ${todo.join(', ')}, then drop _todo` });
}

/**
 * Report a gate's issues the same way in all three subcommands: every one at
 * once, because fixing one error per run is how an artifact takes ten rounds.
 * @type {(what: string, issues: string[]) => void}
 */
function gate(what, issues) {
	if (!issues.length) return;
	for (const issue of issues) note(c.red(issue));
	throw new ShipError(`design ${what}: ${issues.length} issue(s)`, {
		hint: 'every value is cited, legible in both themes, and on the declared scale',
	});
}

/**
 * Write a draft. It is deliberately invalid until filled — `_todo` names what
 * is missing, and every gate refuses it by name until it is gone.
 * @type {(file: string, doc: any, next: string) => Promise<number>}
 */
async function writeDraft(file, doc, next) {
	const out = await writeJSON(file, doc);
	good(`wrote ${out}`);
	step(`draft: ${(doc._todo ?? []).join(', ')} are yours`);
	note(next);
	return 0;
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function system({ flags }) {
	const cfg = await loadConfig();
	const file = cfg.paths.designSystem;
	const existing = await readJSONIfExists(file);
	heading('design system');
	if (!existing || (flags.force && !flags.check)) {
		if (flags.check) throw new ShipError(`design system: ${file} does not exist`, { hint: 'run `ship design system` to draft it' });
		return writeDraft(file, draftSystem({ name: cfg.name }), 'next: choose the accent hue and both themes, then ship design system --check');
	}

	refuseDraft('system', 'system.json', existing);
	gate('system', [
		...(await checkArtifact('design-system', existing, 'system.json')),
		...checkSystem(existing, { known: await knownCitations(cfg, strOf(flags.slug)) }),
	]);
	const themes = Object.keys(/** @type {any} */ (existing).color?.themes ?? {});
	step(`accent hue ${/** @type {any} */ (existing).color?.accentHue}° · ${themes.length} themes · ${(/** @type {any} */ (existing).type?.ramp ?? []).length} type steps`);
	good('every token cited, both themes legible, one accent');
	return 0;
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function spec({ flags }) {
	const cfg = await loadConfig();
	const file = join(cfg.paths.design, 'ux.json');
	const existing = await readJSONIfExists(file);
	heading('design spec');
	if (!existing || (flags.force && !flags.check)) {
		if (flags.check) throw new ShipError(`design spec: ${file} does not exist`, { hint: 'run `ship design spec` to draft it' });
		const flows = resolveFlows(cfg.research.flows, strOf(flags.flows));
		return writeDraft(file, draftSpec({ flows }), 'next: write the copy and the success conditions, then ship design spec --check');
	}

	refuseDraft('spec', 'ux.json', existing);
	const components = await readJSONIfExists(join(cfg.paths.design, 'components.json'));
	const ids = new Set(Object.keys(/** @type {any} */ (components)?.components ?? {}));
	gate('spec', [
		...(await checkArtifact('ux-spec', existing, 'ux.json')),
		...checkSpec(existing, { components: ids }),
	]);
	const doc = /** @type {any} */ (existing);
	table(doc.flows ?? [], [
		{ header: 'flow', get: (f) => f.id },
		{ header: 'screens', get: (f) => (f.screens ?? []).join(' → ') },
		{ header: 'success', get: (f) => f.success },
	]);
	good(`${(doc.screens ?? []).length} screens over ${(doc.flows ?? []).length} flows, every string specified`);
	return 0;
}

/**
 * Every source file under the app, as `{path, source}` the scanner is handed.
 * @type {(root: string) => Promise<{path: string, source: string}[]>}
 */
async function sourcesUnder(root) {
	/** @type {{path: string, source: string}[]} */
	const out = [];
	/** @type {(dir: string) => Promise<void>} */
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (SOURCE.has(entry.name.slice(entry.name.lastIndexOf('.'))))
				out.push({ path: relative(root, full), source: await readFile(full, 'utf8') });
		}
	};
	await walk(root);
	return out;
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function review({ flags }) {
	const cfg = await loadConfig();
	const doc = await readJSONStrict(cfg.paths.designSystem);
	refuseDraft('review', 'system.json', doc);
	await assertArtifact('design-system', doc, 'system.json');
	const files = await sourcesUnder(cfg.paths.app);
	// src/theme is where the tokens legitimately become literals, so the whole
	// directory is exempt — this must agree with `EXCEPTIONS.dirs` in design-review.
	const tokens = new Set(files.map((f) => f.path).filter((p) => p.startsWith('src/theme/')));
	const violations = reviewSources(files, doc, { tokens });

	heading('design review');
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(violations, null, '\t')}\n`);
		return violations.length ? 1 : 0;
	}
	step(`${files.length} source files · ${tokens.size} token file(s) exempt`);
	if (!violations.length) {
		good('no drift: every literal in the implementation comes from design/system.json');
		return 0;
	}
	table(violations.slice(0, 40), [
		{ header: 'file', get: (v) => `${v.file}:${v.line}` },
		{ header: 'kind', get: (v) => v.kind },
		{ header: 'problem', get: (v) => v.message },
	]);
	if (violations.length > 40) note(`… and ${violations.length - 40} more`);
	const counts = Object.entries(tally(violations)).map(([kind, n]) => `${kind} ${n}`).join(' · ');
	warn(counts);
	throw new ShipError(`design review: ${violations.length} violation(s)`, {
		hint: 'every one is a value the implementation invented — take it from design/system.json or add it there with a citation',
	});
}

const SUB = { system, spec, review };

/** @type {(ctx: SubCtx) => Promise<number>} */
export async function run({ args, flags }) {
	const { fn, args: rest } = resolveSubcommand({ command: 'design', args, subs: SUB, fallback: 'system' });
	return fn({ args: rest, flags });
}

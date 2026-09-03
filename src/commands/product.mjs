// ship product — what the app is, as an artifact rather than a conversation.
//
// The pipeline had a gap exactly here. `ship scout brief` decides whether a
// keyword is winnable; `ship research plan` asks what to go and look at;
// `ship design spec` names the screens. Nothing between them wrote down what
// the product *is*, so every later stage re-derived it from the term, which is
// how an app ends up being whatever the keyword implied.
//
// Node computes the market half and refuses the file until the agent has
// written the product half. See lib/product-brief.mjs for why the split falls
// where it does.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig } from '../config.mjs';
import { ShipError, c, good, heading, info, note, step, table } from '../log.mjs';
import { readJSONIfExists, writeJSON } from '../lib/jsonio.mjs';
import { emit } from '../lib/output.mjs';
import { loadRun, resolveSlug } from '../lib/research-run.mjs';
import { resolveBrief, marketOf } from '../lib/storefront-scout.mjs';
import { checkArtifact } from '../lib/schemas.mjs';
import { AUTHORED, checkBrief, draftBrief, jobSeeds } from '../lib/product-brief.mjs';
import { resolveSubcommand, strOf } from '../lib/util.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */

export const help = `
${c.bold('ship product')} ${c.dim('— the brief every later stage reads instead of guessing')}

  ${c.cyan('brief')}     draft product/brief.json from a scout brief, or gate the one on disk

${c.bold('Flags')}
  ${c.cyan('--from <f>')}   scout brief to draft from ${c.dim('(default: the only one under scout/<market>/)')}
  ${c.cyan('--market <c>')} storefront to look for that brief in ${c.dim('(default: us)')}
  ${c.cyan('--check')}      gate only; never write
  ${c.cyan('--slug')}       which research run to resolve theme citations against
  ${c.cyan('--json')}       print the artifact or the issues instead of a table

${c.dim('Artifact: product/brief.json')}
${c.dim('Re-runnable: the market half is recomputed, the authored half is kept.')}
${c.dim('Order: scout brief → product brief → research plan → design spec')}
`;

/** @type {(cfg: Config) => string} */
const briefFile = (cfg) => join(cfg.paths.product, 'brief.json');

/**
 * The newest research run's themes, or null when there is no run.
 *
 * Absent themes downgrade the citation check rather than failing it: a brief
 * drafted before any research is allowed to cite nothing, and one drafted after
 * may not cite a theme that does not exist.
 * @type {(cfg: Config, slug?: string) => Promise<any>}
 */
async function themesFor(cfg, slug) {
	if (!existsSync(cfg.paths.research)) return null;
	try {
		return (await loadRun(cfg.paths.research, await resolveSlug(cfg.paths.research, slug))).themes;
	} catch {
		return null;
	}
}

/**
 * Report every issue at once. Fixing one error per run is how an artifact takes
 * ten rounds to land.
 * @type {(issues: string[], json: boolean) => number}
 */
function gate(issues, json) {
	if (json) return emit({ ok: issues.length === 0, issues });
	for (const issue of issues) note(c.red(issue));
	throw new ShipError(`product brief: ${issues.length} issue(s)`, {
		hint: 'every job cites a theme, every flow is from the closed vocabulary, and the monetization model agrees with itself',
	});
}

/** @type {(cfg: Config, doc: any, file: string) => void} */
function printDraft(cfg, doc, file) {
	heading(`Drafted ${relative(cfg.paths.root, file)}`);
	step(`${doc.verdict.go ? c.green('GO') : c.red('NO-GO')} · viability ${doc.verdict.viability} · ${doc.risks.length} risk(s) from the storefront`);
	for (const line of doc._todo ?? []) note(c.yellow(`_todo ${line}`));
	note(c.dim(doc._todo ? 'fill those, drop _todo, then: ship product brief --check' : 'the authored half was kept; re-gate it with: ship product brief --check'));
}

/** @type {(doc: any, seeds: ReturnType<typeof jobSeeds>) => void} */
function printBrief(doc, seeds) {
	heading(`Product brief — ${doc.slug}`);
	info(doc.valueProp);
	step(`${doc.user.who} · ${doc.user.context}`);
	table(doc.jobs, [
		{ header: 'job to be done', get: (j) => j.job },
		{ header: 'evidence', get: (j) => (j.evidence ?? []).join('; ') },
	]);
	step(`north star: ${c.cyan(doc.northStar.action)} (${doc.northStar.flow}) · activation ${c.cyan(doc.activation.event)} within ${doc.activation.within}`);
	step(`retention: ${doc.retention.loop} — ${(doc.retention.flows ?? []).join(', ')}`);
	step(`monetization: ${doc.monetization.model}${doc.monetization.priceUsd ? ` $${doc.monetization.priceUsd}/${doc.monetization.period ?? '?'}` : ''}`);
	table(doc.risks, [
		{ header: 'risk', get: (r) => r.risk },
		{ header: 'severity', get: (r) => r.severity },
		{ header: 'from', get: (r) => r.source ?? 'author' },
	]);
	// Themes nobody turned into a job are the cheapest place to look next.
	const cited = new Set((doc.jobs ?? []).flatMap((/** @type {any} */ j) => j.evidence ?? []));
	const spare = seeds.filter((s) => !cited.has(s.label));
	if (spare.length) note(c.dim(`themes not yet a job: ${spare.map((s) => `${s.label} (${s.support})`).join(', ')}`));
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function brief({ flags }) {
	const cfg = await loadConfig();
	const file = briefFile(cfg);
	const existing = /** @type {any} */ (await readJSONIfExists(file));
	const themes = await themesFor(cfg, strOf(flags.slug));
	const seeds = jobSeeds(themes);

	if (flags.check || (existing && !flags.from)) {
		if (!existing)
			throw new ShipError(`product brief: ${relative(cfg.paths.root, file)} does not exist`, {
				hint: 'run `ship product brief --from <scout brief>` to draft it',
			});
		const todo = Array.isArray(existing._todo) ? existing._todo : [];
		// A draft is refused before its schema is, so the message is the one the
		// reader can act on: "still a draft, fill valueProp" beats "valueProp is
		// required".
		if (todo.length)
			throw new ShipError(`product brief: ${relative(cfg.paths.root, file)} is still a draft`, {
				hint: `fill ${todo.map(firstWord).join(', ')}, then drop _todo`,
			});
		const issues = [
			...(await checkArtifact('product-brief', existing, 'brief.json')),
			...checkBrief(existing, { themes }),
		];
		if (issues.length) return gate(issues, Boolean(flags.json));
		if (flags.json) return emit(existing);
		printBrief(existing, seeds);
		good(`${existing.jobs.length} job(s), every one cited`);
		return 0;
	}

	const source = await resolveBrief(flags, marketOf(flags.market));
	const scout = /** @type {any} */ (await readJSONIfExists(source));
	if (!scout)
		throw new ShipError(`product brief: cannot read ${source}`, {
			hint: 'run `ship scout brief "your keyword"` first — the brief is what the market half is computed from',
		});
	const doc = draftBrief(scout, { source: relative(cfg.paths.root, source), previous: existing });
	await writeJSON(file, doc);
	if (flags.json) return emit(doc);
	printDraft(cfg, doc, file);
	if (seeds.length) {
		heading('Themes to write jobs from');
		table(seeds, [
			{ header: 'theme', get: (s) => s.label },
			{ header: 'kind', get: (s) => s.kind },
			{ header: 'reviews', get: (s) => String(s.support) },
		]);
	} else note(c.dim('no research themes yet — `ship research plan` then re-run this to seed the jobs'));
	return AUTHORED.some((f) => doc[f] === undefined) ? 1 : 0;
}

/** @param {string} line */
const firstWord = (line) => String(line).split(':')[0];

const SUB = { brief };

/** @param {{args: string[], flags: import('../lib/util.mjs').Flags}} ctx @returns {Promise<number|void>} */
export async function run({ args, flags }) {
	const { fn, args: rest } = resolveSubcommand({ command: 'product', args, subs: SUB, fallback: 'brief' });
	return fn({ args: rest, flags });
}

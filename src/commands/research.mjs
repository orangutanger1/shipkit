// ship research — the evidence engine's front door.
// Shipkit fetches what is fetchable and gates what the agent writes; the
// reading of screens and reviews in between is the only agent work.
import { join } from 'node:path';
import { loadConfig } from '../config.mjs';
import { ShipError, c, good, heading, note, step, table } from '../log.mjs';
import { marketFor } from '../lib/appstore.mjs';
import { readJSONIfExists, writeJSON } from '../lib/jsonio.mjs';
import { buildPlan, resolveFlows, slugFor } from '../lib/research-plan.mjs';
import { assertArtifact } from '../lib/schemas.mjs';
import { resolveSubcommand, strOf } from '../lib/util.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */

export const help = `
${c.bold('ship research')} ${c.dim('— competitor evidence from the public App Store storefront')}

  ${c.cyan('plan')}   pick the apps and flows, and fix the fetch budget

${c.bold('Flags')}
  ${c.cyan('--flows a,b')}  flows to research (default: research.flows, else the standard six)
  ${c.cyan('--apps n')}     research fewer apps than the budget allows
  ${c.cyan('--locale')}     which storefront's competitor set to read (default: asc.primaryLocale)
  ${c.cyan('--name')}       name this run, when one date holds more than one
  ${c.cyan('--json')}       print the plan instead of a table

${c.dim('Artifacts: research/<slug>/{plan,index}.json · references/ · reviews/ · assets/')}
${c.dim('Credential-free: the storefront is public, like `ship scout`.')}
`;

/**
 * The competitor set `ship aso competitors` wrote for this storefront.
 * @type {(cfg: Config, locale: string) => Promise<{file: string, apps: any[]}>}
 */
async function competitorSet(cfg, locale) {
	const file = join(cfg.paths.aso, locale, 'competitors.json');
	const artifact = await readJSONIfExists(file);
	if (!artifact) {
		throw new ShipError(`research plan: no competitor set for ${locale}`, {
			hint: `run \`ship aso competitors --locale ${locale}\` first (expected ${file})`,
		});
	}
	const apps = /** @type {any} */ (artifact).apps;
	return { file, apps: Array.isArray(apps) ? apps : [] };
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function plan({ flags }) {
	const cfg = await loadConfig();
	const locale = strOf(flags.locale) ?? cfg.asc.primaryLocale;
	const market = marketFor(locale);
	if (!market) throw new ShipError(`research plan: no storefront for locale "${locale}"`);

	const { file, apps } = await competitorSet(cfg, locale);
	const flows = resolveFlows(cfg.research.flows, strOf(flags.flows));
	const now = new Date().toISOString();
	const slug = slugFor(now, strOf(flags.name));
	const doc = buildPlan({
		cfg,
		competitors: apps,
		flows,
		slug,
		country: market.country,
		apps: flags.apps === undefined ? undefined : Number(flags.apps),
		now,
	});

	// The gate runs on the way out, not only in `verify`: a plan that cannot
	// satisfy its own schema would fail every later step with a worse message.
	await assertArtifact('research-plan', doc, `${slug}/plan.json`);
	const out = await writeJSON(join(cfg.paths.research, slug, 'plan.json'), /** @type {any} */ (doc));
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(doc, null, '\t')}\n`);
		return 0;
	}

	heading(`research plan · ${slug}`);
	note(`competitor set: ${file}`);
	step(`flows: ${doc.flows.join(', ')}`);
	table(doc.apps, [
		{ header: '#', get: (a) => a.rank },
		{ header: 'app', get: (a) => a.name },
		{ header: 'id', get: (a) => a.trackId },
		{ header: 'evidence', get: (a) => a.why },
	]);
	const { requests } = doc.budget;
	step(`budget: ${requests.total} requests — ${requests.lookup} lookup, ${requests.screenshots} screenshots, ${requests.reviews} review pages`);
	good(`wrote ${out}`);
	note('next: ship research fetch');
	return 0;
}

const SUB = { plan };

/** @type {(ctx: SubCtx) => Promise<number>} */
export async function run({ args, flags }) {
	const { fn, args: rest } = resolveSubcommand({ command: 'research', args, subs: SUB, fallback: 'plan' });
	return fn({ args: rest, flags });
}

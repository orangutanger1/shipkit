// App Store listing metadata.
//
// `store/staged/<locale>.json` is the only file a human edits. Everything else
// under `store/` — app-info/, version/<v>/ — is generated from it and is safe to
// delete. That split exists because `asc metadata apply --dir` wants one field
// per file-tree location while a copywriter wants one file per language, and
// hand-maintaining the canonical tree is how locales silently drift apart.
//
// This file is a dispatcher. The listing lifecycle (lint, pull, apply, migrate,
// keywords) lives in lib/listing-sync.mjs and the custom product page writer in
// lib/cpp-asc.mjs — except `stage`, which only re-expands the staged files
// through locales.mjs and shares listing-sync's lint gate.
import { loadConfig, resolveVersion } from '../config.mjs';
import { isDryRun } from '../exec.mjs';
import { c, good, heading, info, note, ShipError } from '../log.mjs';
import { stage as expand } from '../lib/locales.mjs';
import { gateOnLint, lint, pull, apply, migrate, keywords } from '../lib/listing-sync.mjs';
import { cpp } from '../lib/cpp-asc.mjs';
import { strOf } from '../lib/util.mjs';

/** @typedef {import('../lib/util.mjs').Flags} Flags */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */

export const help = `
${c.bold('ship meta')} ${c.dim('— App Store listing metadata')}

${c.dim('usage:')} ship meta [subcommand] [flags]

  ${c.cyan('lint')}       ${c.dim('default')} offline validation of every staged listing
  ${c.cyan('stage')}      expand staged/<locale>.json into the tree asc consumes
  ${c.cyan('pull')}       download live metadata from ASC and fold it back into staged/
  ${c.cyan('apply')}      lint → stage → state gate → dry-run → push to App Store Connect
  ${c.cyan('migrate')}    convert legacy .strings localizations into staged/<locale>.json
  ${c.cyan('keywords')}   inspect or rewrite the 100-char keyword field for one locale
  ${c.cyan('cpp')}        custom product pages: list · stage · apply · link

${c.bold('Flags')}
  ${c.cyan('--version V')}     marketing version (default: ship.config.json / app.json)
  ${c.cyan('--force')}         proceed despite lint failures, a bad app store state, or an existing file
  ${c.cyan('--no-stage')}      ${c.dim('apply, cpp apply')} push the tree as-is instead of regenerating it
  ${c.cyan('--from D')}        ${c.dim('migrate')} directory of version-level .strings files
  ${c.cyan('--app-info D')}    ${c.dim('migrate')} directory of app-info .strings files
  ${c.cyan('--set "a,b,c"')}   ${c.dim('keywords')} replace the keyword field for the locale
  ${c.cyan('--ad-group N')}    ${c.dim('cpp link')} ad group this page serves ${c.dim('(ship ads sync reads it)')}
  ${c.cyan('--screenshots')}   ${c.dim('cpp apply')} also upload each locale's screenshotDir
  ${c.cyan('--local')}         ${c.dim('cpp list')} skip the live App Store Connect lookup
  ${c.cyan('--json')}          machine-readable output ${c.dim('(lint, keywords, cpp)')}
  ${c.cyan('--dry-run')}       show what would change, write nothing

${c.dim('Source of truth: store/staged/<locale>.json — app-info/ and version/ are generated.')}
${c.dim('Custom product pages: store/cpp/<slug>/<locale>.json — generated/ is generated.')}
${c.dim('Keyword research lives in `ship aso`; this command only enforces the fields.')}
`;

/** Expand staged/<locale>.json into the tree `asc metadata apply --dir` consumes. */
/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
async function stage({ flags }) {
	const cfg = await loadConfig();
	if (!cfg) throw new ShipError('no ship.config.json found', { hint: 'run `ship init` inside the app repo to create one' });
	const version = await resolveVersion(cfg, strOf(flags.version));
	heading(`${cfg.name} ${version} — stage`);
	await gateOnLint(cfg, flags);

	const dry = isDryRun();
	const { written, locales } = await expand(cfg, version, { write: !dry });
	if (dry) {
		info(`${c.yellow('dry-run')} would write ${written.length} files for ${locales.length} locales`);
		for (const f of written) note(f.replace(`${cfg.root}/`, ''));
		return 0;
	}
	good(`wrote ${written.length} files for ${locales.length} locales`);
	note(`${cfg.paths.appInfo.replace(`${cfg.root}/`, '')}/  +  ${cfg.versionDir(version).replace(`${cfg.root}/`, '')}/`);
	return 0;
}

/** @type {Record<string, (ctx: SubCtx) => Promise<number>>} */
const SUB = { lint, stage, pull, apply, migrate, keywords, cpp };

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
export async function run({ args, flags }) {
	const [sub = 'lint', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`meta: unknown subcommand "${sub}"`, {
			hint: `try: ${Object.keys(SUB).join(', ')}`,
		});
	return fn({ args: rest, flags });
}

// App Store analytics — the only place `ship` reads conversion truth.
//
// Three operational facts shape this module:
//
//  1. Without it the keyword loop never learns. `ship aso` scores candidates
//     against autocomplete rank, harvests again, and scores against rank again.
//     Impressions and installs are the only inputs that can contradict it, so
//     `.asc/analytics/<locale>-terms.json` is what makes the loop converge.
//  2. The Analytics Reports API is asynchronous and role-gated. You create a
//     report *request*, Apple takes up to 48 h to produce the first instance,
//     and a key without an analytics-capable role gets a flat "forbidden for
//     security reasons" rather than a 401. An unconfigured or under-privileged
//     key is the normal state, so every credentialed path here names exactly
//     what is missing instead of forwarding Apple's sentence or asc's usage.
//  3. No report Apple exposes over that API carries a search-term dimension
//     today — search terms live in the App Analytics web UI. So the term
//     columns are read opportunistically (if Apple ships them, we use them)
//     and `--file` imports a manual export as a first-class path, not a
//     fallback. `terms` and `funnel` never touch the network at all.
//  4. Apple's funnel ends at the install, and the install is not the money.
//     `onboarding` continues it — onboarding step → paywall reach → paid — from
//     a PostHog-style export, because no Apple report carries a step a user took
//     inside the app. It is offline for the same reason `terms` is: the numbers
//     that decide what to cut must be readable without a credential.
//
// Report parsing lives in `lib/report-parse.mjs` (pure) and ASC access in
// `lib/analytics-api.mjs`; this file is the subcommands and their output.
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, requireAppId } from '../config.mjs';
import { isDryRun } from '../exec.mjs';
import { Report, ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { pct } from '../lib/fmt.mjs';
import { readJSONIfExists, writeJSON } from '../lib/jsonio.mjs';
import { readStaged } from '../lib/locales.mjs';
import { emit } from '../lib/output.mjs';
import { strOf } from '../lib/util.mjs';
import {
	BENCHMARK,
	STAGE,
	bottleneck,
	foldRecords,
	missingFromListing,
	normaliseRow,
	parseDelimited,
	parseFunnelExport,
	parseSpreadsheetNumber,
	zero,
} from '../lib/report-parse.mjs';
import {
	ascJSON,
	collectSegments,
	downloadSegments,
	requireCredentials,
	windowOf,
} from '../lib/analytics-api.mjs';
import { CONVERSION, ONBOARDING, conversionTier, onboardingFunnel, pct as fraction } from '../lib/paywall.mjs';

// The pure parsing surface moved to lib/report-parse.mjs; re-exported here so
// the tests keep their single import path.
export {
	BENCHMARK,
	bottleneck,
	foldRecords,
	missingFromListing,
	parseDelimited,
	parseFunnelExport,
};

export const help = `
${c.bold('ship analytics')} ${c.dim('— impressions · page views · installs, then onboarding · paywall · paid')}

${c.dim('usage:')} ship analytics [subcommand] [flags]

  ${c.cyan('funnel')}      ${c.dim('default')} impressions → page views → installs, and which stage is the bottleneck
  ${c.cyan('onboarding')}  ${c.green('offline')} onboarding step → paywall reach → install→paid tier
  ${c.cyan('terms')}       ranked search terms, and the ones that convert but are ${c.bold('missing from the keyword field')}
  ${c.cyan('pull')}        fetch from App Store Connect ${c.dim('(or --file <export> to import a manual export)')}

${c.bold('Flags')}
  ${c.cyan('--locale <l>')}      one locale ${c.dim('(default: every locale with a pulled file; pull: asc.primaryLocale)')}
  ${c.cyan('--file <path>')}     ${c.dim('pull, onboarding')} import an exported report (.csv/.tsv/.json) instead of calling ASC
  ${c.cyan('--from --to')}       ${c.dim('pull')} window ${c.dim('YYYY-MM-DD, default: the last 30 days')}
  ${c.cyan('--territory <t>')}   ${c.dim('pull')} keep only rows whose territory matches ${c.dim('(default: all territories)')}
  ${c.cyan('--top <n>')}         ${c.dim('terms')} rows to print ${c.dim('(default: 20)')}
  ${c.cyan('--installs <n>')}    ${c.dim('onboarding')} installs in the window ${c.dim('(default: the pulled funnel file)')}
  ${c.cyan('--paid <n>')}        ${c.dim('onboarding')} paying subscribers started in the same window
  ${c.cyan('--json')}            machine-readable output
  ${c.cyan('--dry-run')}         print every mutation, write nothing

${c.dim('Artifacts: .asc/analytics/<locale>-terms.json · -funnel.json · -onboarding.json')}
${c.dim('`ship aso score` uses the terms file as measured demand; `ship loc draft` as provenance.')}
`;

/** @typedef {import('../lib/report-parse.mjs').TermRow} TermRow */
/** @typedef {import('../lib/report-parse.mjs').Counts} Counts */
/** @typedef {import('../lib/report-parse.mjs').FunnelStep} FunnelStep */
/** @typedef {import('../lib/util.mjs').Flags} Flags */
/** @typedef {import('../lib/util.mjs').Json} Json */
/** @typedef {import('../config.mjs').Config} Config */

/** `--json` prints the payload and nothing else, so `pull` routes progress through here. */
let QUIET = false;
/** @type {import('../lib/analytics-api.mjs').Say} */
const say = {
	step: (m) => void (!QUIET && step(m)),
	info: (m) => void (!QUIET && info(m)),
	good: (m) => void (!QUIET && good(m)),
	note: (m) => void (!QUIET && note(m)),
	warn: (m) => void (!QUIET && warn(m)),
};

/** @param {Flags} flags @returns {boolean} */
const dryRun = (flags) => isDryRun() || flags['dry-run'] === true || flags.n === true;

// ─── artifacts ──────────────────────────────────────────────────────────────

/** @param {Config} cfg @param {string} locale @returns {string} */
const termsFile = (cfg, locale) => join(cfg.paths.analytics, `${locale}-terms.json`);
/** @param {Config} cfg @param {string} locale @returns {string} */
const funnelFile = (cfg, locale) => join(cfg.paths.analytics, `${locale}-funnel.json`);
/** @param {Config} cfg @param {string} locale @returns {string} */
const onboardingFile = (cfg, locale) => join(cfg.paths.analytics, `${locale}-onboarding.json`);

/**
 * Every locale that has been pulled, in artifact order.
 * @param {Config} cfg
 * @returns {Promise<string[]>}
 */
async function pulledLocales(cfg) {
	if (!existsSync(cfg.paths.analytics)) return [];
	const files = await readdir(cfg.paths.analytics);
	/** @type {Set<string>} */
	const out = new Set();
	for (const f of files) {
		const m = /^(.+)-(terms|funnel)\.json$/.exec(f);
		if (m) out.add(m[1]);
	}
	return [...out].sort();
}

/** @param {Config} cfg @param {Flags} flags @returns {Promise<string[]>} */
async function targetLocales(cfg, flags) {
	const only = strOf(flags.locale);
	const pulled = await pulledLocales(cfg);
	if (only) return [only];
	if (pulled.length) return pulled;
	return [];
}

// ─── pull ───────────────────────────────────────────────────────────────────

/**
 * @param {string|undefined} file
 * @param {{territory?: string}} opts
 * @returns {Promise<{terms: TermRow[], funnel: Counts, matched: boolean, source: string}>}
 */
async function pullFromFile(file, { territory }) {
	const abs = resolve(String(file).replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
	if (!existsSync(abs))
		throw new ShipError(`analytics pull: no such file ${abs}`, {
			hint: 'App Store Connect → Analytics → Metrics (or Search Terms) → Export exports the .csv this imports',
		});
	const text = await readFile(abs, 'utf8');
	const records = /^\s*[[{]/.test(text) ? jsonRecords(text, abs) : parseDelimited(text);
	const folded = foldRecords(records, { territory });
	if (!folded.matched)
		throw new ShipError(`${abs} has no columns this can read`, {
			hint: `found: ${Object.keys(records[0] ?? {}).join(', ') || '(no rows)'}\nexpected impressions / product page views / installs columns, or an Event + Counts pair, optionally with a search term column`,
		});
	return { ...folded, source: abs };
}

/** @param {string} text @param {string} file @returns {Array<Record<string, string>>} */
function jsonRecords(text, file) {
	let data;
	try {
		data = JSON.parse(text);
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err instanceof Error ? err.message : String(err) });
	}
	const rows = Array.isArray(data) ? data : (data.rows ?? data.data ?? data.records ?? []);
	if (!Array.isArray(rows)) throw new ShipError(`${file}: expected an array of rows`, { hint: 'or {"rows": [...]}' });
	return rows;
}

/** @param {{flags: Flags, args?: string[]}} ctx @returns {Promise<number>} */
async function pull({ flags }) {
	QUIET = !!flags.json;
	const cfg = await loadConfig();
	const locale = strOf(flags.locale) ?? cfg.asc.primaryLocale;
	const territory = strOf(flags.territory);
	const { from, to } = windowOf(flags);
	const dry = dryRun(flags);

	let folded;
	let source;
	if (strOf(flags.file)) {
		say.step(`importing ${strOf(flags.file)}`);
		const got = await pullFromFile(strOf(flags.file), { territory });
		folded = got;
		source = 'file';
	} else {
		await requireCredentials();
		const appId = requireAppId(cfg);
		say.step(`App Store Connect analytics for ${appId} ${c.dim(`${from} → ${to}`)}`);
		const { requestId, segments } = await collectSegments(appId, { from, to });
		if (!requestId) {
			if (dry) {
				say.info(`--dry-run: would create an ONGOING analytics report request for ${appId}`);
				return 0;
			}
			await ascJSON(['analytics', 'request', '--app', appId, '--access-type', 'ONGOING', '--reuse-existing'], {
				what: 'create an analytics report request',
			});
			say.good('created an ONGOING analytics report request');
			say.note('Apple takes up to 48 h to produce the first report instance. Re-run `ship analytics pull` after that.');
			say.note(`meanwhile: ship analytics pull --file <export.csv> --locale ${locale}`);
			return 0;
		}
		if (!segments.length)
			throw new ShipError(`analytics request ${requestId} has no report instances in ${from} → ${to}`, {
				hint: 'Apple backfills roughly the last 365 days but only after the request has been active for up to 48 h. Widen the window with --from, or import an export with --file.',
			});
		say.info(`${segments.length} report segment${segments.length === 1 ? '' : 's'} to download`);
		const { records, downloaded } = await downloadSegments(segments, say);
		if (!downloaded)
			throw new ShipError('every analytics segment download failed', {
				hint: 'the request exists but its data could not be fetched — `asc analytics view --request-id <id> --include-segments` shows the state of each instance',
			});
		folded = foldRecords(records, { territory });
		if (!folded.matched)
			throw new ShipError('the downloaded reports have no impression / page view / install columns', {
				hint: `columns seen: ${Object.keys(records[0] ?? {}).join(', ') || '(no rows)'}\nApple renames report columns without notice; open an issue with that list.`,
			});
		source = 'asc';
	}

	const generatedAt = new Date().toISOString();
	const terms = {
		generatedAt,
		locale,
		source,
		from,
		to,
		territory: territory ?? 'all',
		rows: folded.terms,
	};
	const funnel = { generatedAt, locale, source, from, to, ...folded.funnel };

	if (dry) {
		say.info(`--dry-run: would write ${termsFile(cfg, locale)} (${folded.terms.length} terms)`);
		say.info(`--dry-run: would write ${funnelFile(cfg, locale)}`);
		return flags.json ? emit({ locale, terms, funnel, written: [] }) : 0;
	}
	const written = [await writeJSON(termsFile(cfg, locale), terms), await writeJSON(funnelFile(cfg, locale), funnel)];
	if (flags.json) return emit({ locale, terms, funnel, written });

	good(`${folded.terms.length} search terms → ${c.dim(written[0])}`);
	good(`funnel ${folded.funnel.impressions} → ${folded.funnel.pageViews} → ${folded.funnel.installs} → ${c.dim(written[1])}`);
	if (!folded.terms.length)
		note(
			'no search-term dimension in this report — Apple exposes terms only in the App Analytics web UI. Export it and re-run with --file to unlock `ship analytics terms`.',
		);
	note(`next: ship analytics terms --locale ${locale}`);
	return 0;
}

// ─── terms ──────────────────────────────────────────────────────────────────

/** @param {Config} cfg @param {string} locale @returns {Promise<TermRow[]>} */
async function termsFor(cfg, locale) {
	const data = await readJSONIfExists(termsFile(cfg, locale));
	const rows = data !== null && !Array.isArray(data) && Array.isArray(data.rows) ? data.rows : [];
	return rows.map(normaliseRow).filter((r) => r.term);
}

/** @param {{flags: Flags, args?: string[]}} ctx @returns {Promise<number>} */
async function terms({ flags }) {
	const cfg = await loadConfig();
	const locales = await targetLocales(cfg, flags);
	if (!locales.length)
		throw new ShipError('no analytics have been pulled', {
			hint: 'run `ship analytics pull` (or `ship analytics pull --file <export.csv>`) first',
		});
	const staged = new Map((await readStaged(cfg)).map((s) => [s.locale, s.data]));
	const top = Math.max(1, Number(flags.top) || 20);

	/** @type {{locale: string, keywords: string, rows: TermRow[], missing: TermRow[]}[]} */
	const out = [];
	for (const locale of locales) {
		const rows = await termsFor(cfg, locale);
		if (!rows.length && !existsSync(termsFile(cfg, locale))) continue;
		const keywords = String(staged.get(locale)?.keywords ?? '');
		const missing = missingFromListing(rows, keywords, locale);
		out.push({ locale, keywords, rows, missing });
	}
	if (!out.length)
		throw new ShipError(`no terms file for ${locales.join(', ')}`, {
			hint: `expected ${termsFile(cfg, locales[0])} — run \`ship analytics pull --locale ${locales[0]}\``,
		});

	if (flags.json)
		return emit({
			locales: out.map(({ locale, rows, missing }) => ({
				locale,
				terms: rows.slice(0, top),
				missingFromKeywords: missing,
			})),
		});

	for (const { locale, keywords, rows, missing } of out) {
		const gap = new Set(missing.map((m) => m.term));
		heading(`Search terms ${c.dim(`(${locale}, ${rows.length} terms)`)}`);
		if (!rows.length) {
			note('(none — the pulled report carried no search-term dimension)');
			continue;
		}
		table(rows.slice(0, top), [
			{ header: 'term', get: (r) => r.term },
			{ header: 'impressions', get: (r) => String(r.impressions) },
			{ header: 'page views', get: (r) => String(r.pageViews) },
			{ header: 'installs', get: (r) => String(r.installs) },
			{ header: 'cvr', get: (r) => pct(r.conversionRate, 1) },
			{ header: 'in keywords', get: (r) => (gap.has(r.term) ? c.red('missing') : r.installs > 0 ? c.green('yes') : c.dim('-')) },
		]);
		if (!keywords) warn(`${locale}: no staged keyword field — store/staged/${locale}.json is where coverage is judged from`);
		if (!missing.length) {
			good(`${locale}: every converting term is already in the keyword field`);
			continue;
		}
		heading(`${c.bold('Highest-value listing edit available')} ${c.dim(`(${locale})`)}`);
		note('these terms already convert and the keyword field does not carry them:');
		table(missing.slice(0, top), [
			{ header: 'term', get: (r) => c.yellow(r.term) },
			{ header: 'installs', get: (r) => String(r.installs) },
			{ header: 'impressions', get: (r) => String(r.impressions) },
			{ header: 'cvr', get: (r) => pct(r.conversionRate, 1) },
		]);
		note(`add them: ship loc draft --locale ${locale} · then ship meta lint`);
	}
	return 0;
}

// ─── funnel ─────────────────────────────────────────────────────────────────

/** @param {Config} cfg @param {string} locale @returns {Promise<Counts|null>} */
async function funnelFor(cfg, locale) {
	const data = await readJSONIfExists(funnelFile(cfg, locale));
	if (data !== null) {
		const doc = Array.isArray(data) ? /** @type {Record<string, import('../lib/util.mjs').Json>} */ ({}) : data;
		return {
			impressions: parseSpreadsheetNumber(doc.impressions),
			pageViews: parseSpreadsheetNumber(doc.pageViews),
			installs: parseSpreadsheetNumber(doc.installs),
		};
	}
	// A terms file without its funnel sibling still totals to the same numbers.
	const rows = await termsFor(cfg, locale);
	if (!rows.length) return null;
	return rows.reduce(
		(acc, r) => ({
			impressions: acc.impressions + r.impressions,
			pageViews: acc.pageViews + r.pageViews,
			installs: acc.installs + r.installs,
		}),
		zero(),
	);
}

/** @param {{flags: Flags, args?: string[]}} ctx @returns {Promise<number>} */
async function funnel({ flags }) {
	const cfg = await loadConfig();
	const locales = await targetLocales(cfg, flags);
	if (!locales.length)
		throw new ShipError('no analytics have been pulled', {
			hint: 'run `ship analytics pull` (or `ship analytics pull --file <export.csv>`) first',
		});

	const rows = [];
	for (const locale of locales) {
		const totals = await funnelFor(cfg, locale);
		if (totals) rows.push({ locale, ...bottleneck(totals) });
	}
	if (!rows.length)
		throw new ShipError(`no funnel file for ${locales.join(', ')}`, {
			hint: `expected ${funnelFile(cfg, locales[0])} — run \`ship analytics pull --locale ${locales[0]}\``,
		});

	if (flags.json) return emit({ locales: rows });

	heading('Funnel: impressions → product page views → installs');
	table(rows, [
		{ header: 'locale', get: (r) => r.locale },
		{ header: 'impressions', get: (r) => String(r.impressions) },
		{ header: 'page views', get: (r) => String(r.pageViews) },
		{ header: 'installs', get: (r) => String(r.installs) },
		{ header: 'imp→ppv', get: (r) => (r.viewRate >= BENCHMARK.viewRate ? c.green(pct(r.viewRate, 1)) : c.red(pct(r.viewRate, 1))) },
		{ header: 'ppv→install', get: (r) => (r.installRate >= BENCHMARK.installRate ? c.green(pct(r.installRate, 1)) : c.red(pct(r.installRate, 1))) },
		{ header: 'bottleneck', get: (r) => (r.healthy ? c.green('none') : c.yellow(r.stage)) },
	]);

	heading('What each stage means');
	note(`${c.bold('impression→pageview')} ${c.dim(`(healthy ≥ ${pct(BENCHMARK.viewRate, 1)})`)} — ${STAGE.view.means}`);
	note(`  ${STAGE.view.fix}`);
	note(`${c.bold('pageview→install')} ${c.dim(`(healthy ≥ ${pct(BENCHMARK.installRate, 1)})`)} — ${STAGE.install.means}`);
	note(`  ${STAGE.install.fix}`);

	for (const r of rows) {
		if (r.healthy) {
			good(`${r.locale}: both stages above benchmark`);
			continue;
		}
		warn(`${r.locale}: ${r.stage} is the bottleneck — ${r.means}`);
		note(r.fix);
	}
	return 0;
}

// ─── onboarding (offline) ────────────────────────────────────────────────────
//
// The stage Apple cannot see. Every export shape in the wild is "an ordered list
// of steps with a count", so that is the only thing parsed here — the analysis
// lives in `onboardingFunnel`, which is pure and tested.

/** @param {Json} s @returns {s is Record<string, Json>} */
const isStepObj = (s) => s !== null && typeof s === 'object' && !Array.isArray(s);

/**
 * @param {Config} cfg
 * @param {string} locale
 * @param {Flags} flags
 * @returns {Promise<{steps: FunnelStep[]|Array<Record<string, Json>>, source: string, imported?: boolean, installs?: number, paid?: number}|null>}
 */
async function onboardingFor(cfg, locale, flags) {
	const file = strOf(flags.file);
	if (file) {
		const path = resolve(file);
		if (!existsSync(path)) throw new ShipError(`no such export: ${path}`);
		return { steps: parseFunnelExport(await readFile(path, 'utf8')), source: path, imported: true };
	}
	const doc = await readJSONIfExists(onboardingFile(cfg, locale));
	if (!doc) return null;
	const rawSteps = Array.isArray(doc) ? doc : (Array.isArray(doc.steps) ? doc.steps : []);
	const steps = rawSteps.filter(isStepObj);
	return {
		steps,
		source: onboardingFile(cfg, locale),
		installs: parseSpreadsheetNumber(Array.isArray(doc) ? undefined : doc.installs),
		paid: parseSpreadsheetNumber(Array.isArray(doc) ? undefined : doc.paid),
	};
}

/**
 * Installs for the paid-conversion rate. `--installs` wins, then the export
 * itself, then the funnel Apple already gave us for this locale — which is the
 * whole reason the two live under one command.
 * @param {Config} cfg
 * @param {string} locale
 * @param {Flags} flags
 * @param {{steps: FunnelStep[]|Array<Record<string, Json>>, source: string, imported?: boolean, installs?: number, paid?: number}|null} doc
 * @returns {Promise<{installs: number, from: string|null}>}
 */
async function installsFor(cfg, locale, flags, doc) {
	const flag = parseSpreadsheetNumber(strOf(flags.installs));
	if (flag > 0) return { installs: flag, from: '--installs' };
	if ((doc?.installs ?? 0) > 0) return { installs: /** @type {number} */ (doc?.installs), from: 'export' };
	const apple = await funnelFor(cfg, locale);
	return (apple?.installs ?? 0) > 0 ? { installs: /** @type {Counts} */ (apple).installs, from: 'App Store funnel' } : { installs: 0, from: null };
}

/** @param {{flags: Flags, args?: string[]}} ctx @returns {Promise<number>} */
async function onboarding({ flags }) {
	const cfg = await loadConfig();
	const locale = strOf(flags.locale) ?? (await targetLocales(cfg, flags))[0] ?? cfg.asc?.primaryLocale ?? 'en-US';

	const doc = await onboardingFor(cfg, locale, flags);
	if (!doc)
		throw new ShipError(`no onboarding funnel for ${locale}`, {
			hint: `export the funnel from PostHog and import it: \`ship analytics onboarding --file <export.csv>\` (it is written to ${onboardingFile(cfg, locale)})`,
		});

	const analysis = onboardingFunnel(doc.steps);
	const { installs, from } = await installsFor(cfg, locale, flags, doc);
	const paid = parseSpreadsheetNumber(strOf(flags.paid)) || parseSpreadsheetNumber(doc.paid);
	const paidRate = installs > 0 ? paid / installs : 0;
	const tier = conversionTier(paidRate);

	// An imported export is the artifact from now on; `--dry-run` still writes nothing.
	if (doc.imported && !dryRun(flags)) {
		await writeJSON(onboardingFile(cfg, locale), { locale, source: doc.source, steps: analysis.steps.map(({ name, users, role }) => ({ name, users, kind: role })), installs, paid });
	}

	if (flags.json)
		return emit({ locale, source: doc.source, installs, installsFrom: from, paid, ...analysis, conversion: tier });

	heading(`Onboarding: ${locale} ${c.dim(`(${doc.source})`)}`);
	table(analysis.steps, [
		{ header: 'step', get: (s) => s.name },
		{ header: 'role', get: (s) => c.dim(s.role) },
		{ header: 'users', get: (s) => String(s.users) },
		{ header: 'drop', get: (s) => (s.dropRate >= 0.25 ? c.red(fraction(s.dropRate)) : c.dim(fraction(s.dropRate))) },
		{ header: 'of entrants', get: (s) => (s.role === 'paywall' && s.reach >= ONBOARDING.paywallReach ? c.green(fraction(s.reach)) : fraction(s.reach)) },
	]);

	const report = new Report(`Gates ${c.dim(`(reach ≥ ${fraction(ONBOARDING.paywallReach)}, ${ONBOARDING.minScreens}-${ONBOARDING.maxScreens} screens, ≤ ${ONBOARDING.maxQuizScreens} quiz)`)}`);
	for (const f of analysis.findings) report[f.level](f.name, f.detail);

	if (installs > 0) {
		const detail = `${paid}/${installs} = ${fraction(tier.rate)} ${c.dim(`(floor ${fraction(CONVERSION.floor)} · healthy ${fraction(CONVERSION.healthy)} · excellent ${fraction(CONVERSION.excellent)}; installs from ${from})`)}`;
		report[tier.rate < CONVERSION.floor ? 'fail' : tier.healthy ? 'ok' : 'warn'](`install→paid (${tier.tier})`, detail);
	} else {
		report.skip('install→paid', 'no install count — pass --installs, or `ship analytics pull` for this locale');
	}
	report.print();

	if (analysis.worst && analysis.worst.dropRate >= 0.25) note(`worst step: ${analysis.worst.name} — ${tier.fix}`);
	else note(tier.fix);
	return report.code;
}

/** @type {Record<string, (ctx: {flags: Flags, args?: string[]}) => Promise<number>>} */
const SUB = { funnel, onboarding, terms, pull };

/** @param {{args: string[], flags: Flags}} ctx @returns {Promise<number|void>} */
export async function run({ args, flags }) {
	const [sub = 'funnel', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`analytics: unknown subcommand "${sub}"`, { hint: `try: ${Object.keys(SUB).join(', ')}` });
	return fn({ args: rest, flags });
}

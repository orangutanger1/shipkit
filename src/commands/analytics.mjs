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
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, requireAppId } from '../config.mjs';
import { ASC, isDryRun, run as exec } from '../exec.mjs';
import { Report, ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { readStaged } from '../lib/locales.mjs';
import { isCovered, stopwordsFor, words } from '../lib/text.mjs';
import { CONVERSION, ONBOARDING, conversionTier, onboardingFunnel, pct as fraction } from '../lib/paywall.mjs';

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

const emit = (data) => {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
	return 0;
};

/** `--json` prints the payload and nothing else, so `pull` routes progress through here. */
let QUIET = false;
const say = {
	step: (m) => !QUIET && step(m),
	info: (m) => !QUIET && info(m),
	good: (m) => !QUIET && good(m),
	note: (m) => !QUIET && note(m),
	warn: (m) => !QUIET && warn(m),
};

/** A bare `--flag` parses as `true`; only a real string is a usable value. */
const str = (v) => (typeof v === 'string' && v.length ? v : undefined);
const dryRun = (flags) => isDryRun() || flags['dry-run'] === true || flags.n === true;

/** Numbers arrive as "1,234", "12.3%" or "" depending on who exported them. */
function num(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
	const n = Number(String(v ?? '').replace(/[,\s%]/g, ''));
	return Number.isFinite(n) ? n : 0;
}

const rate = (top, bottom) => (bottom > 0 ? top / bottom : 0);
const pct = (n) => `${(n * 100).toFixed(1)}%`;

// ─── the two things worth unit-testing ──────────────────────────────────────

/**
 * Search terms that already convert and that the keyword field does not carry.
 *
 * This is the highest-value listing edit available at any moment: Apple has
 * proven the demand and proven the term converts, and the field it should be
 * indexed from does not contain it. Tokenisation is locale-aware because
 * whitespace splitting reports every Japanese term as missing — `予定管理` is
 * covered by a field holding `カレンダー,予定,管理` and no `/\s+/` split sees it.
 *
 * @param {Array<object>} rows analytics term rows
 * @param {string|string[]} keywords the staged keyword field
 * @param {string} [locale]
 * @returns {Array<{term:string, impressions:number, pageViews:number, installs:number, conversionRate:number}>}
 */
export function missingFromListing(rows, keywords, locale = 'en') {
	const field = Array.isArray(keywords) ? keywords.join(' ') : String(keywords ?? '');
	const index = new Set(words(field, locale));
	// `isCovered` tests every token of the term. Apple indexes none of the
	// connectives, so their absence from the field is not a gap.
	for (const w of stopwordsFor(locale)) index.add(w);
	return (rows ?? [])
		.map(normaliseRow)
		.filter((r) => r.term && r.installs > 0 && !isCovered(r.term, index, locale))
		.sort((a, b) => b.installs - a.installs || b.impressions - a.impressions);
}

/** Where a healthy listing sits. Below these, the stage is the problem. */
export const BENCHMARK = { viewRate: 0.08, installRate: 0.3 };

const STAGE = {
	impressions: {
		stage: 'impressions',
		means: 'nobody is seeing the listing at all',
		fix: 'not a conversion problem — you rank for terms with no volume. `ship aso score` then re-pick the keyword field.',
	},
	view: {
		stage: 'impression→pageview',
		means: 'people see the search result and scroll past it',
		fix: 'ASO problem: icon, title and subtitle are all a search result shows. Rewrite them around terms that convert.',
	},
	install: {
		stage: 'pageview→install',
		means: 'people open the product page and leave',
		fix: 'product-page problem: screenshots 1-2, the first-run promise and paywall timing.',
	},
};

/**
 * Which stage of impressions → page views → installs is losing the users, and
 * what that stage actually maps to. Zero impressions is the common case for a
 * new app and must not divide by zero.
 *
 * @param {{impressions?:number, pageViews?:number, installs?:number}} totals
 */
export function bottleneck({ impressions = 0, pageViews = 0, installs = 0 } = {}) {
	const imp = num(impressions);
	const views = num(pageViews);
	const inst = num(installs);
	const out = {
		impressions: imp,
		pageViews: views,
		installs: inst,
		viewRate: rate(views, imp),
		installRate: rate(inst, views),
		conversionRate: rate(inst, imp),
	};
	if (imp <= 0) return { ...out, ...STAGE.impressions, healthy: false };
	const viewScore = out.viewRate / BENCHMARK.viewRate;
	const installScore = out.installRate / BENCHMARK.installRate;
	const worst = installScore < viewScore ? STAGE.install : STAGE.view;
	return { ...out, ...worst, healthy: viewScore >= 1 && installScore >= 1 };
}

/** Analytics rows are written by us but read from files humans edit; take every shape. */
function normaliseRow(r) {
	const term = String(r?.term ?? r?.keyword ?? '').trim();
	const impressions = num(r?.impressions);
	const pageViews = num(r?.pageViews ?? r?.pageviews ?? r?.views);
	const installs = num(r?.installs ?? r?.downloads ?? r?.units);
	return {
		term,
		impressions,
		pageViews,
		installs,
		conversionRate: impressions > 0 ? rate(installs, impressions) : num(r?.conversionRate),
	};
}

// ─── report parsing ─────────────────────────────────────────────────────────

/**
 * Parse a delimited report into records. Apple's API reports are TSV, the web
 * export is CSV, and some locales export CSV with semicolons; sniff the header.
 * @returns {Array<Record<string,string>>}
 */
export function parseDelimited(text) {
	const src = String(text ?? '')
		.replace(/^\uFEFF/, '')
		.replace(/\r\n?/g, '\n');
	const head = src.split('\n').find((l) => l.trim()) ?? '';
	const delim = head.includes('\t') ? '\t' : head.split(';').length > head.split(',').length ? ';' : ',';
	const rows = [];
	let row = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (quoted) {
			if (ch !== '"') cell += ch;
			else if (src[i + 1] === '"') {
				cell += '"';
				i++;
			} else quoted = false;
			continue;
		}
		if (ch === '"' && cell === '') quoted = true;
		else if (ch === delim) {
			row.push(cell);
			cell = '';
		} else if (ch === '\n') {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else cell += ch;
	}
	if (cell !== '' || row.length) rows.push([...row, cell]);
	const used = rows.filter((r) => r.some((v) => v.trim() !== ''));
	if (used.length < 2) return [];
	const header = used[0].map((h) => h.trim());
	return used.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** Header name → the role it plays. Apple has renamed every one of these at least once. */
const COLUMN = [
	['term', /^(search\s*)?(term|keyword|query)s?$/i],
	['impressions', /impression/i],
	['pageViews', /(product\s*)?page\s*views?$/i],
	['installs', /^(installs?|downloads?|units|total downloads?|first[-\s]?time downloads?)$/i],
	['conversionRate', /conversion/i],
	['territory', /^(territory|country|region|storefront)$/i],
	['event', /^(event|metric|engagement\s*type)$/i],
	['counts', /^(unique\s*)?counts?$/i],
];

function roles(headers) {
	const out = {};
	for (const h of headers) {
		const hit = COLUMN.find(([, re]) => re.test(h));
		if (hit && !out[hit[0]]) out[hit[0]] = h;
	}
	return out;
}

const EVENT = [
	['impressions', /impression/i],
	['pageViews', /page\s*view/i],
	['installs', /install|download|unit/i],
];

const zero = () => ({ impressions: 0, pageViews: 0, installs: 0 });

/**
 * Fold report records into per-term counts and a total funnel.
 * Handles both layouts Apple ships: wide (one column per metric) and long
 * (an `Event` column plus `Counts`).
 */
export function foldRecords(records, { territory } = {}) {
	if (!records.length) return { terms: [], funnel: zero(), matched: false };
	const col = roles(Object.keys(records[0]));
	const wide = col.impressions || col.pageViews || col.installs;
	const long = col.event && col.counts;
	if (!wide && !long) return { terms: [], funnel: zero(), matched: false };

	const funnel = zero();
	const byTerm = new Map();
	const want = territory ? String(territory).toLowerCase() : null;
	for (const rec of records) {
		if (want && col.territory && !String(rec[col.territory] ?? '').toLowerCase().includes(want)) continue;
		const term = col.term ? String(rec[col.term] ?? '').trim() : '';
		if (/^(total|totals|all|—|-)$/i.test(term)) continue; // an export's own total row would double-count
		const add = zero();
		if (wide) {
			add.impressions = num(rec[col.impressions]);
			add.pageViews = num(rec[col.pageViews]);
			add.installs = num(rec[col.installs]);
		} else {
			const kind = EVENT.find(([, re]) => re.test(String(rec[col.event] ?? '')));
			if (!kind) continue;
			add[kind[0]] = num(rec[col.counts]);
		}
		for (const k of ['impressions', 'pageViews', 'installs']) funnel[k] += add[k];
		if (!term) continue;
		const seen = byTerm.get(term) ?? zero();
		for (const k of ['impressions', 'pageViews', 'installs']) seen[k] += add[k];
		byTerm.set(term, seen);
	}

	const terms = [...byTerm]
		.map(([term, v]) => ({ term, ...v, conversionRate: rate(v.installs, v.impressions) }))
		.sort((a, b) => b.installs - a.installs || b.impressions - a.impressions);
	return { terms, funnel, matched: true };
}

// ─── artifacts ──────────────────────────────────────────────────────────────

const termsFile = (cfg, locale) => join(cfg.paths.analytics, `${locale}-terms.json`);
const funnelFile = (cfg, locale) => join(cfg.paths.analytics, `${locale}-funnel.json`);

async function readJSON(file) {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

async function writeJSON(file, data) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, '\t')}\n`);
	return file;
}

/** Every locale that has been pulled, in artifact order. */
async function pulledLocales(cfg) {
	if (!existsSync(cfg.paths.analytics)) return [];
	const files = await readdir(cfg.paths.analytics);
	const out = new Set();
	for (const f of files) {
		const m = /^(.+)-(terms|funnel)\.json$/.exec(f);
		if (m) out.add(m[1]);
	}
	return [...out].sort();
}

async function targetLocales(cfg, flags) {
	const only = str(flags.locale);
	const pulled = await pulledLocales(cfg);
	if (only) return [only];
	if (pulled.length) return pulled;
	return [];
}

const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function windowOf(flags) {
	const to = str(flags.to) ?? isoDay(Date.now());
	const from = str(flags.from) ?? isoDay(Date.parse(`${to}T00:00:00Z`) - 29 * DAY);
	for (const [name, v] of [['from', from], ['to', to]])
		if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))
			throw new ShipError(`analytics pull: --${name} must be YYYY-MM-DD, got "${v}"`);
	if (from > to) throw new ShipError(`analytics pull: --from ${from} is after --to ${to}`);
	return { from, to };
}

// ─── asc, with the failures named ───────────────────────────────────────────

const tail = (text, n = 6) => text.trim().split('\n').slice(-n).join('\n');

const SETUP = [
	'The Analytics Reports API needs an App Store Connect API key whose role is',
	'Admin, App Manager, Developer, Marketing or Sales.',
	'',
	'  1. appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API',
	'  2. Create (or re-role) a Team key with one of those roles; the .p8 downloads once',
	'  3. asc auth login --name <profile> --key-id <id> --issuer-id <id> --key <path.p8>',
	'  4. asc auth status --validate   # confirms the key before you re-run',
	'',
	'No API access yet? `ship analytics pull --file <export.csv>` imports the App',
	'Analytics web export (Analytics → Metrics → Export) and needs no key at all.',
].join('\n');

/** Apple answers an under-privileged key with a refusal, not a 401; name the cause. */
const WRONG_ROLE = `The key asc is using exists but is not allowed to read analytics — a\nCustomer Support or Finance-only key returns exactly this refusal.\n\n${SETUP}`;

const FORBIDDEN = /forbidden|unauthor|not authorized|401|403|no active credential|no credentials|api key/i;
const UNSUPPORTED = /unexpected argument|unknown (sub)?command|unknown flag|^usage:/im;

/**
 * `asc <args> --output json`. Every failure mode Apple and asc have is turned
 * into a sentence naming what is missing — never a raw refusal or a usage dump.
 */
async function ascJSON(args, { what, fallback } = {}) {
	const res = await exec(ASC, [...args, '--output', 'json'], { allowFail: true });
	const text = `${res.stdout}\n${res.stderr}`.trim();
	if (res.code !== 0) {
		if (UNSUPPORTED.test(text))
			throw new ShipError(`the installed asc cannot ${what}`, {
				hint: `\`asc ${args.slice(0, 2).join(' ')}\` is not available in ${ASC}. Upgrade asc (the Analytics Reports API needs \`asc analytics request\`, \`view\`, \`reports links\`, \`instances links\` and \`download\`), or import a manual export:\n  ship analytics pull --file <export.csv>`,
			});
		if (FORBIDDEN.test(text))
			throw new ShipError(`App Store Connect refused analytics access while trying to ${what}`, {
				hint: `${tail(text, 2)}\n\n${WRONG_ROLE}`,
			});
		throw new ShipError(`asc ${args.slice(0, 2).join(' ')} exited ${res.code}`, { hint: tail(text) });
	}
	const body = res.stdout.trim();
	if (!body) return fallback ?? {};
	try {
		return JSON.parse(body);
	} catch {
		const start = body.search(/[[{]/);
		if (start >= 0) {
			try {
				return JSON.parse(body.slice(start));
			} catch {
				/* fall through */
			}
		}
		throw new ShipError(`asc ${args.slice(0, 2).join(' ')} returned output that is not JSON`, {
			hint: body.slice(0, 300),
		});
	}
}

/** Pull every `{type, id, attributes}` of one type out of an asc payload, whatever it nests them in. */
function nodesOf(payload, type) {
	const out = new Map();
	const seen = new Set();
	const walk = (v) => {
		if (!v || typeof v !== 'object' || seen.has(v)) return;
		seen.add(v);
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (v.type === type && v.id) out.set(v.id, { ...v, ...(v.attributes ?? {}), id: v.id });
		for (const x of Object.values(v)) walk(x);
	};
	walk(payload);
	return [...out.values()];
}

/** ASC will not answer at all without a stored key; say so before spending a round trip. */
async function requireCredentials() {
	const res = await exec(ASC, ['auth', 'status', '--output', 'json'], { allowFail: true });
	let state = null;
	try {
		state = JSON.parse(res.stdout.trim() || '{}');
	} catch {
		state = null;
	}
	const configured =
		state?.environmentCredentialsComplete === true || (state?.credentials ?? []).length > 0;
	if (!configured)
		throw new ShipError('no App Store Connect API credentials are configured', {
			hint: SETUP,
		});
}

// ─── pull ───────────────────────────────────────────────────────────────────

const REPORT_WANTED = /discovery|engagement|install|download/i;
const MAX_INSTANCES = 120;

/** Reports Apple has finished producing for this app, and their downloadable segments. */
async function collectSegments(appId, { from, to }) {
	const requests = nodesOf(await ascJSON(['analytics', 'requests', '--app', appId, '--paginate'], {
		what: 'list analytics report requests',
	}), 'analyticsReportRequests');
	const usable = requests.filter((r) => !r.stoppedDueToInactivity);
	if (!usable.length) return { requestId: null, segments: [] };

	const requestId = (usable.find((r) => r.accessType === 'ONGOING') ?? usable[0]).id;
	const view = await ascJSON(
		['analytics', 'view', '--request-id', requestId, '--include-segments', '--paginate'],
		{ what: 'list the reports in an analytics request' },
	);
	const reports = nodesOf(view, 'analyticsReports').filter((r) => REPORT_WANTED.test(String(r.name ?? '')));
	if (!reports.length) return { requestId, segments: [] };

	const segments = [];
	for (const report of reports) {
		const links = await ascJSON(['analytics', 'reports', 'links', '--report-id', report.id, '--paginate'], {
			what: 'list report instances',
		});
		const instances = nodesOf(links, 'analyticsReportInstances')
			.filter((i) => {
				const day = String(i.processingDate ?? '').slice(0, 10);
				return day >= from && day <= to;
			})
			.sort((a, b) => String(a.processingDate).localeCompare(String(b.processingDate)));
		for (const instance of instances.slice(0, MAX_INSTANCES)) {
			const segs = nodesOf(
				await ascJSON(['analytics', 'instances', 'links', '--instance-id', instance.id, '--paginate'], {
					what: 'list report segments',
				}),
				'analyticsReportSegments',
			);
			for (const seg of segs) segments.push({ report: report.name, requestId, instance: instance.id, id: seg.id });
		}
	}
	return { requestId, segments };
}

/** Download every segment into one throwaway directory and read whatever asc named the files. */
async function downloadSegments(segments) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-analytics-'));
	let ok = 0;
	for (const seg of segments) {
		const res = await exec(
			ASC,
			['analytics', 'download', '--request-id', seg.requestId, '--instance-id', seg.instance, '--segment-id', seg.id, '--decompress'],
			{ cwd: dir, allowFail: true },
		);
		if (res.code === 0) ok++;
		else say.warn(`segment ${seg.id} did not download: ${tail(`${res.stdout}\n${res.stderr}`, 1)}`);
	}
	const records = [];
	for (const f of await readdir(dir)) {
		if (!/\.(csv|tsv|txt)$/i.test(f)) continue;
		records.push(...parseDelimited(await readFile(join(dir, f), 'utf8')));
	}
	return { records, downloaded: ok, dir };
}

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

function jsonRecords(text, file) {
	let data;
	try {
		data = JSON.parse(text);
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
	const rows = Array.isArray(data) ? data : (data.rows ?? data.data ?? data.records ?? []);
	if (!Array.isArray(rows)) throw new ShipError(`${file}: expected an array of rows`, { hint: 'or {"rows": [...]}' });
	return rows;
}

async function pull({ flags }) {
	QUIET = !!flags.json;
	const cfg = await loadConfig();
	const locale = str(flags.locale) ?? cfg.asc.primaryLocale;
	const territory = str(flags.territory);
	const { from, to } = windowOf(flags);
	const dry = dryRun(flags);

	let folded;
	let source;
	if (str(flags.file)) {
		say.step(`importing ${str(flags.file)}`);
		const got = await pullFromFile(str(flags.file), { territory });
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
		const { records, downloaded } = await downloadSegments(segments);
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

async function termsFor(cfg, locale) {
	const data = await readJSON(termsFile(cfg, locale));
	return (data?.rows ?? []).map(normaliseRow).filter((r) => r.term);
}

async function terms({ flags }) {
	const cfg = await loadConfig();
	const locales = await targetLocales(cfg, flags);
	if (!locales.length)
		throw new ShipError('no analytics have been pulled', {
			hint: 'run `ship analytics pull` (or `ship analytics pull --file <export.csv>`) first',
		});
	const staged = new Map((await readStaged(cfg)).map((s) => [s.locale, s.data]));
	const top = Math.max(1, Number(flags.top) || 20);

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
			{ header: 'cvr', get: (r) => pct(r.conversionRate) },
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
			{ header: 'cvr', get: (r) => pct(r.conversionRate) },
		]);
		note(`add them: ship loc draft --locale ${locale} · then ship meta lint`);
	}
	return 0;
}

// ─── funnel ─────────────────────────────────────────────────────────────────

async function funnelFor(cfg, locale) {
	const data = await readJSON(funnelFile(cfg, locale));
	if (data) return { impressions: num(data.impressions), pageViews: num(data.pageViews), installs: num(data.installs) };
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
		{ header: 'imp→ppv', get: (r) => (r.viewRate >= BENCHMARK.viewRate ? c.green(pct(r.viewRate)) : c.red(pct(r.viewRate))) },
		{ header: 'ppv→install', get: (r) => (r.installRate >= BENCHMARK.installRate ? c.green(pct(r.installRate)) : c.red(pct(r.installRate))) },
		{ header: 'bottleneck', get: (r) => (r.healthy ? c.green('none') : c.yellow(r.stage)) },
	]);

	heading('What each stage means');
	note(`${c.bold('impression→pageview')} ${c.dim(`(healthy ≥ ${pct(BENCHMARK.viewRate)})`)} — ${STAGE.view.means}`);
	note(`  ${STAGE.view.fix}`);
	note(`${c.bold('pageview→install')} ${c.dim(`(healthy ≥ ${pct(BENCHMARK.installRate)})`)} — ${STAGE.install.means}`);
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

const onboardingFile = (cfg, locale) => join(cfg.paths.analytics, `${locale}-onboarding.json`);

/** Column roles in a funnel export. PostHog, Amplitude and Mixpanel each name these differently. */
const STEP_NAME = /^(step|name|event|label|screen|funnel[ _-]?step)$/i;
const STEP_COUNT = /^(users?|count|completed|people|value|unique[ _-]?users|conversions?)$/i;

/**
 * An export → ordered `{name, users}` steps. Accepts the three shapes a funnel
 * arrives in: delimited text with a header, a bare JSON array, and PostHog's
 * `{result:[{name, count, order}]}`. Row order is the funnel order except when
 * an explicit `order`/`step_index` is present, which wins.
 * @param {string} text
 */
export function parseFunnelExport(text) {
	const raw = String(text ?? '').trim();
	if (!raw) return [];

	let records;
	if (raw.startsWith('{') || raw.startsWith('[')) {
		const doc = JSON.parse(raw);
		records = Array.isArray(doc) ? doc : (doc.result ?? doc.steps ?? doc.funnel ?? doc.data);
		if (!Array.isArray(records)) throw new ShipError('that JSON has no funnel array', { hint: 'expected an array, or {steps:[…]} / {result:[…]}' });
	} else {
		records = parseDelimited(raw);
	}

	const steps = records.map((r, i) => {
		const keys = Object.keys(r ?? {});
		const nameKey = keys.find((k) => STEP_NAME.test(k.trim()));
		const countKey = keys.find((k) => STEP_COUNT.test(k.trim()));
		const order = num(r?.order ?? r?.step_index ?? r?.index);
		return {
			name: String((nameKey ? r[nameKey] : r?.name) ?? `step ${i + 1}`).trim(),
			users: num(countKey ? r[countKey] : (r?.users ?? r?.count)),
			kind: r?.kind ?? r?.type,
			// Absent order must not collapse every row onto 0 and reverse nothing.
			order: Number.isFinite(order) && order > 0 ? order : i + 1,
		};
	});
	return steps.sort((a, b) => a.order - b.order).map(({ order: _order, ...s }) => s);
}

async function onboardingFor(cfg, locale, flags) {
	const file = str(flags.file);
	if (file) {
		const path = resolve(file);
		if (!existsSync(path)) throw new ShipError(`no such export: ${path}`);
		return { steps: parseFunnelExport(await readFile(path, 'utf8')), source: path, imported: true };
	}
	const doc = await readJSON(onboardingFile(cfg, locale));
	if (!doc) return null;
	const steps = Array.isArray(doc) ? doc : (doc.steps ?? []);
	return { steps, source: onboardingFile(cfg, locale), installs: num(doc.installs), paid: num(doc.paid) };
}

/**
 * Installs for the paid-conversion rate. `--installs` wins, then the export
 * itself, then the funnel Apple already gave us for this locale — which is the
 * whole reason the two live under one command.
 */
async function installsFor(cfg, locale, flags, doc) {
	const flag = num(str(flags.installs));
	if (flag > 0) return { installs: flag, from: '--installs' };
	if (doc?.installs > 0) return { installs: doc.installs, from: 'export' };
	const apple = await funnelFor(cfg, locale);
	return apple?.installs > 0 ? { installs: apple.installs, from: 'App Store funnel' } : { installs: 0, from: null };
}

async function onboarding({ flags }) {
	const cfg = await loadConfig();
	const locale = str(flags.locale) ?? (await targetLocales(cfg, flags))[0] ?? cfg.asc?.primaryLocale ?? 'en-US';

	const doc = await onboardingFor(cfg, locale, flags);
	if (!doc)
		throw new ShipError(`no onboarding funnel for ${locale}`, {
			hint: `export the funnel from PostHog and import it: \`ship analytics onboarding --file <export.csv>\` (it is written to ${onboardingFile(cfg, locale)})`,
		});

	const analysis = onboardingFunnel(doc.steps);
	const { installs, from } = await installsFor(cfg, locale, flags, doc);
	const paid = num(str(flags.paid)) || num(doc.paid);
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
	for (const f of analysis.findings) report[f.level === 'skip' ? 'skip' : f.level](f.name, f.detail);

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

const SUB = { funnel, onboarding, terms, pull };

export async function run({ args, flags }) {
	const [sub = 'funnel', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`analytics: unknown subcommand "${sub}"`, { hint: `try: ${Object.keys(SUB).join(', ')}` });
	return fn({ args: rest, flags });
}

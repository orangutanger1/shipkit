// The gate you run before `ship submit`. Everything App Store Review can bounce
// you for, collapsed into one ordered report.
//
// Scars encoded here:
//   · `asc validate` is the *authoritative* answer. We do not re-implement its
//     metadata/screenshot/pricing rules — we fold its remediation plan in verbatim
//     and preserve its order, so the first failing row is literally the next thing
//     to fix. Local checks below it exist only to catch what Apple cannot see.
//   · A version mismatch between ship.config.json and app.json is how a metadata
//     push silently lands on the wrong App Store version. Hard fail, always.
//   · A dead privacy URL is an automatic rejection, and it is the one thing that
//     rots without anyone touching the repo. HEAD it every single time.
//   · The rejections that actually happen are mechanical, not editorial: an
//     unanswered encryption question parks the build in "Waiting for Export
//     Compliance" before a reviewer ever opens it, an empty privacy label or a
//     blank age-rating/content-rights answer bounces the submission, and an
//     undeclared EU trader is *removed from every EU storefront* — worse than a
//     rejection, because nothing is submitted and nothing is reviewed. All four
//     are checkable, so they are checked.
//   · Half of this file needs an App Store Connect key and half does not. The
//     offline half has to run on a machine that has never seen a key, so every
//     live check skips — never fails — when credentials are absent or --offline
//     is passed. A skip means "unknown"; only a fail means "you are blocked".
import { Report, ShipError, SYM, c } from '../log.mjs';
import { ASC, run as exec, which } from '../exec.mjs';
import { loadConfig, readExpoConfig, resolveVersion, requireAppId } from '../config.mjs';
import { readStaged, lintListing } from '../lib/locales.mjs';
import { otaSafety } from '../lib/native.mjs';
import { localizationId } from './shots.mjs';
import { apiKey, resolveProject, auditProject } from '../lib/revenuecat.mjs';

export const help = `
${c.bold('ship preflight')} ${c.dim('— submission readiness gate for this repo')}

${c.dim('usage:')} ship preflight [flags]

Checks, in order:
  ${c.cyan('listing')}      store/staged locales lint clean
  ${c.cyan('version')}      ship.config.json agrees with app.json
  ${c.cyan('encryption')}   app.json answers Apple's export compliance question
  ${c.cyan('asc')}          the version exists and what state it is in
  ${c.cyan('build')}        newest build and whether it processed
  ${c.cyan('screenshots')}  the primary locale has an iPhone set live on ASC
  ${c.cyan('validate')}     Apple's own readiness plan, in fix order
  ${c.cyan('age rating')}   the age rating questionnaire is answered in full
  ${c.cyan('rights')}       the content rights declaration is answered
  ${c.cyan('privacy')}      the app has App Store privacy labels declared
  ${c.cyan('rc')}           RevenueCat entitlement / offering wiring
  ${c.cyan('legal')}        privacy + support URLs actually resolve
  ${c.cyan('eu trader')}    EU locales require a declared trader
  ${c.cyan('ota')}          whether this version is still OTA-compatible

${c.bold('Flags')}
  ${c.cyan('--version <v>')}  override the version under test
  ${c.cyan('--offline')}      run only the checks that need no network or credentials
  ${c.cyan('--json')}         emit the report as JSON

${c.dim('Live checks skip, never fail, when there is no App Store Connect key.')}
`;

const URL_TIMEOUT_MS = 5000;
const LEVELS = new Set(['ok', 'warn', 'fail', 'skip']);

/** asc/revenuecat severity words → Report methods. Unknown severities are failures. */
function levelOf(raw, fallback = 'fail') {
	const s = String(raw ?? '').toLowerCase();
	if (LEVELS.has(s)) return s;
	if (s === 'error' || s === 'invalid' || s === 'blocker' || s === 'critical') return 'fail';
	if (s === 'warning' || s === 'caution') return 'warn';
	if (s === 'info' || s === 'notice' || s === 'passed' || s === 'pass' || s === 'valid') return 'ok';
	if (s === 'skipped' || s === 'not_applicable') return 'skip';
	return fallback;
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * `asc validate` answers with `{summary, remediation:{totalActionable, steps}, checks}`.
 * `remediation.steps` is `checks` already sorted into fix order (blocking first, then
 * by `order`), so it is what we fold in — the first row is the next thing to do.
 * We still fall back to `checks` in case a future asc drops the plan.
 */
function validationItems(payload) {
	const root = payload?.data?.attributes ?? payload?.data ?? payload;
	if (!root) return [];
	if (Array.isArray(root)) return root;
	if (Array.isArray(root.remediation?.steps) && root.remediation.steps.length) return root.remediation.steps;
	for (const key of ['checks', 'problems', 'issues', 'errors', 'results']) {
		if (Array.isArray(root[key]) && root[key].length) return root[key];
	}
	return [];
}

/** One validation step/check → {level, name, detail}. */
function validationRow(item, i) {
	if (typeof item === 'string') return { level: 'fail', name: `#${i + 1}`, detail: clean(item) };
	const name = clean(item.checkId ?? item.id ?? item.check ?? item.field) || `#${i + 1}`;
	const subject = item.resourceType && item.resourceId ? `${item.resourceType} ${item.resourceId}` : null;
	const detail = clean(
		[item.message, item.remediation ? `${SYM.arrow} ${item.remediation}` : null, subject ? `(${subject})` : null]
			.filter(Boolean)
			.join(' '),
	);
	// `blocking` is asc's own verdict on whether this stops a submission; trust it
	// over severity alone. `info` steps are unverifiable-by-API notes, not work.
	const severity = String(item.severity ?? item.level ?? item.status ?? '').toLowerCase();
	const level = item.blocking === true ? 'fail' : severity === 'info' ? 'skip' : levelOf(severity);
	return { level, name, detail };
}

async function checkListing(report, cfg) {
	let staged;
	try {
		staged = await readStaged(cfg);
	} catch (err) {
		report.fail('listing', clean(err.message));
		return;
	}
	if (!staged.length) {
		report.fail('listing', `no locale files in ${cfg.paths.staged} — run \`ship meta stage\` first`);
		return;
	}
	for (const listing of staged) {
		const problems = lintListing(listing).filter((p) => levelOf(p.level, 'fail') !== 'ok');
		if (!problems.length) {
			report.ok(`listing ${listing.locale}`, 'clean');
			continue;
		}
		const worst = problems.some((p) => levelOf(p.level, 'fail') === 'fail') ? 'fail' : 'warn';
		report[worst](
			`listing ${listing.locale}`,
			problems.map((p) => clean([p.field, p.message].filter(Boolean).join(': '))).join('; '),
		);
	}
}

async function checkVersion(report, cfg, version) {
	const expo = await readExpoConfig(cfg);
	const expoVersion = expo?.version ?? expo?.expo?.version ?? null;
	if (!expo) report.skip('version', `${version} — no app.json to cross-check`);
	else if (!expoVersion) report.skip('version', `${version} — app.json declares no version`);
	else if (expoVersion !== version)
		report.fail('version', `app.json says ${expoVersion}, shipping ${version} — a metadata push would hit the wrong version`);
	else report.ok('version', version);
}

async function checkAscVersion(report, appId, version) {
	const probe = await ascProbe(['versions', 'list', '--app', appId, '--version', version]);
	if (probeRow(report, 'asc version', probe, `\`asc versions list --app ${appId}\``)) return;
	const rows = probe.payload?.data ?? (Array.isArray(probe.payload) ? probe.payload : []);
	const hit = rows.find((r) => (r?.attributes?.versionString ?? r?.versionString) === version) ?? rows[0];
	if (!hit) {
		report.fail('asc version', `${version} does not exist on app ${appId} — create it before submitting`);
		return;
	}
	const attrs = hit.attributes ?? hit;
	const state = attrs.appStoreState ?? attrs.state ?? 'UNKNOWN';
	report.ok('asc version', `${version} · ${state}`);
}

async function checkBuild(report, appId) {
	const probe = await ascProbe(['builds', 'list', '--app', appId, '--limit', '5']);
	if (probeRow(report, 'build', probe, '`asc builds list` / `ship build`')) return;
	const rows = probe.payload?.data ?? (Array.isArray(probe.payload) ? probe.payload : []);
	if (!rows.length) {
		report.warn('build', `no builds on app ${appId} — run \`ship build\``);
		return;
	}
	const newest = rows[0].attributes ?? rows[0];
	const number = newest.version ?? newest.buildNumber ?? '?';
	const state = newest.processingState ?? 'UNKNOWN';
	const anyValid = rows.some((r) => (r.attributes ?? r).processingState === 'VALID');
	report[anyValid ? 'ok' : 'warn'](
		'build',
		anyValid ? `build ${number} · ${state}` : `newest build ${number} is ${state} — nothing VALID to attach yet`,
	);
}

async function checkValidate(report, appId, version) {
	const probe = await ascProbe(['validate', '--app', appId, '--version', version, '--platform', 'IOS']);
	// asc validate can exit non-zero *because* it found blockers, and its plan
	// payload still arrives — only auth/transport trouble is a skip, not a fail.
	if (['unsupported', 'unauthorized', 'unavailable'].includes(probe.state)) {
		probeRow(report, 'validate', probe, `\`asc validate --app ${appId} --version ${version}\``);
		return;
	}
	const res = probe.payload;
	if (!res) {
		report.fail('validate', `asc validate returned nothing for ${version} — run it manually to see the error`);
		return;
	}
	const items = validationItems(res);
	const summary = res?.summary ?? res?.data?.attributes?.summary;
	if (summary)
		report[summary.blocking ? 'fail' : summary.errors ? 'fail' : summary.warnings ? 'warn' : 'ok'](
			'validate',
			`${summary.blocking ?? 0} blocking · ${summary.errors ?? 0} error · ${summary.warnings ?? 0} warning · ${summary.infos ?? 0} info`,
		);
	if (!items.length) {
		if (!summary) report.ok('validate', 'Apple reports no blockers');
		return;
	}
	// Payload order is the remediation plan; the first row below is what to fix next.
	items.forEach((item, i) => {
		const { level, name, detail } = validationRow(item, i);
		report[level](`  ${i + 1}. ${name}`, detail);
	});
}

async function checkRevenueCat(report, cfg) {
	const key = await apiKey({ optional: true });
	if (!key) {
		report.skip('rc', 'no RevenueCat v2 key — see `ship doctor`');
		return;
	}
	let project;
	try {
		project = await resolveProject(cfg);
	} catch (err) {
		report.skip('rc', `project unresolved — ${clean(err.message)}`);
		return;
	}
	if (!project) {
		report.skip('rc', 'no revenuecat.projectId in ship.config.json');
		return;
	}
	const findings = await auditProject(cfg, project);
	if (!findings.length) {
		report.ok('rc: project', `${project.name ?? project.id} — no findings`);
		return;
	}
	for (const f of findings) report[levelOf(f.level, 'warn')](`rc: ${clean(f.name)}`, clean(f.detail));
}

async function headOk(url) {
	// HEAD is enough and cheap; some hosts answer 405, which still proves it resolves.
	const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(URL_TIMEOUT_MS) });
	return res.status;
}

async function checkLegal(report, cfg) {
	const urls = [
		['privacy url', cfg.legal?.privacyUrl],
		['support url', cfg.legal?.supportUrl],
	];
	for (const [name, url] of urls) {
		if (!url) {
			report.skip(name, 'unset in ship.config.json');
			continue;
		}
		try {
			const status = await headOk(url);
			if (status >= 200 && status < 400) report.ok(name, `${status} · ${url}`);
			else report.fail(name, `${status} · ${url} — a dead policy URL is an automatic rejection`);
		} catch (err) {
			report.fail(name, `${url} unreachable — ${clean(err.message)}`);
		}
	}
}

/**
 * A version with zero iPhone screenshots is rejected before a human looks at it,
 * and `asc validate` does not always surface it. Ask App Store Connect what is
 * actually attached to the primary locale rather than trusting the local tree —
 * uploads happen from other machines too.
 */
async function checkScreenshots(report, cfg, appId, version) {
	const locale = cfg.asc.primaryLocale;
	let locId;
	try {
		locId = await localizationId(appId, version, locale);
	} catch (err) {
		report.skip('screenshots', clean(err.message));
		return;
	}
	const probe = await ascProbe(['screenshots', 'list', '--version-localization', locId]);
	if (['unsupported', 'unauthorized', 'unavailable'].includes(probe.state)) {
		probeRow(report, 'screenshots', probe, '`ship shots upload`');
		return;
	}
	const sets = Array.isArray(probe.payload?.sets) ? probe.payload.sets : [];
	const counts = sets
		.map((s) => ({
			type: s.set?.attributes?.screenshotDisplayType ?? 'UNKNOWN',
			n: Array.isArray(s.screenshots) ? s.screenshots.length : 0,
		}))
		.filter((s) => s.n > 0);
	if (!counts.length) {
		report.fail(
			'screenshots',
			`${locale} has none on App Store Connect — Apple rejects a version with zero iPhone screenshots (\`ship shots upload\`)`,
		);
		return;
	}
	if (!counts.some((s) => /IPHONE/.test(s.type))) {
		report.fail('screenshots', `${locale} has ${counts.map((s) => `${s.type} ×${s.n}`).join(', ')} but no iPhone set`);
		return;
	}
	report.ok('screenshots', `${locale}: ${counts.map((s) => `${s.type} ×${s.n}`).join(', ')}`);
}

// ─── mechanical review blockers ──────────────────────────────────────────────
//
// The rejections that actually happen are clerical. Each rule below is a pure
// predicate plus a thin row, because a rule nobody can unit-test is a rule a
// refactor silently inverts, and the cost of that is a bounced submission.

export const ENCRYPTION_KEY = 'ITSAppUsesNonExemptEncryption';
export const COMPLIANCE_CODE_KEY = 'ITSEncryptionExportComplianceCode';

const infoPlist = (expo) => (expo?.expo ?? expo)?.ios?.infoPlist ?? null;

/** True when the Expo config never answers Apple's export compliance question. */
export function missingEncryptionKey(expo) {
	const value = infoPlist(expo)?.[ENCRYPTION_KEY];
	return value === undefined || value === null || value === '';
}

/** True when the app claims non-exempt encryption but files no compliance code. */
export function missingComplianceCode(expo) {
	const plist = infoPlist(expo);
	const value = plist?.[ENCRYPTION_KEY];
	return (value === true || value === 'true') && !plist?.[COMPLIANCE_CODE_KEY];
}

async function checkEncryption(report, cfg) {
	const expo = await readExpoConfig(cfg);
	if (!expo) {
		report.skip('export compliance', 'no app.json to read ios.infoPlist from');
		return;
	}
	if (missingEncryptionKey(expo)) {
		report.fail(
			'export compliance',
			`app.json has no ios.infoPlist.${ENCRYPTION_KEY} — every build then parks in "Waiting for Export Compliance" before review even starts; add "${ENCRYPTION_KEY}": false, or true plus ${COMPLIANCE_CODE_KEY} if you ship your own crypto`,
		);
		return;
	}
	if (missingComplianceCode(expo)) {
		report.warn(
			'export compliance',
			`${ENCRYPTION_KEY} is true but ${COMPLIANCE_CODE_KEY} is unset — Apple holds the build until this year's self-classification report is on file`,
		);
		return;
	}
	report.ok('export compliance', `${ENCRYPTION_KEY}: ${infoPlist(expo)[ENCRYPTION_KEY]}`);
}

/**
 * App Store locales that put the app on an EU storefront. Hard-coded because the
 * DSA trader obligation follows the storefront and Apple exposes no mapping for
 * it. Bare-language codes appear only where every variant Apple offers is an EU
 * country — fr, es and pt are absent on purpose (fr-CA, es-MX, pt-BR are not).
 */
export const EU_LOCALES = new Set([
	'bg', 'ca', 'ca-es', 'cs', 'cs-cz', 'da', 'da-dk', 'de', 'de-at', 'de-de', 'el', 'el-gr', 'es-es', 'et',
	'fi', 'fi-fi', 'fr-fr', 'ga', 'hr', 'hr-hr', 'hu', 'hu-hu', 'it', 'it-it', 'lt', 'lv', 'mt', 'nl', 'nl-be',
	'nl-nl', 'pl', 'pl-pl', 'pt-pt', 'ro', 'ro-ro', 'sk', 'sk-sk', 'sl', 'sv', 'sv-se',
]);

/** The EU-storefront locales in a store.locales list, in the order given. */
export function euLocalesIn(locales) {
	return (Array.isArray(locales) ? locales : []).filter((l) => EU_LOCALES.has(String(l).trim().toLowerCase()));
}

/** True when shipping these locales requires a declared EU trader. */
export function euTraderRequired(locales) {
	return euLocalesIn(locales).length > 0;
}

function checkEuTrader(report, cfg) {
	const hits = euLocalesIn(cfg.store?.locales);
	if (!hits.length) {
		report.skip('eu trader', 'no EU storefront locale in store.locales');
		return;
	}
	if (cfg.legal?.euTrader) {
		report.ok('eu trader', `declared · ${hits.join(', ')}`);
		return;
	}
	report.fail(
		'eu trader',
		`${hits.join(', ')} ship to EU storefronts and legal.euTrader is ${cfg.legal?.euTrader === false ? 'false' : 'unset'} — an undeclared trader is pulled from every EU storefront outright, which is worse than a rejection; declare it in App Store Connect → Business, then set legal.euTrader to true`,
	);
}

// Answers Apple legitimately leaves null (`kidsAgeBand` outside the kids category,
// the override fields) plus JSON:API envelope keys, so neither reads as a gap.
const AGE_RATING_IGNORED = /override|kidsAgeBand|^(type|id|data|links|relationships)$/i;

/**
 * @returns {null|string[]} null when the app has no declaration at all, otherwise
 * the unanswered question names — `[]` means the questionnaire is complete.
 */
export function ageRatingGaps(payload) {
	const attrs = payload?.data?.attributes ?? payload?.attributes ?? payload?.data ?? payload;
	if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return null;
	const questions = Object.keys(attrs).filter((k) => !AGE_RATING_IGNORED.test(k));
	if (!questions.length) return null;
	return questions.filter((k) => attrs[k] === null || attrs[k] === undefined || attrs[k] === '');
}

/** The answered content rights value, or null when the question is unanswered. */
export function contentRightsAnswer(payload) {
	const root = payload?.data?.attributes ?? payload?.data ?? payload;
	const value = String(root?.contentRightsDeclaration ?? root?.content_rights_declaration ?? '')
		.trim()
		.toUpperCase();
	return value && value !== 'NOT_ANSWERED' && value !== 'NONE' ? value : null;
}

/** How many data usages the app declares. Zero is an empty privacy label. */
export function privacyDeclarationCount(payload) {
	const root = payload?.data ?? payload;
	if (Array.isArray(root)) return root.length;
	for (const key of ['declarations', 'dataUsages', 'dataTypes', 'purposes', 'categories', 'privacyDetails'])
		if (Array.isArray(root?.[key])) return root[key].length;
	return 0;
}

const UNSUPPORTED = /unknown (sub)?command|unrecognized (sub)?command|not a valid command|no such command/i;
const UNAUTHORIZED =
	/\b40[13]\b|unauthori[sz]ed|forbidden|not authenticated|authentication (failed|required)|no (stored |valid )?credentials|no active session|session (has )?expired|auth login/i;

/** Salvage JSON from asc stdout the way runJSON does, but never throwing. */
function parseJSON(text) {
	const body = String(text ?? '').trim();
	if (!body) return null;
	for (const start of [0, body.search(/[[{]/), body.indexOf('{')]) {
		if (start < 0) continue;
		try {
			return JSON.parse(body.slice(start));
		} catch {
			/* asc occasionally prefixes a banner; try the next candidate */
		}
	}
	return null;
}

/**
 * An asc result → what the row should say. `unsupported` (this asc predates the
 * subcommand) and `unauthorized` (no key for it) are answers, not failures: a
 * preflight that hard-fails because the CLI is a version behind is one nobody runs.
 * Pure, so the tests never spawn asc.
 */
export function classifyAsc({ code = 0, stdout = '', stderr = '' } = {}) {
	const payload = parseJSON(stdout);
	if (code === 0) return { state: payload === null ? 'empty' : 'ok', payload, detail: '' };
	const text = `${stdout}\n${stderr}`;
	const detail = clean(text.split('\n').filter(Boolean).slice(-2).join(' ')).slice(0, 200);
	if (UNSUPPORTED.test(text)) return { state: 'unsupported', payload: null, detail };
	if (UNAUTHORIZED.test(text)) return { state: 'unauthorized', payload: null, detail };
	return { state: 'error', payload, detail };
}

/** One read-only asc call, classified. */
async function ascProbe(args) {
	try {
		return classifyAsc(await exec(ASC, [...args, '--output', 'json'], { allowFail: true }));
	} catch (err) {
		return { state: 'unavailable', payload: null, detail: clean(err.message) };
	}
}

/** Emit the row for a non-`ok` probe. Returns true when it handled the check. */
function probeRow(report, name, { state, detail }, manual) {
	if (state === 'ok') return false;
	if (state === 'unsupported')
		report.warn(name, `this asc cannot answer it (${detail || 'no such subcommand'}) — confirm it by hand: ${manual}`);
	else if (state === 'unauthorized' || state === 'unavailable')
		report.skip(name, `App Store Connect unreachable — ${detail || 'not authenticated'}`);
	else report.fail(name, `asc could not read it — ${detail || 'empty response'} (${manual})`);
	return true;
}

async function checkAgeRating(report, appId) {
	const probe = await ascProbe(['age-rating', 'view', '--app', appId]);
	if (probeRow(report, 'age rating', probe, 'App Store Connect → App Information → Age Rating')) return;
	const gaps = ageRatingGaps(probe.payload);
	if (gaps === null) {
		report.fail(
			'age rating',
			`app ${appId} has no age rating declaration — an unrated version cannot be submitted (\`asc age-rating edit --app ${appId} ...\`)`,
		);
		return;
	}
	if (gaps.length) {
		report.fail('age rating', `unanswered: ${gaps.join(', ')} — the questionnaire has to be complete before submission`);
		return;
	}
	report.ok('age rating', 'questionnaire complete');
}

async function checkContentRights(report, appId) {
	const probe = await ascProbe(['apps', 'content-rights', 'view', '--app', appId]);
	if (probeRow(report, 'content rights', probe, 'App Store Connect → App Information → Content Rights')) return;
	const answer = contentRightsAnswer(probe.payload);
	if (!answer) {
		report.fail(
			'content rights',
			`app ${appId} has not answered the third-party content question — \`asc apps content-rights edit --app ${appId} --uses-third-party-content=false\``,
		);
		return;
	}
	report.ok('content rights', answer);
}

/**
 * Privacy nutrition labels are not in the public API — App Store Connect only
 * exposes them over a web session, which is a separate identity from the ASC key.
 * So this asks whether a session exists before touching anything, and skips
 * loudly when it does not. An app that collects data behind an empty label is
 * rejected, so "unknown" still has to be visible in the report.
 */
async function checkPrivacy(report, appId) {
	const session = await ascProbe(['web', 'auth', 'status']);
	if (session.state === 'unsupported' || session.state === 'unavailable') {
		report.warn(
			'privacy labels',
			'this asc has no `web privacy` — confirm the labels by hand: App Store Connect → App Privacy',
		);
		return;
	}
	if (!session.payload?.authenticated) {
		report.skip(
			'privacy labels',
			'no Apple web session (`asc web auth login`) — privacy labels live behind web-session endpoints, not the ASC API key',
		);
		return;
	}
	const probe = await ascProbe(['web', 'privacy', 'pull', '--app', appId]);
	if (probeRow(report, 'privacy labels', probe, 'App Store Connect → App Privacy')) return;
	const count = privacyDeclarationCount(probe.payload);
	if (!count) {
		report.fail(
			'privacy labels',
			`app ${appId} declares no data collection — a binary that collects data behind an empty privacy label is rejected; fill it in App Store Connect → App Privacy`,
		);
		return;
	}
	report.ok('privacy labels', `${count} data usage declaration${count === 1 ? '' : 's'}`);
}

async function checkOta(report, cfg, version) {
	let safety;
	try {
		safety = await otaSafety(cfg, version);
	} catch (err) {
		report.skip('ota', `cannot read the native surface — ${clean(err.message)}`);
		return;
	}
	// Informational only — preflight gates submission, not updates.
	report[safety.safe ? 'ok' : 'warn']('ota', safety.safe ? 'native surface unchanged since lock' : clean(safety.reason));
}

const ASC_ROWS = ['asc version', 'build', 'screenshots', 'validate'];
const REVIEW_ROWS = ['age rating', 'content rights', 'privacy labels'];

/**
 * Can we reach App Store Connect at all? Asked once so the review checks below do
 * not each rediscover the same missing key, and answered without a network call
 * when the run is offline.
 */
async function ascReachable(offline) {
	if (offline) return { live: false, why: '--offline' };
	if (!(await which(ASC))) return { live: false, why: 'asc is not on PATH — see `ship doctor`' };
	const probe = await ascProbe(['auth', 'status']);
	if (probe.state === 'unauthorized' || probe.state === 'error')
		return { live: false, why: `asc auth status failed — ${probe.detail || 'not authenticated'}` };
	if (!probe.payload?.credentials?.length)
		return { live: false, why: 'no App Store Connect credentials — `asc auth login`' };
	return { live: true, why: null };
}

async function preflight({ flags }) {
	const cfg = await loadConfig(process.cwd(), { optional: true });
	if (!cfg)
		throw new ShipError('preflight: no ship.config.json in this repo', { hint: 'run `ship init` in an app repo first' });

	const offline = !!flags.offline;
	// The offline half has to run in a repo that has never been wired to ASC, so
	// the app id stops being mandatory exactly there and nowhere else.
	const appId = offline ? (cfg.asc.appId ?? process.env.ASC_APP_ID ?? null) : String(requireAppId(cfg));
	const version = await resolveVersion(cfg, flags.version);
	const report = new Report(`ship preflight ${c.dim(`${cfg.name} ${version}`)}`);
	const gate = await ascReachable(offline);
	const skipAll = (rows, why) => {
		for (const row of rows) report.skip(row, `skipped: ${why}`);
	};

	await checkListing(report, cfg);
	await checkVersion(report, cfg, version);
	await checkEncryption(report, cfg);

	if (offline) skipAll([...ASC_ROWS, ...REVIEW_ROWS], gate.why);
	else if (!gate.live) {
		// A dead key or missing asc is "unknown", not "the version does not exist".
		// Each check below still probes on its own, so this only short-circuits
		// what we already know will be a skip.
		skipAll([...ASC_ROWS, ...REVIEW_ROWS], gate.why);
	} else {
		await checkAscVersion(report, appId, version);
		await checkBuild(report, appId);
		await checkScreenshots(report, cfg, appId, version);
		await checkValidate(report, appId, version);
		await checkAgeRating(report, appId);
		await checkContentRights(report, appId);
		await checkPrivacy(report, appId);
	}

	if (offline) skipAll(['rc', 'privacy url', 'support url'], gate.why);
	else {
		await checkRevenueCat(report, cfg);
		await checkLegal(report, cfg);
	}
	checkEuTrader(report, cfg);
	await checkOta(report, cfg, version);

	report.print({ json: !!flags.json });
	return report.code;
}

export { preflight as run };

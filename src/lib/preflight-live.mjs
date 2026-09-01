// Live preflight checks: one read-only asc probe per review blocker, plus the
// RevenueCat / legal / OTA checks. Every live check skips — never fails — when
// credentials are absent, so the offline half can run on a machine that has
// never seen a key. A skip means "unknown"; only a fail means "you are blocked".
import { ASC, run as exec, which } from '../exec.mjs';
import { readExpoConfig } from '../config.mjs';
import { lintListing, readStaged } from './locales.mjs';
import { otaSafety } from './native.mjs';
import { apiKey, auditProject, resolveProject } from './revenuecat.mjs';
import {
	classifyAsc,
	clean,
	contentRightsAnswer,
	ageRatingGaps,
	euLocalesIn,
	levelOf,
	missingComplianceCode,
	missingEncryptionKey,
	privacyDeclarationCount,
	validationItems,
	validationRow,
	COMPLIANCE_CODE_KEY,
	ENCRYPTION_KEY,
} from './preflight-checks.mjs';

const URL_TIMEOUT_MS = 5000;

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

const UNAVAILABLE_STATES = ['unsupported', 'unauthorized', 'unavailable'];

export async function checkListing(report, cfg) {
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

export async function checkVersion(report, cfg, version) {
	const expo = await readExpoConfig(cfg);
	const expoVersion = expo?.version ?? expo?.expo?.version ?? null;
	if (!expo) report.skip('version', `${version} — no app.json to cross-check`);
	else if (!expoVersion) report.skip('version', `${version} — app.json declares no version`);
	else if (expoVersion !== version)
		report.fail('version', `app.json says ${expoVersion}, shipping ${version} — a metadata push would hit the wrong version`);
	else report.ok('version', version);
}

export async function checkAscVersion(report, appId, version) {
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

export async function checkBuild(report, appId) {
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

export async function checkValidate(report, appId, version) {
	const probe = await ascProbe(['validate', '--app', appId, '--version', version, '--platform', 'IOS']);
	// asc validate can exit non-zero *because* it found blockers, and its plan
	// payload still arrives — only auth/transport trouble is a skip, not a fail.
	if (UNAVAILABLE_STATES.includes(probe.state)) {
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

export async function checkRevenueCat(report, cfg) {
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

export async function checkLegal(report, cfg) {
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
export async function checkScreenshots(report, cfg, appId, version, localizationId) {
	const locale = cfg.asc.primaryLocale;
	let locId;
	try {
		locId = await localizationId(appId, version, locale);
	} catch (err) {
		report.skip('screenshots', clean(err.message));
		return;
	}
	const probe = await ascProbe(['screenshots', 'list', '--version-localization', locId]);
	if (UNAVAILABLE_STATES.includes(probe.state)) {
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

export async function checkEncryption(report, cfg) {
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
	report.ok('export compliance', `${ENCRYPTION_KEY}: ${(expo?.expo ?? expo)?.ios?.infoPlist?.[ENCRYPTION_KEY]}`);
}

export function checkEuTrader(report, cfg) {
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

export async function checkAgeRating(report, appId) {
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

export async function checkContentRights(report, appId) {
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
export async function checkPrivacy(report, appId) {
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

export async function checkOta(report, cfg, version) {
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

/**
 * Can we reach App Store Connect at all? Asked once so the review checks below do
 * not each rediscover the same missing key, and answered without a network call
 * when the run is offline.
 */
export async function ascReachable(offline) {
	if (offline) return { live: false, why: '--offline' };
	if (!(await which(ASC))) return { live: false, why: 'asc is not on PATH — see `ship doctor`' };
	const probe = await ascProbe(['auth', 'status']);
	if (probe.state === 'unauthorized' || probe.state === 'error')
		return { live: false, why: `asc auth status failed — ${probe.detail || 'not authenticated'}` };
	if (!probe.payload?.credentials?.length)
		return { live: false, why: 'no App Store Connect credentials — `asc auth login`' };
	return { live: true, why: null };
}

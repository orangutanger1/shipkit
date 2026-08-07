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
import { Report, ShipError, SYM, c } from '../log.mjs';
import { asc } from '../exec.mjs';
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
  ${c.cyan('asc')}          the version exists and what state it is in
  ${c.cyan('build')}        newest build and whether it processed
  ${c.cyan('screenshots')}  the primary locale has an iPhone set live on ASC
  ${c.cyan('validate')}     Apple's own readiness plan, in fix order
  ${c.cyan('rc')}           RevenueCat entitlement / offering wiring
  ${c.cyan('legal')}        privacy + support URLs actually resolve
  ${c.cyan('ota')}          whether this version is still OTA-compatible

${c.bold('Flags')}
  ${c.cyan('--version <v>')}  override the version under test
  ${c.cyan('--json')}         emit the report as JSON
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
	const res = await asc(['versions', 'list', '--app', appId, '--version', version], { fallback: null });
	const rows = res?.data ?? (Array.isArray(res) ? res : []);
	const hit = rows.find((r) => (r?.attributes?.versionString ?? r?.versionString) === version) ?? rows[0];
	if (!hit) {
		report.fail('asc version', `${version} does not exist on app ${appId} — create it before submitting`);
		return null;
	}
	const attrs = hit.attributes ?? hit;
	const state = attrs.appStoreState ?? attrs.state ?? 'UNKNOWN';
	report.ok('asc version', `${version} · ${state}`);
	return state;
}

async function checkBuild(report, appId) {
	const res = await asc(['builds', 'list', '--app', appId, '--limit', '5'], { fallback: null });
	const rows = res?.data ?? (Array.isArray(res) ? res : []);
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
	const res = await asc(['validate', '--app', appId, '--version', version, '--platform', 'IOS'], {
		fallback: null,
		allowFail: true,
	});
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
	const res = await asc(['screenshots', 'list', '--version-localization', locId], {
		fallback: null,
		allowFail: true,
	});
	const sets = Array.isArray(res?.sets) ? res.sets : [];
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

async function preflight({ flags }) {
	const cfg = await loadConfig(process.cwd(), { optional: true });
	if (!cfg)
		throw new ShipError('preflight: no ship.config.json in this repo', { hint: 'run `ship init` in an app repo first' });

	const appId = String(requireAppId(cfg));
	const version = await resolveVersion(cfg, flags.version);
	const report = new Report(`ship preflight ${c.dim(`${cfg.name} ${version}`)}`);

	await checkListing(report, cfg);
	await checkVersion(report, cfg, version);
	await checkAscVersion(report, appId, version);
	await checkBuild(report, appId);
	await checkScreenshots(report, cfg, appId, version);
	await checkValidate(report, appId, version);
	await checkRevenueCat(report, cfg);
	await checkLegal(report, cfg);
	await checkOta(report, cfg, version);

	report.print({ json: !!flags.json });
	return report.code;
}

export { preflight as run };

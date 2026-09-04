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
//   · The rejections that actually happen are mechanical, not editorial — see
//     lib/preflight-live.mjs for the four that are checked.
//   · Half of this command needs an App Store Connect key and half does not. The
//     offline half has to run on a machine that has never seen a key, so every
//     live check skips — never fails — when credentials are absent or --offline
//     is passed. A skip means "unknown"; only a fail means "you are blocked".
import { Report, ShipError, c } from '../log.mjs';
import { loadConfig, requireAppId, resolveVersion } from '../config.mjs';
import { localizationId } from './shots.mjs';

import {
	checkAscVersion,
	checkAgeRating,
	checkBuild,
	checkContentRights,
	checkEncryption,
	checkEuTrader,
	checkLegal,
	checkListing,
	checkOta,
	checkPrivacy,
	checkQa,
	checkRevenueCat,
	checkScreenshots,
	checkValidate,
	checkVersion,
	ascReachable,
} from '../lib/preflight-live.mjs';
import {
	EU_LOCALES,
	ageRatingGaps,
	classifyAsc,
	contentRightsAnswer,
	euLocalesIn,
	euTraderRequired,
	missingComplianceCode,
	missingEncryptionKey,
	privacyDeclarationCount,
	levelOf,
	validationItems,
	validationRow,
	COMPLIANCE_CODE_KEY,
	ENCRYPTION_KEY,
} from '../lib/preflight-checks.mjs';

import { strOf } from '../lib/util.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */

// The pure predicates are this command's public surface (tests import them from
// here; the implementations live in lib/preflight-checks.mjs).
export {
	EU_LOCALES,
	COMPLIANCE_CODE_KEY,
	ENCRYPTION_KEY,
	ageRatingGaps,
	classifyAsc,
	contentRightsAnswer,
	euLocalesIn,
	euTraderRequired,
	levelOf,
	missingComplianceCode,
	missingEncryptionKey,
	privacyDeclarationCount,
	validationItems,
	validationRow,
};

export const help = `
${c.bold('ship preflight')} ${c.dim('— submission readiness gate for this repo')}

${c.dim('usage:')} ship preflight [flags]

Checks, in order:
  ${c.cyan('listing')}      store/staged locales lint clean
  ${c.cyan('version')}      ship.config.json agrees with app.json
  ${c.cyan('encryption')}   app.json answers Apple's export compliance question
  ${c.cyan('qa')}           the Tier 1 quality report for this version is clean
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

const ASC_ROWS = ['asc version', 'build', 'screenshots', 'validate'];
const REVIEW_ROWS = ['age rating', 'content rights', 'privacy labels'];
const EXTERNAL_ROWS = ['rc', 'privacy url', 'support url'];

/**
 * @param {Report} report
 * @param {{cfg: Config, appId: string, version: string}} ctx
 * @returns {Promise<void>}
 */
async function runLiveChecks(report, { cfg, appId, version }) {
	await checkAscVersion(report, appId, version);
	await checkBuild(report, appId);
	await checkScreenshots(report, cfg, appId, version, localizationId);
	await checkValidate(report, appId, version);
	await checkAgeRating(report, appId);
	await checkContentRights(report, appId);
	await checkPrivacy(report, appId);
}

/** @param {SubCtx} ctx @returns {Promise<number>} */
async function preflight({ flags }) {
	const cfg = await loadConfig(process.cwd(), { optional: true });
	if (!cfg)
		throw new ShipError('preflight: no ship.config.json in this repo', { hint: 'run `ship init` in an app repo first' });

	const offline = !!flags.offline;
	// The offline half has to run in a repo that has never been wired to ASC, so
	// the app id stops being mandatory exactly there and nowhere else.
	const appId = offline ? (cfg.asc.appId ?? process.env.ASC_APP_ID ?? null) : String(requireAppId(cfg));
	const version = await resolveVersion(cfg, strOf(flags.version));
	const report = new Report(`ship preflight ${c.dim(`${cfg.name} ${version}`)}`);
	const gate = await ascReachable(offline);
	/** @type {(rows: string[], why: string) => void} */
	const skipAll = (rows, why) => {
		for (const row of rows) report.skip(row, `skipped: ${why}`);
	};

	await checkListing(report, cfg);
	await checkVersion(report, cfg, version);
	await checkEncryption(report, cfg);
	await checkQa(report, cfg, version);

	// A dead key or missing asc is "unknown", not "the version does not exist".
	// Each live check below still probes on its own, so short-circuiting here
	// only skips what we already know will be a skip.
	// `gate.live` is only ever true when `offline` is false, which is the branch
	// where `requireAppId` has already thrown on a missing id — so the second
	// test never changes which path runs. It is what tells the compiler that.
	if (gate.live && appId !== null) await runLiveChecks(report, { cfg, appId, version });
	else skipAll([...ASC_ROWS, ...REVIEW_ROWS], gate.why ?? 'no App Store Connect app id');

	if (offline) skipAll(EXTERNAL_ROWS, gate.why ?? '--offline');
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

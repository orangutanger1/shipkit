// Apple's analytics reports → the numbers `ship analytics` reasons about.
//
// One folder per report, because these reports share no header and no unit.
// The generic column-sniffing fold in report-parse.mjs is right for a human's
// exported spreadsheet, where the shape is unknown; it is wrong here, where the
// shape is known and the reports disagree:
//
//   · Discovery and Engagement is long — an `Event` column of Impression /
//     Page view / Tap, with `Counts` beside it;
//   · App Downloads is keyed by `Download Type`, and only "First-time
//     download" is an install — a manual update is not a new user;
//   · Installation and Deletion carries `App Download Date`, the cohort day, so
//     a deletion can be charged to the week it was installed;
//   · App Sessions and App Crashes are per-device counts, not per-event.
//
// Every folder tolerates an absent report: an app with no sessions data must
// produce "unknown", never a zero that reads as "nobody opened it".
import { parseSpreadsheetNumber } from './report-parse.mjs';

/** @typedef {Record<string, string>} Row */

/** @type {(rows: Row[]|undefined, want: string) => number} */
const sumWhere = (rows, want) => sumBy(rows, (r) => (String(r.Event ?? '').trim().toLowerCase() === want ? r.Counts : 0));

/**
 * @param {Row[]|undefined} rows
 * @param {(r: Row) => string|number|undefined} pick
 * @returns {number}
 */
function sumBy(rows, pick) {
	let total = 0;
	for (const r of rows ?? []) total += parseSpreadsheetNumber(pick(r));
	return total;
}

/** Rows for one territory, or all of them when none was asked for.
 * @param {Row[]|undefined} rows
 * @param {string|null|undefined} territory
 * @returns {Row[]}
 */
export function inTerritory(rows, territory) {
	const want = territory ? String(territory).toLowerCase() : null;
	if (!want) return rows ?? [];
	return (rows ?? []).filter((r) => String(r.Territory ?? '').toLowerCase().includes(want));
}

/** Impressions and product-page views, off the long Event/Counts layout.
 * @param {Row[]|undefined} rows
 * @returns {{impressions: number, pageViews: number}}
 */
export const foldEngagement = (rows) => ({
	impressions: sumWhere(rows, 'impression'),
	pageViews: sumWhere(rows, 'page view'),
});

/**
 * Installs. Only a first-time download is one: "Manual update" and
 * "Re-download" are the same person again, and counting them turns a release
 * week into a fake acquisition spike.
 * @param {Row[]|undefined} rows
 * @returns {number}
 */
export const foldDownloads = (rows) =>
	sumBy(rows, (r) => (/first[- ]?time/i.test(String(r['Download Type'] ?? '')) ? r.Counts : 0));

/**
 * Installs and deletions, and the deletion rate between them.
 *
 * This is the closest thing Apple gives to retention without an SDK: not a D7
 * curve, but the share of installs that did not survive. `rate` is null rather
 * than 0 when there were no installs, because "nobody deleted it" and "nobody
 * had it" are different answers and only one of them is good news.
 * @param {Row[]|undefined} rows
 * @returns {{installs: number, deletions: number, rate: number|null}}
 */
export function foldInstallDelete(rows) {
	const installs = sumWhere(rows, 'install');
	const deletions = sumWhere(rows, 'delete');
	return { installs, deletions, rate: installs > 0 ? deletions / installs : null };
}

/**
 * Sessions, and sessions per active device — the core-loop signal. A device
 * that installed and opened the app once has a ratio of 1; a habit is above it.
 * @param {Row[]|undefined} rows
 * @returns {{sessions: number, devices: number, perDevice: number|null}}
 */
export function foldSessions(rows) {
	const sessions = sumBy(rows, (r) => r.Sessions ?? r.Counts);
	const devices = sumBy(rows, (r) => r['Unique Devices'] ?? r['Unique Counts']);
	return { sessions, devices, perDevice: devices > 0 ? sessions / devices : null };
}

/**
 * Crashes, and crashes per active device. Apple's own report, which is why the
 * quality branch of `analytics diagnose` needs no third-party SDK.
 * @param {Row[]|undefined} rows
 * @param {number} devices
 * @returns {{crashes: number, perDevice: number|null}}
 */
export function foldCrashes(rows, devices) {
	const crashes = sumBy(rows, (r) => r.Crashes ?? r.Counts);
	return { crashes, perDevice: devices > 0 ? crashes / devices : null };
}

/**
 * The whole funnel out of a `{report name: rows}` download.
 *
 * Impressions and page views come from the engagement report and installs from
 * the downloads report, because they are the numbers those two reports are
 * *about*. Reading installs off the engagement report's "Tap → Get" instead
 * would count the tap, not the download.
 *
 * @param {Record<string, Row[]>} byReport
 * @param {{names: Record<string, string>, territory?: string|null}} opts
 * @returns {{funnel: {impressions: number, pageViews: number, installs: number}, retention: ReturnType<typeof foldInstallDelete>|null, sessions: ReturnType<typeof foldSessions>|null, crashes: ReturnType<typeof foldCrashes>|null, reports: string[]}}
 */
export function foldReports(byReport, { names, territory = null }) {
	/** @param {string} key */
	const rows = (key) => (names[key] in byReport ? inTerritory(byReport[names[key]], territory) : undefined);
	const sessionRows = rows('sessions');
	const deleteRows = rows('installDelete');
	const crashRows = rows('crashes');

	const sessions = sessionRows ? foldSessions(sessionRows) : null;
	return {
		funnel: { ...foldEngagement(rows('engagement')), installs: foldDownloads(rows('downloads')) },
		retention: deleteRows ? foldInstallDelete(deleteRows) : null,
		sessions,
		crashes: crashRows ? foldCrashes(crashRows, sessions?.devices ?? 0) : null,
		reports: Object.keys(byReport),
	};
}

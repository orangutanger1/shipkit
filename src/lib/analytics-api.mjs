// ASC App Analytics API access, isolated from the analytics command: every asc
// invocation `analytics pull` makes, the credential gate, segment collection
// and download, and the pull window parsing. The Analytics Reports API is
// asynchronous and role-gated — a key without an analytics-capable role gets a
// flat "forbidden for security reasons" rather than a 401 — so every failure
// here names exactly what is missing instead of forwarding Apple's sentence or
// asc's usage.
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASC, run as exec } from '../exec.mjs';
import { ShipError } from '../log.mjs';
import { DAY_MS, isoDay } from './dates.mjs';
import { parseDelimited } from './report-parse.mjs';
import { strOf } from './util.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./util.mjs').Flags} Flags */
/** @typedef {import('../exec.mjs').AscPayload} AscPayload */

/**
 * The caller's quiet-aware logger: `--json` output routes progress through it
 * so `downloadSegments` can stay clean without owning the flag.
 * @typedef {{step: (m: string) => void, info: (m: string) => void, good: (m: string) => void, note: (m: string) => void, warn: (m: string) => void}} Say
 */
/**
 * One JSON:API resource node asc nests somewhere in an analytics payload, after
 * `nodesOf` has flattened `attributes` onto it.
 * @typedef {JsonObject & {
 *   id?: Json, type?: Json, name?: Json, attributes?: JsonObject,
 *   accessType?: Json, stoppedDueToInactivity?: Json, processingDate?: Json,
 * }} NodeRow
 */
/** One downloaded report segment, ready for `analytics download`. */
/** @typedef {{report: string, requestId: string, instance: string, id: string, date: string}} SegmentRow */

/**
 * @param {string} text
 * @param {number} [n]
 * @returns {string}
 */
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
 *
 * @param {string[]} args
 * @param {{what?: string, fallback?: AscPayload}} [opts]
 * @returns {Promise<Json>}
 */
export async function ascJSON(args, { what, fallback } = {}) {
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

/**
 * Pull every `{type, id, attributes}` of one type out of an asc payload, whatever it nests them in.
 *
 * @param {Json|undefined} payload
 * @param {string} type
 * @returns {NodeRow[]}
 */
function nodesOf(payload, type) {
	/** @type {Map<Json, NodeRow>} */
	const out = new Map();
	/** @type {Set<Json>} */
	const seen = new Set();
	/**
	 * @param {Json|undefined} v
	 */
	const walk = (v) => {
		if (!v || typeof v !== 'object' || seen.has(v)) return;
		seen.add(v);
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (v.type === type && v.id) {
			const attrs =
				v.attributes !== null && typeof v.attributes === 'object' && !Array.isArray(v.attributes)
					? v.attributes
					: {};
			out.set(v.id, { ...v, ...attrs, id: v.id });
		}
		for (const x of Object.values(v)) walk(x);
	};
	walk(payload);
	return [...out.values()];
}

/** ASC will not answer at all without a stored key; say so before spending a round trip.
 * @returns {Promise<void>}
 */
export async function requireCredentials() {
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

/**
 * The pull window: `--from`/`--to` as YYYY-MM-DD, defaulting to the last 30 days.
 *
 * @param {Flags} flags
 * @returns {{from: string, to: string}}
 */
export function windowOf(flags) {
	const to = strOf(flags.to) ?? isoDay(Date.now());
	const from = strOf(flags.from) ?? isoDay(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS);
	for (const [name, v] of [['from', from], ['to', to]])
		if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))
			throw new ShipError(`analytics pull: --${name} must be YYYY-MM-DD, got "${v}"`);
	if (from > to) throw new ShipError(`analytics pull: --from ${from} is after --to ${to}`);
	return { from, to };
}

/**
 * The reports `pull` reads, one per concern, keyed by what it asks them.
 *
 * A closed list rather than a name pattern, because Apple serves the same
 * numbers several ways and folding more than one of them into a single funnel
 * silently multiplies it. On 2026-08-28 this app had, all matching
 * `/discovery|engagement|install|download/`: Discovery and Engagement
 * **Standard** (1,273 impressions) and **Detailed** (1,086) — the same day cut
 * two ways — plus Web Preview Engagement, which is the *website* surface, not
 * the App Store.
 */
export const REPORTS = /** @type {const} */ ({
	engagement: 'App Store Discovery and Engagement Standard',
	downloads: 'App Downloads Standard',
	installDelete: 'App Store Installation and Deletion Standard',
	sessions: 'App Sessions Standard',
	crashes: 'App Crashes',
	subscriptions: 'App Store Subscription State Report Standard',
});

/** @type {Set<string>} */
const REPORT_NAMES = new Set(Object.values(REPORTS));

/**
 * The only granularity `pull` reads.
 *
 * Apple publishes a DAILY *and* a WEEKLY instance of the same report under one
 * processingDate — on 2026-08-28 this app had both, at 1,273 and 600
 * impressions. Summing them counts the week on top of the day.
 */
const GRANULARITY = 'DAILY';

/**
 * Every day in an inclusive window, as YYYY-MM-DD.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function daysBetween(from, to) {
	/** @type {string[]} */
	const out = [];
	for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) out.push(isoDay(t));
	return out;
}

/**
 * The segments in one `analytics view --date <day> --include-segments` answer.
 *
 * That payload is asc's own flattening, not JSON:API — `data[].instances[]
 * .segments[]`, with no `type` keys — so it is read structurally rather than
 * through {@link nodesOf}.
 *
 * @param {Json|undefined} payload
 * @param {{requestId: string, wanted?: Set<string>, granularity?: string}} opts
 * @returns {SegmentRow[]}
 */
export function segmentsOfView(payload, { requestId, wanted = REPORT_NAMES, granularity = GRANULARITY }) {
	const reports = Array.isArray(/** @type {any} */ (payload)?.data) ? /** @type {any[]} */ (/** @type {any} */ (payload).data) : [];
	/** @type {SegmentRow[]} */
	const out = [];
	for (const report of reports) {
		const name = String(report?.name ?? '');
		if (!wanted.has(name)) continue;
		for (const instance of Array.isArray(report?.instances) ? report.instances : []) {
			if (String(instance?.granularity ?? granularity) !== granularity) continue;
			const date = String(instance?.processingDate ?? '').slice(0, 10);
			for (const seg of Array.isArray(instance?.segments) ? instance.segments : [])
				if (seg?.id) out.push({ report: name, requestId, instance: String(instance.id ?? ''), id: String(seg.id), date });
		}
	}
	return out;
}

/**
 * Reports Apple has finished producing for this app, and their downloadable segments.
 *
 * This walks the window a day at a time rather than reports → instances →
 * segments, because `asc analytics reports links` returns bare relationship
 * identifiers — `{type, id}` and nothing else. There is no `processingDate` on
 * them to filter a window by, so the old three-level walk discarded every
 * instance it found and the command died claiming Apple had produced none.
 * `analytics view --date <day> --include-segments` answers with the report, its
 * instance *and* that instance's processingDate in one payload, and asks only
 * about the days we want: one call per day against 157+ for the walk.
 *
 * @param {string} appId
 * @param {{from: string, to: string}} window
 * @param {Say} [say]
 * @returns {Promise<{requestId: Json|undefined, segments: SegmentRow[]}>}
 */
export async function collectSegments(appId, { from, to }, say) {
	const requests = nodesOf(await ascJSON(['analytics', 'requests', '--app', appId, '--paginate'], {
		what: 'list analytics report requests',
	}), 'analyticsReportRequests');
	const usable = requests.filter((r) => !r.stoppedDueToInactivity);
	if (!usable.length) return { requestId: null, segments: [] };

	// nodesOf only emits rows with an id, so the pick always has one.
	const requestId = String((usable.find((r) => r.accessType === 'ONGOING') ?? usable[0]).id);
	const days = daysBetween(from, to);
	/** @type {SegmentRow[]} */
	const segments = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for (const [i, day] of days.entries()) {
		const view = await ascJSON(
			['analytics', 'view', '--request-id', requestId, '--date', day, '--include-segments', '--paginate'],
			{ what: `list the reports produced on ${day}` },
		);
		for (const seg of segmentsOfView(view, { requestId }))
			if (!seen.has(seg.id)) {
				seen.add(seg.id);
				segments.push(seg);
			}
		const left = days.length - i - 1;
		say?.note(`${day} · ${segments.length} segment${segments.length === 1 ? '' : 's'} so far ${left ? `(${left} day${left === 1 ? '' : 's'} left)` : ''}`.trim());
	}
	return { requestId, segments };
}

/**
 * Download every segment and read whatever asc named the files, keeping each
 * report's rows apart.
 *
 * Two reasons for the shape of this, both found against a live account:
 *
 *   · asc names the file it writes after the *instance*, not the segment, so
 *     two segments of one instance collide. Verified: instance 9d9e0f96's two
 *     segments are 5 and 8 rows of different data under one filename. Each
 *     download therefore gets its own directory.
 *   · these reports do not share a header. Folding a concatenated pile reads
 *     every row through whichever report happened to be parsed first, and
 *     silently drops the rest — so rows come back grouped by report name.
 *
 * `say` is the caller's quiet-aware logger so `--json` output stays clean
 * without this module owning the flag.
 *
 * @param {SegmentRow[]} segments
 * @param {Say} say
 * @returns {Promise<{byReport: Record<string, Array<Record<string,string>>>, downloaded: number, dir: string}>}
 */
export async function downloadSegments(segments, say) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-analytics-'));
	/** @type {Record<string, Array<Record<string,string>>>} */
	const byReport = {};
	let ok = 0;
	for (const [i, seg] of segments.entries()) {
		const into = join(dir, String(i));
		await mkdir(into, { recursive: true });
		const res = await exec(
			ASC,
			['analytics', 'download', '--request-id', seg.requestId, '--instance-id', seg.instance, '--segment-id', seg.id, '--decompress'],
			{ cwd: into, allowFail: true },
		);
		if (res.code !== 0) {
			say.warn(`segment ${seg.id} did not download: ${tail(`${res.stdout}\n${res.stderr}`, 1)}`);
			continue;
		}
		ok++;
		const rows = (byReport[seg.report] ??= []);
		for (const f of await readdir(into)) {
			if (!/\.(csv|tsv|txt)$/i.test(f)) continue;
			rows.push(...parseDelimited(await readFile(join(into, f), 'utf8')));
		}
	}
	return { byReport, downloaded: ok, dir };
}

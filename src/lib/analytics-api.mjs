// ASC App Analytics API access, isolated from the analytics command: every asc
// invocation `analytics pull` makes, the credential gate, segment collection
// and download, and the pull window parsing. The Analytics Reports API is
// asynchronous and role-gated — a key without an analytics-capable role gets a
// flat "forbidden for security reasons" rather than a 401 — so every failure
// here names exactly what is missing instead of forwarding Apple's sentence or
// asc's usage.
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
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
/** @typedef {{report: string, requestId: string, instance: string, id: string}} SegmentRow */

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

const REPORT_WANTED = /discovery|engagement|install|download/i;
const MAX_INSTANCES = 120;

/**
 * Reports Apple has finished producing for this app, and their downloadable segments.
 *
 * @param {string} appId
 * @param {{from: string, to: string}} window
 * @returns {Promise<{requestId: Json|undefined, segments: SegmentRow[]}>}
 */
export async function collectSegments(appId, { from, to }) {
	const requests = nodesOf(await ascJSON(['analytics', 'requests', '--app', appId, '--paginate'], {
		what: 'list analytics report requests',
	}), 'analyticsReportRequests');
	const usable = requests.filter((r) => !r.stoppedDueToInactivity);
	if (!usable.length) return { requestId: null, segments: [] };

	const requestId = (usable.find((r) => r.accessType === 'ONGOING') ?? usable[0]).id;
	const view = await ascJSON(
		['analytics', 'view', '--request-id', String(requestId), '--include-segments', '--paginate'],
		{ what: 'list the reports in an analytics request' },
	);
	const reports = nodesOf(view, 'analyticsReports').filter((r) => REPORT_WANTED.test(String(r.name ?? '')));
	if (!reports.length) return { requestId, segments: [] };

	const segments = [];
	for (const report of reports) {
		const links = await ascJSON(['analytics', 'reports', 'links', '--report-id', String(report.id), '--paginate'], {
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
				await ascJSON(['analytics', 'instances', 'links', '--instance-id', String(instance.id), '--paginate'], {
					what: 'list report segments',
				}),
				'analyticsReportSegments',
			);
			for (const seg of segs)
				segments.push({
					report: String(report.name ?? ''),
					requestId: String(requestId ?? ''),
					instance: String(instance.id ?? ''),
					id: String(seg.id ?? ''),
				});
		}
	}
	return { requestId, segments };
}

/**
 * Download every segment into one throwaway directory and read whatever asc
 * named the files. `say` is the caller's quiet-aware logger so `--json` output
 * stays clean without this module owning the flag.
 *
 * @param {SegmentRow[]} segments
 * @param {Say} say
 * @returns {Promise<{records: Array<Record<string,string>>, downloaded: number, dir: string}>}
 */
export async function downloadSegments(segments, say) {
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

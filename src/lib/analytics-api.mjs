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

/** Pull every `{type, id, attributes}` of one type out of an asc payload, whatever it nests them in. */
export function nodesOf(payload, type) {
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

/** The pull window: `--from`/`--to` as YYYY-MM-DD, defaulting to the last 30 days. */
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

/** Reports Apple has finished producing for this app, and their downloadable segments. */
export async function collectSegments(appId, { from, to }) {
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

/**
 * Download every segment into one throwaway directory and read whatever asc
 * named the files. `say` is the caller's quiet-aware logger so `--json` output
 * stays clean without this module owning the flag.
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

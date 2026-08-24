// Apple Search Ads — `asc ads` wrapper, plus the offline half nobody else does.
//
// Four operational facts shape this whole module:
//
//  1. Apple Ads credentials are a *separate* identity from App Store Connect.
//     They live behind app-ads.apple.com and require an API-role user that most
//     solo developers have never created. So every credentialed path here has to
//     fail loudly and usefully rather than dumping a 401 — an unconfigured
//     account is the normal state, not an error.
//  2. `asc ads` mutations are payload-file driven (`--file payload.json`), not
//     flag driven. There is no `--name`/`--budget` on `campaigns create`. We
//     therefore build Apple Ads JSON ourselves and hand it over a temp file.
//     Do not go looking for convenience flags; they do not exist.
//  3. **The plan is desired state; the snapshot is observed state.** They are two
//     files because they are two different claims. `sync` reconciles them by
//     Apple's object ids — recorded into the plan under `apple` — and reports
//     every transition before making any of them. It refuses to pause anything
//     without `--prune`, and refuses to overwrite a value a human changed
//     outside ship without `--force` (plan wins) or `--adopt` (the account wins).
//  4. **Buying installs is only rational if installs are worth something.** `plan`
//     and `sync` read the configured RevenueCat project, because a target CPI
//     against a 0% install→paid rate is a target for losing money at a
//     predictable rate. See src/lib/asa.mjs for the arithmetic.
//
// `ads plan` is deliberately offline apart from those two reads: it turns
// `ship aso` scores into a campaign structure you can read, argue with, and only
// then push. `ads mine` keeps the same bargain — `--file <report.json>` decides
// entirely offline, and it writes the mining plan before `--apply --confirm`
// pushes anything, so the record of what was decided survives a failed push.
import { mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.mjs';
import { ASC, asc, isDryRun, run as exec } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { marketFor } from '../lib/appstore.mjs';
import { pageForAdGroup, readPages } from '../lib/cpp.mjs';
import { keywordList, readStaged } from '../lib/locales.mjs';
import { brandTokens, indexedWords, isCovered, tokenSupport, words } from '../lib/text.mjs';
import { overviewMetrics, resolveProject } from '../lib/revenuecat.mjs';
import {
	BID,
	assertBidSpread,
	bidFor,
	describeAction,
	lastModified,
	monetisation,
	normaliseAdGroup,
	normaliseCampaign,
	normaliseKeyword,
	reconcile,
	resolveBidding,
	resolveKillRule,
} from '../lib/asa.mjs';

export const help = `
${c.bold('ship ads')} ${c.dim('— Apple Search Ads (Apple Ads Campaign Management API)')}

${c.dim('usage:')} ship ads [subcommand] [flags]

  ${c.cyan('status')}     ${c.dim('default')} credential state; setup instructions when unconfigured
  ${c.cyan('login')}      store Apple Ads credentials (validates the .p8 before calling asc)
  ${c.cyan('campaigns')}  list campaigns for the org
  ${c.cyan('keywords')}   list targeting keywords in an ad group
  ${c.cyan('report')}     spend / installs / CPI / TTR / CVR at campaign, ad-group, keyword or search-term level
  ${c.cyan('plan')}       ${c.green('offline')} four campaigns (Exact · Discovery · Competitor · Brand) + budget split
  ${c.cyan('snapshot')}   read the live account — ids, statuses, bids, negatives, performance
  ${c.cyan('sync')}       reconcile campaign-plan.json with the live account, by object id
  ${c.cyan('mine')}       search-term report → negative keywords + Exact promotions + ASO feedback

${c.bold('Flags')}
  ${c.cyan('--org <id>')}          Apple Ads organization id ${c.dim('(default: ads.orgId in ship.config.json)')}
  ${c.cyan('--campaign <id>')}     campaign id ${c.dim('(keywords, report; mine: one campaign instead of all)')}
  ${c.cyan('--ad-group <id>')}     ad group id ${c.dim('(keywords, report)')}
  ${c.cyan('--level <l>')}         ${c.dim('report')} campaign${c.dim('|')}ad-group${c.dim('|')}keyword${c.dim('|')}search-term ${c.dim('(default: campaign)')}
  ${c.cyan('--from --to')}         report window ${c.dim('YYYY-MM-DD, default: 7 days (report) / 30 days (mine)')}
  ${c.cyan('--locale <l>')}        aso locale to plan from, and to feed paid winners back into ${c.dim('(default: asc.primaryLocale)')}
  ${c.cyan('--top <n>')}           keywords to plan ${c.dim('(default: 15)')}
  ${c.cyan('--budget <n>')}        total daily ${c.bold('campaign')} budget in USD ${c.dim('(default: 10; Apple has no ad-group budget)')}
  ${c.cyan('--split <a/b/c/d>')}   exact/discovery/competitor/brand ratio ${c.dim('(default: 50/25/15/10)')}
  ${c.cyan('--bid <n>')}           seed bid per tap, overriding the realised CPT ${c.dim('(default: measured, else ads.seedBid, else $0.60)')}
  ${c.cyan('--min-bid <n>')}       bid floor ${c.dim(`(default: Apple's $${BID.floor.toFixed(2)} minimum)`)}
  ${c.cyan('--max-bid <n>')}       bid ceiling ${c.dim(`(default: $${BID.ceiling.toFixed(2)}, or 2x the seed)`)}
  ${c.cyan('--sub-price <n>')}     monthly subscription price ${c.dim('(default: ads.subPrice)')}
  ${c.cyan('--target-cpi <n>')}    ${c.dim('mine')} decision line ${c.dim('(default: ads.targetCpi)')}
  ${c.cyan('--min-taps <n>')}      ${c.dim('mine')} taps before zero installs counts as evidence ${c.dim('(default: derived from ads.baselineInstallRate)')}
  ${c.cyan('--file <path>')}       ${c.dim('mine')} search-term report JSON instead of pulling one ${c.dim('(no credentials)')}
  ${c.cyan('--apply --confirm')}   ${c.dim('mine')} push the mined negatives and promotions ${c.dim('(--apply alone prints the evidence and stops)')}
  ${c.cyan('--prune')}             ${c.dim('sync')} allow pausing live objects the plan does not contain
  ${c.cyan('--force')}             ${c.dim('sync')} overwrite values changed outside ship ${c.dim('(the plan wins)')}
  ${c.cyan('--adopt')}             ${c.dim('sync')} record live values into the plan instead ${c.dim('(the account wins)')}
  ${c.cyan('--no-ltv-check')}      ${c.dim('plan, sync')} skip the RevenueCat monetisation check
  ${c.cyan('--json')}              machine-readable output

${c.dim('Credentials are separate from ASC: app-ads.apple.com → Account Settings → API.')}
${c.dim('`ship ads plan` needs no Apple Ads credentials at all.')}
${c.dim('Nothing is paused, and no manual change is reverted, without a flag that says so.')}
`;

const emit = (data) => {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
	return 0;
};

const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const pct = (n) => `${(Number(n ?? 0) * 100).toFixed(2)}%`;
const num = (v, fallback = 0) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
};

/**
 * asc emits Apple Ads payloads verbatim, so a list is `{data:[...]}` for the raw
 * API and a bare array once asc has unwrapped it. Tolerate both plus the
 * `pagination`-wrapped shape rather than guessing per-endpoint.
 */
function rows(payload) {
	if (Array.isArray(payload)) return payload;
	if (Array.isArray(payload?.data)) return payload.data;
	if (Array.isArray(payload?.items)) return payload.items;
	if (Array.isArray(payload?.data?.data)) return payload.data.data;
	return [];
}

const orgOf = (cfg, flags) =>
	flags.org ?? cfg?.ads?.orgId ?? process.env.ASC_ADS_ORG_ID ?? null;

function requireOrg(cfg, flags) {
	const org = orgOf(cfg, flags);
	if (!org)
		throw new ShipError('no Apple Ads organization id', {
			hint: 'pass --org <id>, set ads.orgId in ship.config.json, or export ASC_ADS_ORG_ID — `asc ads acls --output json` lists the orgs this key can see',
		});
	return String(org);
}

/** Read credential state without ever failing: "not configured" is a valid answer. */
async function authState() {
	const res = await exec(ASC, ['ads', 'auth', 'status'], { allowFail: true });
	const text = `${res.stdout}${res.stderr}`.trim();
	const configured =
		res.code === 0 &&
		!/no apple ads credentials/i.test(text) &&
		!/active auth:\s*none/i.test(text);
	return { configured, text };
}

const LOGIN_LINE = [
	'asc ads auth login \\',
	'  --name "<profile name>" \\',
	'  --client-id "SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \\',
	'  --team-id "SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \\',
	'  --key-id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \\',
	'  --private-key ~/.asc/asa-private.p8 \\',
	'  --org "<organization id>"',
];

/**
 * The provenance matters more than the command: every one of these values comes
 * from a different screen, and the first one only appears after you invite a
 * user you probably think you already are.
 */
function setupGuide() {
	heading('Not configured — how to fix it');
	process.stdout.write('\n');
	for (const line of LOGIN_LINE) process.stdout.write(`  ${c.cyan(line)}\n`);
	process.stdout.write('\n');
	info('Where each value comes from');
	note(`1. ${c.bold('app-ads.apple.com')} → Account Settings → User Management → Invite Users`);
	note('   Role: API Account Manager (read+write). API Account Read Only can pull');
	note('   reports but cannot create a campaign. API users are separate people in');
	note('   Apple\'s model, so invite yourself even as the account admin — the');
	note(`   invite needs an ${c.bold('Apple ID')}, not just any address.`);
	note(`2. Generate the key pair ${c.bold('yourself')} — Apple never gives you a private key:`);
	note(`   ${c.cyan('openssl ecparam -genkey -name prime256v1 -noout -out asa.pem')}`);
	note(`   ${c.cyan('openssl ec -in asa.pem -pubout -out asa.pub')}   ${c.dim('# this is what you paste')}`);
	note(`   ${c.cyan('openssl pkcs8 -topk8 -nocrypt -in asa.pem -out ~/.asc/asa-private.p8')}`);
	note(`   ${c.dim('--private-key must be PKCS#8: the file starts -----BEGIN PRIVATE KEY-----')}`);
	note(`3. Sign in ${c.bold('as that API user')} → Account Settings → API → paste the`);
	note('   public key → Generate API Client. That screen returns --client-id');
	note('   (starts SEARCHADS.), --team-id (often identical) and --key-id.');
	note(`4. ${c.bold('--org')} is the organization id shown in the URL / account picker;`);
	note('   after login `asc ads acls --output json` lists every org you can reach.');
	process.stdout.write('\n');
	note('`ship ads plan` works right now without any of this.');
}

async function status({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	const { configured, text } = await authState();

	if (!configured) {
		if (flags.json)
			return emit({ configured: false, org: orgOf(cfg, flags), detail: text, login: LOGIN_LINE.join('\n') });
		heading('Apple Search Ads');
		for (const line of text.split('\n')) note(line);
		setupGuide();
		// Unconfigured is information, not failure — CI gates should not trip on it.
		return 0;
	}

	const [me, acls] = await Promise.all([
		asc(['ads', 'me'], { fallback: null, allowFail: true }),
		asc(['ads', 'acls'], { fallback: null, allowFail: true }),
	]);
	const orgs = rows(acls);
	if (flags.json) return emit({ configured: true, me: me?.data ?? me, orgs });

	heading('Apple Search Ads');
	for (const line of text.split('\n')) note(line);
	const user = me?.data ?? me ?? {};
	if (user.parentOrgId || user.userId)
		info(`user ${c.bold(user.userId ?? '?')} · parent org ${c.bold(user.parentOrgId ?? '?')}`);

	heading(`Organizations (${orgs.length})`);
	table(orgs, [
		{ header: 'orgId', get: (o) => o.orgId ?? o.id ?? '' },
		{ header: 'name', get: (o) => o.orgName ?? o.parentOrgName ?? o.name ?? '' },
		{ header: 'currency', get: (o) => o.currency ?? '' },
		{ header: 'roles', get: (o) => (o.roleNames ?? o.roles ?? []).join(',') },
	]);
	const selected = orgOf(cfg, flags);
	if (selected) info(`ads.orgId = ${c.bold(selected)}`);
	else warn('no ads.orgId in ship.config.json — campaigns/report need --org');
	return 0;
}

async function login({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	const keyPath = flags['private-key'] ?? flags.privateKey;
	const missing = ['client-id', 'team-id', 'key-id'].filter((f) => !flags[f]);
	if (!keyPath) missing.push('private-key');
	if (missing.length)
		throw new ShipError(`ads login: missing ${missing.map((m) => `--${m}`).join(' ')}`, {
			hint: `${LOGIN_LINE.join('\n')}\n\nRun \`ship ads status\` for where each value comes from.`,
		});

	const abs = resolve(String(keyPath).replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
	if (!existsSync(abs))
		throw new ShipError(`private key not found: ${abs}`, {
			hint: 'You generated this key, not Apple — it is the private half of the public key pasted at Account Settings → API. If it is lost the client is unusable: generate a new pair and upload the new public key.',
		});

	// Validate before handing to asc: a PEM-header mismatch surfaces from Apple as
	// an opaque invalid_client, hours later, with no mention of the key format.
	const head = (await readFile(abs, 'utf8')).trimStart().split('\n')[0].trim();
	if (head !== '-----BEGIN PRIVATE KEY-----')
		throw new ShipError(`private key is not PKCS#8: first line is "${head}"`, {
			hint: `Apple Ads requires a PKCS#8 P-256 key. Convert it:\n  openssl pkcs8 -topk8 -nocrypt -in ${abs} -out ${abs.replace(/\.[^.]+$/, '')}-pkcs8.p8`,
		});

	const name = flags.name ?? (cfg?.name ? `${cfg.name} ads` : 'ads');
	const args = [
		'ads',
		'auth',
		'login',
		'--name',
		String(name),
		'--client-id',
		String(flags['client-id']),
		'--team-id',
		String(flags['team-id']),
		'--key-id',
		String(flags['key-id']),
		'--private-key',
		abs,
	];
	const org = flags.org ?? cfg?.ads?.orgId;
	if (org) args.push('--org', String(org));

	step(`asc ${args.join(' ')}`);
	const res = await exec(ASC, args, { capture: false, mutating: true, allowFail: true });
	if (res.skipped) return 0;
	if (res.code !== 0)
		throw new ShipError(`asc ads auth login exited ${res.code}`, {
			hint: 'Common cause: the credentials belong to your admin login rather than the API-role user. Re-check step 2 in `ship ads status`.',
		});
	good('credentials stored');
	return 0;
}

/**
 * Every credentialed subcommand funnels through here so the guidance is identical
 * — and so the active credential is checked against the configured org before a
 * mutation goes to the wrong account. `asc ads auth status` already reports which
 * profile and org are active; the only failure was that nothing compared it with
 * `ads.orgId`, exactly as nothing compared the RevenueCat key with
 * `revenuecat.projectId`.
 */
async function gate(cfg = null) {
	const { configured, text } = await authState();
	if (!configured)
		throw new ShipError('Apple Ads credentials are not configured', {
			hint: `${text}\n\n${LOGIN_LINE.join('\n')}\n\nRun \`ship ads status\` for where each value comes from.\n\`ship ads plan\` works offline in the meantime.`,
		});
	const want = cfg?.ads?.orgId;
	if (!want) return;
	const auth = await asc(['ads', 'auth', 'status'], { fallback: null });
	const active = auth?.active ?? {};
	const live = String(active.org_id ?? active.orgId ?? '');
	if (live && live !== String(want))
		throw new ShipError(`the active Apple Ads profile is org ${live}, but ads.orgId is ${want}`, {
			hint: `profile "${active.profile ?? '?'}" is the default — pass --org ${want}, switch the default with \`asc ads auth use\`, or correct ads.orgId in ${cfg.file}`,
		});
}

async function campaigns({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	await gate(cfg);
	const org = requireOrg(cfg, flags);
	const list = rows(
		await asc(['ads', 'campaigns', 'list', '--org', org, '--paginate'], { fallback: null }),
	);
	if (flags.json) return emit(list);

	heading(`Campaigns (${list.length}) · org ${org}`);
	table(list, [
		{ header: 'id', get: (r) => r.id ?? '' },
		{ header: 'name', get: (r) => r.name ?? '' },
		{ header: 'status', get: (r) => r.status ?? r.servingStatus ?? '' },
		{
			header: 'dailyBudget',
			get: (r) =>
				r.dailyBudgetAmount
					? `${r.dailyBudgetAmount.amount} ${r.dailyBudgetAmount.currency ?? ''}`.trim()
					: '',
		},
		{ header: 'countries', get: (r) => (r.countriesOrRegions ?? []).join(',') },
	]);
	return 0;
}

async function keywords({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	await gate(cfg);
	const org = requireOrg(cfg, flags);
	const campaign = flags.campaign;
	const adGroup = flags['ad-group'] ?? flags.adGroup;
	if (!campaign || !adGroup)
		throw new ShipError('ads keywords: --campaign and --ad-group are required', {
			hint: 'Apple scopes targeting keywords to an ad group: `ship ads campaigns` then `asc ads ad-groups --campaign <id> --org <org>`',
		});

	const list = rows(
		await asc(
			[
				'ads',
				'targeting-keywords',
				'list',
				'--campaign',
				String(campaign),
				'--ad-group',
				String(adGroup),
				'--org',
				org,
				'--paginate',
			],
			{ fallback: null },
		),
	);
	if (flags.json) return emit(list);

	heading(`Targeting keywords (${list.length}) · ad group ${adGroup}`);
	table(list, [
		{ header: 'text', get: (r) => r.text ?? '' },
		{ header: 'matchType', get: (r) => r.matchType ?? '' },
		{
			header: 'bid',
			get: (r) => (r.bidAmount ? `${r.bidAmount.amount} ${r.bidAmount.currency ?? ''}`.trim() : ''),
		},
		{ header: 'status', get: (r) => r.status ?? '' },
	]);
	return 0;
}

const isoDay = (d) => d.toISOString().slice(0, 10);

async function withPayload(name, body, fn) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-ads-'));
	const file = join(dir, name);
	await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
	return fn(file);
}

/**
 * Report levels, and what identifies a row at each one. Apple's ad-group,
 * keyword and search-term reports are all campaign-scoped POSTs whose payload a
 * human had to author by hand — which is exactly why an ad-group-level
 * regression (15 new groups at a losing bid) stayed invisible while the
 * campaign-level total looked merely quiet. `asc ads reports preset` builds the
 * ReportingRequest, so `--level` plus `--from`/`--to` is all this needs.
 *
 * The field names are Apple's, and Apple rejects the obvious ones: there is no
 * `installs` selector field ("INVALID_PROJECTION_INPUT"). `tapInstalls` counts
 * installs attributed to a tap, `totalInstalls` also counts view-through — we
 * request both and prefer the total, which is what Apple bills a CPI against.
 */
const LEVELS = {
	campaign: {
		preset: 'campaigns',
		scoped: false,
		fields: 'campaignId,campaignName,campaignStatus,impressions,taps,tapInstalls,totalInstalls,localSpend',
		label: (m) => m.campaignName ?? m.name ?? '(unnamed)',
	},
	'ad-group': {
		preset: 'ad-groups',
		scoped: true,
		// No `campaignId`: Apple lists it as supported for this level and then
		// rejects it ("INVALID_PROJECTION_INPUT"). The id comes from the request.
		fields: 'adGroupId,adGroupName,adGroupStatus,impressions,taps,tapInstalls,totalInstalls,localSpend',
		label: (m) => m.adGroupName ?? m.name ?? '(unnamed)',
	},
	keyword: {
		preset: 'keywords',
		scoped: true,
		fields: 'keywordId,keyword,matchType,keywordStatus,adGroupId,impressions,taps,tapInstalls,totalInstalls,localSpend',
		label: (m) => `${m.keyword ?? m.keywordText ?? '(unnamed)'}${m.matchType ? ` ${m.matchType}` : ''}`,
	},
	'search-term': {
		preset: 'search-terms',
		scoped: true,
		// Apple refuses row totals on search-term reports; the preset knows.
		fields: 'searchTermText,searchTermSource,keyword,matchType,adGroupId,impressions,taps,tapInstalls,totalInstalls,localSpend',
		label: (m) => m.searchTermText ?? m.searchTerm ?? '(unnamed)',
	},
};

const METRIC_KEYS = ['impressions', 'taps', 'tapInstalls', 'totalInstalls', 'installs', 'newDownloads', 'redownloads'];

/**
 * One report row → the metrics we derive ourselves rather than trust avgCPA for.
 *
 * Apple returns either a `total` (when row totals were requested) or a
 * `granularity` array of daily buckets — and refuses row totals outright on
 * search-term reports. Reading `granularity[0]` would silently report one day of
 * a thirty-day window, so the buckets are summed.
 */
function totalsOf(r) {
	if (r.total) return r.total;
	const buckets = Array.isArray(r.granularity) ? r.granularity : [];
	if (!buckets.length) return r.metadata ?? {};
	const out = { localSpend: { amount: 0, currency: 'USD' } };
	for (const b of buckets) {
		out.localSpend.amount += num(b.localSpend?.amount ?? b.localSpend);
		out.localSpend.currency = b.localSpend?.currency ?? out.localSpend.currency;
		for (const k of METRIC_KEYS) if (b[k] !== undefined) out[k] = num(out[k]) + num(b[k]);
	}
	return out;
}

function metricRow(r, level) {
	const meta = r.metadata ?? {};
	const t = totalsOf(r);
	const spend = num(t.localSpend?.amount ?? t.localSpend);
	const impressions = num(t.impressions);
	const taps = num(t.taps);
	// `totalInstalls` first: it is the figure Apple's own CPI is computed against.
	// A row that carries neither falls back to the download breakdown.
	const installs = num(
		t.totalInstalls ?? t.tapInstalls ?? t.installs ?? num(t.newDownloads) + num(t.redownloads),
	);
	return {
		level,
		name: LEVELS[level].label(meta),
		campaignId: meta.campaignId ?? r.campaignId ?? null,
		adGroupId: meta.adGroupId ?? null,
		keywordId: meta.keywordId ?? null,
		status: meta.campaignStatus ?? meta.adGroupStatus ?? meta.keywordStatus ?? meta.status ?? '',
		impressions,
		taps,
		installs,
		spend,
		currency: t.localSpend?.currency ?? 'USD',
		cpi: installs ? round2(spend / installs) : null,
		cpt: taps ? round2(spend / taps) : null,
		ttr: impressions ? taps / impressions : 0,
		conversionRate: taps ? installs / taps : 0,
	};
}

/**
 * Apple marks one row `other: true` when the response is truncated: it is the
 * sum of everything *not* returned. Counting it alongside the named rows inflates
 * every total, so it is dropped — a truncated report should under-report, not
 * silently double-count.
 */
const reportRows = (res) =>
	(res?.data?.reportingDataResponse?.row ?? res?.reportingDataResponse?.row ?? rows(res)).filter(
		(r) => r?.other !== true,
	);

/**
 * Pull one level of report. Campaign-scoped levels need a campaign id each, so
 * `--campaign` narrows and its absence fans out over every campaign in the org
 * — the whole point being that no level requires hand-authored JSON.
 *
 * No `fallback`: a rejected selector must raise, not read as an empty account.
 * An ad-group report that quietly returned zero rows is how a bid regression
 * looked identical to a quiet week.
 */
async function pullReport(org, level, { from, to, campaign, adGroup }) {
	const spec = LEVELS[level];
	const base = [
		'ads', 'reports', 'preset',
		'--level', spec.preset,
		'--from', from,
		'--to', to,
		'--fields', spec.fields,
		'--sort', '-localSpend',
		'--org', String(org),
		...(spec.preset === 'search-terms' ? [] : ['--return-row-totals']),
	];
	if (!spec.scoped) return reportRows(await asc(base)).map((r) => metricRow(r, level));

	const ids = campaign
		? [String(campaign)]
		: (await listCampaigns(org)).map((r) => String(r.id)).filter((id) => id && id !== 'undefined');
	if (!ids.length)
		throw new ShipError(`org ${org} has no campaigns to report on`, {
			hint: 'run `ship ads plan`, then `ship ads sync`',
		});
	const out = [];
	for (const id of ids) {
		const args = [...base, '--campaign', id, ...(adGroup ? ['--ad-group', String(adGroup)] : [])];
		const res = await asc(args);
		for (const r of reportRows(res)) out.push({ ...metricRow(r, level), campaignId: r.metadata?.campaignId ?? id });
	}
	return out;
}

/**
 * What an install is worth, read from the configured RevenueCat project.
 *
 * Never throws: the funnel is context, and a missing credential must not stop a
 * report. It returns *why* it could not answer, because "no data" and "zero
 * conversion" are opposite findings and a report that conflates them is how you
 * end up buying installs worth $0.00.
 */
async function monetisationSignal(cfg, { subPrice } = {}) {
	if (!cfg?.revenuecat?.projectId) return { available: false, reason: 'no revenuecat.projectId in ship.config.json' };
	try {
		const project = await resolveProject(cfg);
		if (!project) return { available: false, reason: `no RevenueCat project matches "${cfg.revenuecat.projectId}"` };
		const raw = await overviewMetrics(project.id);
		return {
			available: true,
			project: project.id,
			keySource: project.keySource ?? null,
			raw,
			...monetisation(raw, {
				subPrice: subPrice ?? cfg.ads?.subPrice,
				retentionMonths: cfg.ads?.retentionMonths,
			}),
		};
	} catch (err) {
		return { available: false, reason: err.message };
	}
}

async function report({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	await gate(cfg);
	const org = requireOrg(cfg, flags);

	const level = String(flags.level ?? 'campaign').toLowerCase();
	if (!LEVELS[level])
		throw new ShipError(`--level "${level}" is not a report level`, {
			hint: `one of: ${Object.keys(LEVELS).join(', ')}`,
		});

	const to = flags.to ? String(flags.to) : isoDay(new Date());
	const from = flags.from
		? String(flags.from)
		: isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86400_000));

	const metrics = (
		await pullReport(org, level, {
			from,
			to,
			campaign: flags.campaign ?? null,
			adGroup: flags['ad-group'] ?? flags.adGroup ?? null,
		})
	).sort((a, b) => b.spend - a.spend);

	const spend = round2(metrics.reduce((s, r) => s + r.spend, 0));
	const installs = metrics.reduce((s, r) => s + r.installs, 0);
	const taps = metrics.reduce((s, r) => s + r.taps, 0);
	const money$ = cfg ? await monetisationSignal(cfg) : { available: false, reason: 'no ship.config.json' };

	if (flags.json)
		return emit({
			from,
			to,
			org,
			level,
			rows: metrics,
			totals: {
				spend,
				taps,
				installs,
				cpi: installs ? round2(spend / installs) : null,
				cpt: taps ? round2(spend / taps) : null,
			},
			monetisation: money$,
		});

	heading(`${level} report · ${from} → ${to} · org ${org}`);
	table(metrics, [
		{ header: level, get: (r) => r.name },
		{ header: 'spend', get: (r) => money(r.spend) },
		{ header: 'installs', get: (r) => String(r.installs) },
		{ header: 'CPI', get: (r) => (r.cpi === null ? '—' : money(r.cpi)) },
		{ header: 'taps', get: (r) => String(r.taps) },
		{ header: 'CPT', get: (r) => (r.cpt === null ? '—' : money(r.cpt)) },
		{ header: 'TTR', get: (r) => pct(r.ttr) },
		{ header: 'CVR', get: (r) => pct(r.conversionRate) },
	]);

	process.stdout.write('\n');
	info(
		`total ${c.bold(money(spend))} · ${c.bold(installs)} installs · blended CPI ${c.bold(installs ? money(spend / installs) : '—')} · CPT ${c.bold(taps ? money(spend / taps) : '—')}`,
	);
	// The other half of the funnel, in the same place: CPI without install→paid is
	// a cost with no revenue beside it, which is how $10/day survives review.
	if (money$.available) {
		const line = `install→paid ${money$.installToPaid === null ? '—' : pct(money$.installToPaid)} · ${money$.subscriptions} subscription(s) · ${money(money$.revenue)} revenue · LTV/install ${money(money$.ltvPerInstall)}`;
		if (money$.proven) info(line);
		else warn(line);
		info(`${money$.label}: ${money$.cpiCeiling === null ? 'none — nothing has monetised' : money(money$.cpiCeiling)} per install`);
	} else note(`install→paid unknown — ${money$.reason}`);

	const dead = metrics.filter((r) => r.spend > 0 && r.installs === 0);
	if (dead.length)
		warn(`${dead.length} ${level}(s) spent with zero installs: ${dead.map((r) => r.name).join(', ')}`);
	if (level === 'campaign')
		note('`ship ads report --level ad-group` is where a bid regression shows up; campaign totals hide it');
	note('`ship ads mine` turns the search-term half of this report into keywords instead of a to-do list');
	return 0;
}

// ─── plan (offline) ──────────────────────────────────────────────────────────

/**
 * Default budget ratio. Exact takes half: it is the only structure whose verdict
 * is unambiguous. Discovery takes a quarter because Search Match is the only
 * source of terms nobody thought to seed. Competitor is a probe, not a strategy.
 * Brand is a rounding error you buy so that a competitor cannot buy it instead.
 */
export const SPLIT = { exact: 0.5, discovery: 0.25, competitor: 0.15, brand: 0.1 };

const ROLES = Object.keys(SPLIT);
const round2 = (n) => Math.round(num(n) * 100) / 100;

/** `--split 50/25/15/10` or `--split exact=50,discovery=25`. Weights, not percentages. */
export function parseSplit(value) {
	if (value === undefined || value === null || value === '' || value === true) return { ...SPLIT };
	const parts = String(value).split(/[/,;:|\s]+/).filter(Boolean);
	const out = {};
	if (parts.every((p) => /^\d+(?:\.\d+)?$/.test(p))) {
		if (parts.length > ROLES.length)
			throw new ShipError(`--split takes at most ${ROLES.length} numbers`, { hint: `order is ${ROLES.join('/')}` });
		parts.forEach((p, i) => {
			out[ROLES[i]] = Number(p);
		});
	} else
		for (const p of parts) {
			const [key, v] = p.split('=');
			const role = ROLES.find((r) => r === String(key).trim().toLowerCase());
			if (!role || !/^\d+(?:\.\d+)?$/.test(String(v ?? '').trim()))
				throw new ShipError(`--split: cannot read "${p}"`, {
					hint: `use "50/25/15/10" or "exact=50,discovery=25" — roles: ${ROLES.join(', ')}`,
				});
			out[role] = Number(v);
		}
	for (const role of ROLES) if (out[role] === undefined) out[role] = 0;
	if (!ROLES.some((role) => out[role] > 0)) throw new ShipError('--split allocates nothing to any campaign');
	return out;
}

/**
 * Cents-exact allocation: the campaign budgets always sum back to `--budget`, so a
 * skipped campaign redistributes its share instead of quietly shrinking the spend.
 * The rounding remainder lands on the largest share, where it distorts least.
 */
export function allocate(total, weights) {
	const keys = Object.keys(weights).filter((k) => num(weights[k]) > 0);
	const sum = keys.reduce((s, k) => s + num(weights[k]), 0);
	const cents = Math.max(0, Math.round(num(total) * 100));
	if (!keys.length || !sum) return {};
	const biggest = keys.reduce((a, b) => (num(weights[b]) > num(weights[a]) ? b : a));
	const out = {};
	let used = 0;
	for (const k of keys) {
		if (k === biggest) continue;
		const share = Math.min(cents - used, Math.round((cents * num(weights[k])) / sum));
		out[k] = share / 100;
		used += share;
	}
	out[biggest] = Math.max(0, cents - used) / 100;
	return out;
}

// The bid model lives in src/lib/asa.mjs (`resolveBidding`/`bidFor`). It used to
// live here as budget ÷ 5 assumed taps × a demand factor, which at $10/day over
// 15 keywords derived $0.086 for every keyword, clamped all fifteen to Apple's
// $0.30 floor, and lost every auction — a formula that produced one number for
// every input is a formula that was not consulted.

/** Apple matches keywords as lowercase text; a store name's tagline is not part of it. */
const keywordText = (name) =>
	String(name ?? '')
		.split(/[:|(\-–—]/)[0]
		.replace(/\s+/g, ' ')
		.trim()
		.toLocaleLowerCase();

/**
 * `scored.json` is `{terms:[…]}` keyed `term`; files written before the rename say
 * `{scored:[…]}` keyed `keyword`. Re-scoring costs a live App Store query per
 * term, so read both shapes. A missing `demand` means "unmeasured", which is not
 * the same as zero — treat it as 100 exactly as `score()` does.
 */
function scoredTerms(doc) {
	const raw = Array.isArray(doc?.terms) ? doc.terms : Array.isArray(doc?.scored) ? doc.scored : [];
	return raw
		.map((r) => (typeof r === 'string' ? { term: r } : { ...r, term: r.term ?? r.keyword }))
		.filter((r) => r.term)
		.map((r) => ({
			term: String(r.term).toLocaleLowerCase(),
			demand: r.demand === undefined || r.demand === null ? 100 : num(r.demand),
			competition: num(r.competition),
			opportunity: num(r.opportunity),
			medianRatings: r.medianRatings ?? null,
			weakAppsTop10: r.weakAppsTop10 ?? null,
			exactTitleMatches: r.exactTitleMatches ?? null,
			top3: r.top3 ?? [],
		}));
}

/**
 * `dailyBudgetAmount` is a campaign field and only a campaign field. Ad groups
 * have no budget in the Apple Ads API, so this shell is the only place in the
 * plan where a budget may appear.
 */
const campaignShell = (name, dailyBudget, market) => ({
	name,
	dailyBudget: round2(dailyBudget),
	totalBudget: round2(num(dailyBudget) * 30),
	countriesOrRegions: [market],
	supplySources: ['APPSTORE_SEARCH_RESULTS'],
	billingEvent: 'TAPS',
	adChannelType: 'SEARCH',
});

/**
 * Four campaigns, because exact-only is three blind spots: no discovery of terms
 * you never seeded, no presence on the incumbents you are compared to, and a brand
 * name any competitor can buy for pennies. Pure — `ship ads plan` needs no
 * credentials, and the structure is testable without them.
 *
 * Every ad group carries a `defaultBidAmount` and every keyword its own `bid`,
 * and no ad group carries a budget: see {@link campaignShell}.
 */
export function buildPlan({
	app,
	locale = 'en-US',
	market = 'US',
	terms = [],
	competitors = [],
	pages = [],
	budget = 10,
	split = SPLIT,
	top = 15,
	subPrice = null,
	targetCpi = null,
	retentionMonths = 1,
	baselineInstallRate = undefined,
	minTaps = null,
	bid = null,
	minBid = null,
	maxBid = null,
	observedCpt = null,
	seedBid = null,
	monetisation: money$ = null,
	minVolume = 0,
	org = null,
	source = null,
	params = null,
	generatedAt = new Date().toISOString(),
}) {
	const brand = keywordText(app?.name);
	const eligible = terms.filter((t) => num(t.demand, 100) >= num(minVolume));
	const picked = [...eligible]
		.sort((a, b) => num(b.opportunity) - num(a.opportunity) || String(a.term).localeCompare(String(b.term)))
		.slice(0, Math.max(1, num(top, 15)));
	if (!picked.length)
		throw new ShipError(`no scored term clears aso.minVolume ${num(minVolume)}`, {
			hint: `${terms.length} scored term(s), all under the floor — a term nobody searches is not worth bidding on, so either lower aso.minVolume or run \`ship aso volume --locale ${locale}\` so demand is measured rather than guessed`,
		});

	// One bid model and one kill rule for the whole plan, resolved once and
	// stamped into the artifact. Nothing downstream recomputes either: the three
	// disagreeing waste thresholds ($1.40 in config, $2.99 in the document,
	// $29.98 in the committed artifact) all came from recomputation.
	const bidding = resolveBidding({ bid, minBid, maxBid, observedCpt, seedBid });
	const killRule = resolveKillRule({
		targetCpi,
		subPrice,
		retentionMonths,
		baselineInstallRate,
		minTaps,
	});
	const bids = [];
	const priced = (demand) => {
		const b = bidFor(demand, bidding);
		bids.push(b);
		return b.amount;
	};

	// A branded query is a competitor buy, not a category buy. `valvoline oil
	// change` and `logmate - service logbook` score well precisely because the
	// only app that matches is the one being named, and paying Exact rates for
	// them out of the category budget hides that decision inside a line item.
	// The publisher names come free with the scored top-3 that is already in the
	// artifact; a token the market types anyway (`service`) is not a brand.
	const brandWords = brandTokens(
		terms.flatMap((t) => (t.top3 ?? []).map((a) => ({ name: a.name, seller: a.seller }))),
		locale,
	);
	const support = tokenSupport(terms.map((t) => t.term), locale);
	const peak = Math.max(0, ...support.values());
	const brandFloor = Math.max(3, Math.ceil(peak / 4));
	const branded = (text) =>
		words(text, locale).some((w) => brandWords.has(w) && (support.get(w) ?? 0) < brandFloor);

	const rivals = [];
	const seenRival = new Set(brand ? [brand] : []);
	for (const rival of [...competitors, ...picked.filter((t) => branded(t.term)).map((t) => ({ name: t.term }))]) {
		const text = keywordText(rival?.name);
		if (!text || seenRival.has(text)) continue;
		seenRival.add(text);
		rivals.push({ text, name: rival.name ?? text, id: rival.id ?? null, ratings: rival.ratings ?? null });
	}

	const category = picked.filter((t) => !branded(t.term));

	const weights = { ...SPLIT, ...split };
	if (!rivals.length) weights.competitor = 0;
	if (!brand) weights.brand = 0;
	if (!category.length) weights.exact = 0;
	const daily = allocate(budget, weights);

	const exactTerms = [...new Set(category.map((t) => t.term))];
	const demands = category.map((t) => num(t.demand, 100)).sort((a, b) => a - b);
	const midDemand = demands.length ? demands[Math.floor(demands.length / 2)] : 100;
	const campaigns = [];

	if (daily.exact > 0) {
		campaigns.push({
			role: 'exact',
			...campaignShell(`${app.name} · Exact · ${market}`, daily.exact, market),
			adGroups: category.map((t) => {
				const amount = priced(t.demand);
				return {
					name: `EX · ${t.term}`,
					defaultBidAmount: amount,
					automatedKeywordsOptIn: false,
					keywords: [{ text: t.term, matchType: 'EXACT', bid: amount }],
					// Carried through so a human can sanity-check the bid against who they
					// are actually bidding against, without re-opening the aso report.
					demand: num(t.demand, 100),
					competition: num(t.competition),
					opportunity: num(t.opportunity),
					medianRatings: t.medianRatings ?? null,
					weakAppsTop10: t.weakAppsTop10 ?? null,
					exactTitleMatches: t.exactTitleMatches ?? null,
					incumbents: (t.top3 ?? []).slice(0, 3).map((a) => ({
						name: a.name,
						id: a.id ?? null,
						ratings: a.ratings ?? null,
					})),
				};
			}),
			negativeKeywords: [],
			// Not budget: Apple has no ad-group budget. An ad group is the smallest
			// object that can carry its own Custom Product Page and its own bid, so
			// one per keyword buys creative control and per-keyword bidding — and
			// costs a longer report. Themed groups are the alternative when no
			// keyword has a page of its own.
			rationale:
				'One ad group per keyword, for creative control: an ad group is the smallest object that can carry its own Custom Product Page and its own bid. Budget is set on the campaign — Apple has no ad-group budget.',
		});
	}

	if (daily.discovery > 0) {
		// EXACT negatives, never BROAD: a broad negative on "oil change" would also
		// block "oil change reminder app", which is precisely the kind of term this
		// campaign exists to find. Exact negation stops the two campaigns bidding
		// against each other on the terms Exact already measures, and nothing else.
		const negativeKeywords = exactTerms.map((text) => ({ text, matchType: 'EXACT' }));
		if (brand && !exactTerms.includes(brand)) negativeKeywords.push({ text: brand, matchType: 'EXACT' });
		const amount = priced(midDemand);
		campaigns.push({
			role: 'discovery',
			...campaignShell(`${app.name} · Discovery · ${market}`, daily.discovery, market),
			adGroups: [
				{
					name: `DISC · ${market}`,
					defaultBidAmount: amount,
					// Search Match is the point of this campaign: it is the only source of
					// terms that are not already in scored.json.
					automatedKeywordsOptIn: true,
					keywords: exactTerms.map((text) => ({ text, matchType: 'BROAD', bid: amount })),
					demand: midDemand,
				},
			],
			negativeKeywords,
			rationale:
				'Broad match plus Search Match, with every Exact term negated so the two cannot cannibalise each other.',
		});
	}

	if (daily.competitor > 0 && rivals.length) {
		campaigns.push({
			role: 'competitor',
			...campaignShell(`${app.name} · Competitor · ${market}`, daily.competitor, market),
			adGroups: rivals.map((r) => {
				const amount = priced(midDemand);
				return {
					name: `COMP · ${r.text}`,
					defaultBidAmount: amount,
					automatedKeywordsOptIn: false,
					keywords: [{ text: r.text, matchType: 'EXACT', bid: amount }],
					demand: midDemand,
					incumbents: [{ name: r.name, id: r.id, ratings: r.ratings }],
				};
			}),
			negativeKeywords: brand ? [{ text: brand, matchType: 'EXACT' }] : [],
			rationale:
				'Exact match on the apps you are compared to; your own name is negated here so Brand keeps that traffic at its own price.',
		});
	}

	if (daily.brand > 0 && brand) {
		const amount = priced(100);
		campaigns.push({
			role: 'brand',
			...campaignShell(`${app.name} · Brand · ${market}`, daily.brand, market),
			adGroups: [
				{
					name: `BRAND · ${brand}`,
					defaultBidAmount: amount,
					automatedKeywordsOptIn: false,
					// EXACT defends the name; BROAD catches the misspellings and the
					// "<brand> app" queries a competitor would otherwise buy.
					keywords: [
						{ text: brand, matchType: 'EXACT', bid: amount },
						{ text: brand, matchType: 'BROAD', bid: amount },
					],
					demand: 100,
				},
			],
			negativeKeywords: [],
			rationale:
				'Your own name is the cheapest tap you will ever buy, and the one a competitor buys if you do not.',
		});
	}

	// Refuse a plan whose prices the demand model did not touch. This is the
	// single check that would have caught fifteen identical $0.30 bids.
	assertBidSpread(bids, bidding);

	// A custom product page is authored per keyword intent; `cpp link` records the
	// ad group it serves, so the plan carries the join key and `sync` binds it.
	for (const cp of campaigns)
		for (const g of cp.adGroups) {
			const entry = pageForAdGroup(pages, g.name);
			if (entry) g.productPage = { slug: entry.slug, name: entry.page?.name ?? entry.slug };
		}

	const spread = [...new Set(bids.map((b) => b.amount))].sort((a, b) => a - b);

	return {
		generatedAt,
		source,
		locale,
		market,
		app: { name: app.name, bundleId: app.bundleId ?? null, appId: app.appId ?? null },
		org,
		currency: 'USD',
		// The fully resolved parameter set that produced this file, so an artifact
		// can never be read as having been generated with the config it sits next to.
		params: params ?? {
			budget: round2(budget),
			split: weights,
			top: num(top, 15),
			minVolume: num(minVolume),
			subPrice: subPrice === null ? null : round2(subPrice),
			retentionMonths: killRule.retentionMonths,
			bidding,
			killRule,
		},
		budget: {
			requested: round2(budget),
			daily: round2(campaigns.reduce((s, cp) => s + cp.dailyBudget, 0)),
			monthly: round2(campaigns.reduce((s, cp) => s + cp.totalBudget, 0)),
			split: Object.fromEntries(campaigns.map((cp) => [cp.role, cp.dailyBudget])),
			ratio: weights,
			derivation: `default ${ROLES.map((r) => Math.round(SPLIT[r] * 100)).join('/')} ${ROLES.join('/')}, overridable with --split; a skipped campaign redistributes its share`,
			scope: 'campaign — Apple Search Ads has no ad-group budget',
		},
		targeting: {
			minVolume: num(minVolume),
			considered: terms.length,
			eligible: eligible.length,
			dropped: terms.length - eligible.length,
			exactTerms,
		},
		bidding: { ...bidding, distinctBids: spread.length, range: [spread[0] ?? null, spread.at(-1) ?? null] },
		monetisation: money$,
		campaigns,
		killRule,
	};
}

function renderPlan(p) {
	const L = [];
	L.push(`# Apple Search Ads plan — ${p.app.name}`, '');
	L.push(`Generated ${p.generatedAt}${p.source ? ` from \`${p.source}\`` : ''}.`, '');
	L.push(`- **Market**: ${p.market} (locale ${p.locale})`);
	L.push(`- **Daily budget**: ${money(p.budget.daily)} across ${p.campaigns.length} campaigns — ${p.budget.scope}`);
	L.push(
		`- **Split**: ${Object.entries(p.budget.split)
			.map(([role, v]) => `${role} ${money(v)}`)
			.join(' · ')} — ${p.budget.derivation}`,
	);
	L.push(`- **Bids**: ${p.bidding.derivation} — ${p.bidding.distinctBids} distinct bid(s)`);
	L.push(
		`- **Demand floor**: aso.minVolume ${p.targeting.minVolume}${p.targeting.dropped ? ` — dropped ${p.targeting.dropped} of ${p.targeting.considered} scored terms as not worth bidding on` : ''}`,
	);
	if (p.monetisation)
		L.push(
			`- **What an install is worth**: ${p.monetisation.available ? p.monetisation.verdict : `unknown — ${p.monetisation.reason}`}`,
		);
	L.push('');
	L.push('## Kill rule', '');
	L.push(`\`${p.killRule.condition}\` → **pause the keyword**.`, '');
	L.push(p.killRule.derivation, '');
	L.push(
		`Concretely: negate a keyword once it has taken at least ${p.killRule.minTaps} taps and spent more than ` +
			`${money(p.killRule.wasteThreshold)} without an install. Both conditions, not either: at ` +
			`${Math.round(p.killRule.baselineInstallRate * 100)}% tap→install, three taps produce nothing 22% of the ` +
			'time, so a spend threshold alone negates healthy keywords. `ship ads mine` applies exactly this rule ' +
			'from the search-term report and stamps these numbers into every artifact.',
		'',
	);
	for (const cp of p.campaigns) {
		L.push(`## ${cp.name}`, '');
		L.push(cp.rationale, '');
		L.push(
			`${money(cp.dailyBudget)}/day (${money(cp.totalBudget)} over 30 days) · ${cp.countriesOrRegions.join(', ')} · ${cp.adGroups.length} ad group(s)`,
			'',
		);
		L.push('| ad group | keywords | demand | bid | product page | incumbents |');
		L.push('| --- | --- | ---: | ---: | --- | --- |');
		for (const g of cp.adGroups) {
			const inc = (g.incumbents ?? [])
				.map((a) => `${a.name}${a.ratings == null ? '' : ` (${a.ratings})`}`)
				.join('<br>');
			const kw = g.keywords.map((k) => `${k.text} \`${k.matchType}\` ${money(k.bid)}`).join('<br>');
			L.push(
				`| ${g.name} | ${kw} | ${g.demand ?? '—'} | ${money(g.defaultBidAmount)} | ${g.productPage?.name ?? '—'} | ${inc || '—'} |`,
			);
		}
		if (cp.negativeKeywords.length) {
			L.push('');
			L.push(`Negatives: ${cp.negativeKeywords.map((k) => `\`${k.text}\` (${k.matchType})`).join(', ')}`);
		}
		L.push('');
	}
	L.push('Sanity-check each bid against the incumbents: a keyword whose top 3 are 50k-rating');
	L.push('apps will not convert at any bid you can afford, however high its opportunity score.');
	L.push('');
	L.push('This file is **desired state**. What is live is in `snapshot.json` (`ship ads snapshot`);');
	L.push('`ship ads sync` reconciles the two by Apple object id and prints every transition first.');
	L.push('');
	L.push('Push with `ship ads sync` (dry-run first: `ship ads sync --dry-run`), then close the loop');
	L.push('with `ship ads mine`, which turns the search-term report back into keywords.');
	L.push('');
	return L.join('\n');
}

/**
 * The account's own realised cost per tap, which is the only honest starting bid.
 * Never throws and never requires credentials: without them the plan falls back
 * to the configured seed and says so.
 */
async function realisedCpt(cfg, org, { days = 30 } = {}) {
	if (!org) return { cpt: null, reason: 'no ads.orgId' };
	const auth = await authState();
	if (!auth.configured) return { cpt: null, reason: 'no Apple Ads credentials' };
	const to = isoDay(new Date());
	const from = isoDay(new Date(Date.now() - (days - 1) * 86400_000));
	try {
		const rowsOut = await pullReport(org, 'campaign', { from, to });
		const spend = rowsOut.reduce((s, r) => s + r.spend, 0);
		const taps = rowsOut.reduce((s, r) => s + r.taps, 0);
		if (!taps) return { cpt: null, reason: `no taps in the last ${days} days` };
		return { cpt: round2(spend / taps), reason: null, taps, spend: round2(spend), window: { from, to } };
	} catch (err) {
		return { cpt: null, reason: err.message };
	}
}

/**
 * Print the monetisation finding, and make a zero unmissable.
 *
 * A tool that knows an install is worth $0.00 should not help you buy installs
 * quietly. It is a warning rather than a refusal because a pre-revenue account
 * buying a measured amount of research traffic is a legitimate decision — it
 * just has to be a decision, printed in the numbers that make it one.
 */
function reportMonetisation(money$, { budget = null } = {}) {
	if (!money$) return;
	if (!money$.available) {
		warn(`no monetisation evidence read — ${money$.reason}`);
		note('every CPI target below is a research cap, not a target: nothing here knows what an install is worth');
		return;
	}
	if (money$.proven) {
		info(`monetisation: ${money$.verdict}`);
		return;
	}
	warn(`NOTHING HAS MONETISED — ${money$.verdict}`);
	warn(
		`install→paid is ${money$.installToPaid === null ? 'unmeasurable' : pct(money$.installToPaid)}, so lifetime value per install is ${money(money$.ltvPerInstall)} and no CPI is profitable`,
	);
	if (budget)
		warn(`you are about to authorise ${money(budget)}/day — ${money(round2(budget * 30))} a month — against ${money(0)} of revenue`);
	note('fix the paywall before the bids: `ship rc audit`, then `ship ads plan` again');
	note('or proceed deliberately, treating the spend as research with a fixed cap (--no-ltv-check silences this)');
}

/** Every artifact stamps the resolved parameters that produced it; this indexes them. */
async function writeArtifact(cfg, name, body) {
	await mkdir(cfg.paths.asa, { recursive: true });
	const file = join(cfg.paths.asa, name);
	await writeFile(file, `${JSON.stringify(body, null, '\t')}\n`);
	await reindexArtifacts(cfg);
	return file;
}

/**
 * `aso/asa/` used to accumulate dated files with no index and no retention, one
 * of which had been generated with flags matching neither the config nor the
 * document beside it. Every dated artifact is now listed with the parameters it
 * was generated under, and anything past `ads.retain` is deleted rather than
 * left to be misread later.
 */
async function reindexArtifacts(cfg) {
	const dir = cfg.paths.asa;
	let names = [];
	try {
		names = await readdir(dir);
	} catch {
		return null;
	}
	const dated = names.filter((n) => /^(mining|snapshot)-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
	const keep = Math.max(1, num(cfg.ads?.retain, 12));
	const byKind = new Map();
	for (const n of dated) {
		const kind = n.split('-')[0];
		byKind.set(kind, [...(byKind.get(kind) ?? []), n]);
	}
	const pruned = [];
	for (const [, list] of byKind)
		for (const n of list.slice(0, Math.max(0, list.length - keep))) {
			await unlink(join(dir, n)).catch(() => {});
			pruned.push(n);
		}

	const entries = [];
	for (const n of [...dated.filter((n) => !pruned.includes(n)), 'campaign-plan.json', 'snapshot.json']) {
		const file = join(dir, n);
		if (!existsSync(file)) continue;
		let doc = null;
		try {
			doc = JSON.parse(await readFile(file, 'utf8'));
		} catch {
			doc = null;
		}
		const st = await stat(file).catch(() => null);
		entries.push({
			file: n,
			kind: n.replace(/-\d{4}-\d{2}-\d{2}\.json$/, '').replace(/\.json$/, ''),
			generatedAt: doc?.generatedAt ?? st?.mtime?.toISOString() ?? null,
			params: doc?.params ?? null,
			killRule: doc?.killRule ?? null,
		});
	}
	const index = {
		generatedAt: new Date().toISOString(),
		retain: keep,
		pruned,
		artifacts: entries.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt))),
	};
	await writeFile(join(dir, 'index.json'), `${JSON.stringify(index, null, '\t')}\n`);
	return index;
}

async function plan({ flags }) {
	const cfg = await loadConfig();
	for (const w of cfg.warnings ?? []) warn(w);
	const locale = String(flags.locale ?? cfg.asc?.primaryLocale ?? 'en-US');

	const scoredFile = join(cfg.paths.aso, locale, 'scored.json');
	if (!existsSync(scoredFile))
		throw new ShipError(`no scored keywords for ${locale}: ${scoredFile}`, {
			hint: `run \`ship aso score --locale ${locale}\` first — the plan is built from opportunity scores, not guesses`,
		});
	const terms = scoredTerms(JSON.parse(await readFile(scoredFile, 'utf8')));
	if (!terms.length) throw new ShipError(`${scoredFile} contains no scored keywords`);

	// Competitors are optional: without the file there is nothing honest to bid on,
	// so the campaign is skipped rather than invented.
	const rivalFile = join(cfg.paths.aso, locale, 'competitors.json');
	const competitors = existsSync(rivalFile)
		? (JSON.parse(await readFile(rivalFile, 'utf8')).apps ?? [])
		: [];

	const budget = Math.max(1, num(flags.budget, 10));
	const subPrice = flags['sub-price'] ?? flags.subPrice ?? cfg.ads?.subPrice ?? null;
	const org = cfg.ads?.orgId ?? null;
	// The bid the account actually pays beats every derivation; ask before guessing.
	const measured = flags.bid ? { cpt: null, reason: '--bid overrides it' } : await realisedCpt(cfg, org);
	const money$ =
		flags['no-ltv-check']
			? { available: false, reason: '--no-ltv-check' }
			: await monetisationSignal(cfg, { subPrice });

	const out = buildPlan({
		app: { name: cfg.name, bundleId: cfg.bundleId, appId: cfg.asc?.appId ?? null },
		locale,
		market: (marketFor(locale)?.country ?? 'US').toUpperCase(),
		terms,
		competitors,
		pages: await readPages(cfg),
		budget,
		split: parseSplit(flags.split),
		top: Math.max(1, num(flags.top, 15)),
		subPrice: subPrice === null ? null : Math.max(0.01, num(subPrice)),
		targetCpi: flags['target-cpi'] ?? flags.targetCpi ?? cfg.ads?.targetCpi ?? null,
		retentionMonths: cfg.ads?.retentionMonths,
		baselineInstallRate: cfg.ads?.baselineInstallRate,
		minTaps: flags['min-taps'] ?? cfg.ads?.minTaps ?? null,
		bid: flags.bid ?? null,
		minBid: flags['min-bid'] ?? null,
		maxBid: flags['max-bid'] ?? null,
		observedCpt: measured.cpt,
		seedBid: cfg.ads?.seedBid ?? null,
		monetisation: money$,
		minVolume: num(cfg.aso?.minVolume),
		org,
		source: scoredFile,
	});

	const jsonFile = await writeArtifact(cfg, 'campaign-plan.json', out);
	const mdFile = join(cfg.paths.asa, 'campaign-plan.md');
	await writeFile(mdFile, renderPlan(out));

	if (flags.json) return emit(out);

	heading(`Campaign plan · ${cfg.name} · ${out.market}`);
	info(
		`${money(out.budget.daily)}/day across ${out.campaigns.length} campaigns · ${Object.entries(out.budget.split)
			.map(([role, v]) => `${role} ${money(v)}`)
			.join(' · ')}`,
	);
	note(out.budget.scope);
	info(`bids: ${out.bidding.derivation}`);
	if (measured.cpt === null && !flags.bid)
		note(`no realised cost per tap yet (${measured.reason}) — seeded at ${money(out.bidding.seed)}, override with --bid`);
	reportMonetisation(money$, { budget: out.budget.daily });
	if (!competitors.length)
		note(
			`no aso/${locale}/competitors.json — Competitor campaign skipped, its budget went to the rest (\`ship aso competitors --locale ${locale}\`)`,
		);
	if (out.targeting.dropped)
		note(`${out.targeting.dropped} scored term(s) under aso.minVolume ${out.targeting.minVolume} are not worth bidding on`);

	for (const cp of out.campaigns) {
		process.stdout.write('\n');
		step(
			`${cp.name} · ${money(cp.dailyBudget)}/day · ${cp.adGroups.length} ad group(s)${cp.negativeKeywords.length ? ` · ${cp.negativeKeywords.length} negative(s)` : ''}`,
		);
		table(cp.adGroups, [
			{ header: 'ad group', get: (g) => g.name },
			{ header: 'keywords', get: (g) => g.keywords.map((k) => `${k.text} ${k.matchType.toLowerCase()}`).join(', ') },
			{ header: 'demand', get: (g) => (g.demand == null ? '—' : String(Math.round(g.demand))) },
			{ header: 'bid', get: (g) => money(g.defaultBidAmount) },
			{ header: 'page', get: (g) => g.productPage?.name ?? '' },
		]);
	}
	process.stdout.write('\n');
	info(`kill rule: ${out.killRule.condition} (source: ${out.killRule.source})`);
	good(`wrote ${jsonFile}`);
	good(`wrote ${mdFile}`);
	note('review it, then `ship ads sync --dry-run` once credentials exist');
	return 0;
}

// ─── mutations (shared by sync and mine) ─────────────────────────────────────

/** A mutation that participates in --dry-run; returns null when skipped. */
async function ascMutate(args, { file } = {}) {
	const full = file ? [...args, '--file', file, '--output', 'json'] : [...args, '--output', 'json'];
	const res = await exec(ASC, full, { mutating: true, allowFail: true });
	if (res.skipped) return null;
	if (res.code !== 0)
		throw new ShipError(`asc ${args.slice(0, 4).join(' ')} exited ${res.code}`, {
			hint: (res.stderr || res.stdout).trim().split('\n').slice(-8).join('\n'),
		});
	try {
		const t = res.stdout.trim();
		return t ? JSON.parse(t.slice(Math.max(0, t.search(/[[{]/)))) : null;
	} catch {
		return null;
	}
}

const one = (payload) => (Array.isArray(payload?.data) ? payload.data[0] : (payload?.data ?? payload));

// Name matching, for first-time adoption only: it is how sync finds an object it
// has never recorded an id for. Everything after that is matched by id — Apple
// happily creates a second campaign with an identical name, and a *renamed*
// object matched by name is indistinguishable from a deleted one.
const byName = (list, name) => list.find((r) => r.name === name) ?? null;

const amountOf = (n, currency = 'USD') => ({ amount: num(n).toFixed(2), currency });

const listCampaigns = (org) =>
	asc(['ads', 'campaigns', 'list', '--org', org, '--paginate'], { fallback: null }).then(rows);

const listAdGroups = (org, campaignId) =>
	asc(['ads', 'ad-groups', 'list', '--campaign', campaignId, '--org', org, '--paginate'], {
		fallback: null,
	}).then(rows);

const listKeywords = (org, campaignId, adGroupId) =>
	asc(
		['ads', 'targeting-keywords', 'list', '--campaign', campaignId, '--ad-group', adGroupId, '--org', org, '--paginate'],
		{ fallback: [] },
	).then(rows);

const listNegatives = (org, campaignId) =>
	asc(['ads', 'campaign-negative-keywords', 'list', '--campaign', campaignId, '--org', org, '--paginate'], {
		fallback: [],
	}).then(rows);

/**
 * Apple rejects immutable fields on update rather than ignoring them
 * ("INVALID_ATTRIBUTE_TYPE: adamId: Invalid field"). The promoted app, the
 * billing event, the channel and the supply sources are all fixed at create
 * time, and startTime is frozen once it has passed
 * ("START_TIME_CANNOT_BE_MODIFIED"), so an update may only move budget, endTime,
 * name and status. endTime staying editable is what makes "extend the flight
 * window" a one-command change.
 */
function campaignBody(cp, adamId, currency) {
	return {
		name: cp.name,
		adamId,
		countriesOrRegions: cp.countriesOrRegions,
		// No budgetAmount: Apple rejects a lifetime budget outright
		// ("LIFETIME_BUDGET_NOT_SUPPORTED: Lifetime budget is not supported"), and the
		// Platform API v1 drops the field entirely. dailyBudgetAmount is the only spend
		// control the API still honours — and it exists only here, never on an ad group.
		dailyBudgetAmount: amountOf(cp.dailyBudget, currency),
		...(cp.startTime ? { startTime: cp.startTime } : {}),
		...(cp.endTime ? { endTime: cp.endTime } : {}),
		supplySources: cp.supplySources,
		billingEvent: cp.billingEvent,
		adChannelType: cp.adChannelType,
		status: cp.status ?? 'ENABLED',
	};
}

const createCampaign = async (org, cp, adamId, currency) =>
	one(
		await withPayload('campaign.json', campaignBody(cp, adamId, currency), (file) =>
			ascMutate(['ads', 'campaigns', 'create', '--org', org], { file }),
		),
	);

function updateCampaign(org, id, cp, adamId, currency) {
	const {
		adamId: _a, supplySources: _s, billingEvent: _b, adChannelType: _c, startTime: _t, ...update
	} = campaignBody(cp, adamId, currency);
	return withPayload('campaign.json', { campaign: update, clearGeoTargetingOnCountryOrRegionChange: false }, (file) =>
		ascMutate(['ads', 'campaigns', 'update', '--campaign', String(id), '--org', org], { file }),
	);
}

function adGroupBody(spec, currency) {
	return {
		name: spec.name,
		// Apple rejects a startTime in the past on create; "now" is the only safe value.
		startTime: new Date().toISOString().replace(/\.\d+Z$/, '.000Z'),
		defaultBidAmount: amountOf(spec.defaultBidAmount, currency),
		pricingModel: 'CPC',
		automatedKeywordsOptIn: Boolean(spec.automatedKeywordsOptIn),
		...(spec.endTime ? { endTime: spec.endTime } : {}),
		status: spec.status ?? 'ENABLED',
	};
}

const createAdGroup = async (org, campaignId, spec, currency) =>
	one(
		await withPayload('ad-group.json', adGroupBody(spec, currency), (file) =>
			ascMutate(['ads', 'ad-groups', 'create', '--campaign', campaignId, '--org', org], { file }),
		),
	);

/** Same immutability rule as the campaign: startTime is not sendable on update. */
function updateAdGroup(org, campaignId, id, spec, currency) {
	const { startTime: _t, ...update } = adGroupBody(spec, currency);
	return withPayload('ad-group.json', update, (file) =>
		ascMutate(['ads', 'ad-groups', 'update', '--campaign', campaignId, '--ad-group', String(id), '--org', org], {
			file,
		}),
	);
}

/**
 * Pausing is the only destructive transition `ship` performs, so it is a named
 * function reached from exactly one place: a `--prune` run. It used to happen as
 * a side effect of a name mismatch, unreported, to a delivering ad group.
 */
const pauseAdGroup = (org, campaignId, id) =>
	withPayload('ad-group.json', { status: 'PAUSED' }, (file) =>
		ascMutate(['ads', 'ad-groups', 'update', '--campaign', campaignId, '--ad-group', String(id), '--org', org], {
			file,
		}),
	);

const keywordArgs = (verb, campaignId, adGroupId, org) => [
	'ads',
	'targeting-keywords',
	verb,
	'--campaign',
	campaignId,
	'--ad-group',
	adGroupId,
	'--org',
	org,
];

const createKeywords = async (org, campaignId, adGroupId, list, currency) =>
	rows(
		await withPayload(
			'keywords.json',
			list.map((k) => ({ text: k.text, matchType: k.matchType, bidAmount: amountOf(k.bid ?? k.bidAmount, currency) })),
			(file) => ascMutate(keywordArgs('create-bulk', campaignId, adGroupId, org), { file }),
		),
	);

const updateKeywords = (org, campaignId, adGroupId, list, currency) =>
	withPayload(
		'keywords.json',
		list.map((k) => ({
			id: k.id,
			...(k.bid === undefined && k.bidAmount === undefined ? {} : { bidAmount: amountOf(k.bid ?? k.bidAmount, currency) }),
			status: k.status ?? 'ACTIVE',
		})),
		(file) => ascMutate(keywordArgs('update-bulk', campaignId, adGroupId, org), { file }),
	);

const pauseKeywords = (org, campaignId, adGroupId, ids) =>
	updateKeywords(org, campaignId, adGroupId, ids.map((id) => ({ id, status: 'PAUSED' })));

/**
 * Create-or-update one ad group by name. `sync` reconciles by id and does not
 * use this; `mine --apply` does, because a promoted keyword has no plan entry to
 * carry an id yet.
 */
async function ensureAdGroup(org, campaignId, groups, spec, currency) {
	const found = byName(groups, spec.name);
	if (found) {
		await updateAdGroup(org, campaignId, found.id, spec, currency);
		return { group: found, created: false };
	}
	return { group: await createAdGroup(org, campaignId, spec, currency), created: true };
}

/** Bulk-create the keywords that are missing and bulk re-bid the ones that exist. */
async function ensureKeywords(org, campaignId, adGroupId, wanted, currency) {
	if (!wanted.length) return { created: 0, updated: 0 };
	const have = await listKeywords(org, campaignId, adGroupId);
	const missing = [];
	const present = [];
	for (const k of wanted) {
		const hit = have.find((h) => h.text === k.text && h.matchType === k.matchType);
		if (hit) present.push({ id: hit.id, bid: k.bid });
		else missing.push(k);
	}
	if (missing.length) await createKeywords(org, campaignId, adGroupId, missing, currency);
	if (present.length) await updateKeywords(org, campaignId, adGroupId, present, currency);
	return { created: missing.length, updated: present.length };
}

/** Campaign-level negatives, matched by text + match type so re-running adds nothing. */
async function ensureNegatives(org, campaignId, wanted) {
	if (!wanted.length) return 0;
	const have = await listNegatives(org, campaignId);
	const missing = wanted.filter((k) => !have.some((h) => h.text === k.text && h.matchType === k.matchType));
	if (!missing.length) return 0;
	await withPayload(
		'negative-keywords.json',
		missing.map((k) => ({ text: k.text, matchType: k.matchType })),
		(file) =>
			ascMutate(['ads', 'campaign-negative-keywords', 'create-bulk', '--campaign', campaignId, '--org', org], {
				file,
			}),
	);
	return missing.length;
}

/**
 * Bind a custom product page to an ad group. Apple Ads never sees the ASC page id,
 * so the join key is the name `ship meta cpp link` recorded — and the binding lives
 * on an *ad*, not the ad group: ad groups have no productPageId field.
 */
async function bindProductPage(org, adamId, campaignId, adGroupId, page, cache) {
	cache.pages ??= rows(
		await asc(['ads', 'product-pages', 'list', '--adam-id', String(adamId), '--org', org], { fallback: [] }),
	);
	const live = cache.pages.find((p) => p.name === page.name);
	if (!live) {
		warn(`product page "${page.name}" is not in Apple Ads yet — \`ship meta cpp apply ${page.slug}\`, then re-run sync`);
		return false;
	}
	const productPageId = live.productPageId ?? live.id ?? null;
	const name = `${page.name} · CPP`;
	const body = { name, productPageId, creativeType: 'CUSTOM_PRODUCT_PAGE', status: 'ENABLED' };
	const have = rows(
		await asc(['ads', 'ads', 'list', '--campaign', campaignId, '--ad-group', adGroupId, '--org', org], {
			fallback: [],
		}),
	);
	const found = byName(have, name);
	if (found && String(found.productPageId ?? '') === String(productPageId)) return true;
	const args = found
		? ['ads', 'ads', 'update', '--campaign', campaignId, '--ad-group', adGroupId, '--ad', String(found.id), '--org', org]
		: ['ads', 'ads', 'create', '--campaign', campaignId, '--ad-group', adGroupId, '--org', org];
	await withPayload('ad.json', body, (file) => ascMutate(args, { file }));
	return true;
}

// ─── snapshot (observed state) ───────────────────────────────────────────────

/**
 * Read the whole live account: ids, statuses, bids, negatives, and the
 * performance of every object.
 *
 * This exists because reconstructing live state used to take about twenty raw
 * `asc ads` calls and a hand-authored report payload — so nobody did it, and the
 * plan file was read as if it were the account. Desired state and observed state
 * are now two files that can be diffed.
 */
async function readAccount(org, { performance = true, from, to } = {}) {
	const campaigns = [];
	for (const raw of await listCampaigns(org)) {
		const cp = normaliseCampaign(raw);
		if (!cp.id) continue;
		cp.negativeKeywords = (await listNegatives(org, cp.id)).map(normaliseKeyword);
		for (const rawGroup of await listAdGroups(org, cp.id)) {
			const g = normaliseAdGroup(rawGroup);
			if (!g.id) continue;
			g.keywords = (await listKeywords(org, cp.id, g.id)).map(normaliseKeyword);
			cp.adGroups.push(g);
		}
		campaigns.push(cp);
	}
	if (!performance) return { campaigns };

	// Performance is attached per object, because "the campaign spent $3.20" and
	// "one of its fifteen ad groups spent $3.20 and the rest spent nothing" are
	// the same campaign row and completely different accounts.
	const attach = async (level, key) => {
		const rowsOut = await pullReport(org, level, { from, to }).catch(() => []);
		for (const r of rowsOut) {
			for (const cp of campaigns) {
				if (level === 'campaign') {
					if (String(cp.id) === String(r.campaignId ?? '')) cp.performance = r;
					continue;
				}
				for (const g of cp.adGroups) {
					if (level === 'ad-group' && g.name === r.name) g.performance = r;
					if (level === 'keyword')
						for (const k of g.keywords)
							if (`${k.text} ${k.matchType}` === r.name) k.performance = r;
				}
			}
		}
		return key;
	};
	await attach('campaign');
	await attach('ad-group');
	await attach('keyword');
	return { campaigns };
}

async function snapshot({ flags }) {
	const cfg = await loadConfig();
	await gate(cfg);
	const org = requireOrg(cfg, flags);
	const to = flags.to ? String(flags.to) : isoDay(new Date());
	const from = flags.from
		? String(flags.from)
		: isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400_000));

	const account = await readAccount(org, { performance: flags.performance !== false, from, to });
	const doc = {
		generatedAt: new Date().toISOString(),
		org: String(org),
		window: { from, to },
		params: { org: String(org), window: { from, to }, performance: flags.performance !== false },
		lastModified: lastModified(account) ? new Date(lastModified(account)).toISOString() : null,
		campaigns: account.campaigns,
	};

	const file = await writeArtifact(cfg, 'snapshot.json', doc);
	await writeArtifact(cfg, `snapshot-${isoDay(new Date())}.json`, doc);
	if (flags.json) return emit({ ...doc, file });

	heading(`Live account · org ${org} · ${from} → ${to}`);
	for (const cp of account.campaigns) {
		process.stdout.write('\n');
		step(
			`${cp.name} · ${cp.id} · ${cp.status ?? '—'} · ${cp.dailyBudget === null ? 'no budget' : `${money(cp.dailyBudget)}/day`} · ${cp.adGroups.length} ad group(s), ${cp.negativeKeywords.length} negative(s)`,
		);
		table(cp.adGroups, [
			{ header: 'ad group', get: (g) => g.name },
			{ header: 'id', get: (g) => g.id },
			{ header: 'status', get: (g) => g.status ?? '' },
			{ header: 'bid', get: (g) => (g.defaultBidAmount === null ? '—' : money(g.defaultBidAmount)) },
			{ header: 'keywords', get: (g) => String(g.keywords.length) },
			{ header: 'spend', get: (g) => (g.performance ? money(g.performance.spend) : '—') },
			{ header: 'taps', get: (g) => (g.performance ? String(g.performance.taps) : '—') },
			{ header: 'installs', get: (g) => (g.performance ? String(g.performance.installs) : '—') },
		]);
	}
	process.stdout.write('\n');
	good(`wrote ${file}`);
	note('this is observed state; campaign-plan.json is desired state. `ship ads sync --dry-run` diffs them');
	return 0;
}

// ─── sync ────────────────────────────────────────────────────────────────────

/** Record what Apple returned, so the next run reconciles by id and not by name. */
const stampApple = (obj, live, fields) => {
	obj.apple = { id: live?.id ? String(live.id) : (obj.apple?.id ?? null), syncedAt: new Date().toISOString(), ...fields };
	return obj;
};

const OP_COLOUR = {
	create: c.green,
	update: c.cyan,
	adopt: c.blue,
	preserve: c.yellow,
	pause: c.red,
	unplanned: c.yellow,
	conflict: c.red,
	orphan: c.magenta,
	noop: c.dim,
};

/** The reconciliation report: every transition, before any of them happen. */
function printReconciliation(plan$, { verbose = false } = {}) {
	const shown = plan$.actions.filter((a) => verbose || a.op !== 'noop');
	if (!shown.length) {
		good('nothing to do — the account already matches the plan');
		return;
	}
	table(shown, [
		{ header: 'op', get: (a) => (OP_COLOUR[a.op] ?? c.dim)(a.op) },
		{ header: 'level', get: (a) => a.level },
		{ header: 'object', get: (a) => a.path },
		{ header: 'id', get: (a) => a.id ?? '—' },
		{ header: 'detail', get: (a) => describeAction(a) },
	]);
	const counts = Object.entries(plan$.summary)
		.filter(([op]) => verbose || op !== 'noop')
		.map(([op, n]) => `${n} ${op}`)
		.join(' · ');
	info(counts || 'no changes');
}

async function sync({ flags }) {
	const cfg = await loadConfig();
	for (const w of cfg.warnings ?? []) warn(w);
	const planFile = join(cfg.paths.asa, 'campaign-plan.json');
	if (!existsSync(planFile))
		throw new ShipError(`no campaign plan at ${planFile}`, {
			hint: 'run `ship ads plan` first — sync never invents a structure, it only pushes a reviewed one',
		});
	const p = JSON.parse(await readFile(planFile, 'utf8'));
	const planned = Array.isArray(p.campaigns) ? p.campaigns : [];
	if (!planned.length)
		throw new ShipError(`${planFile} declares no campaigns`, {
			hint: 'plans written before the four-campaign structure carry a single `campaign` key — re-run `ship ads plan`',
		});

	await gate(cfg);
	const org = requireOrg(cfg, { org: flags.org ?? p.org });
	const adamId = num(cfg.asc?.appId ?? p.app?.appId, 0);
	if (!adamId)
		throw new ShipError('sync needs the numeric App Store app id (adamId)', {
			hint: 'set asc.appId in ship.config.json — `asc apps list --bundle-id ' + (cfg.bundleId ?? '<bundle>') + ' --output json` has it',
		});

	const prune = Boolean(flags.prune);
	const force = Boolean(flags.force);
	const adopt = Boolean(flags.adopt);
	if (force && adopt) throw new ShipError('--force and --adopt contradict each other', { hint: '--force: the plan wins. --adopt: the account wins.' });

	const currency = p.currency ?? 'USD';
	const account = await readAccount(org, { performance: false });

	// A plan older than the account describes a structure that has since been
	// edited by hand. Overwriting it silently is the failure mode that made a
	// manual fix survive four hours.
	const liveAt = lastModified(account);
	const planAt = Date.parse(p.generatedAt ?? '') || (await stat(planFile)).mtimeMs;
	if (liveAt && planAt && liveAt > planAt && !force && !adopt)
		throw new ShipError(
			`the account was modified after this plan was written (live ${new Date(liveAt).toISOString()} > plan ${new Date(planAt).toISOString()})`,
			{
				hint: 'somebody changed Apple Ads by hand since `ship ads plan` ran. `ship ads snapshot` to see what, then re-run `ship ads plan`, or `--adopt` to take the live values, or `--force` to overwrite them',
			},
		);

	const plan$ = reconcile({ planned, live: account.campaigns, force, adopt, prune });

	heading(`Reconcile · ${cfg.name} · org ${org}${isDryRun() ? c.dim(' · dry run') : ''}`);
	printReconciliation(plan$, { verbose: Boolean(flags.verbose) });
	for (const u of plan$.unmanaged) note(`unmanaged campaign left alone: ${u.name} (${u.id}, ${u.status ?? '—'})`);
	for (const a of plan$.preserved) info(`keeping the manual value on ${a.path}: ${describeAction(a)}`);

	const money$ =
		flags['no-ltv-check']
			? { available: false, reason: '--no-ltv-check' }
			: await monetisationSignal(cfg, { subPrice: cfg.ads?.subPrice });
	process.stdout.write('\n');
	reportMonetisation(money$, { budget: p.budget?.daily ?? null });

	// Two refusals, both naming the objects. Neither is overridable by accident.
	if (plan$.conflicts.length)
		throw new ShipError(
			`${plan$.conflicts.length} object(s) were changed outside ship and would be overwritten`,
			{
				hint:
					`${plan$.conflicts.map((a) => `${a.path}: ${describeAction(a)}`).join('\n')}\n` +
					'--force to let the plan win, --adopt to record the live values into the plan instead',
			},
		);
	if (plan$.unplanned.length)
		throw new ShipError(`${plan$.unplanned.length} live object(s) are not in the plan`, {
			hint:
				`${plan$.unplanned.map((a) => `${a.path} (${a.id})`).join('\n')}\n` +
				'these are delivering right now. --prune to pause them, or re-run `ship ads plan` so the plan contains them. ' +
				'Nothing was changed.',
		});

	if (!plan$.mutations.length && !adopt) {
		process.stdout.write('\n');
		good('0 mutations');
		return 0;
	}
	if (isDryRun()) {
		process.stdout.write('\n');
		good(`dry-run: ${plan$.mutations.length} mutation(s) would be issued, exactly as listed above`);
		return 0;
	}

	const cache = {};
	const tally = { campaigns: 0, groups: 0, keywords: 0, negatives: 0, paused: 0, pages: 0, adopted: 0 };
	const at = (level, path) => plan$.actions.find((a) => a.level === level && a.path === path) ?? { op: 'noop' };

	for (const cp of planned) {
		const action = at('campaign', cp.name);
		const liveCp = account.campaigns.find((r) => r.id === action.id) ?? null;
		let campaignId = action.id;

		if (action.op === 'create' || action.op === 'orphan') {
			step(`create campaign "${cp.name}" · ${money(cp.dailyBudget)}/day`);
			const created = await createCampaign(org, cp, adamId, currency);
			if (!created?.id)
				throw new ShipError(`campaign create returned no id for "${cp.name}"`, {
					hint: 'asc ads campaigns create emitted an unexpected payload — re-run with --verbose',
				});
			campaignId = String(created.id);
			tally.campaigns++;
			stampApple(cp, created, { name: cp.name, dailyBudget: round2(cp.dailyBudget), status: 'ENABLED' });
		} else if (action.op === 'update') {
			step(`update campaign "${cp.name}" · ${describeAction(action)}`);
			await updateCampaign(org, campaignId, cp, adamId, currency);
			stampApple(cp, { id: campaignId }, { name: cp.name, dailyBudget: round2(cp.dailyBudget), status: cp.status ?? 'ENABLED' });
		} else if (action.op === 'adopt') {
			tally.adopted++;
			if (action.adoptFields) {
				cp.dailyBudget = action.adoptFields.dailyBudget ?? cp.dailyBudget;
				cp.status = action.adoptFields.status ?? cp.status;
			}
			stampApple(cp, { id: campaignId }, { name: cp.name, dailyBudget: round2(cp.dailyBudget), status: cp.status ?? 'ENABLED' });
		} else if (liveCp) {
			stampApple(cp, liveCp, { name: cp.name, dailyBudget: liveCp.dailyBudget, status: liveCp.status });
		}
		if (!campaignId) continue;

		tally.negatives += await ensureNegatives(org, campaignId, cp.negativeKeywords ?? []);

		for (const g of cp.adGroups ?? []) {
			const path = `${cp.name} / ${g.name}`;
			const ga = at('adGroup', path);
			let adGroupId = ga.id;
			if (ga.op === 'create' || ga.op === 'orphan') {
				const created = await createAdGroup(org, campaignId, g, currency);
				if (!created?.id) throw new ShipError(`ad group create returned no id for "${g.name}"`);
				adGroupId = String(created.id);
				tally.groups++;
				good(`created ad group ${adGroupId} "${g.name}" @ ${money(g.defaultBidAmount)}`);
			} else if (ga.op === 'update') {
				step(`update ad group "${g.name}" · ${describeAction(ga)}`);
				await updateAdGroup(org, campaignId, adGroupId, g, currency);
				tally.groups++;
			} else if (ga.op === 'adopt' && ga.adoptFields) {
				g.defaultBidAmount = ga.adoptFields.defaultBidAmount ?? g.defaultBidAmount;
				g.automatedKeywordsOptIn = ga.adoptFields.automatedKeywordsOptIn ?? g.automatedKeywordsOptIn;
				tally.adopted++;
			}
			if (!adGroupId) continue;
			stampApple(g, { id: adGroupId }, {
				name: g.name,
				defaultBidAmount: round2(g.defaultBidAmount),
				automatedKeywordsOptIn: Boolean(g.automatedKeywordsOptIn),
				status: g.status ?? 'ENABLED',
			});

			const create = [];
			const update = [];
			for (const k of g.keywords ?? []) {
				const bid = round2(k.bid ?? g.defaultBidAmount);
				const ka = at('keyword', `${path} / ${k.text} ${k.matchType}`);
				if (ka.op === 'create' || ka.op === 'orphan') create.push({ ...k, bid });
				else if (ka.op === 'update') update.push({ id: ka.id, bid, status: 'ACTIVE' });
				else if (ka.op === 'adopt' && ka.adoptFields) k.bid = ka.adoptFields.bidAmount ?? bid;
				if (ka.id)
					stampApple(k, { id: ka.id }, {
						text: k.text,
						matchType: k.matchType,
						bidAmount: round2(k.bid ?? bid),
						status: 'ACTIVE',
					});
			}
			if (create.length) {
				const made = await createKeywords(org, campaignId, adGroupId, create, currency);
				tally.keywords += create.length;
				for (const row of made) {
					const k = (g.keywords ?? []).find((x) => x.text === row.text && x.matchType === row.matchType);
					if (k) stampApple(k, row, { text: row.text, matchType: row.matchType, bidAmount: round2(k.bid ?? g.defaultBidAmount), status: 'ACTIVE' });
				}
			}
			if (update.length) {
				await updateKeywords(org, campaignId, adGroupId, update, currency);
				tally.keywords += update.length;
			}

			// Pausing keywords the plan dropped, inside a group it owns.
			const stale = plan$.destructive.filter((a) => a.level === 'keyword' && a.path.startsWith(`${path} / `));
			if (stale.length) {
				warn(`pausing ${stale.length} keyword(s) in "${g.name}": ${stale.map((a) => a.name).join(', ')}`);
				await pauseKeywords(org, campaignId, adGroupId, stale.map((a) => a.id));
				tally.paused += stale.length;
			}

			if (g.productPage && (await bindProductPage(org, adamId, campaignId, adGroupId, g.productPage, cache)))
				tally.pages++;
		}

		for (const a of plan$.destructive.filter((x) => x.level === 'adGroup' && x.path.startsWith(`${cp.name} / `))) {
			warn(`pausing ad group "${a.name}" (${a.id}) — it is not in the plan`);
			await pauseAdGroup(org, campaignId, a.id);
			tally.paused++;
		}
	}

	// The ids go back into the plan: this is what makes the next run reconcile by
	// identity instead of re-deriving one from a name somebody may rename.
	p.syncedAt = new Date().toISOString();
	p.syncedOrg = String(org);
	await writeArtifact(cfg, 'campaign-plan.json', p);

	process.stdout.write('\n');
	good(
		`${tally.campaigns} campaign(s) created · ${tally.groups} ad group(s) created or updated · ${tally.keywords} keyword(s) · ${tally.negatives} negative(s)${tally.paused ? ` · ${c.red(`${tally.paused} paused`)}` : ''}${tally.adopted ? ` · ${tally.adopted} adopted` : ''}${tally.pages ? ` · ${tally.pages} product page(s) bound` : ''}`,
	);
	good(`recorded Apple object ids into ${planFile}`);
	note(`verify: ship ads snapshot --org ${org}`);
	return 0;
}

// ─── mine ────────────────────────────────────────────────────────────────────

/**
 * Search-term report rows, flattened. `metadata` carries the query and the keyword
 * it matched, `total` carries the money. A row whose matchType is EXACT is already
 * targeted; everything else is a term Apple found for you, at Apple's price.
 */
export function searchTermRows(payload) {
	const raw =
		payload?.data?.reportingDataResponse?.row ??
		payload?.reportingDataResponse?.row ??
		(Array.isArray(payload?.rows) ? payload.rows : rows(payload));
	return raw
		.map((r) => {
			const m = r.metadata ?? r;
			const t = r.total ?? r.granularity?.[0] ?? m;
			return {
				term: String(m.searchTermText ?? m.searchTerm ?? m.text ?? '')
					.trim()
					.toLocaleLowerCase(),
				keyword: m.keyword ?? null,
				matchType: m.matchType ?? null,
				source: m.searchTermSource ?? null,
				campaignId: m.campaignId ?? null,
				campaignName: m.campaignName ?? null,
				adGroupId: m.adGroupId ?? null,
				adGroupName: m.adGroupName ?? null,
				impressions: num(t.impressions),
				taps: num(t.taps),
				installs: num(t.installs ?? num(t.newDownloads) + num(t.redownloads)),
				spend: num(t.localSpend?.amount ?? t.localSpend),
				currency: t.localSpend?.currency ?? 'USD',
			};
		})
		.filter((r) => r.term);
}

/**
 * The two decisions a search-term report actually supports — and the reason `mine`
 * exists, since a report a human must interpret gets interpreted once:
 *
 *  - Zero installs, past 2× target CPI, **and** past the tap count at which a
 *    keyword that was going to convert would have. All three, not the money
 *    alone: with `targetCpi` $0.70 the waste line is $1.40, which at a $0.53 CPT
 *    is under three taps — and a genuinely healthy 40% keyword shows zero
 *    installs across three taps about 22% of the time. A spend-only rule
 *    therefore negates roughly two of every nine healthy keywords per weekly
 *    cycle, permanently, silently, and with a rationale that reads correct.
 *  - A term that converted at or under target CPI and is not already an Exact
 *    keyword is being served by broad match or Search Match — at Apple's discretion
 *    and Apple's bid. Promote it to Exact and own the bid.
 *
 * Terms that are past the money line but short of the sample size come back under
 * `held`, with what they are waiting for. Withholding a decision silently is how
 * you end up making it twice.
 *
 * Pure: no credentials, no filesystem, so the rule is testable and auditable.
 * @param {object[]} rows {@link searchTermRows} output
 * @param {{targetCpi:number, minTaps?:number, subPrice?:number, retentionMonths?:number, baselineInstallRate?:number, source?:string}} opts
 */
export function decide(rows, opts = {}) {
	const rule = resolveKillRule(opts);
	const { targetCpi: cpi, wasteThreshold, minTaps } = rule;

	// One term can appear in several ad groups; the money is what decides, so sum it.
	const agg = new Map();
	for (const r of rows ?? []) {
		const term = String(r?.term ?? '')
			.trim()
			.toLocaleLowerCase();
		if (!term) continue;
		const e = agg.get(term) ?? {
			term,
			impressions: 0,
			taps: 0,
			installs: 0,
			spend: 0,
			exact: false,
			topSpend: -1,
			campaignId: null,
			campaignName: null,
			adGroupId: null,
			adGroupName: null,
		};
		e.impressions += num(r.impressions);
		e.taps += num(r.taps);
		e.installs += num(r.installs);
		e.spend += num(r.spend);
		if (String(r.matchType ?? '').toUpperCase() === 'EXACT') e.exact = true;
		// A negative belongs to the ad group that actually paid for the term.
		if (num(r.spend) > e.topSpend) {
			e.topSpend = num(r.spend);
			e.campaignId = r.campaignId ?? null;
			e.campaignName = r.campaignName ?? null;
			e.adGroupId = r.adGroupId ?? null;
			e.adGroupName = r.adGroupName ?? null;
		}
		agg.set(term, e);
	}

	// Round to cents before comparing: a float artifact must not push a term across
	// a threshold that spends money.
	const terms = [...agg.values()].map((e) => ({
		...e,
		spend: round2(e.spend),
		cpi: e.installs ? round2(e.spend / e.installs) : null,
	}));

	const spent = terms.filter((e) => e.installs === 0 && e.spend > wasteThreshold);
	const evidence = (e) =>
		`${money(e.spend)} over ${e.taps} tap(s) and ${e.impressions} impression(s) for zero installs`;

	const negatives = spent
		.filter((e) => e.taps >= minTaps)
		.sort((a, b) => b.spend - a.spend || a.term.localeCompare(b.term))
		.map((e) => ({
			term: e.term,
			matchType: 'EXACT',
			spend: e.spend,
			taps: e.taps,
			impressions: e.impressions,
			campaignId: e.campaignId,
			campaignName: e.campaignName,
			adGroupName: e.adGroupName,
			reason: `${evidence(e)} — past the ${money(wasteThreshold)} waste line and past ${minTaps} taps, so zero is a verdict`,
		}));

	const held = spent
		.filter((e) => e.taps < minTaps)
		.sort((a, b) => b.spend - a.spend || a.term.localeCompare(b.term))
		.map((e) => ({
			term: e.term,
			spend: e.spend,
			taps: e.taps,
			impressions: e.impressions,
			needTaps: minTaps,
			campaignName: e.campaignName,
			adGroupName: e.adGroupName,
			reason:
				`${evidence(e)}, but ${e.taps} tap(s) is under the ${minTaps} needed before zero installs means anything: ` +
				`a keyword converting at ${Math.round(rule.baselineInstallRate * 100)}% shows nothing this often by chance`,
		}));

	const promotions = terms
		.filter((e) => e.installs > 0 && e.cpi <= cpi && !e.exact)
		.sort((a, b) => a.cpi - b.cpi || b.installs - a.installs || a.term.localeCompare(b.term))
		.map((e) => ({
			term: e.term,
			matchType: 'EXACT',
			installs: e.installs,
			spend: e.spend,
			cpi: e.cpi,
			// It converted at this price, so this is the only bid in the whole plan
			// that is measured rather than derived.
			bid: round2(Math.min(BID.ceiling, Math.max(BID.floor, e.cpi))),
			servedBy: e.adGroupName ?? e.campaignName ?? null,
			campaignId: e.campaignId,
			reason: `${e.installs} install(s) at ${money(e.cpi)} CPI, under the ${money(cpi)} target, on broad or Search Match — own the bid`,
		}));

	return { targetCpi: cpi, wasteThreshold, minTaps, killRule: rule, negatives, held, promotions };
}

/** Every term that converted at all, regardless of price: the ASO feedback channel. */
export function convertingTerms(rows) {
	const agg = new Map();
	for (const r of rows ?? []) {
		const term = String(r?.term ?? '').toLocaleLowerCase();
		if (!term) continue;
		const e = agg.get(term) ?? { term, installs: 0, taps: 0, spend: 0 };
		e.installs += num(r.installs);
		e.taps += num(r.taps);
		e.spend += num(r.spend);
		agg.set(term, e);
	}
	return [...agg.values()]
		.filter((e) => e.installs > 0)
		.map((e) => ({ term: e.term, installs: e.installs, taps: e.taps, spend: round2(e.spend), cpi: round2(e.spend / e.installs) }))
		.sort((a, b) => b.installs - a.installs || a.term.localeCompare(b.term));
}

/**
 * Feed paid winners back into ASO. This is the only demand signal in the repo
 * measured in money, so it is merged rather than overwritten: a term that
 * converted last month stays on the record with its first-seen date.
 */
async function writePaidTerms(cfg, locale, converting) {
	const dir = join(cfg.paths.aso, locale);
	const file = join(dir, 'paid-terms.json');
	const today = isoDay(new Date());
	const before = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
	const merged = new Map((before?.terms ?? []).map((t) => [String(t.term).toLocaleLowerCase(), t]));
	for (const t of converting) {
		const prev = merged.get(t.term);
		merged.set(t.term, {
			term: t.term,
			installs: Math.max(num(prev?.installs), t.installs),
			spend: t.spend,
			cpi: t.cpi,
			firstSeen: prev?.firstSeen ?? today,
			lastSeen: today,
		});
	}
	const artifact = {
		generatedAt: new Date().toISOString(),
		locale,
		source: 'apple-ads-search-terms',
		terms: [...merged.values()].sort((a, b) => num(b.installs) - num(a.installs) || a.term.localeCompare(b.term)),
	};
	await mkdir(dir, { recursive: true });
	await writeFile(file, `${JSON.stringify(artifact, null, '\t')}\n`);
	return { file, count: artifact.terms.length };
}

/** Which converting terms the organic listing does not already index. */
async function organicGap(cfg, locale, converting) {
	const listing = (await readStaged(cfg)).find((l) => (l.data?.locale ?? l.locale) === locale) ?? null;
	if (!listing) return { staged: false, missing: converting.map((t) => t.term) };
	const d = listing.data ?? {};
	const indexed = indexedWords(`${d.name ?? ''} ${d.subtitle ?? ''} ${keywordList(d.keywords).join(' ')}`, locale);
	return { staged: true, missing: converting.filter((t) => !isCovered(t.term, indexed, locale)).map((t) => t.term) };
}

/**
 * Push the mined decisions through the same payload-file path `sync` uses, matched
 * by name so re-running adds nothing.
 */
async function applyMining({ cfg, org, artifact, flags }) {
	await gate(cfg);
	const resolvedOrg = requireOrg(cfg, { org: org ?? flags.org });
	const live = await listCampaigns(resolvedOrg);
	const planFile = join(cfg.paths.asa, 'campaign-plan.json');
	const plan = existsSync(planFile) ? JSON.parse(await readFile(planFile, 'utf8')) : null;
	const currency = plan?.currency ?? 'USD';
	const forRole = (role) => {
		const named = plan?.campaigns?.find((cp) => cp.role === role)?.name;
		return (
			(named ? byName(live, named) : null) ??
			live.find((r) => String(r.name ?? '').toLowerCase().includes(role)) ??
			null
		);
	};

	// Negatives go to the campaign that paid for the term. A row without a campaign
	// id (an exported report can drop metadata) falls back to Discovery, which is
	// where broad matching does the spending.
	const discovery = forRole('discovery');
	const grouped = new Map();
	const unplaced = [];
	for (const n of artifact.negatives) {
		const id = n.campaignId ? String(n.campaignId) : discovery?.id ? String(discovery.id) : null;
		if (!id) {
			unplaced.push(n.term);
			continue;
		}
		grouped.set(id, [...(grouped.get(id) ?? []), { text: n.term, matchType: n.matchType }]);
	}
	let negativesAdded = 0;
	for (const [campaignId, wanted] of grouped) {
		step(`negatives → campaign ${campaignId} (${wanted.length})`);
		negativesAdded += await ensureNegatives(resolvedOrg, campaignId, wanted);
	}
	if (unplaced.length)
		warn(
			`no campaign to negate ${unplaced.join(', ')} in — pass --campaign <id>, or run \`ship ads plan && ship ads sync\` so a Discovery campaign exists`,
		);

	// Promotions land in the Exact campaign, one ad group per keyword, exactly as
	// `plan` structures it.
	const exact = forRole('exact');
	const skipped = [];
	let promoted = 0;
	if (artifact.promotions.length && !exact?.id) skipped.push(...artifact.promotions.map((p) => p.term));
	else if (artifact.promotions.length) {
		const campaignId = String(exact.id);
		const groups = await listAdGroups(resolvedOrg, campaignId);
		for (const p of artifact.promotions) {
			const name = `EX · ${p.term}`;
			step(`promote "${p.term}" → ${name} @ ${money(p.bid)}`);
			const { group } = await ensureAdGroup(
				resolvedOrg,
				campaignId,
				groups,
				{ name, defaultBidAmount: p.bid, automatedKeywordsOptIn: false },
				currency,
			);
			if (!group?.id) {
				if (isDryRun()) continue;
				throw new ShipError(`ad group create returned no id for "${name}"`);
			}
			await ensureKeywords(
				resolvedOrg,
				campaignId,
				String(group.id),
				[{ text: p.term, matchType: 'EXACT', bid: p.bid }],
				currency,
			);
			promoted++;
		}
	}
	if (skipped.length)
		warn(`no Exact campaign in org ${resolvedOrg} — ${skipped.length} promotion(s) not pushed: ${skipped.join(', ')}`);

	return {
		at: new Date().toISOString(),
		org: resolvedOrg,
		dryRun: isDryRun(),
		negativesAdded,
		promoted,
		skipped,
		unplaced,
	};
}

async function mine({ flags }) {
	const cfg = await loadConfig();
	for (const w of cfg.warnings ?? []) warn(w);
	const locale = String(flags.locale ?? cfg.asc?.primaryLocale ?? 'en-US');

	// One threshold, from one place. `ads.subPrice` is deliberately *not* a
	// fallback for a missing target: silently deciding against a subscription
	// price is how one account ran with a $29.98 waste line and a $1.40 config.
	const killOpts = {
		targetCpi: flags['target-cpi'] ?? flags.targetCpi ?? cfg.ads?.targetCpi ?? null,
		subPrice: cfg.ads?.subPrice ?? null,
		retentionMonths: cfg.ads?.retentionMonths,
		baselineInstallRate: cfg.ads?.baselineInstallRate,
		minTaps: flags['min-taps'] ?? cfg.ads?.minTaps ?? null,
		source: flags['target-cpi'] ?? flags.targetCpi ? '--target-cpi' : `ads.targetCpi (${cfg.file})`,
	};

	// 30 days, not the report's 7: a single search term needs a month before its
	// zero-install verdict is anything other than noise.
	const to = flags.to ? String(flags.to) : isoDay(new Date());
	const from = flags.from
		? String(flags.from)
		: isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400_000));

	const reportFile = flags.file ? resolve(String(flags.file)) : null;
	let org = orgOf(cfg, flags);
	const raw = [];
	if (reportFile) {
		if (!existsSync(reportFile)) throw new ShipError(`no such search-term report: ${reportFile}`);
		raw.push(...searchTermRows(JSON.parse(await readFile(reportFile, 'utf8'))));
	} else {
		// Credentials only when we actually have to fetch one: `--file` keeps the
		// whole decision offline, the same way `plan` is.
		await gate(cfg);
		org = requireOrg(cfg, flags);
		const ids = flags.campaign
			? [String(flags.campaign)]
			: (await listCampaigns(org)).map((r) => String(r.id)).filter((id) => id && id !== 'undefined');
		if (!ids.length)
			throw new ShipError(`org ${org} has no campaigns to mine`, {
				hint: 'run `ship ads plan`, then `ship ads sync`, then let it spend for a month',
			});
		const payload = {
			startTime: from,
			endTime: to,
			selector: {
				orderBy: [{ field: 'localSpend', sortOrder: 'DESCENDING' }],
				pagination: { offset: 0, limit: 1000 },
			},
			timeZone: 'UTC',
			returnRecordsWithNoMetrics: false,
			returnRowTotals: true,
			returnGrandTotals: false,
		};
		for (const id of ids) {
			const res = await withPayload('search-terms.json', payload, (file) =>
				asc(['ads', 'reports', 'search-terms', '--campaign', id, '--org', org, '--file', file], {
					fallback: null,
				}),
			);
			raw.push(...searchTermRows(res));
		}
	}

	const decided = decide(raw, killOpts);
	const converting = convertingTerms(raw);
	const gap = await organicGap(cfg, locale, converting);

	const artifact = {
		generatedAt: new Date().toISOString(),
		locale,
		org: org ?? null,
		source: reportFile ?? `asc ads reports search-terms (${from} → ${to})`,
		window: { from, to },
		// The resolved rule, stamped whole. Nothing downstream recomputes a
		// threshold, so no artifact can disagree with the config that produced it.
		params: { window: { from, to }, locale, killRule: decided.killRule, campaign: flags.campaign ?? null },
		killRule: decided.killRule,
		targetCpi: decided.targetCpi,
		wasteThreshold: decided.wasteThreshold,
		minTaps: decided.minTaps,
		rows: raw.length,
		negatives: decided.negatives,
		held: decided.held,
		promotions: decided.promotions,
		converting,
		asoGap: gap.missing,
		applied: null,
	};

	// The file is written before anything is pushed: the artifact is the record,
	// and --apply is only the part that trusts it.
	const outFile = await writeArtifact(cfg, `mining-${isoDay(new Date())}.json`, artifact);
	const paid = await writePaidTerms(cfg, locale, converting);

	// Negation is permanent and invisible after the fact, so the evidence is
	// printed and a second flag is required. `--apply --dry-run` previews instead.
	const wantsApply = Boolean(flags.apply);
	const confirmed = Boolean(flags.confirm) || isDryRun();
	if (wantsApply && confirmed) {
		artifact.applied = await applyMining({ cfg, org, artifact, flags });
		await writeArtifact(cfg, `mining-${isoDay(new Date())}.json`, artifact);
	}

	if (flags.json)
		return emit({ ...artifact, file: outFile, paidTermsFile: paid.file, confirmed: wantsApply && confirmed });

	heading(`Search-term mining · ${from} → ${to}`);
	info(
		`${raw.length} row(s) · target CPI ${money(decided.targetCpi)} (${decided.killRule.source}) · waste line ${money(decided.wasteThreshold)} · min ${decided.minTaps} taps · source ${c.dim(artifact.source)}`,
	);
	note(decided.killRule.derivation);

	if (decided.negatives.length) {
		process.stdout.write('\n');
		step(`${decided.negatives.length} negative keyword(s) proposed`);
		table(decided.negatives, [
			{ header: 'term', get: (n) => n.term },
			{ header: 'spend', get: (n) => money(n.spend) },
			{ header: 'taps', get: (n) => String(n.taps) },
			{ header: 'impr', get: (n) => String(n.impressions) },
			{ header: 'window', get: () => `${from} → ${to}` },
			{ header: 'served by', get: (n) => n.adGroupName ?? n.campaignName ?? '' },
		]);
	} else note('no term is past both the waste line and the minimum tap count');

	// The keywords a spend-only rule would have killed. Printing them is the point:
	// this is the list that used to disappear into a negative-keyword set.
	if (decided.held.length) {
		process.stdout.write('\n');
		step(`${decided.held.length} term(s) past the money line but held for evidence`);
		table(decided.held, [
			{ header: 'term', get: (h) => h.term },
			{ header: 'spend', get: (h) => money(h.spend) },
			{ header: 'taps', get: (h) => `${h.taps}/${h.needTaps}` },
			{ header: 'why', get: (h) => h.reason },
		]);
	}

	if (decided.promotions.length) {
		process.stdout.write('\n');
		step(`${decided.promotions.length} promotion(s) to Exact`);
		table(decided.promotions, [
			{ header: 'term', get: (p) => p.term },
			{ header: 'installs', get: (p) => String(p.installs) },
			{ header: 'CPI', get: (p) => money(p.cpi) },
			{ header: 'bid', get: (p) => money(p.bid) },
			{ header: 'served by', get: (p) => p.servedBy ?? '' },
		]);
	} else note('nothing converted under target on broad or Search Match');

	process.stdout.write('\n');
	good(`wrote ${outFile}`);
	good(`${converting.length} converting term(s) → ${paid.file}`);
	if (gap.missing.length) {
		warn(
			`${gap.missing.length} converting term(s) are absent from the ${locale} listing: ${gap.missing.slice(0, 8).join(', ')}${gap.missing.length > 8 ? ', …' : ''}`,
		);
		note(
			'a term that converts on paid and is missing from the organic listing is the highest-value ASO finding there is —',
		);
		note(`you are renting traffic you could own: \`ship aso suggest --locale ${locale}\`, then \`ship meta keywords\``);
	} else if (!gap.staged) note(`no staged listing for ${locale} — cannot tell which paid winners the listing already covers`);

	if (!wantsApply) note('`ship ads mine --apply --confirm` pushes it (preview first: `--apply --dry-run`)');
	else if (!confirmed) {
		warn(
			`--apply needs --confirm: ${decided.negatives.length} negation(s) are permanent and ${decided.promotions.length} promotion(s) spend money`,
		);
		note(`the evidence for each is above and in ${outFile} — re-run with --confirm, or --apply --dry-run to preview the calls`);
		return 1;
	} else
		good(
			`${artifact.applied.dryRun ? 'dry-run: ' : ''}applied ${artifact.applied.negativesAdded} negative(s), ${artifact.applied.promoted} promotion(s)`,
		);
	return 0;
}

const SUB = { status, login, campaigns, keywords, report, plan, snapshot, sync, mine };
export async function run({ args, flags }) {
	const [sub = 'status', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`ads: unknown subcommand "${sub}"`, {
			hint: `try: ${Object.keys(SUB).join(', ')}`,
		});
	return fn({ args: rest, flags });
}

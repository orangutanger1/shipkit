// Apple Search Ads — `asc ads` wrapper, plus the offline half nobody else does.
//
// Two operational facts shape this whole module:
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
//
// `ads plan` is deliberately offline: it turns `ship aso` scores into a campaign
// structure you can read, argue with, and only then push. Planning spend should
// never require the credentials you are trying to justify creating. `ads mine`
// keeps the same bargain — `--file <report.json>` decides entirely offline, and it
// writes the mining plan before `--apply` pushes anything, so the record of what
// was decided survives a failed push.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

export const help = `
${c.bold('ship ads')} ${c.dim('— Apple Search Ads (Apple Ads Campaign Management API)')}

${c.dim('usage:')} ship ads [subcommand] [flags]

  ${c.cyan('status')}     ${c.dim('default')} credential state; setup instructions when unconfigured
  ${c.cyan('login')}      store Apple Ads credentials (validates the .p8 before calling asc)
  ${c.cyan('campaigns')}  list campaigns for the org
  ${c.cyan('keywords')}   list targeting keywords in an ad group
  ${c.cyan('report')}     campaign report with installs / spend / CPI / TTR / CVR
  ${c.cyan('plan')}       ${c.green('offline')} four campaigns (Exact · Discovery · Competitor · Brand) + budget split
  ${c.cyan('sync')}       push campaign-plan.json to Apple Ads (idempotent, matches by name)
  ${c.cyan('mine')}       search-term report → negative keywords + Exact promotions + ASO feedback

${c.bold('Flags')}
  ${c.cyan('--org <id>')}          Apple Ads organization id ${c.dim('(default: ads.orgId in ship.config.json)')}
  ${c.cyan('--campaign <id>')}     campaign id ${c.dim('(keywords; mine: one campaign instead of all)')}
  ${c.cyan('--ad-group <id>')}     ad group id ${c.dim('(keywords)')}
  ${c.cyan('--from --to')}         report window ${c.dim('YYYY-MM-DD, default: 7 days (report) / 30 days (mine)')}
  ${c.cyan('--locale <l>')}        aso locale to plan from, and to feed paid winners back into ${c.dim('(default: asc.primaryLocale)')}
  ${c.cyan('--top <n>')}           keywords to plan ${c.dim('(default: 15)')}
  ${c.cyan('--budget <n>')}        total daily budget in USD ${c.dim('(default: 10)')}
  ${c.cyan('--split <a/b/c/d>')}   exact/discovery/competitor/brand ratio ${c.dim('(default: 50/25/15/10)')}
  ${c.cyan('--sub-price <n>')}     monthly subscription price, drives the kill rule ${c.dim('(default: 4.99)')}
  ${c.cyan('--target-cpi <n>')}    ${c.dim('mine')} decision line ${c.dim('(default: ads.targetCpi, else ads.subPrice)')}
  ${c.cyan('--file <path>')}       ${c.dim('mine')} search-term report JSON instead of pulling one ${c.dim('(no credentials)')}
  ${c.cyan('--apply')}             ${c.dim('mine')} push the mined negatives and promotions ${c.dim('(default: write the plan only)')}
  ${c.cyan('--json')}              machine-readable output

${c.dim('Credentials are separate from ASC: app-ads.apple.com → Account Settings → API.')}
${c.dim('`ship ads plan` needs no credentials at all.')}
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

/** Every credentialed subcommand funnels through here so the guidance is identical. */
async function gate() {
	const { configured, text } = await authState();
	if (!configured)
		throw new ShipError('Apple Ads credentials are not configured', {
			hint: `${text}\n\n${LOGIN_LINE.join('\n')}\n\nRun \`ship ads status\` for where each value comes from.\n\`ship ads plan\` works offline in the meantime.`,
		});
}

async function campaigns({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	await gate();
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
	await gate();
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

async function report({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	await gate();
	const org = requireOrg(cfg, flags);

	const to = flags.to ? String(flags.to) : isoDay(new Date());
	const from = flags.from
		? String(flags.from)
		: isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86400_000));

	// Row totals only: we derive CPI/TTR/CVR ourselves rather than trusting
	// Apple's avgCPA, which counts conversions we did not ask for.
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
		returnGrandTotals: true,
	};

	const res = await withPayload('report.json', payload, (file) =>
		asc(['ads', 'reports', 'campaigns', '--org', org, '--file', file], { fallback: null }),
	);
	const raw = res?.data?.reportingDataResponse?.row ?? res?.reportingDataResponse?.row ?? rows(res);

	const metrics = raw
		.map((r) => {
			const t = r.total ?? r.metadata ?? {};
			const meta = r.metadata ?? {};
			const spend = num(t.localSpend?.amount ?? t.localSpend);
			const impressions = num(t.impressions);
			const taps = num(t.taps);
			const installs = num(t.installs ?? num(t.newDownloads) + num(t.redownloads));
			return {
				campaignId: meta.campaignId ?? r.campaignId ?? null,
				name: meta.campaignName ?? meta.name ?? r.name ?? '(unnamed)',
				status: meta.campaignStatus ?? meta.status ?? '',
				impressions,
				taps,
				installs,
				spend,
				currency: t.localSpend?.currency ?? 'USD',
				cpi: installs ? spend / installs : null,
				ttr: impressions ? taps / impressions : 0,
				conversionRate: taps ? installs / taps : 0,
			};
		})
		.sort((a, b) => b.spend - a.spend);

	if (flags.json) return emit({ from, to, org, campaigns: metrics });

	heading(`Campaign report · ${from} → ${to} · org ${org}`);
	table(metrics, [
		{ header: 'campaign', get: (r) => r.name },
		{ header: 'spend', get: (r) => money(r.spend) },
		{ header: 'installs', get: (r) => r.installs },
		{ header: 'CPI', get: (r) => (r.cpi === null ? '—' : money(r.cpi)) },
		{ header: 'taps', get: (r) => r.taps },
		{ header: 'TTR', get: (r) => pct(r.ttr) },
		{ header: 'CVR', get: (r) => pct(r.conversionRate) },
	]);

	const spend = metrics.reduce((s, r) => s + r.spend, 0);
	const installs = metrics.reduce((s, r) => s + r.installs, 0);
	process.stdout.write('\n');
	info(
		`total ${c.bold(money(spend))} · ${c.bold(installs)} installs · blended CPI ${c.bold(installs ? money(spend / installs) : '—')}`,
	);
	const dead = metrics.filter((r) => r.spend > 0 && r.installs === 0);
	if (dead.length)
		warn(`${dead.length} campaign(s) spent with zero installs: ${dead.map((r) => r.name).join(', ')}`);
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
const pct100 = (n) => Math.min(100, Math.max(0, num(n)));

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

/**
 * Starting bid. No offline source knows the real CPT, so the honest derivation is
 * "fund roughly five taps a day per keyword" — enough to reach statistical
 * daylight inside the 7-day kill window, cheap enough that a wrong guess costs one
 * coffee. Demand scales it: a term everybody types is a term everybody bids on, so
 * demand 0 pays 0.6× and demand 100 pays 1.4× of that. Clamped so a tiny or huge
 * budget stays sane.
 */
export const startingBid = (perKeywordDaily, demand = 50) =>
	round2(Math.min(2, Math.max(0.3, (num(perKeywordDaily) / 5) * (0.6 + pct100(demand) / 125))));

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
	subPrice = 4.99,
	minVolume = 0,
	org = null,
	source = null,
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
		const each = round2(daily.exact / category.length);
		campaigns.push({
			role: 'exact',
			...campaignShell(`${app.name} · Exact · ${market}`, daily.exact, market),
			adGroups: category.map((t) => ({
				name: `EX · ${t.term}`,
				dailyBudget: each,
				defaultBidAmount: startingBid(each, t.demand),
				automatedKeywordsOptIn: false,
				keywords: [{ text: t.term, matchType: 'EXACT' }],
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
			})),
			negativeKeywords: [],
			rationale: 'One ad group per keyword: every keyword owns its budget and earns its own verdict.',
		});
	}

	if (daily.discovery > 0) {
		// EXACT negatives, never BROAD: a broad negative on "oil change" would also
		// block "oil change reminder app", which is precisely the kind of term this
		// campaign exists to find. Exact negation stops the two campaigns bidding
		// against each other on the terms Exact already measures, and nothing else.
		const negativeKeywords = exactTerms.map((text) => ({ text, matchType: 'EXACT' }));
		if (brand && !exactTerms.includes(brand)) negativeKeywords.push({ text: brand, matchType: 'EXACT' });
		campaigns.push({
			role: 'discovery',
			...campaignShell(`${app.name} · Discovery · ${market}`, daily.discovery, market),
			adGroups: [
				{
					name: `DISC · ${market}`,
					dailyBudget: round2(daily.discovery),
					defaultBidAmount: startingBid(daily.discovery / picked.length, midDemand),
					// Search Match is the point of this campaign: it is the only source of
					// terms that are not already in scored.json.
					automatedKeywordsOptIn: true,
					keywords: exactTerms.map((text) => ({ text, matchType: 'BROAD' })),
					demand: midDemand,
				},
			],
			negativeKeywords,
			rationale:
				'Broad match plus Search Match, with every Exact term negated so the two cannot cannibalise each other.',
		});
	}

	if (daily.competitor > 0 && rivals.length) {
		const each = round2(daily.competitor / rivals.length);
		campaigns.push({
			role: 'competitor',
			...campaignShell(`${app.name} · Competitor · ${market}`, daily.competitor, market),
			adGroups: rivals.map((r) => ({
				name: `COMP · ${r.text}`,
				dailyBudget: each,
				defaultBidAmount: startingBid(each, midDemand),
				automatedKeywordsOptIn: false,
				keywords: [{ text: r.text, matchType: 'EXACT' }],
				demand: midDemand,
				incumbents: [{ name: r.name, id: r.id, ratings: r.ratings }],
			})),
			negativeKeywords: brand ? [{ text: brand, matchType: 'EXACT' }] : [],
			rationale:
				'Exact match on the apps you are compared to; your own name is negated here so Brand keeps that traffic at its own price.',
		});
	}

	if (daily.brand > 0 && brand) {
		campaigns.push({
			role: 'brand',
			...campaignShell(`${app.name} · Brand · ${market}`, daily.brand, market),
			adGroups: [
				{
					name: `BRAND · ${brand}`,
					dailyBudget: round2(daily.brand),
					defaultBidAmount: startingBid(daily.brand / 2, 100),
					automatedKeywordsOptIn: false,
					// EXACT defends the name; BROAD catches the misspellings and the
					// "<brand> app" queries a competitor would otherwise buy.
					keywords: [
						{ text: brand, matchType: 'EXACT' },
						{ text: brand, matchType: 'BROAD' },
					],
					demand: 100,
				},
			],
			negativeKeywords: [],
			rationale:
				'Your own name is the cheapest tap you will ever buy, and the one a competitor buys if you do not.',
		});
	}

	// A custom product page is authored per keyword intent; `cpp link` records the
	// ad group it serves, so the plan carries the join key and `sync` binds it.
	for (const cp of campaigns)
		for (const g of cp.adGroups) {
			const entry = pageForAdGroup(pages, g.name);
			if (entry) g.productPage = { slug: entry.slug, name: entry.page?.name ?? entry.slug };
		}

	const killRule = {
		window: '7 days',
		condition: 'spend > monthlyRevenuePerSubscriber AND conversions === 0',
		monthlyRevenuePerSubscriber: round2(subPrice),
		thresholdPerKeyword: round2(subPrice),
		action: 'pause the keyword',
		rationale:
			`A keyword that burns ${money(subPrice)} — one month of subscription revenue — without a single ` +
			'conversion has already lost money on the best case it will ever have. Pause it; do not "give it more data".',
		automation: '`ship ads mine` applies this from the search-term report instead of asking you to remember it.',
	};

	return {
		generatedAt,
		source,
		locale,
		market,
		app: { name: app.name, bundleId: app.bundleId ?? null, appId: app.appId ?? null },
		org,
		currency: 'USD',
		budget: {
			requested: round2(budget),
			daily: round2(campaigns.reduce((s, cp) => s + cp.dailyBudget, 0)),
			monthly: round2(campaigns.reduce((s, cp) => s + cp.totalBudget, 0)),
			split: Object.fromEntries(campaigns.map((cp) => [cp.role, cp.dailyBudget])),
			ratio: weights,
			derivation: `default ${ROLES.map((r) => Math.round(SPLIT[r] * 100)).join('/')} ${ROLES.join('/')}, overridable with --split; a skipped campaign redistributes its share`,
		},
		targeting: {
			minVolume: num(minVolume),
			considered: terms.length,
			eligible: eligible.length,
			dropped: terms.length - eligible.length,
			exactTerms,
		},
		bidding: {
			derivation: '(perKeywordDailyBudget / 5 taps) × (0.6 + demand/125), clamped to [0.30, 2.00]',
		},
		campaigns,
		killRule,
	};
}

function renderPlan(p) {
	const L = [];
	L.push(`# Apple Search Ads plan — ${p.app.name}`, '');
	L.push(`Generated ${p.generatedAt}${p.source ? ` from \`${p.source}\`` : ''}.`, '');
	L.push(`- **Market**: ${p.market} (locale ${p.locale})`);
	L.push(`- **Daily budget**: ${money(p.budget.daily)} across ${p.campaigns.length} campaigns`);
	L.push(
		`- **Split**: ${Object.entries(p.budget.split)
			.map(([role, v]) => `${role} ${money(v)}`)
			.join(' · ')} — ${p.budget.derivation}`,
	);
	L.push(`- **Bids**: ${p.bidding.derivation}`);
	L.push(
		`- **Demand floor**: aso.minVolume ${p.targeting.minVolume}${p.targeting.dropped ? ` — dropped ${p.targeting.dropped} of ${p.targeting.considered} scored terms as not worth bidding on` : ''}`,
	);
	L.push('');
	L.push('## Kill rule', '');
	L.push(`\`${p.killRule.condition}\` over ${p.killRule.window} → **${p.killRule.action}**.`, '');
	L.push(p.killRule.rationale, '');
	L.push(
		`Concretely: after 7 days, pause any keyword that has spent more than ${money(p.killRule.thresholdPerKeyword)} with zero conversions. ${p.killRule.automation}`,
		'',
	);
	for (const cp of p.campaigns) {
		L.push(`## ${cp.name}`, '');
		L.push(cp.rationale, '');
		L.push(
			`${money(cp.dailyBudget)}/day (${money(cp.totalBudget)} over 30 days) · ${cp.countriesOrRegions.join(', ')} · ${cp.adGroups.length} ad group(s)`,
			'',
		);
		L.push('| ad group | keywords | demand | bid | daily | product page | incumbents |');
		L.push('| --- | --- | ---: | ---: | ---: | --- | --- |');
		for (const g of cp.adGroups) {
			const inc = (g.incumbents ?? [])
				.map((a) => `${a.name}${a.ratings == null ? '' : ` (${a.ratings})`}`)
				.join('<br>');
			const kw = g.keywords.map((k) => `${k.text} \`${k.matchType}\``).join('<br>');
			L.push(
				`| ${g.name} | ${kw} | ${g.demand ?? '—'} | ${money(g.defaultBidAmount)} | ${money(g.dailyBudget)} | ${g.productPage?.name ?? '—'} | ${inc || '—'} |`,
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
	L.push('Push with `ship ads sync` (dry-run first: `ship ads sync --dry-run`), then close the loop');
	L.push('with `ship ads mine`, which turns the search-term report back into keywords.');
	L.push('');
	return L.join('\n');
}

async function plan({ flags }) {
	const cfg = await loadConfig();
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

	const out = buildPlan({
		app: { name: cfg.name, bundleId: cfg.bundleId, appId: cfg.asc?.appId ?? null },
		locale,
		market: (marketFor(locale)?.country ?? 'US').toUpperCase(),
		terms,
		competitors,
		pages: await readPages(cfg),
		budget: Math.max(1, num(flags.budget, 10)),
		split: parseSplit(flags.split),
		top: Math.max(1, num(flags.top, 15)),
		subPrice: Math.max(0.01, num(flags['sub-price'] ?? flags.subPrice, 4.99)),
		minVolume: num(cfg.aso?.minVolume),
		org: cfg.ads?.orgId ?? null,
		source: scoredFile,
	});

	await mkdir(cfg.paths.asa, { recursive: true });
	const jsonFile = join(cfg.paths.asa, 'campaign-plan.json');
	const mdFile = join(cfg.paths.asa, 'campaign-plan.md');
	await writeFile(jsonFile, `${JSON.stringify(out, null, '\t')}\n`);
	await writeFile(mdFile, renderPlan(out));

	if (flags.json) return emit(out);

	heading(`Campaign plan · ${cfg.name} · ${out.market}`);
	info(
		`${money(out.budget.daily)}/day across ${out.campaigns.length} campaigns · ${Object.entries(out.budget.split)
			.map(([role, v]) => `${role} ${money(v)}`)
			.join(' · ')}`,
	);
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
			{ header: 'daily', get: (g) => money(g.dailyBudget) },
			{ header: 'page', get: (g) => g.productPage?.name ?? '' },
		]);
	}
	process.stdout.write('\n');
	info(`kill rule: ${out.killRule.condition} → ${out.killRule.action} (${money(out.killRule.thresholdPerKeyword)}/keyword/7d)`);
	good(`wrote ${jsonFile}`);
	good(`wrote ${mdFile}`);
	note('review it, then `ship ads sync` once credentials exist');
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

// Match by name, always. Apple happily creates a second campaign with an
// identical name and then splits your budget across both of them.
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

async function ensureCampaign(org, existing, cp, adamId, currency) {
	const body = {
		name: cp.name,
		adamId,
		countriesOrRegions: cp.countriesOrRegions,
		// No budgetAmount: Apple rejects a lifetime budget outright
		// ("LIFETIME_BUDGET_NOT_SUPPORTED: Lifetime budget is not supported"), and the
		// Platform API v1 drops the field entirely. dailyBudget is the only spend control
		// the API still honours, so a fixed total is expressed as dailyBudget × a flight
		// window: set endTime and the campaign cannot spend past (days × dailyBudget).
		dailyBudgetAmount: amountOf(cp.dailyBudget, currency),
		...(cp.startTime ? { startTime: cp.startTime } : {}),
		...(cp.endTime ? { endTime: cp.endTime } : {}),
		supplySources: cp.supplySources,
		billingEvent: cp.billingEvent,
		adChannelType: cp.adChannelType,
		status: 'ENABLED',
	};
	const found = byName(existing, cp.name);
	if (found) {
		note(`exists → ${found.id}, updating budget`);
		await withPayload(
			'campaign.json',
			{ campaign: body, clearGeoTargetingOnCountryOrRegionChange: false },
			(file) => ascMutate(['ads', 'campaigns', 'update', '--campaign', String(found.id), '--org', org], { file }),
		);
		return { campaign: found, created: false };
	}
	const res = await withPayload('campaign.json', body, (file) =>
		ascMutate(['ads', 'campaigns', 'create', '--org', org], { file }),
	);
	return { campaign: one(res), created: true };
}

/** Create or update one ad group, matched by name. */
async function ensureAdGroup(org, campaignId, groups, spec, currency) {
	const body = {
		name: spec.name,
		// Apple rejects a startTime in the past on create; "now" is the only safe value.
		startTime: new Date().toISOString().replace(/\.\d+Z$/, '.000Z'),
		defaultBidAmount: amountOf(spec.defaultBidAmount, currency),
		pricingModel: 'CPC',
		automatedKeywordsOptIn: Boolean(spec.automatedKeywordsOptIn),
		...(spec.endTime ? { endTime: spec.endTime } : {}),
		status: 'ENABLED',
	};
	const found = byName(groups, spec.name);
	if (found) {
		await withPayload('ad-group.json', body, (file) =>
			ascMutate(
				['ads', 'ad-groups', 'update', '--campaign', campaignId, '--ad-group', String(found.id), '--org', org],
				{ file },
			),
		);
		return { group: found, created: false };
	}
	const res = await withPayload('ad-group.json', body, (file) =>
		ascMutate(['ads', 'ad-groups', 'create', '--campaign', campaignId, '--org', org], { file }),
	);
	return { group: one(res), created: true };
}

/** Bulk-create the keywords that are missing and bulk re-bid the ones that exist. */
async function ensureKeywords(org, campaignId, adGroupId, wanted, currency) {
	if (!wanted.length) return { created: 0, updated: 0 };
	const have = await listKeywords(org, campaignId, adGroupId);
	const missing = [];
	const present = [];
	for (const k of wanted) {
		const match = have.find((h) => h.text === k.text && h.matchType === k.matchType);
		if (match) present.push({ id: match.id, bidAmount: amountOf(k.bid, currency), status: 'ACTIVE' });
		else missing.push({ text: k.text, matchType: k.matchType, bidAmount: amountOf(k.bid, currency) });
	}
	const args = (verb) => [
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
	if (missing.length) await withPayload('keywords.json', missing, (file) => ascMutate(args('create-bulk'), { file }));
	if (present.length) await withPayload('keywords.json', present, (file) => ascMutate(args('update-bulk'), { file }));
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

// ─── sync ────────────────────────────────────────────────────────────────────

async function sync({ flags }) {
	const cfg = await loadConfig();
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

	await gate();
	const org = requireOrg(cfg, { org: flags.org ?? p.org });
	const adamId = num(cfg.asc?.appId ?? p.app?.appId, 0);
	if (!adamId)
		throw new ShipError('sync needs the numeric App Store app id (adamId)', {
			hint: 'set asc.appId in ship.config.json — `asc apps list --bundle-id ' + (cfg.bundleId ?? '<bundle>') + ' --output json` has it',
		});

	const currency = p.currency ?? 'USD';
	const existing = await listCampaigns(org);
	const cache = {};
	const tally = { campaigns: 0, groupsCreated: 0, groupsUpdated: 0, kwCreated: 0, kwUpdated: 0, negatives: 0, pages: 0 };

	for (const cp of planned) {
		step(`campaign "${cp.name}" · ${money(cp.dailyBudget)}/day`);
		const { campaign, created } = await ensureCampaign(org, existing, cp, adamId, currency);
		if (!campaign?.id) {
			if (isDryRun()) {
				note(
					`dry-run: ${(cp.adGroups ?? []).length} ad group(s) + ${(cp.negativeKeywords ?? []).length} negative(s) would follow campaign creation`,
				);
				continue;
			}
			throw new ShipError(`campaign create returned no id for "${cp.name}"`, {
				hint: 'asc ads campaigns create emitted an unexpected payload — re-run with --verbose',
			});
		}
		if (created) {
			tally.campaigns++;
			good(`created campaign ${campaign.id}`);
		}

		const campaignId = String(campaign.id);
		tally.negatives += await ensureNegatives(org, campaignId, cp.negativeKeywords ?? []);
		const groups = await listAdGroups(org, campaignId);
		for (const g of cp.adGroups ?? []) {
			const { group, created: isNew } = await ensureAdGroup(org, campaignId, groups, g, currency);
			if (isNew) tally.groupsCreated++;
			else tally.groupsUpdated++;
			if (!group?.id) {
				if (isDryRun()) continue;
				throw new ShipError(`ad group create returned no id for "${g.name}"`);
			}
			const adGroupId = String(group.id);
			const res = await ensureKeywords(
				org,
				campaignId,
				adGroupId,
				(g.keywords ?? []).map((k) => ({ ...k, bid: g.defaultBidAmount })),
				currency,
			);
			tally.kwCreated += res.created;
			tally.kwUpdated += res.updated;
			if (g.productPage && (await bindProductPage(org, adamId, campaignId, adGroupId, g.productPage, cache)))
				tally.pages++;
		}
	}

	process.stdout.write('\n');
	good(
		`${isDryRun() ? 'dry-run: ' : ''}${planned.length} campaign(s) (${tally.campaigns} created) · ${tally.groupsCreated} ad group(s) created, ${tally.groupsUpdated} updated · ${tally.kwCreated} keyword(s) added, ${tally.kwUpdated} re-bid · ${tally.negatives} negative(s)${tally.pages ? ` · ${tally.pages} product page(s) bound` : ''}`,
	);
	if (!isDryRun()) note(`verify: ship ads campaigns --org ${org}`);
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
 *  - Spend past 2× target CPI with zero installs is not "not enough data". At twice
 *    the price of a win, the term has already answered. Negate it.
 *  - A term that converted at or under target CPI and is not already an Exact
 *    keyword is being served by broad match or Search Match — at Apple's discretion
 *    and Apple's bid. Promote it to Exact and own the bid.
 *
 * Pure: no credentials, no filesystem, so the rule is testable and auditable.
 * @param {object[]} rows {@link searchTermRows} output
 * @param {{targetCpi: number}} opts
 * @returns {{targetCpi:number, wasteThreshold:number, negatives:object[], promotions:object[]}}
 */
export function decide(rows, { targetCpi } = {}) {
	const cpi = num(targetCpi);
	if (!(cpi > 0))
		throw new ShipError('mine needs a positive target CPI', {
			hint: 'pass --target-cpi <n>, or set ads.targetCpi (or ads.subPrice) in ship.config.json',
		});
	const wasteThreshold = round2(2 * cpi);

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

	const negatives = terms
		.filter((e) => e.installs === 0 && e.spend > wasteThreshold)
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
			reason: `${money(e.spend)} over ${e.taps} tap(s) for zero installs — past the ${money(wasteThreshold)} (2× target CPI) waste line`,
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
			bid: round2(Math.min(2, Math.max(0.3, e.cpi))),
			servedBy: e.adGroupName ?? e.campaignName ?? null,
			campaignId: e.campaignId,
			reason: `${e.installs} install(s) at ${money(e.cpi)} CPI, under the ${money(cpi)} target, on broad or Search Match — own the bid`,
		}));

	return { targetCpi: round2(cpi), wasteThreshold, negatives, promotions };
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
	await gate();
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
	const locale = String(flags.locale ?? cfg.asc?.primaryLocale ?? 'en-US');
	const targetCpi = num(
		flags['target-cpi'] ?? flags.targetCpi ?? cfg.ads?.targetCpi ?? cfg.ads?.subPrice,
	);
	if (!(targetCpi > 0))
		throw new ShipError('no target CPI to decide against', {
			hint: 'set ads.targetCpi in ship.config.json, or pass --target-cpi <n>. One month of subscription revenue (ads.subPrice) is the honest ceiling.',
		});

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
		await gate();
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

	const decided = decide(raw, { targetCpi });
	const converting = convertingTerms(raw);
	const gap = await organicGap(cfg, locale, converting);

	const artifact = {
		generatedAt: new Date().toISOString(),
		locale,
		org: org ?? null,
		source: reportFile ?? `asc ads reports search-terms (${from} → ${to})`,
		window: { from, to },
		targetCpi: decided.targetCpi,
		wasteThreshold: decided.wasteThreshold,
		rows: raw.length,
		negatives: decided.negatives,
		promotions: decided.promotions,
		converting,
		asoGap: gap.missing,
		applied: null,
	};

	// The file is written before anything is pushed: the plan is the record, and
	// --apply is just the part that trusts it.
	await mkdir(cfg.paths.asa, { recursive: true });
	const outFile = join(cfg.paths.asa, `mining-${isoDay(new Date())}.json`);
	const write = () => writeFile(outFile, `${JSON.stringify(artifact, null, '\t')}\n`);
	await write();
	const paid = await writePaidTerms(cfg, locale, converting);

	if (flags.apply) {
		artifact.applied = await applyMining({ cfg, org, artifact, flags });
		await write();
	}

	if (flags.json) return emit({ ...artifact, file: outFile, paidTermsFile: paid.file });

	heading(`Search-term mining · ${from} → ${to}`);
	info(
		`${raw.length} row(s) · target CPI ${money(decided.targetCpi)} · waste line ${money(decided.wasteThreshold)} · source ${c.dim(artifact.source)}`,
	);

	if (decided.negatives.length) {
		process.stdout.write('\n');
		step(`${decided.negatives.length} negative keyword(s)`);
		table(decided.negatives, [
			{ header: 'term', get: (n) => n.term },
			{ header: 'spend', get: (n) => money(n.spend) },
			{ header: 'taps', get: (n) => String(n.taps) },
			{ header: 'served by', get: (n) => n.adGroupName ?? n.campaignName ?? '' },
		]);
	} else note('no term is past the waste line');

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

	if (!flags.apply) note('`ship ads mine --apply` pushes it (dry-run first: `--apply --dry-run`)');
	else
		good(
			`${artifact.applied.dryRun ? 'dry-run: ' : ''}applied ${artifact.applied.negativesAdded} negative(s), ${artifact.applied.promoted} promotion(s)`,
		);
	return 0;
}

const SUB = { status, login, campaigns, keywords, report, plan, sync, mine };
export async function run({ args, flags }) {
	const [sub = 'status', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`ads: unknown subcommand "${sub}"`, {
			hint: `try: ${Object.keys(SUB).join(', ')}`,
		});
	return fn({ args: rest, flags });
}

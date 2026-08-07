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
// never require the credentials you are trying to justify creating.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.mjs';
import { ASC, asc, isDryRun, run as exec } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { marketFor } from '../lib/appstore.mjs';

export const help = `
${c.bold('ship ads')} ${c.dim('— Apple Search Ads (Apple Ads Campaign Management API)')}

${c.dim('usage:')} ship ads [subcommand] [flags]

  ${c.cyan('status')}     ${c.dim('default')} credential state; setup instructions when unconfigured
  ${c.cyan('login')}      store Apple Ads credentials (validates the .p8 before calling asc)
  ${c.cyan('campaigns')}  list campaigns for the org
  ${c.cyan('keywords')}   list targeting keywords in an ad group
  ${c.cyan('report')}     campaign report with installs / spend / CPI / TTR / CVR
  ${c.cyan('plan')}       ${c.green('offline')} turn aso scores into a campaign plan + budget split
  ${c.cyan('sync')}       push campaign-plan.json to Apple Ads (idempotent, matches by name)

${c.bold('Flags')}
  ${c.cyan('--org <id>')}          Apple Ads organization id ${c.dim('(default: ads.orgId in ship.config.json)')}
  ${c.cyan('--campaign <id>')}     campaign id ${c.dim('(keywords, sync)')}
  ${c.cyan('--ad-group <id>')}     ad group id ${c.dim('(keywords)')}
  ${c.cyan('--from --to')}         report window ${c.dim('YYYY-MM-DD, default: last 7 days')}
  ${c.cyan('--locale <l>')}        aso locale to plan from ${c.dim('(default: asc.primaryLocale)')}
  ${c.cyan('--top <n>')}           keywords to plan ${c.dim('(default: 15)')}
  ${c.cyan('--budget <n>')}        total daily budget in USD ${c.dim('(default: 10)')}
  ${c.cyan('--sub-price <n>')}     monthly subscription price, drives the kill rule ${c.dim('(default: 4.99)')}
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
	note(`1. ${c.bold('app-ads.apple.com')} → Account Settings → User Management`);
	note('   Invite a user with the API role (API accounts are separate people in');
	note('   Apple\'s model — your own admin login cannot mint API credentials).');
	note(`2. Sign in ${c.bold('as that API user')} → Account Settings → API`);
	note('   Create a key. That screen shows --client-id, --team-id and --key-id,');
	note('   and downloads the private key exactly once.');
	note(`3. ${c.bold('--org')} is the organization id shown in the URL / account picker;`);
	note('   after login `asc ads acls --output json` lists every org you can reach.');
	note(`4. The key must be ${c.bold('PKCS#8 P-256')} — the file starts with`);
	note(`   ${c.dim('-----BEGIN PRIVATE KEY-----')}. If yours says ${c.dim('EC PRIVATE KEY')}, convert it:`);
	note(`   ${c.cyan('openssl pkcs8 -topk8 -nocrypt -in key.pem -out ~/.asc/asa-private.p8')}`);
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
			hint: 'Apple downloads the .p8 exactly once, at Account Settings → API. If it is gone, revoke the key and create a new one.',
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
	return 0;
}

// ─── plan (offline) ──────────────────────────────────────────────────────────

/**
 * Exact-match starting bid. No offline source knows the real CPT, so the honest
 * derivation is "fund roughly five taps a day per keyword" — enough to reach
 * statistical daylight within the 7-day kill window below, cheap enough that a
 * wrong guess costs one coffee. Clamped so a tiny or huge budget stays sane.
 */
const startingBid = (perKeywordDaily) =>
	Math.round(Math.min(2, Math.max(0.3, perKeywordDaily / 5)) * 100) / 100;

async function plan({ flags }) {
	const cfg = await loadConfig();
	const locale = String(flags.locale ?? cfg.asc?.primaryLocale ?? 'en-US');
	const top = Math.max(1, num(flags.top, 15));
	const budget = Math.max(1, num(flags.budget, 10));
	const subPrice = Math.max(0.01, num(flags['sub-price'] ?? flags.subPrice, 4.99));

	const scoredFile = join(cfg.paths.aso, locale, 'scored.json');
	if (!existsSync(scoredFile))
		throw new ShipError(`no scored keywords for ${locale}: ${scoredFile}`, {
			hint: `run \`ship aso score --locale ${locale}\` first — the plan is built from opportunity scores, not guesses`,
		});
	const doc = JSON.parse(await readFile(scoredFile, 'utf8'));
	const all = Array.isArray(doc?.scored) ? doc.scored : [];
	if (!all.length) throw new ShipError(`${scoredFile} contains no scored keywords`);

	const picked = [...all].sort((a, b) => num(b.opportunity) - num(a.opportunity)).slice(0, top);
	const perKeyword = Math.round((budget / picked.length) * 100) / 100;
	const bid = startingBid(perKeyword);
	const market = (marketFor(locale)?.country ?? 'US').toUpperCase();

	const campaignName = `${cfg.name} · Exact · ${market}`;
	const adGroups = picked.map((k) => ({
		name: `EX · ${k.keyword}`,
		keyword: k.keyword,
		matchType: 'EXACT',
		defaultBidAmount: bid,
		dailyBudget: perKeyword,
		// Carried through so a human can sanity-check the bid against who they are
		// actually bidding against, without re-opening the aso report.
		opportunity: num(k.opportunity),
		medianRatings: k.medianRatings ?? null,
		weakAppsTop10: k.weakAppsTop10 ?? null,
		exactTitleMatches: k.exactTitleMatches ?? null,
		incumbents: (k.top3 ?? []).slice(0, 3).map((a) => ({
			name: a.name,
			id: a.id ?? null,
			ratings: a.ratings ?? null,
		})),
	}));

	const killRule = {
		window: '7 days',
		condition: 'spend > monthlyRevenuePerSubscriber AND conversions === 0',
		monthlyRevenuePerSubscriber: subPrice,
		thresholdPerKeyword: subPrice,
		action: 'pause the keyword',
		rationale:
			`A keyword that burns ${money(subPrice)} — one month of subscription revenue — without a single ` +
			'conversion has already lost money on the best case it will ever have. Pause it; do not "give it more data".',
	};

	const out = {
		generatedAt: new Date().toISOString(),
		source: scoredFile,
		locale,
		market,
		app: { name: cfg.name, bundleId: cfg.bundleId, appId: cfg.asc?.appId ?? null },
		org: cfg.ads?.orgId ?? null,
		currency: 'USD',
		campaign: {
			name: campaignName,
			dailyBudget: budget,
			totalBudget: Math.round(budget * 30 * 100) / 100,
			countriesOrRegions: [market],
			supplySources: ['APPSTORE_SEARCH_RESULTS'],
			billingEvent: 'TAPS',
			adChannelType: 'SEARCH',
		},
		bidding: {
			startingBid: bid,
			derivation: 'perKeywordDailyBudget / 5 taps, clamped to [0.30, 2.00]',
		},
		adGroups,
		killRule,
	};

	await mkdir(cfg.paths.asa, { recursive: true });
	const jsonFile = join(cfg.paths.asa, 'campaign-plan.json');
	const mdFile = join(cfg.paths.asa, 'campaign-plan.md');
	await writeFile(jsonFile, `${JSON.stringify(out, null, '\t')}\n`);
	await writeFile(mdFile, renderPlan(out));

	if (flags.json) return emit(out);

	heading(`Campaign plan · ${campaignName}`);
	info(
		`${picked.length} exact-match ad groups · ${money(budget)}/day total · ${money(perKeyword)}/day each · start bid ${money(bid)}`,
	);
	table(adGroups, [
		{ header: 'keyword', get: (g) => g.keyword },
		{ header: 'opp', get: (g) => g.opportunity.toFixed(1) },
		{ header: 'daily', get: (g) => money(g.dailyBudget) },
		{ header: 'bid', get: (g) => money(g.defaultBidAmount) },
		{ header: 'top incumbents', get: (g) => g.incumbents.map((a) => a.name).join(' / ') || '—' },
	]);
	process.stdout.write('\n');
	info(`kill rule: ${killRule.condition} → ${killRule.action} (${money(subPrice)}/keyword/7d)`);
	good(`wrote ${jsonFile}`);
	good(`wrote ${mdFile}`);
	note('review it, then `ship ads sync` once credentials exist');
	return 0;
}

function renderPlan(p) {
	const L = [];
	L.push(`# Apple Search Ads plan — ${p.app.name}`, '');
	L.push(`Generated ${p.generatedAt} from \`${p.source}\`.`, '');
	L.push(`- **Campaign**: ${p.campaign.name}`);
	L.push(`- **Market**: ${p.market} (locale ${p.locale})`);
	L.push(`- **Daily budget**: ${money(p.campaign.dailyBudget)} across ${p.adGroups.length} ad groups`);
	L.push(`- **Starting bid**: ${money(p.bidding.startingBid)} — ${p.bidding.derivation}`);
	L.push(`- **Structure**: one exact-match ad group per keyword, so every keyword has its own budget and its own verdict.`);
	L.push('');
	L.push('## Kill rule', '');
	L.push(`\`${p.killRule.condition}\` over ${p.killRule.window} → **${p.killRule.action}**.`, '');
	L.push(p.killRule.rationale, '');
	L.push(
		`Concretely: after 7 days, pause any keyword that has spent more than ${money(p.killRule.thresholdPerKeyword)} with zero conversions.`,
		'',
	);
	L.push('## Ad groups', '');
	L.push('| keyword | opportunity | daily | bid | median ratings | weak apps (top 10) | exact title matches | incumbents |');
	L.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
	for (const g of p.adGroups) {
		const inc = g.incumbents
			.map((a) => `${a.name}${a.ratings == null ? '' : ` (${a.ratings})`}`)
			.join('<br>');
		L.push(
			`| ${g.keyword} | ${g.opportunity.toFixed(1)} | ${money(g.dailyBudget)} | ${money(g.defaultBidAmount)} | ${g.medianRatings ?? '—'} | ${g.weakAppsTop10 ?? '—'} | ${g.exactTitleMatches ?? '—'} | ${inc || '—'} |`,
		);
	}
	L.push('');
	L.push('Sanity-check each bid against the incumbents: a keyword whose top 3 are 50k-rating');
	L.push('apps will not convert at any bid you can afford, however high its opportunity score.');
	L.push('');
	L.push(`Push with \`ship ads sync\` (dry-run first: \`ship ads sync --dry-run\`).`);
	L.push('');
	return L.join('\n');
}

// ─── sync ────────────────────────────────────────────────────────────────────

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

async function sync({ flags }) {
	const cfg = await loadConfig();
	const planFile = join(cfg.paths.asa, 'campaign-plan.json');
	if (!existsSync(planFile))
		throw new ShipError(`no campaign plan at ${planFile}`, {
			hint: 'run `ship ads plan` first — sync never invents a structure, it only pushes a reviewed one',
		});
	const p = JSON.parse(await readFile(planFile, 'utf8'));

	await gate();
	const org = requireOrg(cfg, { org: flags.org ?? p.org });
	const adamId = num(cfg.asc?.appId ?? p.app?.appId, 0);
	if (!adamId)
		throw new ShipError('sync needs the numeric App Store app id (adamId)', {
			hint: 'set asc.appId in ship.config.json — `asc apps list --bundle-id ' + (cfg.bundleId ?? '<bundle>') + ' --output json` has it',
		});

	const currency = p.currency ?? 'USD';
	const amount = (n) => ({ amount: Number(n).toFixed(2), currency });

	// Match by name, always. Apple happily creates a second campaign with an
	// identical name and then splits your budget across both of them.
	step(`campaign "${p.campaign.name}"`);
	const existing = rows(
		await asc(['ads', 'campaigns', 'list', '--org', org, '--paginate'], { fallback: null }),
	);
	let campaign = existing.find((r) => r.name === p.campaign.name) ?? null;

	const campaignBody = {
		name: p.campaign.name,
		adamId,
		countriesOrRegions: p.campaign.countriesOrRegions,
		budgetAmount: amount(p.campaign.totalBudget),
		dailyBudgetAmount: amount(p.campaign.dailyBudget),
		supplySources: p.campaign.supplySources,
		billingEvent: p.campaign.billingEvent,
		adChannelType: p.campaign.adChannelType,
		status: 'ENABLED',
	};

	if (campaign) {
		note(`exists → ${campaign.id}, updating budget`);
		await withPayload('campaign.json', { campaign: campaignBody, clearGeoTargetingOnCountryOrRegionChange: false }, (file) =>
			ascMutate(['ads', 'campaigns', 'update', '--campaign', String(campaign.id), '--org', org], { file }),
		);
	} else {
		const created = await withPayload('campaign.json', campaignBody, (file) =>
			ascMutate(['ads', 'campaigns', 'create', '--org', org], { file }),
		);
		campaign = one(created);
		if (!campaign?.id) {
			if (isDryRun()) {
				note(`dry-run: ${p.adGroups.length} ad groups + keywords would follow campaign creation`);
				return 0;
			}
			throw new ShipError('campaign create returned no id', {
				hint: 'asc ads campaigns create emitted an unexpected payload — re-run with --verbose',
			});
		}
		good(`created campaign ${campaign.id}`);
	}

	const campaignId = String(campaign.id);
	const groups = rows(
		await asc(['ads', 'ad-groups', 'list', '--campaign', campaignId, '--org', org, '--paginate'], {
			fallback: null,
		}),
	);
	// Apple rejects a startTime in the past on create; "now" is the only safe value.
	const startTime = new Date().toISOString().replace(/\.\d+Z$/, '.000Z');

	let created = 0;
	let updated = 0;
	for (const g of p.adGroups) {
		const body = {
			name: g.name,
			startTime,
			defaultBidAmount: amount(g.defaultBidAmount),
			pricingModel: 'CPC',
			automatedKeywordsOptIn: false,
			status: 'ENABLED',
		};
		let group = groups.find((r) => r.name === g.name) ?? null;
		if (group) {
			await withPayload('ad-group.json', body, (file) =>
				ascMutate(
					['ads', 'ad-groups', 'update', '--campaign', campaignId, '--ad-group', String(group.id), '--org', org],
					{ file },
				),
			);
			updated++;
		} else {
			const res = await withPayload('ad-group.json', body, (file) =>
				ascMutate(['ads', 'ad-groups', 'create', '--campaign', campaignId, '--org', org], { file }),
			);
			group = one(res);
			created++;
			if (!group?.id) {
				if (isDryRun()) continue;
				throw new ShipError(`ad group create returned no id for "${g.name}"`);
			}
		}

		const adGroupId = String(group.id);
		const have = rows(
			await asc(
				[
					'ads',
					'targeting-keywords',
					'list',
					'--campaign',
					campaignId,
					'--ad-group',
					adGroupId,
					'--org',
					org,
					'--paginate',
				],
				{ fallback: [] },
			),
		);
		const match = have.find((k) => k.text === g.keyword && k.matchType === g.matchType);
		const kwArgs = [
			'ads',
			'targeting-keywords',
			match ? 'update-bulk' : 'create-bulk',
			'--campaign',
			campaignId,
			'--ad-group',
			adGroupId,
			'--org',
			org,
		];
		const kwBody = match
			? [{ id: match.id, bidAmount: amount(g.defaultBidAmount), status: 'ACTIVE' }]
			: [{ text: g.keyword, matchType: g.matchType, bidAmount: amount(g.defaultBidAmount) }];
		await withPayload('keywords.json', kwBody, (file) => ascMutate(kwArgs, { file }));
	}

	process.stdout.write('\n');
	good(
		`${isDryRun() ? 'dry-run: ' : ''}campaign ${campaignId} · ${created} ad group(s) created, ${updated} updated, ${p.adGroups.length} keyword(s) synced`,
	);
	if (!isDryRun()) note(`verify: ship ads campaigns --org ${org}`);
	return 0;
}

const SUB = { status, login, campaigns, keywords, report, plan, sync };
export async function run({ args, flags }) {
	const [sub = 'status', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`ads: unknown subcommand "${sub}"`, {
			hint: `try: ${Object.keys(SUB).join(', ')}`,
		});
	return fn({ args: rest, flags });
}

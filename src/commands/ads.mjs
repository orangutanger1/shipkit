import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.mjs';
import { asc, isDryRun } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { marketFor } from '../lib/appstore.mjs';
import { readPages } from '../lib/cpp.mjs';
import { keywordList, readStaged } from '../lib/locales.mjs';
import { indexedWords, isCovered } from '../lib/text.mjs';
import { BID, describeAction, lastModified, reconcile } from '../lib/asa.mjs';
import { DASH, money, num, pct, round2 } from '../lib/fmt.mjs';
import { DAY_MS, isoDay } from '../lib/dates.mjs';
import { emit } from '../lib/output.mjs';
import { resolveSubcommand } from '../lib/util.mjs';
import { gate, login as adsLogin, orgOf, requireOrg, status as adsStatus } from '../lib/ads-auth.mjs';
import {
	LEVELS, ensureAdGroup, ensureKeywords, ensureNegatives, listAdGroups, listCampaigns,
	listKeywords, pullReport, readAccount, withPayload,
} from '../lib/ads-client.mjs';
import {
	applyPlan, monetisationSignal, printReconciliation, printSyncSummary, realisedCpt, reportMonetisation,
} from '../lib/ads-apply.mjs';
import { scoredTerms, writeArtifact, writePaidTerms } from '../lib/ads-artifacts.mjs';
import { printMining, printReport, printSnapshot } from '../lib/ads-print.mjs';
import {
	buildPlan, convertingTerms, decide, parseSplit, planBindings, printPlan, renderOnly, renderPlan, searchTermRows,
} from '../lib/ads-plan.mjs';
export { SPLIT, allocate, buildPlan, convertingTerms, decide, parseSplit, planBindings, planTotals, renderPlan, searchTermRows } from '../lib/ads-plan.mjs';
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
  ${c.cyan('--render')}            ${c.dim('plan')} re-render campaign-plan.md from campaign-plan.json ${c.dim('(no replan, no credentials)')}
  ${c.cyan('--prune')}             ${c.dim('sync')} allow pausing live objects the plan does not contain
  ${c.cyan('--force')}             ${c.dim('sync')} overwrite values changed outside ship ${c.dim('(the plan wins)')} · ${c.dim('plan')} replan over a plan bound to a live account
  ${c.cyan('--adopt')}             ${c.dim('sync')} record live values into the plan instead ${c.dim('(the account wins)')}
  ${c.cyan('--no-ltv-check')}      ${c.dim('plan, sync')} skip the RevenueCat monetisation check
  ${c.cyan('--json')}              machine-readable output
${c.dim('Credentials are separate from ASC: app-ads.apple.com → Account Settings → API.')}
${c.dim('`ship ads plan` needs no Apple Ads credentials at all.')}
${c.dim('Nothing is paused, and no manual change is reverted, without a flag that says so.')}
${c.dim('`ship ads plan` will not overwrite a plan carrying Apple object ids: --render the doc, or --force the replan.')}
`;
const status = adsStatus; // credential UX lives with the auth module that serves it
const login = adsLogin;

async function campaigns({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	await gate(cfg);
	const org = requireOrg(cfg, flags);
	const list = await listCampaigns(org);
	if (flags.json) return emit(list);
	heading(`Campaigns (${list.length}) · org ${org}`);
	table(list, [
		{ header: 'id', get: (r) => r.id ?? '' }, { header: 'name', get: (r) => r.name ?? '' },
		{ header: 'status', get: (r) => r.status ?? r.servingStatus ?? '' },
		{
			header: 'dailyBudget',
			get: (r) => (r.dailyBudgetAmount ? `${r.dailyBudgetAmount.amount} ${r.dailyBudgetAmount.currency ?? ''}`.trim() : ''),
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
	const list = await listKeywords(org, String(campaign), String(adGroup));
	if (flags.json) return emit(list);
	heading(`Targeting keywords (${list.length}) · ad group ${adGroup}`);
	table(list, [
		{ header: 'text', get: (r) => r.text ?? '' }, { header: 'matchType', get: (r) => r.matchType ?? '' },
		{ header: 'bid', get: (r) => (r.bidAmount ? `${r.bidAmount.amount} ${r.bidAmount.currency ?? ''}`.trim() : '') },
		{ header: 'status', get: (r) => r.status ?? '' },
	]);
	return 0;
}

function reportWindow(flags, days) {
	const to = flags.to ? String(flags.to) : isoDay(Date.now());
	const from = flags.from ? String(flags.from) : isoDay(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS);
	return { from, to };
}

async function report({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	await gate(cfg);
	const org = requireOrg(cfg, flags);
	const level = String(flags.level ?? 'campaign').toLowerCase();
	if (!LEVELS[level]) throw new ShipError(`--level "${level}" is not a report level`, { hint: `one of: ${Object.keys(LEVELS).join(', ')}` });
	const { from, to } = reportWindow(flags, 7);
	const metrics = (
		await pullReport(org, level, { from, to, campaign: flags.campaign ?? null, adGroup: flags['ad-group'] ?? flags.adGroup ?? null })
	).sort((a, b) => b.spend - a.spend);
	const money$ = cfg ? await monetisationSignal(cfg) : { available: false, reason: 'no ship.config.json' };
	return printReport({ flags, level, from, to, org, metrics, money$ });
}

async function readJSONFile(file) {
	return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
}

/** Refuse to replan a plan that carries Apple object ids without --force. */
function assertUnbound(onDisk, flags, planFile) {
	const bound = planBindings(onDisk);
	if (bound.bound && !flags.force)
		throw new ShipError(
			`${planFile} is bound to a live account — ${bound.objects} Apple object id(s)${bound.syncedAt ? `, last synced ${bound.syncedAt}` : ''}`,
			{
				hint:
					'a fresh plan is rebuilt from scored.json and would drop hand-set bids, pruned ad groups and any keyword outside the ASO set — ' +
					'`ship ads plan --render` to refresh campaign-plan.md alone, `ship ads sync --dry-run` to see what is live, ' +
					'or `ship ads plan --force` to replan anyway (the previous plan is kept as campaign-plan.prev.json)',
			},
		);
	return bound;
}

/** Everything buildPlan needs, read and guarded. */
async function planInputs(cfg, flags, locale) {
	const scoredFile = join(cfg.paths.aso, locale, 'scored.json');
	if (!existsSync(scoredFile))
		throw new ShipError(`no scored keywords for ${locale}: ${scoredFile}`, {
			hint: `run \`ship aso score --locale ${locale}\` first — the plan is built from opportunity scores, not guesses`,
		});
	const terms = scoredTerms(JSON.parse(await readFile(scoredFile, 'utf8')));
	if (!terms.length) throw new ShipError(`${scoredFile} contains no scored keywords`);
	const rivalFile = join(cfg.paths.aso, locale, 'competitors.json');
	const competitors = existsSync(rivalFile) ? (JSON.parse(await readFile(rivalFile, 'utf8')).apps ?? []) : [];
	const subPrice = flags['sub-price'] ?? flags.subPrice ?? cfg.ads?.subPrice ?? null;
	const org = cfg.ads?.orgId ?? null;
	const measured = flags.bid ? { cpt: null, reason: '--bid overrides it' } : await realisedCpt(cfg, org);
	const money$ = flags['no-ltv-check'] ? { available: false, reason: '--no-ltv-check' } : await monetisationSignal(cfg, { subPrice });
	return { terms, competitors, subPrice, org, measured, money$, scoredFile };
}

/** Map CLI flags + config onto buildPlan's inputs. */
function planOptions(cfg, flags, { locale, terms, competitors, subPrice, org, measured, money$, scoredFile }) {
	return {
		app: { name: cfg.name, bundleId: cfg.bundleId, appId: cfg.asc?.appId ?? null },
		locale, market: (marketFor(locale)?.country ?? 'US').toUpperCase(), terms, competitors,
		budget: Math.max(1, num(flags.budget, 10)), split: parseSplit(flags.split), top: Math.max(1, num(flags.top, 15)),
		subPrice: subPrice === null ? null : Math.max(0.01, num(subPrice)),
		targetCpi: flags['target-cpi'] ?? flags.targetCpi ?? cfg.ads?.targetCpi ?? null,
		retentionMonths: cfg.ads?.retentionMonths, baselineInstallRate: cfg.ads?.baselineInstallRate,
		minTaps: flags['min-taps'] ?? cfg.ads?.minTaps ?? null,
		bid: flags.bid ?? null, minBid: flags['min-bid'] ?? null, maxBid: flags['max-bid'] ?? null,
		observedCpt: measured.cpt, seedBid: cfg.ads?.seedBid ?? null, monetisation: money$,
		minVolume: num(cfg.aso?.minVolume), org, source: scoredFile,
	};
}

/** Back up a bound plan before overwriting it, so --force is never lossy. */
async function backupBoundPlan(cfg, onDisk, bound) {
	if (!onDisk || !bound.bound) return null;
	const backup = join(cfg.paths.asa, 'campaign-plan.prev.json');
	await writeFile(backup, `${JSON.stringify(onDisk, null, '\t')}\n`);
	return backup;
}

async function plan({ flags }) {
	const cfg = await loadConfig();
	for (const w of cfg.warnings ?? []) warn(w);
	const planFile = join(cfg.paths.asa, 'campaign-plan.json');
	const mdFile = join(cfg.paths.asa, 'campaign-plan.md');
	const onDisk = await readJSONFile(planFile);
	if (flags.render) return renderOnly({ cfg, flags, planFile, mdFile, onDisk });
	const bound = assertUnbound(onDisk, flags, planFile);

	const locale = String(flags.locale ?? cfg.asc?.primaryLocale ?? 'en-US');
	const inputs = await planInputs(cfg, flags, locale);
	const out = await buildPlan({
		...planOptions(cfg, flags, { ...inputs, locale }),
		pages: await readPages(cfg),
	});
	const backup = await backupBoundPlan(cfg, onDisk, bound);
	const jsonFile = await writeArtifact(cfg, 'campaign-plan.json', out);
	await writeFile(mdFile, renderPlan(out));
	if (flags.json) return emit({ ...out, replacedBoundPlan: backup ? { backup, objects: bound.objects } : null });
	printPlan(out, { name: cfg.name, jsonFile, mdFile, backup, bound, measured: inputs.measured, money$: inputs.money$, competitors: inputs.competitors, locale, bid: flags.bid });
	reportMonetisation(inputs.money$, { budget: out.budget.daily });
	return 0;
}

async function snapshot({ flags }) {
	const cfg = await loadConfig();
	await gate(cfg);
	const org = requireOrg(cfg, flags);
	const { from, to } = reportWindow(flags, 30);
	const account = await readAccount(org, { performance: flags.performance !== false, from, to });
	const doc = {
		generatedAt: new Date().toISOString(), org: String(org), window: { from, to },
		params: { org: String(org), window: { from, to }, performance: flags.performance !== false },
		lastModified: lastModified(account) ? new Date(lastModified(account)).toISOString() : null,
		campaigns: account.campaigns,
	};
	const file = await writeArtifact(cfg, 'snapshot.json', doc);
	await writeArtifact(cfg, `snapshot-${isoDay(Date.now())}.json`, doc);
	if (flags.json) return emit({ ...doc, file });
	printSnapshot(account, { org, from, to, file });
	return 0;
}

async function loadSyncPlan(cfg) {
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
	return { planFile, p, planned };
}

/** Org, adamId, and the --force/--adopt contract. */
function syncTargets(cfg, p, flags) {
	const org = requireOrg(cfg, { org: flags.org ?? p.org });
	const adamId = num(cfg.asc?.appId ?? p.app?.appId, 0);
	if (!adamId)
		throw new ShipError('sync needs the numeric App Store app id (adamId)', {
			hint: 'set asc.appId in ship.config.json — `asc apps list --bundle-id ' + (cfg.bundleId ?? '<bundle>') + ' --output json` has it',
		});
	const force = Boolean(flags.force), adopt = Boolean(flags.adopt);
	if (force && adopt) throw new ShipError('--force and --adopt contradict each other', { hint: '--force: the plan wins. --adopt: the account wins.' });
	return { org, adamId, force, adopt, currency: p.currency ?? 'USD' };
}

/** A plan older than the account means somebody edited Apple Ads by hand. */
function assertFresh({ p, planFile, liveAt, force, adopt }) {
	const planAt = Date.parse(p.generatedAt ?? '');
	if (!(liveAt && planAt && liveAt > planAt) || force || adopt) return;
	throw new ShipError(
		`the account was modified after this plan was written (live ${new Date(liveAt).toISOString()} > plan ${new Date(planAt).toISOString()})`,
		{
			hint: 'somebody changed Apple Ads by hand since `ship ads plan` ran. `ship ads snapshot` to see what, then re-run `ship ads plan`, or `--adopt` to take the live values, or `--force` to overwrite them',
		},
	);
}

async function sync({ flags }) {
	const cfg = await loadConfig();
	for (const w of cfg.warnings ?? []) warn(w);
	const { planFile, p, planned } = await loadSyncPlan(cfg);
	await gate(cfg);
	const { org, adamId, force, adopt, currency } = syncTargets(cfg, p, flags);
	const account = await readAccount(org, { performance: false });
	assertFresh({ p, planFile, liveAt: lastModified(account), force, adopt });

	const plan$ = reconcile({ planned, live: account.campaigns, force, adopt, prune: Boolean(flags.prune) });
	heading(`Reconcile · ${cfg.name} · org ${org}${isDryRun() ? c.dim(' · dry run') : ''}`);
	printReconciliation(plan$, { verbose: Boolean(flags.verbose) });
	for (const u of plan$.unmanaged) note(`unmanaged campaign left alone: ${u.name} (${u.id}, ${u.status ?? '—'})`);
	for (const a of plan$.preserved) info(`keeping the manual value on ${a.path}: ${describeAction(a)}`);
	const money$ = flags['no-ltv-check'] ? { available: false, reason: '--no-ltv-check' } : await monetisationSignal(cfg, { subPrice: cfg.ads?.subPrice });
	process.stdout.write('\n');
	reportMonetisation(money$, { budget: p.budget?.daily ?? null });

	const blocked = syncBlockers(plan$);
	if (blocked) throw blocked;
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
	const tally = await applyPlan({ org, adamId, currency, planned, account, plan$ });
	p.syncedAt = new Date().toISOString();
	p.syncedOrg = String(org);
	await writeArtifact(cfg, 'campaign-plan.json', p);
	printSyncSummary(tally, { org, planFile });
	return 0;
}

/** Conflicts and unplanned objects abort the run before any mutation. */
function syncBlockers(plan$) {
	if (plan$.conflicts.length)
		return new ShipError(`${plan$.conflicts.length} object(s) were changed outside ship and would be overwritten`, {
			hint:
				`${plan$.conflicts.map((a) => `${a.path}: ${describeAction(a)}`).join('\n')}\n` +
				'--force to let the plan win, --adopt to record the live values into the plan instead',
		});
	if (plan$.unplanned.length)
		return new ShipError(`${plan$.unplanned.length} live object(s) are not in the plan`, {
			hint:
				`${plan$.unplanned.map((a) => `${a.path} (${a.id})`).join('\n')}\n` +
				'these are delivering right now. --prune to pause them, or re-run `ship ads plan` so the plan contains them. Nothing was changed.',
		});
	return null;
}

async function organicGap(cfg, locale, converting) {
	const listing = (await readStaged(cfg)).find((l) => (l.data?.locale ?? l.locale) === locale) ?? null;
	if (!listing) return { staged: false, missing: converting.map((t) => t.term) };
	const d = listing.data ?? {};
	const indexed = indexedWords(`${d.name ?? ''} ${d.subtitle ?? ''} ${keywordList(d.keywords).join(' ')}`, locale);
	return { staged: true, missing: converting.filter((t) => !isCovered(t.term, indexed, locale)).map((t) => t.term) };
}

async function applyMining({ cfg, org, artifact, flags }) {
	await gate(cfg);
	const resolvedOrg = requireOrg(cfg, { org: org ?? flags.org });
	const live = await listCampaigns(resolvedOrg);
	const plan = await readJSONFile(join(cfg.paths.asa, 'campaign-plan.json'));
	const currency = plan?.currency ?? 'USD';
	const forRole = (role) => {
		const named = plan?.campaigns?.find((cp) => cp.role === role)?.name;
		return ((named ? live.find((r) => r.name === named) : null) ?? live.find((r) => String(r.name ?? '').toLowerCase().includes(role))) ?? null;
	};
	const negatives = await applyNegatives({ org: resolvedOrg, artifact, discovery: forRole('discovery') });
	const { promoted, skipped } = await applyPromotions({ org: resolvedOrg, artifact, exact: forRole('exact'), currency });
	if (negatives.unplaced.length)
		warn(`no campaign to negate ${negatives.unplaced.join(', ')} in — pass --campaign <id>, or run \`ship ads plan && ship ads sync\` so a Discovery campaign exists`);
	if (skipped.length)
		warn(`no Exact campaign in org ${resolvedOrg} — ${skipped.length} promotion(s) not pushed: ${skipped.join(', ')}`);
	return { at: new Date().toISOString(), org: resolvedOrg, dryRun: isDryRun(), negativesAdded: negatives.added, promoted, skipped, unplaced: negatives.unplaced };
}

async function applyNegatives({ org, artifact, discovery }) {
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
	let added = 0;
	for (const [campaignId, wanted] of grouped) {
		step(`negatives → campaign ${campaignId} (${wanted.length})`);
		added += await ensureNegatives(org, campaignId, wanted);
	}
	return { added, unplaced };
}

async function applyPromotions({ org, artifact, exact, currency }) {
	const skipped = [];
	let promoted = 0;
	if (artifact.promotions.length && !exact?.id) skipped.push(...artifact.promotions.map((p) => p.term));
	else if (artifact.promotions.length) {
		const campaignId = String(exact.id);
		const groups = await listAdGroups(org, campaignId);
		for (const p of artifact.promotions) {
			const name = `EX · ${p.term}`;
			step(`promote "${p.term}" → ${name} @ ${money(p.bid)}`);
			const { group } = await ensureAdGroup(
				org, campaignId, groups, { name, defaultBidAmount: p.bid, automatedKeywordsOptIn: false }, currency,
			);
			if (!group?.id) {
				if (isDryRun()) continue;
				throw new ShipError(`ad group create returned no id for "${name}"`);
			}
			await ensureKeywords(org, campaignId, String(group.id), [{ text: p.term, matchType: 'EXACT', bid: p.bid }], currency);
			promoted++;
		}
	}
	return { promoted, skipped };
}

/** Search-term rows from --file, or pulled per campaign for the org. */
async function collectTermRows({ cfg, flags, org, from, to }) {
	if (flags.file) {
		const reportFile = resolve(String(flags.file));
		if (!existsSync(reportFile)) throw new ShipError(`no such search-term report: ${reportFile}`);
		return { rows: searchTermRows(JSON.parse(await readFile(reportFile, 'utf8'))), org: orgOf(cfg, flags), source: reportFile };
	}
	await gate(cfg);
	const resolvedOrg = requireOrg(cfg, flags);
	const ids = flags.campaign
		? [String(flags.campaign)]
		: (await listCampaigns(resolvedOrg)).map((r) => String(r.id)).filter((id) => id && id !== 'undefined');
	if (!ids.length)
		throw new ShipError(`org ${resolvedOrg} has no campaigns to mine`, {
			hint: 'run `ship ads plan`, then `ship ads sync`, then let it spend for a month',
		});
	const payload = {
		startTime: from, endTime: to,
		selector: { orderBy: [{ field: 'localSpend', sortOrder: 'DESCENDING' }], pagination: { offset: 0, limit: 1000 } },
		timeZone: 'UTC', returnRecordsWithNoMetrics: false, returnRowTotals: true, returnGrandTotals: false,
	};
	const rows = [];
	for (const id of ids) {
		const res = await withPayload('search-terms.json', payload, (file) =>
			asc(['ads', 'reports', 'search-terms', '--campaign', id, '--org', resolvedOrg, '--file', file], { fallback: null }));
		rows.push(...searchTermRows(res));
	}
	return { rows, org: resolvedOrg, source: `asc ads reports search-terms (${from} → ${to})` };
}

function killOptions(cfg, flags) {
	return {
		targetCpi: flags['target-cpi'] ?? flags.targetCpi ?? cfg.ads?.targetCpi ?? null,
		subPrice: cfg.ads?.subPrice ?? null,
		retentionMonths: cfg.ads?.retentionMonths,
		baselineInstallRate: cfg.ads?.baselineInstallRate,
		minTaps: flags['min-taps'] ?? cfg.ads?.minTaps ?? null,
		source: flags['target-cpi'] ?? flags.targetCpi ? '--target-cpi' : `ads.targetCpi (${cfg.file})`,
	};
}

async function mine({ flags }) {
	const cfg = await loadConfig();
	for (const w of cfg.warnings ?? []) warn(w);
	const locale = String(flags.locale ?? cfg.asc?.primaryLocale ?? 'en-US');
	const { from, to } = reportWindow(flags, 30);
	const { rows: raw, org, source } = await collectTermRows({ cfg, flags, org: orgOf(cfg, flags), from, to });

	const decided = decide(raw, killOptions(cfg, flags));
	const converting = convertingTerms(raw);
	const gap = await organicGap(cfg, locale, converting);
	const artifact = {
		generatedAt: new Date().toISOString(), locale, org: org ?? null,
		source,
		window: { from, to },
		params: { window: { from, to }, locale, killRule: decided.killRule, campaign: flags.campaign ?? null },
		killRule: decided.killRule, targetCpi: decided.targetCpi, wasteThreshold: decided.wasteThreshold, minTaps: decided.minTaps,
		rows: raw.length, negatives: decided.negatives, held: decided.held, promotions: decided.promotions,
		converting, asoGap: gap.missing, applied: null,
	};
	const outFile = await writeArtifact(cfg, `mining-${isoDay(Date.now())}.json`, artifact);
	const paid = await writePaidTerms(cfg, locale, converting);
	const wantsApply = Boolean(flags.apply);
	const confirmed = Boolean(flags.confirm) || isDryRun();
	if (wantsApply && confirmed) {
		artifact.applied = await applyMining({ cfg, org, artifact, flags });
		await writeArtifact(cfg, `mining-${isoDay(Date.now())}.json`, artifact);
	}
	if (flags.json) return emit({ ...artifact, file: outFile, paidTermsFile: paid.file, confirmed: wantsApply && confirmed });
	printMining({ decided, artifact, converting, gap, outFile, paid, locale, from, to, wantsApply, confirmed });
	if (!wantsApply) return 0;
	if (!confirmed) return 1;
	return 0;
}

const SUB = { status, login, campaigns, keywords, report, plan, snapshot, sync, mine };

export async function run({ args, flags }) {
	const { fn, args: rest } = resolveSubcommand({ command: 'ads', args, subs: SUB, fallback: 'status' });
	return fn({ args: rest, flags });
}

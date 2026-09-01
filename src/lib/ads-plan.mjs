import { writeFile } from 'node:fs/promises';
import { ShipError, good, heading, info, note, step, table, warn } from '../log.mjs';
import { DASH, money, num, round2 } from './fmt.mjs';
import { metric, rowsOf } from './asc-report.mjs';
import { BID, assertBidSpread, bidFor, resolveBidding, resolveKillRule } from './asa.mjs';
import { pageForAdGroup } from './cpp.mjs';
import { brandTokens, tokenSupport, words } from './text.mjs';
import { emit } from './output.mjs';
export const SPLIT = { exact: 0.5, discovery: 0.25, competitor: 0.15, brand: 0.1 };
const ROLES = Object.keys(SPLIT);
export function parseSplit(value) {
	if (value === undefined || value === null || value === '' || value === true) return { ...SPLIT };
	const parts = String(value).split(/[/,;:|\s]+/).filter(Boolean);
	const out = {};
	if (parts.every((p) => /^\d+(?:\.\d+)?$/.test(p))) {
		if (parts.length > ROLES.length)
			throw new ShipError(`--split takes at most ${ROLES.length} numbers`, { hint: `order is ${ROLES.join('/')}` });
		parts.forEach((p, i) => { out[ROLES[i]] = Number(p); });
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
export function allocate(total, weights) {
	const keys = Object.keys(weights).filter((k) => num(weights[k]) > 0);
	const sum = keys.reduce((s, k) => s + num(weights[k]), 0);
	const cents = Math.max(0, Math.round(num(total) * 100));
	if (!keys.length || !sum) return {};
	const biggest = keys.reduce((a, b) => (num(weights[b]) > num(weights[a]) ? b : a));
	const out = {}; let used = 0;
	for (const k of keys) {
		if (k === biggest) continue;
		const share = Math.min(cents - used, Math.round((cents * num(weights[k])) / sum));
		out[k] = share / 100;
		used += share;
	}
	out[biggest] = Math.max(0, cents - used) / 100;
	return out;
}
const keywordText = (name) =>
	String(name ?? '').split(/[:|(\-–—]/)[0].replace(/\s+/g, ' ').trim().toLocaleLowerCase();
const campaignShell = (name, dailyBudget, market) => ({
	name,
	dailyBudget: round2(dailyBudget),
	totalBudget: round2(num(dailyBudget) * 30),
	countriesOrRegions: [market], supplySources: ['APPSTORE_SEARCH_RESULTS'],
	billingEvent: 'TAPS', adChannelType: 'SEARCH',
});
const ROLES_SPEC = {
	exact: {
		when: (c) => c.daily.exact > 0,
		shell: (c) => [`${c.app.name} · Exact · ${c.market}`, c.daily.exact],
		adGroups: (c) =>
			c.category.map((t) => {
				const amount = c.priced(t.demand);
				return {
					name: `EX · ${t.term}`, defaultBidAmount: amount, automatedKeywordsOptIn: false,
					keywords: [{ text: t.term, matchType: 'EXACT', bid: amount }],
					demand: num(t.demand, 100), competition: num(t.competition), opportunity: num(t.opportunity),
					medianRatings: t.medianRatings ?? null, weakAppsTop10: t.weakAppsTop10 ?? null, exactTitleMatches: t.exactTitleMatches ?? null,
					incumbents: (t.top3 ?? []).slice(0, 3).map((a) => ({ name: a.name, id: a.id ?? null, ratings: a.ratings ?? null })),
				};
			}),
		negatives: () => [],
		rationale:
			'One ad group per keyword, for creative control: an ad group is the smallest object that can carry its own Custom Product Page and its own bid. Budget is set on the campaign — Apple has no ad-group budget.',
	},
	discovery: {
		when: (c) => c.daily.discovery > 0,
		shell: (c) => [`${c.app.name} · Discovery · ${c.market}`, c.daily.discovery],
		adGroups: (c) => {
			const amount = c.priced(c.midDemand);
			return [{
				name: `DISC · ${c.market}`, defaultBidAmount: amount, automatedKeywordsOptIn: true,
				keywords: c.exactTerms.map((text) => ({ text, matchType: 'BROAD', bid: amount })),
				demand: c.midDemand,
			}];
		},
		negatives: (c) => {
			const negativeKeywords = c.exactTerms.map((text) => ({ text, matchType: 'EXACT' }));
			if (c.brand && !c.exactTerms.includes(c.brand)) negativeKeywords.push({ text: c.brand, matchType: 'EXACT' });
			return negativeKeywords;
		},
		rationale:
			'Broad match plus Search Match, with every Exact term negated so the two cannot cannibalise each other.',
	},
	competitor: {
		when: (c) => c.daily.competitor > 0 && c.rivals.length > 0,
		shell: (c) => [`${c.app.name} · Competitor · ${c.market}`, c.daily.competitor],
		adGroups: (c) =>
			c.rivals.map((r) => {
				const amount = c.priced(c.midDemand);
				return {
					name: `COMP · ${r.text}`, defaultBidAmount: amount, automatedKeywordsOptIn: false,
					keywords: [{ text: r.text, matchType: 'EXACT', bid: amount }],
					demand: c.midDemand,
					incumbents: [{ name: r.name, id: r.id, ratings: r.ratings }],
				};
			}),
		negatives: (c) => (c.brand ? [{ text: c.brand, matchType: 'EXACT' }] : []),
		rationale:
			'Exact match on the apps you are compared to; your own name is negated here so Brand keeps that traffic at its own price.',
	},
	brand: {
		when: (c) => c.daily.brand > 0 && Boolean(c.brand),
		shell: (c) => [`${c.app.name} · Brand · ${c.market}`, c.daily.brand],
		adGroups: (c) => {
			const amount = c.priced(100);
			return [{
				name: `BRAND · ${c.brand}`, defaultBidAmount: amount, automatedKeywordsOptIn: false,
				keywords: [
					{ text: c.brand, matchType: 'EXACT', bid: amount }, { text: c.brand, matchType: 'BROAD', bid: amount },
				],
				demand: 100,
			}];
		},
		negatives: () => [],
		rationale: 'Your own name is the cheapest tap you will ever buy, and the one a competitor buys if you do not.',
	},
};
const collectRivals = ({ brand, competitors, picked, branded }) => {
	const rivals = [], seen = new Set(brand ? [brand] : []);
	for (const rival of [...competitors, ...picked.filter((t) => branded(t.term)).map((t) => ({ name: t.term }))]) {
		const text = keywordText(rival?.name);
		if (!text || seen.has(text)) continue;
		seen.add(text);
		rivals.push({ text, name: rival.name ?? text, id: rival.id ?? null, ratings: rival.ratings ?? null });
	}
	return rivals;
};
const attachProductPages = (campaigns, pages) => {
	for (const cp of campaigns)
		for (const g of cp.adGroups) {
			const entry = pageForAdGroup(pages, g.name);
			if (entry) g.productPage = { slug: entry.slug, name: entry.page?.name ?? entry.slug };
		}
};
export function buildPlan({
	app, locale = 'en-US', market = 'US', terms = [], competitors = [], pages = [],
	budget = 10, split = SPLIT, top = 15, subPrice = null, targetCpi = null,
	retentionMonths = 1, baselineInstallRate = undefined, minTaps = null, bid = null,
	minBid = null, maxBid = null, observedCpt = null, seedBid = null,
	monetisation: money$ = null, minVolume = 0, org = null, source = null,
	params = null, generatedAt = new Date().toISOString(),
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
	const bidding = resolveBidding({ bid, minBid, maxBid, observedCpt, seedBid });
	const killRule = resolveKillRule({ targetCpi, subPrice, retentionMonths, baselineInstallRate, minTaps });
	const bids = [];
	const priced = (demand) => {
		const b = bidFor(demand, bidding);
		bids.push(b);
		return b.amount;
	};
	const brandWords = brandTokens(terms.flatMap((t) => (t.top3 ?? []).map((a) => ({ name: a.name, seller: a.seller }))), locale);
	const support = tokenSupport(terms.map((t) => t.term), locale);
	const brandFloor = Math.max(3, Math.ceil(Math.max(0, ...support.values()) / 4));
	const branded = (text) => words(text, locale).some((w) => brandWords.has(w) && (support.get(w) ?? 0) < brandFloor);
	const rivals = collectRivals({ brand, competitors, picked, branded });
	const category = picked.filter((t) => !branded(t.term));
	const weights = { ...SPLIT, ...split };
	if (!rivals.length) weights.competitor = 0;
	if (!brand) weights.brand = 0;
	if (!category.length) weights.exact = 0;
	const daily = allocate(budget, weights);
	const exactTerms = [...new Set(category.map((t) => t.term))];
	const demands = category.map((t) => num(t.demand, 100)).sort((a, b) => a - b);
	const midDemand = demands.length ? demands[Math.floor(demands.length / 2)] : 100;
	const ctx = { app, market, daily, category, rivals, brand, exactTerms, midDemand, priced };
	const campaigns = ROLES.map((role) => {
		const spec = ROLES_SPEC[role];
		if (!spec.when(ctx)) return null;
		return {
			role,
			...campaignShell(...spec.shell(ctx)),
			adGroups: spec.adGroups(ctx),
			negativeKeywords: spec.negatives(ctx),
			rationale: spec.rationale,
		};
	}).filter(Boolean);
	assertBidSpread(bids, bidding);
	attachProductPages(campaigns, pages);
	const spread = [...new Set(bids.map((b) => b.amount))].sort((a, b) => a - b);
	return {
		generatedAt, source, locale, market,
		app: { name: app.name, bundleId: app.bundleId ?? null, appId: app.appId ?? null },
		org, currency: 'USD',
		params: params ?? {
			budget: round2(budget), split: weights, top: num(top, 15), minVolume: num(minVolume),
			subPrice: subPrice === null ? null : round2(subPrice), retentionMonths: killRule.retentionMonths,
			bidding, killRule,
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
			minVolume: num(minVolume), considered: terms.length, eligible: eligible.length,
			dropped: terms.length - eligible.length, exactTerms,
		},
		bidding: { ...bidding, distinctBids: spread.length, range: [spread[0] ?? null, spread.at(-1) ?? null] },
		monetisation: money$, campaigns, killRule,
	};
}
export function planBindings(doc) {
	const ids = [];
	let syncedAt = null;
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) return void node.forEach(visit);
		if (node.apple?.id) {
			ids.push(String(node.apple.id));
			const t = node.apple.syncedAt ?? null;
			if (t && (syncedAt === null || String(t) > syncedAt)) syncedAt = String(t);
		}
		for (const v of Object.values(node)) visit(v);
	};
	visit(doc?.campaigns ?? null);
	return { bound: ids.length > 0, objects: ids.length, syncedAt };
}
export function planTotals(p) {
	const campaigns = p?.campaigns ?? [];
	const split = {};
	let daily = 0;
	for (const cp of campaigns) {
		const b = num(cp.dailyBudget);
		daily = Math.round((daily + b) * 100) / 100;
		split[cp.role ?? cp.name] = b;
	}
	const bids = [...new Set(campaigns.flatMap((cp) => (cp.adGroups ?? []).map((g) => num(g.defaultBidAmount))).filter((n) => n > 0))].sort(
		(a, b) => a - b,
	);
	const stamped = { daily: p?.budget?.daily ?? null, distinctBids: p?.bidding?.distinctBids ?? null };
	return {
		daily, split, bids, stamped,
		drifted: stamped.daily !== null && Math.abs(num(stamped.daily) - daily) > 0.005,
	};
}
export function renderPlan(p, { renderedAt = null } = {}) {
	const L = [];
	const bound = planBindings(p);
	const t = planTotals(p);
	L.push(`# Apple Search Ads plan — ${p.app.name}`, '');
	L.push(`Generated ${p.generatedAt}${p.source ? ` from \`${p.source}\`` : ''}.`, '');
	if (renderedAt) L.push(`Re-rendered ${renderedAt} from \`campaign-plan.json\` — \`ship ads plan --render\`.`, '');
	if (bound.bound)
		L.push(
			`This plan is **bound to a live account**: ${bound.objects} Apple object id(s) recorded by ` +
				`\`ship ads sync\`${bound.syncedAt ? `, last at ${bound.syncedAt}` : ''}. Hand-set bids, pruned ad groups and keywords ` +
				'outside the ASO set exist **only** in `campaign-plan.json`, so `ship ads plan` refuses to overwrite it without ' +
				'`--force`. To refresh this document alone, use `ship ads plan --render`.',
			'',
		);
	L.push(`- **Market**: ${p.market} (locale ${p.locale})`);
	L.push(`- **Daily budget**: ${money(t.daily)} across ${p.campaigns.length} campaigns — ${p.budget.scope}`);
	L.push(
		`- **Split**: ${Object.entries(t.split).map(([role, v]) => `${role} ${money(v)}`).join(' · ')}${t.drifted ? '' : ` — ${p.budget.derivation}`}`,
	);
	L.push(
		`- **Bids**: ${t.bids.length === 0 ? '—' : t.bids.length === 1 ? money(t.bids[0]) : `${money(t.bids[0])}–${money(t.bids[t.bids.length - 1])}`}` +
			` — ${t.bids.length} distinct bid(s)${t.drifted ? '' : ` · ${p.bidding.derivation}`}`,
	);
	if (t.drifted)
		L.push(
			`- **Stamped parameters are historical**: this plan was generated for ${money(t.stamped.daily)}/day ` +
				`with bids \`${p.bidding.derivation}\`, and has since been changed by hand or adopted from the account. Every ` +
				'number above and below is read from the campaigns, which is what `ship ads sync` pushes; `params` in ' +
				'`campaign-plan.json` records the run that first created them and is not re-derived.',
		);
	L.push(
		`- **Demand floor**: aso.minVolume ${p.targeting.minVolume}${p.targeting.dropped ? ` — dropped ${p.targeting.dropped} of ${p.targeting.considered} scored terms as not worth bidding on` : ''}`,
	);
	if (p.monetisation)
		L.push(`- **What an install is worth**: ${p.monetisation.available ? p.monetisation.verdict : `unknown — ${p.monetisation.reason}`}`);
	L.push('', '## Kill rule', '', `\`${p.killRule.condition}\` → **pause the keyword**.`, '');
	L.push(p.killRule.derivation, '');
	L.push(
		`Concretely: negate a keyword once it has taken at least ${p.killRule.minTaps} taps and spent more than ` +
			`${money(p.killRule.wasteThreshold)} without an install. Both conditions, not either: at ` +
			`${Math.round(p.killRule.baselineInstallRate * 100)}% tap→install, three taps produce nothing 22% of the time, so a ` +
			'spend threshold alone negates healthy keywords. `ship ads mine` applies exactly this rule from the search-term ' +
			'report and stamps these numbers into every artifact.',
		'',
	);
	for (const cp of p.campaigns) {
		L.push(`## ${cp.name}`, '', cp.rationale, '');
		L.push(
			`${money(cp.dailyBudget)}/day (${money(cp.totalBudget)} over 30 days) · ${cp.countriesOrRegions.join(', ')} · ${cp.adGroups.length} ad group(s)`,
			'',
		);
		L.push('| ad group | keywords | demand | bid | product page | incumbents |', '| --- | --- | ---: | ---: | --- | --- |');
		for (const g of cp.adGroups) {
			const inc = (g.incumbents ?? []).map((a) => `${a.name}${a.ratings == null ? '' : ` (${a.ratings})`}`).join('<br>');
			const kw = g.keywords.map((k) => `${k.text} \`${k.matchType}\` ${money(k.bid)}`).join('<br>');
			L.push(
				`| ${g.name} | ${kw} | ${g.demand ?? '—'} | ${money(g.defaultBidAmount)} | ${g.productPage?.name ?? '—'} | ${inc || '—'} |`,
			);
		}
		if (cp.negativeKeywords.length)
			L.push('', `Negatives: ${cp.negativeKeywords.map((k) => `\`${k.text}\` (${k.matchType})`).join(', ')}`);
		L.push('');
	}
	L.push('Sanity-check each bid against the incumbents: a keyword whose top 3 are 50k-rating');
	L.push('apps will not convert at any bid you can afford, however high its opportunity score.', '');
	L.push('This file is **desired state**. What is live is in `snapshot.json` (`ship ads snapshot`);');
	L.push('`ship ads sync` reconciles the two by Apple object id and prints every transition first.', '');
	L.push('Push with `ship ads sync` (dry-run first: `ship ads sync --dry-run`), then close the loop');
	L.push('with `ship ads mine`, which turns the search-term report back into keywords.', '');
	return L.join('\n');
}
export function searchTermRows(payload) {
	const raw =
		payload?.data?.reportingDataResponse?.row ?? payload?.reportingDataResponse?.row ??
		(Array.isArray(payload?.rows) ? payload.rows : rowsOf(payload, { allowSingle: false }));
	return raw
		.map((r) => {
			const m = r.metadata ?? r, t = r.total ?? r.granularity?.[0] ?? m;
			return {
				term: String(m.searchTermText ?? m.searchTerm ?? m.text ?? '').trim().toLocaleLowerCase(),
				keyword: m.keyword ?? null, matchType: m.matchType ?? null, source: m.searchTermSource ?? null,
				campaignId: m.campaignId ?? null, campaignName: m.campaignName ?? null,
				adGroupId: m.adGroupId ?? null, adGroupName: m.adGroupName ?? null,
				impressions: num(t.impressions), taps: num(t.taps),
				installs: num(t.installs ?? num(t.newDownloads) + num(t.redownloads)),
				spend: metric(t.localSpend), currency: t.localSpend?.currency ?? 'USD',
			};
		})
		.filter((r) => r.term);
}
export function decide(rows, opts = {}) {
	const rule = resolveKillRule(opts);
	const { targetCpi: cpi, wasteThreshold, minTaps } = rule;
	const agg = new Map();
	for (const r of rows ?? []) {
		const term = String(r?.term ?? '').trim().toLocaleLowerCase();
		if (!term) continue;
		const e = agg.get(term) ?? {
			term, impressions: 0, taps: 0, installs: 0, spend: 0, exact: false, topSpend: -1,
			campaignId: null, campaignName: null, adGroupId: null, adGroupName: null,
		};
		e.impressions += num(r.impressions); e.taps += num(r.taps);
		e.installs += num(r.installs); e.spend += num(r.spend);
		if (String(r.matchType ?? '').toUpperCase() === 'EXACT') e.exact = true;
		if (num(r.spend) > e.topSpend) {
			e.topSpend = num(r.spend);
			e.campaignId = r.campaignId ?? null; e.campaignName = r.campaignName ?? null;
			e.adGroupId = r.adGroupId ?? null; e.adGroupName = r.adGroupName ?? null;
		}
		agg.set(term, e);
	}
	const terms = [...agg.values()].map((e) => ({
		...e, spend: round2(e.spend), cpi: e.installs ? round2(e.spend / e.installs) : null,
	}));
	const evidence = (e) => `${money(e.spend)} over ${e.taps} tap(s) and ${e.impressions} impression(s) for zero installs`;
	const spent = terms.filter((e) => e.installs === 0 && e.spend > wasteThreshold);
	const bySpend = (a, b) => b.spend - a.spend || a.term.localeCompare(b.term);
	const negatives = spent
		.filter((e) => e.taps >= minTaps)
		.sort(bySpend)
		.map((e) => ({
			term: e.term, matchType: 'EXACT', spend: e.spend, taps: e.taps, impressions: e.impressions,
			campaignId: e.campaignId, campaignName: e.campaignName, adGroupName: e.adGroupName,
			reason: `${evidence(e)} — past the ${money(wasteThreshold)} waste line and past ${minTaps} taps, so zero is a verdict`,
		}));
	const held = spent
		.filter((e) => e.taps < minTaps)
		.sort(bySpend)
		.map((e) => ({
			term: e.term, spend: e.spend, taps: e.taps, impressions: e.impressions, needTaps: minTaps,
			campaignName: e.campaignName, adGroupName: e.adGroupName,
			reason:
				`${evidence(e)}, but ${e.taps} tap(s) is under the ${minTaps} needed before zero installs means anything: ` +
				`a keyword converting at ${Math.round(rule.baselineInstallRate * 100)}% shows nothing this often by chance`,
		}));
	const promotions = terms
		.filter((e) => e.installs > 0 && e.cpi <= cpi && !e.exact)
		.sort((a, b) => a.cpi - b.cpi || b.installs - a.installs || a.term.localeCompare(b.term))
		.map((e) => ({
			term: e.term, matchType: 'EXACT', installs: e.installs, spend: e.spend, cpi: e.cpi,
			bid: round2(Math.min(BID.ceiling, Math.max(BID.floor, e.cpi))),
			servedBy: e.adGroupName ?? e.campaignName ?? null, campaignId: e.campaignId,
			reason: `${e.installs} install(s) at ${money(e.cpi)} CPI, under the ${money(cpi)} target, on broad or Search Match — own the bid`,
		}));
	return { targetCpi: cpi, wasteThreshold, minTaps, killRule: rule, negatives, held, promotions };
}
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
export async function renderOnly({ cfg, flags, planFile, mdFile, onDisk }) {
	if (!onDisk)
		throw new ShipError(`no plan to render: ${planFile}`, {
			hint: 'run `ship ads plan` first — --render re-renders campaign-plan.md from an existing campaign-plan.json, it does not build one',
		});
	const renderedAt = new Date().toISOString();
	await writeFile(mdFile, renderPlan(onDisk, { renderedAt }));
	const bound = planBindings(onDisk);
	const t = planTotals(onDisk);
	if (flags.json) return emit({ rendered: mdFile, from: planFile, generatedAt: onDisk.generatedAt, renderedAt, ...bound, totals: t });
	heading(`Render · ${cfg.name}`);
	good(`wrote ${mdFile} from ${planFile}`);
	note(`plan generated ${onDisk.generatedAt} — unchanged; only the document was rewritten`);
	info(
		`${money(t.daily)}/day across ${onDisk.campaigns.length} campaigns · ${Object.entries(t.split).map(([role, v]) => `${role} ${money(v)}`).join(' · ')}`,
	);
	if (t.drifted)
		note(`stamped params say ${money(t.stamped.daily)}/day — historical, and not re-derived: the campaigns are what \`ship ads sync\` pushes`);
	if (bound.bound)
		note(`${bound.objects} Apple object id(s) in this plan${bound.syncedAt ? ` (last synced ${bound.syncedAt})` : ''} — \`ship ads sync --dry-run\` diffs it against the account`);
	return 0;
}
export function printPlan(out, ctx) {
	const { name, jsonFile, mdFile, backup, bound, measured, money$, competitors, locale } = ctx;
	heading(`Campaign plan · ${name} · ${out.market}`);
	info(
		`${money(out.budget.daily)}/day across ${out.campaigns.length} campaigns · ${Object.entries(out.budget.split).map(([role, v]) => `${role} ${money(v)}`).join(' · ')}`,
	);
	note(out.budget.scope);
	if (backup) {
		warn(`replanned over a plan bound to ${bound.objects} live Apple object(s) — every Apple id, hand-set bid and pruned ad group in it is gone from campaign-plan.json`);
		note(`previous plan kept at ${backup} · \`ship ads sync --dry-run\` before pushing, or --adopt to take the live values back`);
	}
	info(`bids: ${out.bidding.derivation}`);
	if (measured.cpt === null && !ctx.bid)
		note(`no realised cost per tap yet (${measured.reason}) — seeded at ${money(out.bidding.seed)}, override with --bid`);
	if (!competitors.length)
		note(`no aso/${locale}/competitors.json — Competitor campaign skipped, its budget went to the rest (\`ship aso competitors --locale ${locale}\`)`);
	if (out.targeting.dropped)
		note(`${out.targeting.dropped} scored term(s) under aso.minVolume ${out.targeting.minVolume} are not worth bidding on`);
	for (const cp of out.campaigns) {
		process.stdout.write('\n');
		step(`${cp.name} · ${money(cp.dailyBudget)}/day · ${cp.adGroups.length} ad group(s)${cp.negativeKeywords.length ? ` · ${cp.negativeKeywords.length} negative(s)` : ''}`);
		table(cp.adGroups, [
			{ header: 'ad group', get: (g) => g.name },
			{ header: 'keywords', get: (g) => g.keywords.map((k) => `${k.text} ${k.matchType.toLowerCase()}`).join(', ') },
			{ header: 'demand', get: (g) => (g.demand == null ? DASH : String(Math.round(g.demand))) },
			{ header: 'bid', get: (g) => money(g.defaultBidAmount) },
			{ header: 'page', get: (g) => g.productPage?.name ?? '' },
		]);
	}
	process.stdout.write('\n');
	info(`kill rule: ${out.killRule.condition} (source: ${out.killRule.source})`);
	good(`wrote ${jsonFile}`);
	good(`wrote ${mdFile}`);
	note('review it, then `ship ads sync --dry-run` once credentials exist');
}

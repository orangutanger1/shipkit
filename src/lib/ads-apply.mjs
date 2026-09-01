// The sync apply engine: walk the reconciled plan and issue exactly the
// mutations it lists, stamping Apple object ids back into the plan document.
// The reconciliation itself is pure (asa-reconcile.mjs); this is the half that
// touches Apple.
import { ShipError, c, good, info, note, step, table, warn } from '../log.mjs';
import { money, pct, round2 } from './fmt.mjs';
import { describeAction, monetisation } from './asa.mjs';
import { overviewMetrics, resolveProject } from './revenuecat.mjs';
import { authState } from './ads-auth.mjs';
import {
	bindProductPage,
	createAdGroup,
	createCampaign,
	createKeywords,
	ensureNegatives,
	listCampaigns,
	pauseAdGroup,
	pauseKeywords,
	pullReport,
	updateAdGroup,
	updateCampaign,
	updateKeywords,
} from './ads-client.mjs';

const stampApple = (obj, live, fields) => {
	obj.apple = { id: live?.id ? String(live.id) : (obj.apple?.id ?? null), syncedAt: new Date().toISOString(), ...fields };
	return obj;
};
const adoptLive = (obj, fields) => {
	for (const [k, v] of Object.entries(fields ?? {})) obj[k] = v ?? obj[k];
};
const OP_COLOUR = {
	create: c.green, update: c.cyan, adopt: c.blue, preserve: c.yellow, pause: c.red,
	unplanned: c.yellow, conflict: c.red, orphan: c.magenta, noop: c.dim,
};
export function printReconciliation(plan$, { verbose = false } = {}) {
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
	const counts = Object.entries(plan$.summary).filter(([op]) => verbose || op !== 'noop').map(([op, n]) => `${n} ${op}`).join(' · ');
	info(counts || 'no changes');
}
const applyMutation = (action, { create, update, adopt, keep }) => {
	if (action.op === 'create' || action.op === 'orphan') return create();
	if (action.op === 'update') return update();
	if (action.op === 'adopt') return adopt?.();
	return keep?.();
};
export function printSyncSummary(tally, { org, planFile }) {
	process.stdout.write('\n');
	good(
		`${tally.campaigns} campaign(s) created · ${tally.groups} ad group(s) created or updated · ${tally.keywords} keyword(s) · ${tally.negatives} negative(s)${tally.paused ? ` · ${c.red(`${tally.paused} paused`)}` : ''}${tally.adopted ? ` · ${tally.adopted} adopted` : ''}${tally.pages ? ` · ${tally.pages} product page(s) bound` : ''}`,
	);
	good(`recorded Apple object ids into ${planFile}`);
	note(`verify: ship ads snapshot --org ${org}`);
}
export async function applyPlan({ org, adamId, currency, planned, account, plan$ }) {
	const cache = {};
	const tally = { campaigns: 0, groups: 0, keywords: 0, negatives: 0, paused: 0, pages: 0, adopted: 0 };
	const at = (level, path) => plan$.actions.find((a) => a.level === level && a.path === path) ?? { op: 'noop' };
	const applyKeywords = async (g, path, campaignId, adGroupId) => {
		const create = [], update = [];
		for (const k of g.keywords ?? []) {
			const bid = round2(k.bid ?? g.defaultBidAmount);
			const ka = at('keyword', `${path} / ${k.text} ${k.matchType}`);
			if (ka.op === 'create' || ka.op === 'orphan') create.push({ ...k, bid });
			else if (ka.op === 'update') update.push({ id: ka.id, bid, status: 'ACTIVE' });
			else if (ka.op === 'adopt' && ka.adoptFields) k.bid = ka.adoptFields.bidAmount ?? bid;
			if (ka.id)
				stampApple(k, { id: ka.id }, { text: k.text, matchType: k.matchType, bidAmount: round2(k.bid ?? bid), status: 'ACTIVE' });
		}
		if (create.length) {
			const made = await createKeywords(org, campaignId, adGroupId, create, currency);
			tally.keywords += create.length;
			for (const row of made) {
				const k = (g.keywords ?? []).find((x) => x.text === row.text && x.matchType === row.matchType);
				if (k)
					stampApple(k, row, { text: row.text, matchType: row.matchType, bidAmount: round2(k.bid ?? g.defaultBidAmount), status: 'ACTIVE' });
			}
		}
		if (update.length) {
			await updateKeywords(org, campaignId, adGroupId, update, currency);
			tally.keywords += update.length;
		}
		const stale = plan$.destructive.filter((a) => a.level === 'keyword' && a.path.startsWith(`${path} / `));
		if (stale.length) {
			warn(`pausing ${stale.length} keyword(s) in "${g.name}": ${stale.map((a) => a.name).join(', ')}`);
			await pauseKeywords(org, campaignId, adGroupId, stale.map((a) => a.id));
			tally.paused += stale.length;
		}
	};
	const applyAdGroup = async (cp, g, campaignId) => {
		const path = `${cp.name} / ${g.name}`;
		const ga = at('adGroup', path);
		let adGroupId = ga.id;
		await applyMutation(ga, {
			create: async () => {
				const created = await createAdGroup(org, campaignId, g, currency);
				if (!created?.id) throw new ShipError(`ad group create returned no id for "${g.name}"`);
				adGroupId = String(created.id);
				tally.groups++;
				good(`created ad group ${adGroupId} "${g.name}" @ ${money(g.defaultBidAmount)}`);
			},
			update: async () => {
				step(`update ad group "${g.name}" · ${describeAction(ga)}`);
				await updateAdGroup(org, campaignId, adGroupId, g, currency);
				tally.groups++;
			},
			adopt: () => {
				if (ga.adoptFields) {
					adoptLive(g, ga.adoptFields);
					tally.adopted++;
				}
			},
		});
		if (!adGroupId) return;
		stampApple(g, { id: adGroupId }, { name: g.name, defaultBidAmount: round2(g.defaultBidAmount), automatedKeywordsOptIn: Boolean(g.automatedKeywordsOptIn), status: g.status ?? 'ENABLED' });
		await applyKeywords(g, path, campaignId, adGroupId);
		if (g.productPage && (await bindProductPage(org, adamId, campaignId, adGroupId, g.productPage, cache))) tally.pages++;
	};
	const applyCampaign = async (cp) => {
		const action = at('campaign', cp.name);
		const liveCp = account.campaigns.find((r) => r.id === action.id) ?? null;
		let campaignId = action.id;
		const stamp = () => stampApple(cp, { id: campaignId }, { name: cp.name, dailyBudget: round2(cp.dailyBudget), status: cp.status ?? 'ENABLED' });
		await applyMutation(action, {
			create: async () => {
				step(`create campaign "${cp.name}" · ${money(cp.dailyBudget)}/day`);
				const created = await createCampaign(org, cp, adamId, currency);
				if (!created?.id)
					throw new ShipError(`campaign create returned no id for "${cp.name}"`, {
						hint: 'asc ads campaigns create emitted an unexpected payload — re-run with --verbose',
					});
				campaignId = String(created.id);
				tally.campaigns++;
				stampApple(cp, created, { name: cp.name, dailyBudget: round2(cp.dailyBudget), status: 'ENABLED' });
			},
			update: async () => {
				step(`update campaign "${cp.name}" · ${describeAction(action)}`);
				await updateCampaign(org, campaignId, cp, adamId, currency);
				stamp();
			},
			adopt: () => {
				tally.adopted++;
				adoptLive(cp, action.adoptFields);
				stamp();
			},
			keep: () => {
				if (liveCp) stampApple(cp, liveCp, { name: cp.name, dailyBudget: liveCp.dailyBudget, status: liveCp.status });
			},
		});
		if (!campaignId) return;
		tally.negatives += await ensureNegatives(org, campaignId, cp.negativeKeywords ?? []);
		for (const g of cp.adGroups ?? []) await applyAdGroup(cp, g, campaignId);
		for (const a of plan$.destructive.filter((x) => x.level === 'adGroup' && x.path.startsWith(`${cp.name} / `))) {
			warn(`pausing ad group "${a.name}" (${a.id}) — it is not in the plan`);
			await pauseAdGroup(org, campaignId, a.id);
			tally.paused++;
		}
	};
	for (const cp of planned) await applyCampaign(cp);
	return tally;
}

export async function monetisationSignal(cfg, { subPrice } = {}) {
	if (!cfg?.revenuecat?.projectId) return { available: false, reason: 'no revenuecat.projectId in ship.config.json' };
	try {
		const project = await resolveProject(cfg);
		if (!project) return { available: false, reason: `no RevenueCat project matches "${cfg.revenuecat.projectId}"` };
		const raw = await overviewMetrics(project.id);
		return {
			available: true, project: project.id, keySource: project.keySource ?? null, raw,
			...monetisation(raw, { subPrice: subPrice ?? cfg.ads?.subPrice, retentionMonths: cfg.ads?.retentionMonths }),
		};
	} catch (err) {
		return { available: false, reason: err.message };
	}
}
export async function realisedCpt(cfg, org, { days = 30 } = {}) {
	if (!org) return { cpt: null, reason: 'no ads.orgId' };
	if (!(await authState()).configured) return { cpt: null, reason: 'no Apple Ads credentials' };
	const to = new Date().toISOString().slice(0, 10);
	const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
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
export function reportMonetisation(money$, { budget = null } = {}) {
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
	if (budget) warn(`you are about to authorise ${money(budget)}/day — ${money(round2(budget * 30))} a month — against ${money(0)} of revenue`);
	note('fix the paywall before the bids: `ship rc audit`, then `ship ads plan` again');
	note('or proceed deliberately, treating the spend as research with a fixed cap (--no-ltv-check silences this)');
}

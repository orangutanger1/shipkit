// Territory pricing — the growth lever that moves revenue without moving installs.
//
// The pure core (territory table, price ladders, derivePlan, the delta gate)
// lives in lib/pricing.mjs; the asc plumbing (capability discovery, live reads,
// the plan file, mutations) in lib/price-asc.mjs. What stays here is the
// orchestration: deriving, rendering, and the gates that decide what may move.
//
//  4. Price changes are visible to existing subscribers and are not casually
//     reversible. `apply` refuses any move larger than --max-delta without
//     --force, and refuses the whole batch rather than half of it, because a
//     half-applied price table is worse than either price.
//  5. A per-territory number is the wrong argument when the *ladder* is wrong.
//     `show` answers "are the numbers wrong in this storefront"; `audit` answers
//     "is the shape wrong" — no yearly at all, a yearly above the price where
//     the EU's 14-day right of withdrawal starts reversing it, a trial sitting
//     on the weekly. Those thresholds live in lib/paywall.mjs because they are
//     contested business rules; this file only decides which of them we have
//     the data to judge, and says "unknown" for the rest.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, optionalAppId, requireAppId } from '../config.mjs';
import { asc, isDryRun } from '../exec.mjs';
import { Report, ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { rowsOf } from '../lib/asc-report.mjs';
import { num } from '../lib/fmt.mjs';
import { auditLadder, normalisePeriod } from '../lib/paywall.mjs';
import { emit } from '../lib/output.mjs';
import { resolveSubcommand } from '../lib/util.mjs';
import {
	CONVENTIONS,
	FX_AS_OF,
	derivePlan,
	normaliseTerritory,
	priceLabel,
	reconcilePrices,
} from '../lib/pricing.mjs';
import {
	ascMutate,
	floorFor,
	ladderOfferings,
	ladderSubscriptions,
	listSubscriptions,
	planFileOf,
	priceMap,
	readPlanFile,
	requireAsc,
	resolveSubscription,
	subscriptionPrices,
} from '../lib/price-asc.mjs';

export const help = `
${c.bold('ship price')} ${c.dim('— per-territory pricing: derive it offline, then push it')}

${c.dim('usage:')} ship price [subcommand] [flags]

  ${c.cyan('show')}   ${c.dim('default')} live app price, price schedule and subscription prices; diffs the local plan
  ${c.cyan('plan')}   ${c.green('offline')} derive a per-territory price table into store/pricing/plan.json
  ${c.cyan('apply')}  push the plan through asc, refusing oversized moves
  ${c.cyan('audit')}  ladder shape: tiers, the yearly ceiling, trial placement, the win-back offer

${c.bold('Flags')}
  ${c.cyan('--base <usd>')}          base US price ${c.dim('(default: price.basePriceUsd in ship.config.json)')}
  ${c.cyan('--floor <usd>')}         minimum monthly proceeds a territory must clear ${c.dim('(default: 0.75, or ads.targetCpi/3)')}
  ${c.cyan('--territories <list>')}  restrict the plan to these storefronts ${c.dim('e.g. US,DE,JP')}
  ${c.cyan('--subscription <id>')}   subscription id / product id ${c.dim('(show, apply; default: the app\'s only one)')}
  ${c.cyan('--app-price')}           operate on the paid-app price instead of a subscription
  ${c.cyan('--base-territory <t>')}  base territory for --app-price ${c.dim('(default: US)')}
  ${c.cyan('--max-delta <pct>')}     refuse any price move larger than this ${c.dim('(apply, default: 50)')}
  ${c.cyan('--force')}               apply the moves --max-delta blocked
  ${c.cyan('--start-date <date>')}   schedule the change for YYYY-MM-DD ${c.dim('(apply)')}
  ${c.cyan('--json')}                machine-readable output

${c.dim('`ship price plan` needs no credentials and no network.')}
`;

// ─── plan (offline) ──────────────────────────────────────────────────────────

async function plan({ flags }) {
	const cfg = await loadConfig();
	const base = flags.base !== undefined ? num(flags.base, Number.NaN) : num(cfg.price?.basePriceUsd, Number.NaN);
	if (!Number.isFinite(base))
		throw new ShipError('no base price to derive from', {
			hint: 'set price.basePriceUsd in ship.config.json or pass --base 4.99',
		});
	const territories = flags.territories ? String(flags.territories).split(',').map((s) => s.trim()).filter(Boolean) : null;

	const derived = derivePlan(base, { territories, floorUsd: floorFor(cfg, flags) });
	const doc = {
		generatedAt: new Date().toISOString(),
		app: { name: cfg.name, bundleId: cfg.bundleId, appId: cfg.asc?.appId ?? null },
		...derived,
		conventions: Object.fromEntries(
			Object.entries(CONVENTIONS).map(([k, v]) => [k, { label: v.label, why: v.why }]),
		),
	};

	await mkdir(cfg.paths.pricing, { recursive: true });
	const jsonFile = planFileOf(cfg);
	const mdFile = join(cfg.paths.pricing, 'plan.md');
	await writeFile(jsonFile, `${JSON.stringify(doc, null, '\t')}\n`);
	await writeFile(mdFile, renderPlan(doc));

	if (flags.json) return emit(doc);

	heading(`Price plan · ${cfg.name} · base $${derived.baseUsd.toFixed(2)}`);
	info(`${derived.rows.length} storefronts · FX snapshot ${FX_AS_OF} · proceeds floor $${derived.floorUsd.toFixed(2)} after ${Math.round(derived.commission * 100)}% commission`);
	table(derived.rows, [
		{ header: 'terr', get: (r) => r.territory },
		{ header: 'price', get: (r) => priceLabel(r) },
		{ header: '≈usd', get: (r) => `$${r.usdEquivalent.toFixed(2)}` },
		{ header: 'basis', get: (r) => `${r.basisPct}%` },
		{ header: 'actual', get: (r) => `${r.effectivePct}%` },
		{ header: 'ladder', get: (r) => CONVENTIONS[r.rounding].label },
		{ header: '', get: (r) => (r.belowFloor ? c.yellow('below floor') : '') },
	]);
	process.stdout.write('\n');
	if (derived.flagged.length)
		warn(
			`${derived.flagged.length} territories net under $${derived.floorUsd.toFixed(2)}/month: ${derived.flagged.join(' ')}` +
				' — raise the base price, drop these storefronts from paid acquisition, or accept them as free-tier volume',
		);
	good(`wrote ${jsonFile}`);
	good(`wrote ${mdFile}`);
	note('argue with store/pricing/plan.md, then `ship price apply --dry-run`');
	return 0;
}

function renderPlan(doc) {
	const L = [];
	L.push(`# Territory pricing — ${doc.app.name}`, '');
	L.push(
		`Generated ${doc.generatedAt} from a base US price of **$${doc.baseUsd.toFixed(2)}**,`,
		`FX snapshot \`${doc.fxAsOf}\`, proceeds floor $${doc.floorUsd.toFixed(2)} after Apple's ${Math.round(doc.commission * 100)}%.`,
		'',
	);
	L.push(
		'Each price is a purchasing-power percentage of the US price, snapped onto the local',
		'price ladder. The ladder, not the exchange rate, is what makes a price look native;',
		'`asc` resolves the final number to the nearest real App Store price point.',
		'',
	);
	L.push('| territory | price | ≈ USD | basis | actual | ladder | note |');
	L.push('| --- | ---: | ---: | ---: | ---: | --- | --- |');
	for (const r of doc.rows) {
		L.push(
			`| ${r.territory} | ${priceLabel(r)} | $${r.usdEquivalent.toFixed(2)} | ${r.basisPct}% | ${r.effectivePct}% | ` +
				`${CONVENTIONS[r.rounding].label} | ${r.note}${r.belowFloor ? ' **⚠ below floor**' : ''} |`,
		);
	}
	L.push('');
	if (doc.flagged.length) {
		L.push('## Below the sustaining floor', '');
		L.push(
			`${doc.flagged.join(', ')} net less than $${doc.floorUsd.toFixed(2)} per month after commission.`,
			'A subscription that cannot repay one paid install is not a business in that territory:',
			'raise the base price, exclude the storefront from Apple Search Ads, or treat it as',
			'free-tier volume and price it for goodwill rather than revenue.',
			'',
		);
	}
	L.push('## Ladders', '');
	for (const [key, conv] of Object.entries(doc.conventions)) L.push(`- **${key}** (${conv.label}) — ${conv.why}`);
	L.push('');
	L.push('Push with `ship price apply` (dry-run first: `ship price apply --dry-run`).', '');
	return L.join('\n');
}

// ─── show ────────────────────────────────────────────────────────────────────

async function show({ flags }) {
	const cfg = await loadConfig();
	const appId = requireAppId(cfg);
	await requireAsc(['pricing', 'current']);
	await requireAsc(['pricing', 'schedule', 'view']);

	const appPrices = priceMap(
		await asc(['pricing', 'current', '--app', appId, '--all-territories'], { fallback: null }),
	);
	const schedule = await asc(['pricing', 'schedule', 'view', '--app', appId], { fallback: null });

	let subscription = null;
	let subPrices = new Map();
	if (!flags['app-price']) ({ subscription, subPrices } = await subscriptionTarget(appId, flags));

	const live = flags['app-price'] ? appPrices : (subPrices.size ? subPrices : appPrices);
	const planDoc = await readPlanFile(cfg);
	const diff = planDoc ? reconcilePrices(planDoc.rows, live, { maxDelta: Number.POSITIVE_INFINITY }) : null;

	if (flags.json)
		return showJson({ cfg, appId, flags, subscription, schedule, appPrices, subPrices, planDoc, diff });

	heading(`Pricing · ${cfg.name} (${appId})`);
	if (subscription) info(`subscription ${subscription.productId ?? subscription.id}${subscription.name ? ` — ${subscription.name}` : ''}`);
	printSchedule(schedule);
	printLivePrices(live);
	process.stdout.write('\n');
	printPlanVsLive(cfg, planDoc, diff);
	return 0;
}

/**
 * The subscription half of `show`: name the one subscription to price and read
 * its per-territory prices. An unreadable price read degrades to an empty map
 * and a warning — show is a read, so a target it can see never fails it.
 */
async function subscriptionTarget(appId, flags) {
	await requireAsc(['subscriptions', 'pricing', 'prices']);
	const subs = await listSubscriptions(appId);
	const wanted = flags.subscription ? String(flags.subscription) : null;
	const picked = wanted
		? (subs.find((s) => s.id === wanted || s.productId === wanted) ?? { id: wanted, productId: wanted, name: null })
		: (subs.length === 1 ? subs[0] : null);
	if (picked)
		return {
			subscription: picked,
			subPrices: await subscriptionPrices(picked.id ?? picked.productId, appId).catch((err) => {
				warn(`subscription prices unavailable: ${err.message}`);
				return new Map();
			}),
		};
	if (subs.length > 1) warn(`${subs.length} subscriptions; --subscription <id> to see per-territory prices`);
	return { subscription: null, subPrices: new Map() };
}

/** The `--json` view: everything the human view prints, as data. */
function showJson({ cfg, appId, flags, subscription, schedule, appPrices, subPrices, planDoc, diff }) {
	return emit({
		app: { name: cfg.name, appId },
		target: flags['app-price'] ? 'app' : 'subscription',
		subscription,
		schedule,
		appPrices: [...appPrices.values()],
		subscriptionPrices: [...subPrices.values()],
		plan: planDoc ? { generatedAt: planDoc.generatedAt, baseUsd: planDoc.baseUsd, rows: planDoc.rows.length } : null,
		diff: diff && { changes: diff.changes, added: diff.added, unchanged: diff.unchanged.map((u) => u.territory) },
	});
}

function printSchedule(schedule) {
	const sched = rowsOf(schedule)[0];
	if (sched) {
		const id = sched.id ?? sched.attributes?.id ?? '—';
		const start = sched.attributes?.startDate ?? sched.startDate ?? 'immediate';
		info(`price schedule ${id} · starts ${start}`);
	} else note('no app price schedule (a free app has none)');
}

function printLivePrices(live) {
	if (!live.size) {
		note('no live prices readable for this target');
		return;
	}
	const shown = [...live.values()].sort((a, b) => a.territory.localeCompare(b.territory));
	table(shown, [
		{ header: 'terr', get: (r) => r.territory },
		{ header: 'live', get: (r) => `${r.price} ${r.currency ?? ''}`.trim() },
	]);
}

function printPlanVsLive(cfg, planDoc, diff) {
	if (!planDoc) {
		note(`no local plan at ${planFileOf(cfg)} — run \`ship price plan\``);
		return;
	}
	step(`plan vs live (base $${num(planDoc.baseUsd).toFixed(2)}, generated ${planDoc.generatedAt})`);
	if (!diff.changes.length && !diff.added.length) {
		good(`all ${diff.unchanged.length} planned territories already match`);
		return;
	}
	table([...diff.changes, ...diff.added], [
		{ header: 'terr', get: (r) => r.territory },
		{ header: 'live', get: (r) => (r.from == null ? c.dim('unset') : String(r.from)) },
		{ header: 'plan', get: (r) => `${Number(r.to).toFixed(r.decimals)} ${r.currency}` },
		{ header: 'delta', get: (r) => (r.delta == null ? '' : `${r.delta > 0 ? '+' : ''}${Math.round(r.delta * 100)}%`) },
	]);
	info(`${diff.changes.length} moves, ${diff.added.length} unset, ${diff.unchanged.length} already correct`);
}

// ─── apply ───────────────────────────────────────────────────────────────────

async function apply({ flags }) {
	const cfg = await loadConfig();
	const appId = requireAppId(cfg);
	const planDoc = await readPlanFile(cfg);
	if (!planDoc)
		throw new ShipError(`no price plan at ${planFileOf(cfg)}`, {
			hint: 'run `ship price plan` first — apply never derives prices, it only pushes a reviewed table',
		});
	const maxDelta = Math.max(0, num(flags['max-delta'], 50)) / 100;
	const force = !!flags.force;
	const startDate = flags['start-date'] ? String(flags['start-date']) : null;

	if (flags['app-price']) return applyAppPrice({ cfg, appId, planDoc, flags, maxDelta, force, startDate });

	await requireAsc(['subscriptions', 'pricing', 'prices']);
	const subId = await resolveSubscription(appId, flags);
	const live = await subscriptionPrices(subId, appId);
	const diff = reconcilePrices(planDoc.rows, live, { maxDelta, force });

	if (diff.blocked.length) {
		if (!flags.json) {
			heading('blocked by --max-delta');
			table(diff.blocked, [
				{ header: 'terr', get: (r) => r.territory },
				{ header: 'live', get: (r) => String(r.from) },
				{ header: 'plan', get: (r) => `${Number(r.to).toFixed(r.decimals)} ${r.currency}` },
				{ header: 'delta', get: (r) => `${r.delta > 0 ? '+' : ''}${Math.round(r.delta * 100)}%` },
			]);
		}
		const detail = diff.blocked
			.map((b) => `${b.territory} ${b.from}→${Number(b.to).toFixed(b.decimals)} (${Math.round(b.delta * 100)}%)`)
			.join(', ');
		if (flags.json) emit({ applied: [], blocked: diff.blocked, reason: 'max-delta' });
		throw new ShipError(
			`${diff.blocked.length} price moves exceed --max-delta ${Math.round(maxDelta * 100)}%; nothing was applied`,
			{
				hint:
					`${detail}\nExisting subscribers see these changes and Apple does not un-see them. ` +
					'Re-plan with a saner base, raise --max-delta, or pass --force if the move is deliberate.',
			},
		);
	}

	const todo = [...diff.changes, ...diff.added];
	if (!todo.length) {
		if (flags.json) return emit({ applied: [], skipped: [], unchanged: diff.unchanged.length });
		good(`all ${diff.unchanged.length} planned prices already live; nothing to do`);
		return 0;
	}

	if (!flags.json) {
		heading(`Applying ${todo.length} prices to ${subId}${isDryRun() ? c.yellow(' (dry run)') : ''}`);
	}
	const applied = [];
	const skipped = [];
	for (const change of todo) {
		const args = [
			'subscriptions', 'pricing', 'prices', 'set',
			'--subscription-id', String(subId),
			'--app', appId,
			'--price', Number(change.to).toFixed(change.decimals),
			'--territory', change.territory,
		];
		if (startDate) args.push('--start-date', startDate);
		const res = await ascMutate(args);
		(res.skipped ? skipped : applied).push(change);
		if (!flags.json && !res.skipped)
			good(`${change.territory} ${change.from == null ? 'unset' : change.from} → ${Number(change.to).toFixed(change.decimals)} ${change.currency}`);
	}

	if (flags.json) return emit({ subscription: subId, applied, skipped, unchanged: diff.unchanged.length, startDate });
	info(`${applied.length} applied, ${skipped.length} skipped by --dry-run, ${diff.unchanged.length} already correct`);
	if (!isDryRun()) note('`ship price show` to confirm the store agrees');
	return 0;
}

/**
 * The paid-app path. `asc pricing schedule create` takes one base territory and
 * lets Apple equalize the rest — the API's per-territory `manualPrices` is not
 * on this CLI's surface. So we push the base row, and say plainly that the other
 * rows of the table did not ship rather than implying they did.
 */
async function applyAppPrice({ cfg, appId, planDoc, flags, maxDelta, force, startDate }) {
	await requireAsc(['pricing', 'schedule', 'create']);
	const baseTerritory = normaliseTerritory(flags['base-territory'] ?? 'US');
	const row = planDoc.rows.find((r) => r.territory === baseTerritory);
	if (!row)
		throw new ShipError(`the plan has no row for base territory ${baseTerritory}`, {
			hint: `plan covers: ${planDoc.rows.map((r) => r.territory).join(' ')}`,
		});

	const live = priceMap(
		await asc(['pricing', 'current', '--app', appId, '--territory', baseTerritory], { fallback: null }),
	);
	const diff = reconcilePrices([row], live, { maxDelta, force });
	if (diff.blocked.length) {
		const b = diff.blocked[0];
		throw new ShipError(
			`${baseTerritory} ${b.from} → ${Number(b.to).toFixed(b.decimals)} is ${Math.round(b.delta * 100)}%, over --max-delta ${Math.round(maxDelta * 100)}%`,
			{ hint: 'nothing was applied. --force if the move is deliberate.' },
		);
	}
	if (!diff.changes.length && !diff.added.length) {
		if (flags.json) return emit({ target: 'app', applied: [], unchanged: [baseTerritory] });
		good(`app price in ${baseTerritory} already ${priceLabel(row)}`);
		return 0;
	}

	const args = [
		'pricing', 'schedule', 'create',
		'--app', appId,
		'--price', Number(row.price).toFixed(row.decimals),
		'--base-territory', baseTerritory,
	];
	if (startDate) args.push('--start-date', startDate);
	const res = await ascMutate(args);

	if (flags.json)
		return emit({
			target: 'app',
			baseTerritory,
			price: row.price,
			currency: row.currency,
			applied: res.skipped ? [] : [baseTerritory],
			skipped: res.skipped ? [baseTerritory] : [],
			equalizedByApple: planDoc.rows.filter((r) => r.territory !== baseTerritory).map((r) => r.territory),
		});
	good(`app price schedule ${res.skipped ? 'planned' : 'created'}: ${priceLabel(row)} in ${baseTerritory}`);
	warn(
		`the remaining ${planDoc.rows.length - 1} rows of the plan were NOT applied: asc creates app price schedules from a single base territory, ` +
			'so Apple will equalize the rest by FX. Per-territory pricing that respects the plan needs a subscription (`ship price apply`).',
	);
	return 0;
}

// ─── audit (the shape of the ladder) ─────────────────────────────────────────

/**
 * Is the shape of the ladder wrong? lib/paywall.mjs owns every threshold — this
 * only gathers the inputs and decides which findings we actually have the data
 * to stand behind.
 */
async function audit({ flags }) {
	const cfg = await loadConfig(process.cwd(), { optional: true });
	if (!cfg)
		throw new ShipError('price audit: no ship.config.json in this repo', {
			hint: 'run `ship init` in an app repo first',
		});
	const report = new Report(`Price ladder · ${cfg.name}`);
	const [live, rc] = await Promise.all([ladderSubscriptions(optionalAppId(cfg)), ladderOfferings(cfg)]);
	if (rc.why) report.skip('offerings', rc.why);

	// Unknown is not wrong. Without a readable period there is no shape to judge,
	// and the audit would otherwise report a missing yearly it simply cannot see.
	if (live.why) report.skip('ladder', live.why);
	else if (live.subs.length && !live.subs.some((s) => normalisePeriod(s.period)))
		report.skip('ladder', 'asc returned no subscription periods — cannot tell a yearly from a weekly');
	else {
		const trialKnown = live.subs.some((s) => s.trialDays != null);
		for (const r of auditLadder({ subscriptions: live.subs, offerings: rc.offerings ?? [] })) {
			// auditLadder's own skip already means "no offerings passed"; the row
			// above named why they are missing, so do not say it twice.
			if (r.name === 'retention offer' && r.level === 'skip' && rc.why) continue;
			if (r.name === 'trial placement' && !trialKnown)
				report.skip(r.name, '`asc subscriptions list` carries no introductory-offer duration — trial length unreadable');
			else report[r.level](r.name, r.detail);
		}
		if (live.subs.length && !live.subs.some((s) => s.priceUsd != null))
			report.skip('annual price', 'no US price readable from `asc subscriptions pricing prices list`');
	}
	return report.print({ json: !!flags.json });
}

const SUB = { show, plan, apply, audit };

export async function run({ args, flags }) {
	const { fn, args: rest } = resolveSubcommand({ command: 'price', args, subs: SUB, fallback: 'show' });
	return fn({ args: rest, flags });
}

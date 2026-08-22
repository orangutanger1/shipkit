// Territory pricing — the growth lever that moves revenue without moving installs.
//
// Four operational facts shape this module:
//
//  1. App Store Connect's "equalized" prices are an FX-plus-tax conversion of
//     your US price. Nothing in that conversion knows that the converted number
//     is a rounding error in Oslo and a meal in Jakarta. Equalization is why an
//     app taking 60% of its installs outside the US takes 90% of its revenue
//     inside it: you already paid for those installs, they just cannot pay you.
//  2. A storefront has a price *ladder*, not a currency. Japan ends prices in 00
//     or 80, India in 9 or 99 whole rupees, Indonesia and Vietnam in thousands,
//     Hungary in 90, the euro zone in .99. A raw conversion produces ¥743 — a
//     number no Japanese customer has ever seen on a tag, and not an App Store
//     price point either.
//  3. `plan` is therefore offline and table-driven: deriving prices must never
//     need credentials, network, or an app that exists yet. The table below is
//     committed data you argue with in a pull request. FX drift does not
//     invalidate it — the ladders are coarser than a year of currency movement,
//     and `asc` resolves whatever number we ask for to the nearest real price
//     point, so landing one notch off costs a line of output, not money.
//  4. Price changes are visible to existing subscribers and are not casually
//     reversible. `apply` refuses any move larger than --max-delta without
//     --force, and refuses the whole batch rather than half of it, because a
//     half-applied price table is worse than either price.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, requireAppId } from '../config.mjs';
import { ASC, asc, isDryRun, run as exec } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';

export const help = `
${c.bold('ship price')} ${c.dim('— per-territory pricing: derive it offline, then push it')}

${c.dim('usage:')} ship price [subcommand] [flags]

  ${c.cyan('show')}   ${c.dim('default')} live app price, price schedule and subscription prices; diffs the local plan
  ${c.cyan('plan')}   ${c.green('offline')} derive a per-territory price table into store/pricing/plan.json
  ${c.cyan('apply')}  push the plan through asc, refusing oversized moves

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

const emit = (data) => {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
	return 0;
};

const num = (v, fallback = 0) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
};
const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

/** Mid-market FX snapshot the table below was derived from. */
export const FX_AS_OF = '2025-06';

/** Proceeds floor under which a monthly subscription cannot pay for itself. */
export const MIN_PROCEEDS_USD = 0.75;

/** Apple's Small Business Program rate; the honest default for a solo developer. */
export const COMMISSION = 0.15;

/**
 * Local price ladders. Each `round` maps a raw converted amount onto the shape
 * of a price customers in that storefront actually see. The `why` ships in
 * plan.json so the number in front of a reviewer carries its own justification.
 */
export const CONVENTIONS = {
	charm99: {
		label: 'x.99',
		why: 'the .99 ladder every decimal-currency storefront runs on. Apple also sells .49 midpoints; staying on .99 costs a little granularity and buys a price that is never ambiguous.',
		round: (v) => round2(Math.max(1, Math.round(v + 0.01)) - 0.01),
	},
	whole9: {
		label: 'whole units, 9-ending above 10',
		why: 'Nordic, Czech, Ukrainian, Hong Kong, Chinese, Thai and Filipino tags carry no decimals: kr 39, ¥18, ฿99. A decimal reads as an import.',
		round: (v) => (v < 10 ? Math.max(1, Math.round(v)) : Math.round((v + 1) / 10) * 10 - 1),
	},
	tens: {
		label: 'multiple of 10',
		why: 'Taiwan prices in NT$30 steps; nothing finer than NT$10 appears.',
		round: (v) => Math.max(10, Math.round(v / 10) * 10),
	},
	hundred: {
		label: 'multiple of 100',
		why: 'Korean, Nigerian and Pakistani ladders move in hundreds (₩5,500, ₦1,900, Rs 300); the trailing digits are noise nobody prices in.',
		round: (v) => Math.max(100, Math.round(v / 100) * 100),
	},
	thousand: {
		label: 'multiple of 1000',
		why: 'Indonesia, Vietnam, Chile and Colombia quote in thousands (Rp 24.000, ₫38.000). Anything finer is not a price, it is a typo.',
		round: (v) => Math.max(1000, Math.round(v / 1000) * 1000),
	},
	ninety: {
		label: 'x90 forint',
		why: 'Hungarian retail ends in 90: 490 Ft, 1 490 Ft. A round 500 reads as expensive.',
		round: (v) => Math.max(90, Math.round((v + 10) / 100) * 100 - 10),
	},
	yen80: {
		label: 'ends in 00 or 80',
		why: 'the Japanese App Store ladder is ¥400 / ¥480 / ¥600 / ¥680. Yen have no subunit and ¥743 is not a price anyone has seen.',
		round: (v) => {
			const base = Math.floor(v / 100) * 100;
			const options = [base, base + 80, base + 100, base + 180].filter((n) => n >= 100);
			return options.reduce((best, n) => (Math.abs(n - v) < Math.abs(best - v) ? n : best), options[0]);
		},
	},
	rupee9: {
		label: 'whole rupees ending in 9 / 49 / 99',
		why: 'the Indian ladder is ₹39, ₹99, ₹149, ₹199. Rupee subunits are not used and a non-9 ending is read as a mistake.',
		round: (v) =>
			v < 100
				? Math.max(9, Math.round((v + 1) / 10) * 10 - 1)
				: Math.round((v + 1) / 50) * 50 - 1,
	},
};

/** Decimal places a storefront's tag carries. Only the .99 ladder has any. */
const decimalsFor = (rounding) => (rounding === 'charm99' ? 2 : 0);

/**
 * The pricing table. `basisPct` is what the local price should be as a
 * percentage of the US price — a purchasing-power judgement, not an FX rate —
 * and `fx` is the local-units-per-USD snapshot used to express it. Both are
 * arguable, which is the point: change a number here and every plan moves with
 * a reviewable diff. Russia is absent because Apple suspended paid sales there;
 * Argentina is absent because a committed FX snapshot for ARS would be a lie.
 */
export const TERRITORIES = [
	// Americas
	{ territory: 'US', alpha3: 'USA', currency: 'USD', fx: 1, basisPct: 100, rounding: 'charm99', note: 'reference storefront' },
	{ territory: 'CA', alpha3: 'CAN', currency: 'CAD', fx: 1.37, basisPct: 95, rounding: 'charm99', note: 'US-adjacent income, slightly softer spend' },
	{ territory: 'MX', alpha3: 'MEX', currency: 'MXN', fx: 19.5, basisPct: 50, rounding: 'charm99', note: 'large install base, half the US willingness to pay' },
	{ territory: 'BR', alpha3: 'BRA', currency: 'BRL', fx: 5.5, basisPct: 45, rounding: 'charm99', note: 'volume market; US-priced subs simply do not convert' },
	{ territory: 'CL', alpha3: 'CHL', currency: 'CLP', fx: 950, basisPct: 65, rounding: 'thousand', note: 'richest LatAm storefront per capita' },
	{ territory: 'CO', alpha3: 'COL', currency: 'COP', fx: 4100, basisPct: 40, rounding: 'thousand', note: 'price-sensitive, growing iOS share' },
	{ territory: 'PE', alpha3: 'PER', currency: 'PEN', fx: 3.7, basisPct: 45, rounding: 'charm99' },
	// Western Europe
	{ territory: 'GB', alpha3: 'GBR', currency: 'GBP', fx: 0.78, basisPct: 100, rounding: 'charm99' },
	{ territory: 'IE', alpha3: 'IRL', currency: 'EUR', fx: 0.9, basisPct: 100, rounding: 'charm99' },
	{ territory: 'DE', alpha3: 'DEU', currency: 'EUR', fx: 0.9, basisPct: 100, rounding: 'charm99', note: 'largest euro-zone storefront' },
	{ territory: 'FR', alpha3: 'FRA', currency: 'EUR', fx: 0.9, basisPct: 100, rounding: 'charm99' },
	{ territory: 'IT', alpha3: 'ITA', currency: 'EUR', fx: 0.9, basisPct: 90, rounding: 'charm99', note: 'euro-zone income spread is real; Italy is not Germany' },
	{ territory: 'ES', alpha3: 'ESP', currency: 'EUR', fx: 0.9, basisPct: 90, rounding: 'charm99' },
	{ territory: 'NL', alpha3: 'NLD', currency: 'EUR', fx: 0.9, basisPct: 100, rounding: 'charm99' },
	{ territory: 'BE', alpha3: 'BEL', currency: 'EUR', fx: 0.9, basisPct: 100, rounding: 'charm99' },
	{ territory: 'AT', alpha3: 'AUT', currency: 'EUR', fx: 0.9, basisPct: 100, rounding: 'charm99' },
	{ territory: 'PT', alpha3: 'PRT', currency: 'EUR', fx: 0.9, basisPct: 85, rounding: 'charm99' },
	{ territory: 'GR', alpha3: 'GRC', currency: 'EUR', fx: 0.9, basisPct: 80, rounding: 'charm99' },
	{ territory: 'FI', alpha3: 'FIN', currency: 'EUR', fx: 0.9, basisPct: 100, rounding: 'charm99' },
	{ territory: 'SK', alpha3: 'SVK', currency: 'EUR', fx: 0.9, basisPct: 75, rounding: 'charm99', note: 'euro currency, central-European incomes' },
	{ territory: 'CH', alpha3: 'CHE', currency: 'CHF', fx: 0.85, basisPct: 115, rounding: 'charm99', note: 'highest disposable income in the table; under-pricing here is a donation' },
	{ territory: 'SE', alpha3: 'SWE', currency: 'SEK', fx: 10.6, basisPct: 100, rounding: 'whole9' },
	{ territory: 'NO', alpha3: 'NOR', currency: 'NOK', fx: 10.8, basisPct: 110, rounding: 'whole9', note: 'will pay above the US price without blinking' },
	{ territory: 'DK', alpha3: 'DNK', currency: 'DKK', fx: 6.8, basisPct: 105, rounding: 'whole9' },
	// Central & Eastern Europe
	{ territory: 'PL', alpha3: 'POL', currency: 'PLN', fx: 3.9, basisPct: 70, rounding: 'charm99', note: 'biggest CEE storefront; 70% converts well' },
	{ territory: 'CZ', alpha3: 'CZE', currency: 'CZK', fx: 22.5, basisPct: 75, rounding: 'whole9' },
	{ territory: 'HU', alpha3: 'HUN', currency: 'HUF', fx: 355, basisPct: 65, rounding: 'ninety' },
	{ territory: 'RO', alpha3: 'ROU', currency: 'RON', fx: 4.55, basisPct: 60, rounding: 'charm99' },
	{ territory: 'UA', alpha3: 'UKR', currency: 'UAH', fx: 41, basisPct: 30, rounding: 'whole9' },
	{ territory: 'TR', alpha3: 'TUR', currency: 'TRY', fx: 39, basisPct: 30, rounding: 'charm99', note: 'lira moves fast — re-plan quarterly or the basis is fiction' },
	// Middle East & Africa
	{ territory: 'IL', alpha3: 'ISR', currency: 'ILS', fx: 3.6, basisPct: 100, rounding: 'charm99' },
	{ territory: 'AE', alpha3: 'ARE', currency: 'AED', fx: 3.67, basisPct: 95, rounding: 'charm99' },
	{ territory: 'SA', alpha3: 'SAU', currency: 'SAR', fx: 3.75, basisPct: 85, rounding: 'charm99' },
	{ territory: 'ZA', alpha3: 'ZAF', currency: 'ZAR', fx: 18.2, basisPct: 45, rounding: 'charm99' },
	{ territory: 'EG', alpha3: 'EGY', currency: 'EGP', fx: 49, basisPct: 25, rounding: 'charm99', note: 'high install volume, minimal purchasing power' },
	{ territory: 'NG', alpha3: 'NGA', currency: 'NGN', fx: 1550, basisPct: 25, rounding: 'hundred' },
	// Asia-Pacific
	{ territory: 'JP', alpha3: 'JPN', currency: 'JPY', fx: 148, basisPct: 85, rounding: 'yen80', note: 'high-value storefront; the ladder matters more than the level' },
	{ territory: 'KR', alpha3: 'KOR', currency: 'KRW', fx: 1370, basisPct: 80, rounding: 'hundred' },
	{ territory: 'CN', alpha3: 'CHN', currency: 'CNY', fx: 7.2, basisPct: 55, rounding: 'whole9', note: 'huge, and priced far below the West by every local competitor' },
	{ territory: 'TW', alpha3: 'TWN', currency: 'TWD', fx: 30, basisPct: 75, rounding: 'tens' },
	{ territory: 'HK', alpha3: 'HKG', currency: 'HKD', fx: 7.8, basisPct: 90, rounding: 'whole9' },
	{ territory: 'SG', alpha3: 'SGP', currency: 'SGD', fx: 1.31, basisPct: 100, rounding: 'charm99' },
	{ territory: 'MY', alpha3: 'MYS', currency: 'MYR', fx: 4.4, basisPct: 55, rounding: 'charm99' },
	{ territory: 'TH', alpha3: 'THA', currency: 'THB', fx: 34, basisPct: 40, rounding: 'whole9' },
	{ territory: 'ID', alpha3: 'IDN', currency: 'IDR', fx: 16300, basisPct: 30, rounding: 'thousand', note: 'fourth-largest population on earth; US pricing earns nothing here' },
	{ territory: 'PH', alpha3: 'PHL', currency: 'PHP', fx: 57, basisPct: 35, rounding: 'whole9' },
	{ territory: 'VN', alpha3: 'VNM', currency: 'VND', fx: 25500, basisPct: 30, rounding: 'thousand' },
	{ territory: 'IN', alpha3: 'IND', currency: 'INR', fx: 85, basisPct: 30, rounding: 'rupee9', note: 'the single biggest gap between install share and revenue share' },
	{ territory: 'PK', alpha3: 'PAK', currency: 'PKR', fx: 280, basisPct: 25, rounding: 'hundred' },
	{ territory: 'AU', alpha3: 'AUS', currency: 'AUD', fx: 1.52, basisPct: 105, rounding: 'charm99' },
	{ territory: 'NZ', alpha3: 'NZL', currency: 'NZD', fx: 1.65, basisPct: 100, rounding: 'charm99' },
];

const BY_TERRITORY = new Map(TERRITORIES.map((t) => [t.territory, t]));
const BY_ALPHA3 = new Map(TERRITORIES.map((t) => [t.alpha3, t.territory]));

/** ASC speaks alpha-3 territory ids; humans and this table speak alpha-2. */
export function normaliseTerritory(code) {
	const s = String(code ?? '').trim().toUpperCase();
	if (!s) return '';
	return BY_ALPHA3.get(s) ?? s;
}

/**
 * Derive the whole price table from one US price. Pure: no clock, no config, no
 * filesystem, so it is the thing tests pin and the thing reviewers read.
 *
 * @param {number} baseUsd US price the rest of the table is a percentage of.
 * @param {{territories?:string[], floorUsd?:number, commission?:number}} opts
 */
export function derivePlan(baseUsd, { territories = null, floorUsd = MIN_PROCEEDS_USD, commission = COMMISSION } = {}) {
	const base = Number(baseUsd);
	if (!Number.isFinite(base) || base <= 0)
		throw new ShipError(`base price must be a positive number, got ${JSON.stringify(baseUsd)}`, {
			hint: 'set price.basePriceUsd in ship.config.json or pass --base 4.99',
		});
	const floor = Number.isFinite(Number(floorUsd)) ? Number(floorUsd) : MIN_PROCEEDS_USD;

	let wanted = null;
	if (territories?.length) {
		wanted = territories.map(normaliseTerritory).filter(Boolean);
		const unknown = wanted.filter((t) => !BY_TERRITORY.has(t));
		if (unknown.length)
			throw new ShipError(`no pricing basis for ${unknown.join(', ')}`, {
				hint: `the table covers ${TERRITORIES.length} storefronts: ${TERRITORIES.map((t) => t.territory).join(' ')}`,
			});
		wanted = new Set(wanted);
	}

	const rows = [];
	for (const t of TERRITORIES) {
		if (wanted && !wanted.has(t.territory)) continue;
		const targetUsd = base * (t.basisPct / 100);
		const price = CONVENTIONS[t.rounding].round(targetUsd * t.fx);
		const usdEquivalent = round2(price / t.fx);
		const effectivePct = round1((usdEquivalent / base) * 100);
		const proceedsUsd = round2(usdEquivalent * (1 - commission));
		rows.push({
			territory: t.territory,
			alpha3: t.alpha3,
			currency: t.currency,
			price,
			decimals: decimalsFor(t.rounding),
			basisPct: t.basisPct,
			rounding: t.rounding,
			note: t.note ?? `${t.basisPct}% of the US price, on the ${CONVENTIONS[t.rounding].label} ladder`,
			fx: t.fx,
			usdEquivalent,
			effectivePct,
			// What the ladder cost you. A big drift is not a bug, it is the price
			// of a believable tag — but it should be visible before you ship it.
			roundingDriftPct: round1(effectivePct - t.basisPct),
			proceedsUsd,
			belowFloor: proceedsUsd < floor,
		});
	}

	return {
		baseUsd: round2(base),
		floorUsd: floor,
		commission,
		fxAsOf: FX_AS_OF,
		rows,
		flagged: rows.filter((r) => r.belowFloor).map((r) => r.territory),
	};
}

const fmt = (row) => `${Number(row.price).toFixed(row.decimals ?? 2)} ${row.currency}`;

/**
 * Compare a derived table against live prices and split it by the delta gate.
 * Pure, and separate from the pushing, because "which prices would move, and by
 * how much" is the question you want answered before anything moves.
 *
 * @param {object[]} rows plan rows
 * @param {Map<string,{price:number,currency?:string}>|object} live per-territory live prices
 * @param {{maxDelta?:number, force?:boolean}} opts maxDelta is a fraction: 0.5 = 50%
 */
export function reconcile(rows, live, { maxDelta = 0.5, force = false } = {}) {
	const at = (t) => (live instanceof Map ? live.get(t) : live?.[t]);
	const changes = [];
	const blocked = [];
	const unchanged = [];
	const added = [];

	for (const row of rows) {
		const current = at(row.territory);
		const from = current == null ? null : num(current.price ?? current, Number.NaN);
		const entry = {
			territory: row.territory,
			currency: row.currency,
			from: Number.isFinite(from) ? from : null,
			to: row.price,
			decimals: row.decimals ?? 2,
		};
		if (entry.from == null) {
			// No live price is not a price move; it is a first price. Nothing to gate.
			added.push(entry);
			continue;
		}
		if (Math.abs(entry.from - row.price) < 0.005) {
			unchanged.push(entry);
			continue;
		}
		entry.delta = entry.from === 0 ? 1 : round2((row.price - entry.from) / entry.from);
		if (!force && Math.abs(entry.delta) > maxDelta) blocked.push(entry);
		else changes.push(entry);
	}
	return { changes, blocked, unchanged, added };
}

// ─── asc capability discovery ────────────────────────────────────────────────

const helpCache = new Map();

/**
 * Subcommands the installed asc advertises under a command. asc prints them as
 * an indented two-column block, either after a `SUBCOMMANDS` header or, at the
 * top level, under `... COMMANDS` group headers with a colon after the name.
 */
async function subcommandsOf(path) {
	const key = path.join(' ');
	if (helpCache.has(key)) return helpCache.get(key);
	const res = await exec(ASC, [...path, '--help'], { allowFail: true });
	const found = new Set();
	for (const line of `${res.stdout}\n${res.stderr}`.split('\n')) {
		const m = /^ {2,}([a-z][a-z0-9-]*):?\s{2,}\S/.exec(line);
		if (m) found.add(m[1]);
	}
	helpCache.set(key, found);
	return found;
}

/**
 * Fail on a missing capability by naming it. An `asc` too old for territory
 * pricing is a normal state; dumping its usage screen at the user is not an
 * answer to "why did ship price stop".
 */
async function requireAsc(path) {
	const parent = path.slice(0, -1);
	const leaf = path[path.length - 1];
	const have = await subcommandsOf(parent);
	if (have.has(leaf)) return;
	throw new ShipError(`the installed asc has no \`${path.join(' ')}\` command`, {
		hint:
			`\`asc ${parent.join(' ')} --help\` offers: ${[...have].join(', ') || '(nothing this tool recognises)'}\n` +
			'ship price needs `asc pricing current`, `asc pricing schedule` and `asc subscriptions pricing prices`. Update asc, then retry.',
	});
}

// ─── live reads ──────────────────────────────────────────────────────────────

/** asc emits `{data:[...]}` for raw API payloads and a bare array once unwrapped. */
function rows(payload) {
	if (Array.isArray(payload)) return payload;
	if (Array.isArray(payload?.data)) return payload.data;
	if (Array.isArray(payload?.items)) return payload.items;
	if (payload && typeof payload === 'object') return [payload];
	return [];
}

const idOf = (v) => (typeof v === 'string' ? v : (v?.id ?? v?.data?.id ?? null));

/**
 * Normalise one live price row. Territories arrive as alpha-3 ids on the raw
 * JSON:API shape and as names or codes on the flattened one; prices arrive as
 * strings. A row we cannot read is dropped, never guessed — an unreadable price
 * must not become a price we overwrite unguarded.
 */
function livePrice(r) {
	const a = r?.attributes ?? {};
	const price = num(a.customerPrice ?? r?.customerPrice ?? a.price ?? r?.price, Number.NaN);
	const territory = normaliseTerritory(
		idOf(r?.territory) ??
			idOf(a.territory) ??
			r?.territoryCode ??
			a.territoryCode ??
			idOf(r?.relationships?.territory?.data) ??
			'',
	);
	if (!territory || !Number.isFinite(price)) return null;
	return {
		territory,
		price,
		currency: a.currency ?? a.currencyCode ?? r?.currency ?? r?.currencyCode ?? null,
	};
}

const priceMap = (payload) => {
	const map = new Map();
	for (const r of rows(payload)) {
		const p = livePrice(r);
		if (p && !map.has(p.territory)) map.set(p.territory, p);
	}
	return map;
};

/** Subscriptions in the app, flattened to the three fields anything here needs. */
async function listSubscriptions(appId) {
	const payload = await asc(['subscriptions', 'list', '--app', appId, '--paginate'], { fallback: null });
	return rows(payload)
		.map((s) => ({
			id: s?.id ?? s?.attributes?.id ?? null,
			productId: s?.productId ?? s?.attributes?.productId ?? null,
			name: s?.name ?? s?.attributes?.name ?? s?.attributes?.referenceName ?? null,
		}))
		.filter((s) => s.id || s.productId);
}

async function resolveSubscription(appId, flags) {
	if (flags.subscription) return String(flags.subscription);
	const subs = await listSubscriptions(appId);
	if (!subs.length)
		throw new ShipError('this app has no subscriptions', {
			hint: 'pass --app-price to price the app itself, or --subscription <id> if asc cannot list them',
		});
	if (subs.length > 1)
		throw new ShipError(`this app has ${subs.length} subscriptions; name the one to price`, {
			hint: `--subscription ${subs.map((s) => s.productId ?? s.id).join(' | ')}`,
		});
	return subs[0].id ?? subs[0].productId;
}

/** Live per-territory prices for a subscription. Throws rather than guessing. */
async function subscriptionPrices(subId, appId) {
	const payload = await asc([
		'subscriptions', 'pricing', 'prices', 'list',
		'--subscription-id', subId, '--app', appId, '--resolved', '--paginate',
	]);
	return priceMap(payload);
}

// ─── plan (offline) ──────────────────────────────────────────────────────────

const planFileOf = (cfg) => join(cfg.paths.pricing, 'plan.json');

async function readPlanFile(cfg) {
	const file = planFileOf(cfg);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

/**
 * The floor is a business rule, not a constant: a subscription that nets less
 * than a third of what you pay for an install can never repay one, so the ads
 * target sets the floor whenever it is configured.
 */
function floorFor(cfg, flags) {
	if (flags.floor !== undefined) return Math.max(0, num(flags.floor, MIN_PROCEEDS_USD));
	const cpi = num(cfg.ads?.targetCpi, 0);
	return cpi > 0 ? Math.max(MIN_PROCEEDS_USD, round2(cpi / 3)) : MIN_PROCEEDS_USD;
}

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
		{ header: 'price', get: (r) => fmt(r) },
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
			`| ${r.territory} | ${fmt(r)} | $${r.usdEquivalent.toFixed(2)} | ${r.basisPct}% | ${r.effectivePct}% | ` +
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
	if (!flags['app-price']) {
		await requireAsc(['subscriptions', 'pricing', 'prices']);
		const subs = await listSubscriptions(appId);
		const wanted = flags.subscription ? String(flags.subscription) : null;
		const picked = wanted
			? (subs.find((s) => s.id === wanted || s.productId === wanted) ?? { id: wanted, productId: wanted, name: null })
			: (subs.length === 1 ? subs[0] : null);
		if (picked) {
			subscription = picked;
			subPrices = await subscriptionPrices(picked.id ?? picked.productId, appId).catch((err) => {
				warn(`subscription prices unavailable: ${err.message}`);
				return new Map();
			});
		} else if (subs.length > 1) {
			warn(`${subs.length} subscriptions; --subscription <id> to see per-territory prices`);
		}
	}

	const live = flags['app-price'] ? appPrices : (subPrices.size ? subPrices : appPrices);
	const planDoc = await readPlanFile(cfg);
	const diff = planDoc ? reconcile(planDoc.rows, live, { maxDelta: Number.POSITIVE_INFINITY }) : null;

	if (flags.json)
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

	heading(`Pricing · ${cfg.name} (${appId})`);
	if (subscription) info(`subscription ${subscription.productId ?? subscription.id}${subscription.name ? ` — ${subscription.name}` : ''}`);
	const sched = rows(schedule)[0];
	if (sched) {
		const id = sched.id ?? sched.attributes?.id ?? '—';
		const start = sched.attributes?.startDate ?? sched.startDate ?? 'immediate';
		info(`price schedule ${id} · starts ${start}`);
	} else note('no app price schedule (a free app has none)');

	if (!live.size) {
		note('no live prices readable for this target');
	} else {
		const shown = [...live.values()].sort((a, b) => a.territory.localeCompare(b.territory));
		table(shown, [
			{ header: 'terr', get: (r) => r.territory },
			{ header: 'live', get: (r) => `${r.price} ${r.currency ?? ''}`.trim() },
		]);
	}

	process.stdout.write('\n');
	if (!planDoc) {
		note(`no local plan at ${planFileOf(cfg)} — run \`ship price plan\``);
		return 0;
	}
	step(`plan vs live (base $${num(planDoc.baseUsd).toFixed(2)}, generated ${planDoc.generatedAt})`);
	if (!diff.changes.length && !diff.added.length) {
		good(`all ${diff.unchanged.length} planned territories already match`);
		return 0;
	}
	table([...diff.changes, ...diff.added], [
		{ header: 'terr', get: (r) => r.territory },
		{ header: 'live', get: (r) => (r.from == null ? c.dim('unset') : String(r.from)) },
		{ header: 'plan', get: (r) => `${Number(r.to).toFixed(r.decimals)} ${r.currency}` },
		{ header: 'delta', get: (r) => (r.delta == null ? '' : `${r.delta > 0 ? '+' : ''}${Math.round(r.delta * 100)}%`) },
	]);
	info(`${diff.changes.length} moves, ${diff.added.length} unset, ${diff.unchanged.length} already correct`);
	return 0;
}

// ─── apply ───────────────────────────────────────────────────────────────────

/** A mutation that participates in --dry-run; returns null when skipped. */
async function ascMutate(args) {
	const res = await exec(ASC, [...args, '--output', 'json'], { mutating: true, allowFail: true });
	if (res.skipped) return { skipped: true };
	if (res.code !== 0)
		throw new ShipError(`asc ${args.slice(0, 4).join(' ')} exited ${res.code}`, {
			hint: (res.stderr || res.stdout).trim().split('\n').slice(-8).join('\n'),
		});
	return { skipped: false };
}

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
	const diff = reconcile(planDoc.rows, live, { maxDelta, force });

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
	const diff = reconcile([row], live, { maxDelta, force });
	if (diff.blocked.length) {
		const b = diff.blocked[0];
		throw new ShipError(
			`${baseTerritory} ${b.from} → ${Number(b.to).toFixed(b.decimals)} is ${Math.round(b.delta * 100)}%, over --max-delta ${Math.round(maxDelta * 100)}%`,
			{ hint: 'nothing was applied. --force if the move is deliberate.' },
		);
	}
	if (!diff.changes.length && !diff.added.length) {
		if (flags.json) return emit({ target: 'app', applied: [], unchanged: [baseTerritory] });
		good(`app price in ${baseTerritory} already ${fmt(row)}`);
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
	good(`app price schedule ${res.skipped ? 'planned' : 'created'}: ${fmt(row)} in ${baseTerritory}`);
	warn(
		`the remaining ${planDoc.rows.length - 1} rows of the plan were NOT applied: asc creates app price schedules from a single base territory, ` +
			'so Apple will equalize the rest by FX. Per-territory pricing that respects the plan needs a subscription (`ship price apply`).',
	);
	return 0;
}

const SUB = { show, plan, apply };

export async function run({ args, flags }) {
	const [name = 'show'] = args;
	const fn = SUB[name];
	if (!fn)
		throw new ShipError(`unknown subcommand "${name}"`, {
			hint: `ship price ${Object.keys(SUB).join(' | ')}`,
		});
	return fn({ args: args.slice(1), flags });
}

// Pure pricing: the territory table, the price ladders, and the derivations.
//
// Three operational facts shape this module:
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
//
// Nothing here touches the filesystem, the network, or the clock — `derivePlan`
// is the thing tests pin and the thing reviewers read. The orchestration that
// prints and pushes these numbers lives in commands/price.mjs; the asc plumbing
// in lib/price-asc.mjs.
import { ShipError } from '../log.mjs';
import { num, round1, round2 } from './fmt.mjs';
import { rowsOf } from './asc-report.mjs';

/** Mid-market FX snapshot the territory table was derived from. */
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

/** A plan row as it reads on a tag: `4.99 USD`. */
export const priceLabel = (row) => `${Number(row.price).toFixed(row.decimals ?? 2)} ${row.currency}`;

/**
 * Compare a derived table against live prices and split it by the delta gate.
 * Pure, and separate from the pushing, because "which prices would move, and by
 * how much" is the question you want answered before anything moves. Named
 * `reconcilePrices` — lib/asa.mjs has a different `reconcile` for Apple Ads.
 *
 * @param {object[]} rows plan rows
 * @param {Map<string,{price:number,currency?:string}>|object} live per-territory live prices
 * @param {{maxDelta?:number, force?:boolean}} opts maxDelta is a fraction: 0.5 = 50%
 */
export function reconcilePrices(rows, live, { maxDelta = 0.5, force = false } = {}) {
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

/** ASC offer durations, plus the ISO 8601 durations the same field arrives as. */
const OFFER_DAYS = {
	THREE_DAYS: 3, ONE_WEEK: 7, TWO_WEEKS: 14, ONE_MONTH: 30,
	TWO_MONTHS: 60, THREE_MONTHS: 90, SIX_MONTHS: 180, ONE_YEAR: 365,
	P3D: 3, P1W: 7, P2W: 14, P1M: 30, P2M: 60, P3M: 90, P6M: 180, P1Y: 365,
};

/**
 * Days in a subscription's introductory offer, or null when there is nothing to
 * read. An intro offer hangs off a relationship `asc subscriptions list` does
 * not include, so null is the honest answer far more often than not — and it is
 * not zero, because zero means "this app has no trial" and warns about it.
 */
export function trialDaysOf(s) {
	const a = s?.attributes ?? {};
	const offer = rowsOf(a.introductoryOffers ?? s?.introductoryOffers ?? a.introductoryOffer ?? s?.introductoryOffer)[0];
	const raw =
		offer?.attributes?.duration ??
		offer?.duration ??
		a.introductoryOfferDuration ??
		s?.introductoryOfferDuration ??
		null;
	if (raw == null) return null;
	return OFFER_DAYS[String(raw).trim().toUpperCase()] ?? null;
}

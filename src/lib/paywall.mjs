// The post-install funnel: onboarding → paywall → purchase.
//
// Everything else in `ship` stops at the install. `ship analytics funnel` ends
// where the money starts, `ship rc audit` proves the paywall *renders* but says
// nothing about whether its shape can convert, and `ship price` derives a
// per-territory table from a base price nobody ever argued with. This module is
// the missing half, and it is pure on purpose: the numbers below are contested
// business rules, so they belong in one file with tests around them rather than
// scattered through command output.
//
// Four operational facts shape the thresholds:
//
//  1. **Install → paid is the only conversion number that matters, and 3% is the
//     floor.** Below it, no amount of ASO pays for itself: ads bid against a
//     conversion rate, and `ads.targetCpi` is only affordable if a download
//     eventually buys. ~5% is a working app, 10%+ is a well-tuned one.
//  2. **Reaching the paywall is a measurable stage, not a design opinion.** An
//     onboarding that loses a quarter of its users before the paywall has
//     capped its own conversion rate at 75% of whatever the paywall can do.
//     Every screen either earns its place in that number or is deleted.
//  3. **Screen count is a trade, not a target.** More screens qualify harder:
//     fewer users arrive, but the ones who do have higher intent. So the band is
//     wide (10-15) and the *unmeasured* case is the finding — a funnel with no
//     instrumentation cannot be tuned in either direction.
//  4. **A yearly above $49.99 buys refunds, not revenue.** In the EU the 14-day
//     right of withdrawal makes a refund request essentially automatic for a
//     non-usage-based app, so a high yearly converts once and reverses later.
//     The same asymmetry is why the retention (exit) offer sits *below* the
//     yearly and is only shown to subscribers who are not already on it —
//     offered to a yearly subscriber it is a discount, not a save.

/** Onboarding shape. `paywallReach` is the one hard gate; the band is advice. */
export const ONBOARDING = {
	minScreens: 10,
	maxScreens: 15,
	maxQuizScreens: 4,
	paywallReach: 0.75,
};

/** Install → paid tiers. Below `floor`, acquisition cannot pay for itself. */
export const CONVERSION = { floor: 0.03, healthy: 0.05, excellent: 0.1 };

/**
 * The reference ladder. Not a recommendation to copy — a set of edges that cost
 * money when crossed, derived from what the category leaders converged on.
 */
export const LADDER = {
	annualUsd: 49.99,
	monthlyUsd: 14.99,
	weeklyUsd: 7.99,
	/** Retention offer shown at "manage subscription", below the yearly. */
	winbackUsd: 24.99,
};

/** Offering lookup keys that mean "this is the save offer, not the paywall". */
export const WINBACK_PATTERN = /win.?back|retention|exit|save|downsell|cancel/i;

const num = (v) => {
	const n = typeof v === 'string' ? Number(v.replace(/[^0-9.-]/g, '')) : Number(v);
	return Number.isFinite(n) ? n : 0;
};
const rate = (top, bottom) => (bottom > 0 ? top / bottom : 0);
export const pct = (n) => `${(n * 100).toFixed(1)}%`;

// ─── install → paid ──────────────────────────────────────────────────────────

const TIER = {
	dead: {
		tier: 'dead',
		means: 'nobody is buying',
		fix: 'the paywall is the whole problem: check `ship rc audit` first — a paywall with no current offering renders empty and reads as 0%.',
	},
	below: {
		tier: 'below',
		means: 'conversion is under the 3% floor, so paid acquisition cannot break even',
		fix: 'onboarding, not pricing. Sell the outcome before the price appears; the worst-drop step before the paywall is the first thing to cut.',
	},
	floor: {
		tier: 'floor',
		means: 'above the floor but under the ~5% a working app sees',
		fix: 'test the paywall itself — social proof above the title, outcome-led headline, and the price ladder the category leaders use.',
	},
	healthy: { tier: 'healthy', means: 'a working funnel', fix: 'raise it with paywall A/B tests through RevenueCat, which need no app review.' },
	excellent: { tier: 'excellent', means: 'a well-tuned funnel', fix: 'spend here: this rate can afford acquisition.' },
};

/**
 * Where an install → paid rate sits against the tiers that decide what to fix.
 * @param {number} r installs-to-paid rate as a fraction
 */
export function conversionTier(r) {
	const value = Math.max(0, num(r));
	const band =
		value <= 0 ? TIER.dead
		: value < CONVERSION.floor ? TIER.below
		: value < CONVERSION.healthy ? TIER.floor
		: value < CONVERSION.excellent ? TIER.healthy
		: TIER.excellent;
	return { rate: value, ...band, healthy: value >= CONVERSION.healthy };
}

// ─── onboarding funnel ───────────────────────────────────────────────────────

/**
 * A step's role. `paywall` terminates the onboarding funnel; `quiz` steps are
 * counted separately because a long quiz is the most common source of drop-off
 * that feels productive to build.
 */
const roleOf = (s) => {
	const kind = String(s?.kind ?? s?.type ?? '').toLowerCase();
	if (kind) return kind;
	const name = String(s?.name ?? s?.step ?? s?.event ?? '').toLowerCase();
	if (/paywall|purchase|subscribe|offer/.test(name)) return 'paywall';
	if (/quiz|question|survey|q\d/.test(name)) return 'quiz';
	return 'screen';
};

/**
 * Fold ordered funnel steps into per-step drop-off plus the three numbers that
 * decide whether the onboarding is the problem: how many reach the paywall, how
 * many screens it takes, and which single step loses the most users.
 *
 * Users are absolute counts at each step, in order, as PostHog exports them.
 * Non-monotonic counts (a step showing more users than the one before it) are a
 * broken export, not a funnel, and are reported rather than smoothed.
 *
 * @param {Array<{name?:string, users?:number, kind?:string}>} input
 */
export function onboardingFunnel(input) {
	const steps = (Array.isArray(input) ? input : []).map((s, i) => ({
		name: String(s?.name ?? s?.step ?? s?.event ?? `step ${i + 1}`),
		users: num(s?.users ?? s?.count ?? s?.value),
		role: roleOf(s),
	}));

	const entered = steps.length ? steps[0].users : 0;
	let prev = entered;
	let regressed = false;
	for (const s of steps) {
		s.dropRate = rate(prev - s.users, prev);
		s.reach = rate(s.users, entered);
		if (s.users > prev) regressed = true;
		prev = s.users;
	}

	const paywallIdx = steps.findIndex((s) => s.role === 'paywall');
	const paywall = paywallIdx >= 0 ? steps[paywallIdx] : null;
	// Screens before the paywall are the onboarding; the paywall is not one of them.
	const screens = paywallIdx >= 0 ? paywallIdx : steps.length;
	const quizScreens = steps.slice(0, screens).filter((s) => s.role === 'quiz').length;
	const reach = paywall ? rate(paywall.users, entered) : 0;

	// Only steps before the paywall are onboarding problems; drop-off *on* the
	// paywall is a pricing and copy problem and has its own tier scale.
	const body = steps.slice(1, screens);
	const worst = body.reduce((a, b) => (b.dropRate > (a?.dropRate ?? -1) ? b : a), null);

	const findings = [];
	const add = (level, name, detail) => findings.push({ level, name, detail });

	if (!steps.length) add('fail', 'instrumentation', 'no onboarding funnel recorded — an uninstrumented onboarding cannot be tuned in either direction');
	if (regressed) add('fail', 'export', 'a step reports more users than the step before it — this is not an ordered funnel export');

	if (!paywall && steps.length)
		add('fail', 'paywall step', 'no paywall step in the funnel — the one number worth gating on cannot be computed');
	else if (paywall) {
		if (reach >= ONBOARDING.paywallReach) add('ok', 'paywall reach', `${pct(reach)} of entrants reach the paywall`);
		else
			add(
				'fail',
				'paywall reach',
				`${pct(reach)} reach the paywall, under the ${pct(ONBOARDING.paywallReach)} floor — conversion is capped at ${pct(reach)} of whatever the paywall can do`,
			);
	}

	if (steps.length) {
		if (screens < ONBOARDING.minScreens)
			add('warn', 'screens', `${screens} screens before the paywall — under ${ONBOARDING.minScreens}, most funnels have not convinced the user they have a problem yet`);
		else if (screens > ONBOARDING.maxScreens)
			add('warn', 'screens', `${screens} screens before the paywall — over ${ONBOARDING.maxScreens} qualifies hard; only keep them if reach stays above ${pct(ONBOARDING.paywallReach)}`);
		else add('ok', 'screens', `${screens} screens before the paywall`);
	}

	if (quizScreens > ONBOARDING.maxQuizScreens)
		add('warn', 'quiz', `${quizScreens} quiz screens — over ${ONBOARDING.maxQuizScreens} the quiz stops feeling frictionless`);

	if (worst && worst.dropRate > 0)
		add(
			worst.dropRate >= 0.25 ? 'warn' : 'ok',
			'worst step',
			`${worst.name} loses ${pct(worst.dropRate)}${worst.dropRate >= 0.25 ? ' — this is the screen to cut or rewrite first' : ''}`,
		);

	return {
		entered,
		steps,
		screens,
		quizScreens,
		reach,
		worst,
		healthy: !findings.some((f) => f.level === 'fail' || f.level === 'warn'),
		findings,
	};
}

// ─── the price ladder ────────────────────────────────────────────────────────

/** ASC enums and ISO 8601 durations, collapsed to the four periods that price. */
const PERIODS = [
	[/^(P1W|ONE_WEEK|WEEKLY?)$/i, 'weekly'],
	[/^(P1M|ONE_MONTH|MONTHLY?)$/i, 'monthly'],
	[/^(P2M|TWO_MONTHS|P3M|THREE_MONTHS|P6M|SIX_MONTHS)$/i, 'other'],
	[/^(P1Y|ONE_YEAR|YEARLY?|ANNUAL)$/i, 'annual'],
];

/** @returns {'weekly'|'monthly'|'annual'|'other'|null} */
export function normalisePeriod(raw) {
	const s = String(raw ?? '').trim();
	if (!s) return null;
	for (const [re, name] of PERIODS) if (re.test(s)) return name;
	return null;
}

const byPeriod = (subs, period) => subs.filter((s) => normalisePeriod(s.period) === period);

/**
 * Audit the shape of the ladder — not the per-territory numbers (`ship price`
 * owns those), the edges that cost money regardless of storefront.
 *
 * @param {{subscriptions?:Array<{name?:string, productId?:string, period?:string, priceUsd?:number, trialDays?:number}>,
 *          offerings?:Array<{lookup_key?:string, is_current?:boolean}>}} input
 * @returns {{level:'ok'|'warn'|'fail', name:string, detail:string}[]}
 */
export function auditLadder({ subscriptions = [], offerings = [] } = {}) {
	const rows = [];
	const add = (level, name, detail = '') => rows.push({ level, name, detail });
	const subs = (Array.isArray(subscriptions) ? subscriptions : []).map((s) => ({
		label: s?.name ?? s?.productId ?? '(unnamed)',
		period: s?.period ?? null,
		priceUsd: s?.priceUsd == null ? null : num(s.priceUsd),
		trialDays: num(s?.trialDays),
	}));

	if (!subs.length) {
		add('fail', 'ladder', 'no subscriptions found — nothing to price');
		return rows;
	}

	const annual = byPeriod(subs, 'annual');
	const weekly = byPeriod(subs, 'weekly');
	const monthly = byPeriod(subs, 'monthly');

	if (!annual.length)
		add('fail', 'annual tier', 'no yearly subscription — the yearly is where the revenue is, and MRR without it is a vanity number');
	else add('ok', 'annual tier', annual.map((s) => s.label).join(', '));

	if (!weekly.length && !monthly.length)
		add('warn', 'short tier', 'yearly only — a weekly or monthly tier catches the users who will not commit for a year');
	else add('ok', 'short tier', [...weekly, ...monthly].map((s) => s.label).join(', '));

	const over = annual.filter((s) => s.priceUsd != null && s.priceUsd > LADDER.annualUsd);
	if (over.length)
		add(
			'warn',
			'annual price',
			`${over.map((s) => `${s.label} $${s.priceUsd}`).join(', ')} is above $${LADDER.annualUsd} — in the EU the 14-day right of withdrawal makes refunds near-automatic for a non-usage-based app, so this converts once and reverses`,
		);
	else if (annual.some((s) => s.priceUsd != null)) add('ok', 'annual price', `at or under $${LADDER.annualUsd}`);

	const weeklyTrial = weekly.filter((s) => s.trialDays > 0);
	if (weeklyTrial.length)
		add('warn', 'trial placement', `${weeklyTrial.map((s) => s.label).join(', ')} has a ${weeklyTrial[0].trialDays}-day trial — a trial on the weekly cannibalises the yearly it should be qualifying for`);
	else if (annual.length && !annual.some((s) => s.trialDays > 0))
		add('warn', 'trial placement', 'no trial on the yearly — the standard shape is a 7-day trial on the yearly and no trial on the weekly');
	else if (annual.some((s) => s.trialDays > 0)) add('ok', 'trial placement', `trial on the yearly only`);

	const offers = Array.isArray(offerings) ? offerings : [];
	const winback = offers.filter((o) => WINBACK_PATTERN.test(String(o?.lookup_key ?? o?.id ?? '')));
	if (!offers.length) add('skip', 'retention offer', 'no offerings passed — cannot tell whether an exit offer exists');
	else if (!winback.length)
		add(
			'warn',
			'retention offer',
			`no win-back offering — "manage subscription" should ask why first and then offer ~$${LADDER.winbackUsd}/year to subscribers not already on the yearly`,
		);
	else if (winback.some((o) => o.is_current))
		add('fail', 'retention offer', `${winback.find((o) => o.is_current).lookup_key} is marked current — the save offer is being served as the main paywall`);
	else add('ok', 'retention offer', winback.map((o) => o.lookup_key).join(', '));

	return rows;
}

// From "which stage is losing users" to "what to go and change".
//
// `bottleneck` in report-parse.mjs answers the first question over three
// numbers Apple gives everyone. This answers the second, over the whole chain
// from impression to renewal, and it exists because the stages are not
// independent: fixing onboarding while the product page leaks is work spent on
// users who never arrive. So the verdict is the *first* failing stage in funnel
// order, and everything after it is reported but not blamed.
//
// The one stage outside that order is quality. A crashing app fails every
// downstream stage as a symptom, so a crash rate over the bar is diagnosed
// first and the funnel reading is marked untrustworthy rather than acted on.
//
// A stage with no data is `unknown`, never `pass`. Apple does not produce a
// sessions report for every app, and "we cannot see it" must not read as "it is
// fine" — that is the same rule `ship qa` applies to Tier 2 and `aso volume` to
// Apple's popularity floor.
import { BENCHMARK } from './report-parse.mjs';
import { CONVERSION, ONBOARDING } from './paywall.mjs';
import { flowsIn } from './flows.mjs';

/**
 * Bars for the three signals Apple added that shipkit had no benchmark for.
 *
 * These are conventions, not measurements, and they are here rather than inline
 * so a project that knows better can argue with a number instead of a branch.
 *   · `deletionRate` — deletions over installs in the window. A third of a
 *     cohort gone is the widely-quoted 30-day figure for consumer utilities.
 *   · `sessionsPerDevice` — below 2 in a 30-day window nobody came back once.
 *   · `crashesPerDevice` — Apple's own quality bar is roughly 1%.
 */
export const HEALTH = { deletionRate: 0.35, sessionsPerDevice: 2, crashesPerDevice: 0.01 };

/**
 * The pulled funnel file. The health blocks are absent whenever Apple produced
 * no such report for the app, which is not the same as their being zero.
 * @typedef {{
 *   impressions?: number, pageViews?: number, installs?: number,
 *   retention?: {rate: number|null}|null,
 *   sessions?: {perDevice: number|null}|null,
 *   crashes?: {crashes?: number, perDevice?: number|null}|null,
 * }} FunnelDoc
 */
/**
 * @typedef {{
 *   stage: string, verdict: 'pass'|'fail'|'unknown', group: string,
 *   measured: number|null, benchmark: number, means: string, fix: string, needs?: string,
 * }} Verdict
 */

/** @type {(measured: number|null, benchmark: number, over?: boolean) => 'pass'|'fail'|'unknown'} */
const judge = (measured, benchmark, over = false) =>
	measured === null ? 'unknown' : (over ? measured <= benchmark : measured >= benchmark) ? 'pass' : 'fail';

/** @type {(top: number, bottom: number|null|undefined) => number|null} */
const ratio = (top, bottom) => (bottom ? top / bottom : null);

/**
 * The chain, in the order a user walks it. `over` marks a stage where a *high*
 * number is the failure — deletions and crashes — so one comparison serves all.
 * @type {Array<{key: string, stage: string, group: string, benchmark: number, over?: boolean, means: string, fix: string, needs: string}>}
 */
const STAGES = [
	{
		key: 'view', stage: 'impression→pageview', group: 'activation', benchmark: BENCHMARK.viewRate,
		means: 'people see the search result and scroll past it',
		fix: 'icon, title and subtitle are all a search result shows — `ship aso score`, then rewrite them around terms that convert',
		needs: 'ship analytics pull',
	},
	{
		key: 'install', stage: 'pageview→install', group: 'activation', benchmark: BENCHMARK.installRate,
		means: 'people open the product page and leave',
		fix: 'screenshots 1-2 carry the decision — `ship design spec`, then `ship shots`',
		needs: 'ship analytics pull',
	},
	{
		key: 'activation', stage: 'install→paywall', group: 'activation', benchmark: ONBOARDING.paywallReach,
		means: 'people install, start onboarding and quit before they are asked to pay',
		fix: 'cut screens before the paywall, and move the first moment of value ahead of the first question asked',
		needs: 'ship analytics onboarding --file <export>',
	},
	{
		key: 'retention', stage: 'install→kept', group: 'core', benchmark: HEALTH.deletionRate, over: true,
		means: 'people install, try it once and delete it',
		fix: 'a core-loop problem, not a listing one: the app does not do the thing the listing promised on day one',
		needs: 'ship analytics pull (Apple’s Installation and Deletion report)',
	},
	{
		key: 'engagement', stage: 'sessions per device', group: 'retention', benchmark: HEALTH.sessionsPerDevice,
		means: 'people keep the app but never open it again',
		fix: 'nothing brings them back — reminders, notifications and visible progress are the retention flows',
		needs: 'ship analytics pull (Apple’s App Sessions report)',
	},
	{
		key: 'monetization', stage: 'install→paid', group: 'monetization', benchmark: CONVERSION.healthy,
		means: 'people reach the paywall and do not buy',
		fix: 'paywall copy, price ladder and trial length — `ship paywall audit`',
		needs: 'ship analytics onboarding --paid <n>',
	},
];

/**
 * Crash rate, judged before anything else.
 *
 * Kept out of {@link STAGES} because it is not a stage: a crashing app fails
 * every later stage as a *symptom*, so blaming the funnel's first leak would
 * send someone to rewrite a paywall that works.
 * @param {{crashes?: number, perDevice?: number|null}|null|undefined} crashes
 * @returns {Verdict}
 */
export function quality(crashes) {
	const measured = crashes?.perDevice ?? null;
	return {
		stage: 'crash rate', group: 'edge', measured, benchmark: HEALTH.crashesPerDevice,
		verdict: judge(measured, HEALTH.crashesPerDevice, true),
		means: 'the app is crashing often enough that every number below it is a symptom',
		fix: 'fix the crash before reading the funnel — a crashing build cannot be A/B tested out of',
		needs: 'ship analytics pull (Apple’s App Crashes report)',
	};
}

/**
 * What each stage measured, or null where the input is missing.
 *
 * @param {FunnelDoc|null} funnel
 * @param {{reach?: number}|null} onboarding
 * @param {{paid?: number|null, installs?: number|null}|null} revenue
 * @returns {Record<string, number|null>}
 */
export function measurements(funnel, onboarding, revenue) {
	const impressions = funnel?.impressions ?? 0;
	const pageViews = funnel?.pageViews ?? 0;
	const installs = funnel?.installs ?? 0;
	const deletionRate = funnel?.retention?.rate ?? null;
	return {
		view: ratio(pageViews, impressions),
		install: ratio(installs, pageViews),
		activation: onboarding?.reach ?? null,
		retention: deletionRate,
		engagement: funnel?.sessions?.perDevice ?? null,
		// No paid figure at all is not a conversion rate of zero. Nobody has
		// entered it, which is `unknown`; a real 0 would blame the paywall for a
		// number the pull never carried.
		monetization: typeof revenue?.paid === 'number' ? ratio(revenue.paid, revenue.installs || installs) : null,
	};
}

/**
 * The whole chain, and the one stage worth working on.
 *
 * @param {Parameters<typeof measurements>[0]} funnel
 * @param {Parameters<typeof measurements>[1]} onboarding
 * @param {Parameters<typeof measurements>[2]} revenue
 * @returns {{verdicts: Verdict[], crash: Verdict, culprit: Verdict|null, unknown: Verdict[]}}
 */
export function diagnose(funnel, onboarding, revenue) {
	const measured = measurements(funnel, onboarding, revenue);
	const verdicts = STAGES.map(function one(s) {
		return {
			stage: s.stage, group: s.group, benchmark: s.benchmark, means: s.means, fix: s.fix, needs: s.needs,
			measured: measured[s.key],
			verdict: judge(measured[s.key], s.benchmark, s.over),
		};
	});
	const crash = quality(funnel?.crashes);
	// A crash problem outranks the funnel; otherwise the earliest leak wins,
	// because every later stage is measured on the users it already lost.
	const culprit = crash.verdict === 'fail' ? crash : (verdicts.find(failed) ?? null);
	return { verdicts, crash, culprit, unknown: verdicts.filter(unknown) };
}

/** @param {Verdict} v */
function failed(v) {
	return v.verdict === 'fail';
}

/** @param {Verdict} v */
function unknown(v) {
	return v.verdict === 'unknown';
}

/**
 * The flows to re-research and the screens that implement them.
 *
 * This is the join the flow vocabulary exists for: a verdict names a group,
 * `flowsIn` turns it into flow ids, and `design/ux.json` says which screens
 * carry them. Without a ux spec the flows still answer — a diagnosis that names
 * journeys is useful before any screen exists.
 *
 * @param {Verdict|null} verdict
 * @param {{screens?: Array<{id?: string, route?: string, flow?: string}>}|null} ux
 * @returns {{flows: string[], screens: Array<{id: string, route: string, flow: string}>}}
 */
export function implicated(verdict, ux) {
	if (!verdict) return { flows: [], screens: [] };
	const flows = flowsIn(verdict.group);
	const wanted = new Set(flows);
	const screens = (ux?.screens ?? [])
		.filter((s) => wanted.has(String(s.flow)))
		.map(function pick(s) {
			return { id: String(s.id ?? ''), route: String(s.route ?? ''), flow: String(s.flow ?? '') };
		});
	return { flows, screens };
}

/**
 * The revenue pair as the onboarding artifact carries it.
 *
 * `paid` absent and `paid: 0` are different claims and only the second is a
 * measurement, so a missing field stays missing here rather than becoming a
 * zero that would blame the paywall for a number nobody ever entered.
 * @param {{paid?: any, installs?: any}|null|undefined} onboardingDoc
 * @param {FunnelDoc|null|undefined} funnelDoc
 * @param {(v: any) => number} toNumber
 * @returns {{paid: number|null, installs: number}}
 */
export function revenueOf(onboardingDoc, funnelDoc, toNumber) {
	const raw = onboardingDoc?.paid;
	return {
		paid: raw === undefined || raw === null || raw === '' ? null : toNumber(raw),
		installs: toNumber(onboardingDoc?.installs) || toNumber(funnelDoc?.installs),
	};
}

/**
 * `true` where a *low* number is the healthy one, which is what decides whether
 * the printed benchmark reads `≤` or `≥`.
 * @param {Verdict} v
 * @returns {boolean}
 */
export const wantsLow = (v) => v.stage === 'crash rate' || v.stage === 'install→kept';

/**
 * Every row of the printed table, crash first.
 * @param {ReturnType<typeof diagnose>} out
 * @returns {Verdict[]}
 */
export const verdictRows = (out) => [out.crash, ...out.verdicts];

/**
 * The stages whose input is missing, crash included, each with the command that
 * would answer it. Naming the missing input matters more than the missing row.
 * @param {ReturnType<typeof diagnose>} out
 * @returns {Array<{stage: string, needs: string}>}
 */
export const unmeasured = (out) =>
	verdictRows(out).filter(unknown).map(function need(v) {
		return { stage: v.stage, needs: v.needs ?? '' };
	});

// The flow vocabulary — one closed list of the journeys an app is made of.
//
// Four subsystems need to name the same things and, before this file, three of
// them made up their own names. `lib/paywall.mjs` classifies an exported funnel
// step as `paywall`/`quiz`/`screen`; `lib/report-parse.mjs` names store stages;
// the research layer asks "how do successful apps do onboarding"; the UX spec
// says which screen belongs to which journey; the generated app emits analytics
// events. If those four disagree by one word, a funnel export cannot be joined
// to the screen that produced it and the loop never closes.
//
// So the vocabulary is closed and lives here. A flow id is the join key across
// research references, `design/ux.json`, analytics event names and QA captures.
// Adding a flow is a deliberate edit to this file, which is the point: an
// open-ended taxonomy is how "onboarding_complete" and "onboardingCompleted"
// end up in the same dataset.
import { ShipError } from '../log.mjs';

/** Ordered groups. A flow belongs to exactly one. */
export const GROUPS = /** @type {const} */ (['activation', 'core', 'monetization', 'retention', 'edge']);

/** @typedef {(typeof GROUPS)[number]} Group */
/** One flow: what it is, and how a free-text step name is recognised as it. */
/** @typedef {{group: Group, label: string, purpose: string, match: RegExp}} Flow */

/**
 * Every flow, in reporting order — the order a human wants to read them in.
 * This is deliberately *not* the order {@link flowOf} matches in; see
 * {@link MATCH_ORDER}.
 * @type {Record<string, Flow>}
 */
export const FLOWS = {
	// ── activation ──────────────────────────────────────────────────────────
	'first-launch': {
		group: 'activation',
		label: 'First launch',
		purpose: 'the very first frame after install, before anything is asked',
		match: /first.?(launch|run|open)|cold.?start|app.?open/,
	},
	welcome: {
		group: 'activation',
		label: 'Welcome',
		purpose: 'name the product and set the promise in one screen',
		match: /welcome|splash|intro|get.?started|hello/,
	},
	'value-prop': {
		group: 'activation',
		label: 'Value proposition',
		purpose: 'why this app is worth the next sixty seconds',
		match: /value.?prop|benefit|why|carousel|tour|highlight/,
	},
	personalization: {
		group: 'activation',
		label: 'Personalization',
		purpose: 'collect the answers the product genuinely needs to differ per user',
		match: /personali[sz]|quiz|question|survey|goal|preference|q\d/,
	},
	permission: {
		group: 'activation',
		label: 'Permission request',
		purpose: 'ask the OS for a capability, after its value is visible',
		match: /permission|notification.?prompt| att |tracking.?prompt|camera.?access|location.?access|health.?access/,
	},
	account: {
		group: 'activation',
		label: 'Account creation',
		purpose: 'identity, only where the product cannot work without it',
		match: /sign.?(in|up)|log.?in|register|account|auth|otp|passkey/,
	},
	'first-value': {
		group: 'activation',
		label: 'First value',
		purpose: 'the first moment the user gets the thing they installed for',
		match: /first.?(value|result|log|entry|scan|aha)|aha|activation/,
	},

	// ── core ────────────────────────────────────────────────────────────────
	home: {
		group: 'core',
		label: 'Home',
		purpose: 'the screen the app returns to, and what it makes obvious',
		match: /home|dashboard|today|feed|overview|main/,
	},
	navigation: {
		group: 'core',
		label: 'Navigation',
		purpose: 'how the top-level areas are reached and returned from',
		match: /nav|tab.?bar|menu|drawer|sidebar/,
	},
	search: {
		group: 'core',
		label: 'Search',
		purpose: 'query entry, suggestions, and the shape of results',
		match: /search|query|autocomplete|filter|sort/,
	},
	discovery: {
		group: 'core',
		label: 'Discovery',
		purpose: 'finding something worth opening without knowing its name',
		match: /discover|browse|explore|categor|collection|recommend/,
	},
	detail: {
		group: 'core',
		label: 'Detail',
		purpose: 'one item in full, and the action it exists to enable',
		match: /detail|\bitem\b|profile|product.?page|entry.?view/,
	},
	create: {
		group: 'core',
		label: 'Create',
		purpose: 'adding something new, and how much friction that costs',
		match: /create|add|new.?(entry|item|post|log)|compose|capture|scan|log\b/,
	},
	edit: {
		group: 'core',
		label: 'Edit',
		purpose: 'changing something that already exists, including cancel',
		match: /edit|update|modify|rename|adjust/,
	},
	settings: {
		group: 'core',
		label: 'Settings',
		purpose: 'preferences, account management and the exits',
		match: /setting|preference|config|account.?manage|profile.?edit/,
	},

	// ── monetization ────────────────────────────────────────────────────────
	paywall: {
		group: 'monetization',
		label: 'Paywall',
		purpose: 'the offer screen: plans, framing, and the dismiss path',
		match: /paywall|\bpurchase\b|subscribe|subscription.?offer|offer|premium.?screen|checkout/,
	},
	trial: {
		group: 'monetization',
		label: 'Trial',
		purpose: 'how a free trial is explained, started and reminded about',
		match: /trial|free.?week|intro.?offer/,
	},
	upsell: {
		group: 'monetization',
		label: 'Upsell',
		purpose: 'a second ask, placed after value has been delivered',
		match: /upsell|upgrade|cross.?sell|win.?back|retention.?offer|downsell/,
	},
	'feature-gate': {
		group: 'monetization',
		label: 'Feature gate',
		purpose: 'the moment a locked feature is touched',
		match: /gate|locked|pro.?only|premium.?lock|limit.?reached/,
	},
	pricing: {
		group: 'monetization',
		label: 'Pricing presentation',
		purpose: 'how the numbers themselves are laid out and compared',
		match: /pricing|price.?(table|compare)|plan.?compare|tier/,
	},
	restore: {
		group: 'monetization',
		label: 'Restore purchases',
		purpose: 'the path back for someone who already paid',
		match: /restore|manage.?subscription|billing/,
	},

	// ── retention ───────────────────────────────────────────────────────────
	're-engagement': {
		group: 'retention',
		label: 'Re-engagement',
		purpose: 'bringing back a user who stopped coming',
		match: /re.?engag|win.?back.?campaign|lapsed|comeback|return.?user/,
	},
	notification: {
		group: 'retention',
		label: 'Notification',
		purpose: 'what is sent, when, and what it opens to',
		match: /notification|push|alert|inbox/,
	},
	streak: {
		group: 'retention',
		label: 'Streak',
		purpose: 'consecutive-use mechanics and what breaking one costs',
		match: /streak|consecutive|daily.?goal/,
	},
	progress: {
		group: 'retention',
		label: 'Progress',
		purpose: 'showing accumulated effort back to the user',
		match: /progress|history|stat|chart|trend|report|insight|achievement/,
	},
	reminder: {
		group: 'retention',
		label: 'Reminder',
		purpose: 'scheduled nudges the user configured themselves',
		match: /reminder|schedule|recurring/,
	},

	// ── edge ────────────────────────────────────────────────────────────────
	empty: {
		group: 'edge',
		label: 'Empty state',
		purpose: 'the screen before there is any data, which every new user sees',
		match: /empty|no.?(data|result|item)|zero.?state|blank/,
	},
	loading: {
		group: 'edge',
		label: 'Loading state',
		purpose: 'what is shown while waiting, and for how long',
		match: /loading|skeleton|spinner|placeholder|pending/,
	},
	error: {
		group: 'edge',
		label: 'Error state',
		purpose: 'what broke, whose fault it was, and what to do now',
		match: /error|failure|failed|crash|retry|problem/,
	},
	offline: {
		group: 'edge',
		label: 'Offline',
		purpose: 'behaviour with no network, including what stays usable',
		match: /offline|no.?(network|connection)|airplane|disconnected/,
	},
	undo: {
		group: 'edge',
		label: 'Undo',
		purpose: 'taking back an action without a confirmation dialog',
		match: /undo|revert|restore.?item|trash/,
	},
	destructive: {
		group: 'edge',
		label: 'Destructive action',
		purpose: 'delete, reset and cancel — the confirmations around them',
		match: /destructive|delete|remove|reset|cancel.?account|wipe/,
	},
};

/** Every flow id, in reporting order. */
export const FLOW_IDS = Object.keys(FLOWS);

/**
 * Group order for classification, most specific first.
 *
 * Reporting order and matching order are different jobs and pulled in opposite
 * directions. A screen called "paywall shown" is about the paywall, and a
 * screen called "no items yet" is an empty state — even though `detail` and
 * `home` would happily swallow both. Edge and monetization names are explicit
 * and rarely accidental; `core` names (`home`, `item`, `search`) are the words
 * that appear inside every other name, so core matches last, as the fallback.
 */
const MATCH_GROUPS = /** @type {const} */ (['edge', 'monetization', 'activation', 'retention', 'core']);

/** Flow ids in classification order. Derived, so it can never miss a flow. */
export const MATCH_ORDER = MATCH_GROUPS.flatMap((g) => FLOW_IDS.filter((id) => FLOWS[id].group === g));

/**
 * The flows worth researching for essentially any app. `ship research plan`
 * starts here and the config's `research.flows` narrows or widens it — a plan
 * that researches all 31 flows spends its whole fetch budget proving things
 * nobody asked about.
 */
export const DEFAULT_RESEARCH_FLOWS = /** @type {const} */ ([
	'welcome',
	'personalization',
	'first-value',
	'home',
	'paywall',
	'empty',
]);

/** Verbs an analytics event may use. Past tense: an event is a thing that happened. */
export const EVENT_VERBS = /** @type {const} */ ([
	'viewed',
	'started',
	'completed',
	'skipped',
	'dismissed',
	'failed',
	'granted',
	'denied',
]);

/**
 * Is this a flow id?
 * @param {unknown} id
 * @returns {boolean}
 */
export const isFlow = (id) => typeof id === 'string' && Object.hasOwn(FLOWS, id);

/**
 * Narrow an untrusted string to a flow id, or explain what was allowed.
 * @param {unknown} id
 * @param {string} [what] what the caller was resolving, for the message
 * @returns {string}
 */
export function requireFlow(id, what = 'flow') {
	if (isFlow(id)) return /** @type {string} */ (id);
	throw new ShipError(`unknown ${what} "${String(id)}"`, { hint: `valid flows: ${FLOW_IDS.join(', ')}` });
}

/**
 * Every flow in one group, in declaration order.
 * @param {string} group
 * @returns {string[]}
 */
export function flowsIn(group) {
	if (!(/** @type {readonly string[]} */ (GROUPS).includes(group)))
		throw new ShipError(`unknown flow group "${group}"`, { hint: `valid groups: ${GROUPS.join(', ')}` });
	return FLOW_IDS.filter((id) => FLOWS[id].group === group);
}

/**
 * Classify a free-text screen, step or event name as a flow.
 *
 * This is what lets a PostHog funnel export, a competitor's marketing
 * screenshot and a route in `design/ux.json` all land on the same key without
 * anyone hand-labelling them. First match in declaration order wins, so the
 * ordering of {@link FLOWS} is load-bearing. Returns null rather than guessing:
 * an unrecognised name is a fact worth surfacing, not a `screen` bucket.
 *
 * Matching runs in {@link MATCH_ORDER}, not declaration order.
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function flowOf(text) {
	const s = String(text ?? '').toLowerCase().replace(/[_\-.]+/g, ' ').trim();
	if (!s) return null;
	for (const id of MATCH_ORDER) if (FLOWS[id].match.test(s)) return id;
	return null;
}

/**
 * The canonical analytics event name for a flow and a verb.
 *
 * One naming rule, applied by code rather than remembered per screen:
 * `<flow with dashes as underscores>_<verb>`. `ship analytics onboarding` can
 * then fold a raw export without a mapping table, and two apps built by this
 * pipeline produce comparable funnels.
 *
 * @param {unknown} flow
 * @param {unknown} verb
 * @returns {string}
 */
export function eventName(flow, verb) {
	const id = requireFlow(flow, 'event flow');
	if (!(/** @type {readonly unknown[]} */ (EVENT_VERBS).includes(verb)))
		throw new ShipError(`unknown event verb "${String(verb)}"`, { hint: `valid verbs: ${EVENT_VERBS.join(', ')}` });
	return `${id.replace(/-/g, '_')}_${String(verb)}`;
}

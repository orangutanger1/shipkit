// Apple Search Ads reconciliation: the whole plan against the whole account, as
// a list of transitions a human can read before any of them happen. Pure, so
// `--dry-run` and a real run print the same list by construction rather than by
// two code paths agreeing.
//
// A live object the plan does not mention is only ever a *candidate* for pausing,
// and only inside a campaign the plan owns: campaigns ship did not create are
// reported as unmanaged and never touched.
import { round2 } from './fmt.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./asa-core.mjs').LiveCampaign} LiveCampaign */
/** @typedef {import('./asa-core.mjs').LiveAdGroup} LiveAdGroup */
/** @typedef {import('./asa-core.mjs').LiveKeyword} LiveKeyword */

/** One field transition: what the value was, what the plan wants it to be. */
/** @typedef {{field: string, from: Json, to: Json}} Change */
/** The header every reconcile action carries. */
/** @typedef {{level: 'campaign'|'adGroup'|'keyword', path: string, name: Json, id: Json|null}} ActionBase */
/** One transition the reconcile proposes; which extras are present depends on the op. */
/** @typedef {{level: 'campaign'|'adGroup'|'keyword'|'negative', path: string, name: Json, id: Json, op: string, changes: Change[], detail?: string, adoptFields?: JsonObject, adopted?: boolean, drift?: Change[], role?: Json}} Action */
/** One planned row of campaign-plan.json: the desired state plus what ship last pushed. */
/** @typedef {{name: string, dailyBudget?: Json, status?: Json, role?: Json, adGroups?: PlannedAdGroup[], negativeKeywords?: PlannedNegative[], apple?: Record<string, Json>|null}} PlannedCampaign */
/** @typedef {{name: string, defaultBidAmount?: Json, automatedKeywordsOptIn?: Json, status?: Json, keywords?: PlannedKeyword[], apple?: Record<string, Json>|null}} PlannedAdGroup */
/** @typedef {{text: string, matchType: string, status?: Json, bid?: Json, bidAmount?: Json, apple?: Record<string, Json>|null}} PlannedKeyword */
/** @typedef {{text: Json, matchType?: Json}} PlannedNegative */
/** The whole plan-vs-account result. */
/** @typedef {{actions: Action[], summary: Record<string, number>, mutations: Action[], conflicts: Action[], destructive: Action[], unplanned: Action[], preserved: Action[], unmanaged: {id: string|null, name: Json, status: Json}[]}} ReconcileResult */

/**
 * Which live object a planned one is: id first, name only to adopt an unknown.
 *
 * @template {{id?: Json, name?: Json}} T
 * @param {T[]} list
 * @param {{id?: Json, name?: Json}} pick
 * @returns {{row: T|null, by: 'id'|'name'|'orphan'|null}}
 */
function match(list, { id, name }) {
	if (id) {
		const byId = list.find((r) => r.id && String(r.id) === String(id));
		if (byId) return { row: byId, by: 'id' };
		return { row: null, by: 'orphan' };
	}
	const byName = list.find((r) => r.name === name);
	return byName ? { row: byName, by: 'name' } : { row: null, by: null };
}

/**
 * `round2(Number(v))` rather than `round2(v)`: `*` already coerced inside
 * round2, so this is the same arithmetic with the coercion made explicit.
 *
 * @param {Json|undefined} a
 * @param {Json|undefined} b
 * @returns {boolean}
 */
const same = (a, b) => {
	if (typeof a === 'number' || typeof b === 'number') return round2(Number(a)) === round2(Number(b));
	if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
	return String(a ?? '') === String(b ?? '');
};

/**
 * @param {Record<string, Json>|null|undefined} from
 * @param {Record<string, Json>} to
 * @param {string[]} [fields]
 * @returns {Change[]}
 */
const diff = (from, to, fields = Object.keys(to)) =>
	fields
		.filter((k) => to?.[k] !== undefined && !same(from?.[k], to?.[k]))
		.map((k) => ({ field: k, from: from?.[k] ?? null, to: to[k] }));

const PAUSED = 'PAUSED';
/**
 * @param {{status?: Json}|null|undefined} row
 * @returns {boolean}
 */
const isPaused = (row) => String(row?.status ?? '').toUpperCase() === PAUSED;

/**
 * Three-way reconcile of one object: what the plan wants, what Apple has, and
 * what `ship` last pushed (`synced`). The third leg is what makes a manual fix
 * survivable — without it "live differs from plan" and "a human raised this bid
 * an hour ago" are the same observation, and sync reverts the fix.
 *
 * @param {{level: 'campaign'|'adGroup'|'keyword', path: string, name: Json, desired: Record<string, Json>, live: LiveCampaign|LiveAdGroup|LiveKeyword|null, synced: Record<string, Json>|null, force: boolean, adopt: boolean}} p
 * @returns {Action}
 */
function reconcileOne({ level, path, name, desired, live, synced, force, adopt }) {
	const base = { level, path, name, id: live?.id ?? synced?.id ?? null };
	if (!live)
		return synced?.id
			? { ...base, op: 'orphan', changes: [], detail: `${synced.id} is gone from Apple — recreating` }
			: { ...base, op: 'create', changes: diff({}, desired), detail: 'not in the account' };

	// Only the fields ship manages are compared, in every direction. A live payload
	// also carries ids, timestamps and nested children, and treating those as drift
	// would make every object look manually edited.
	const managed = Object.keys(desired);
	const wanted = diff(live, desired);
	const drifted = synced ? diff(synced, live, managed) : [];
	const firstTime = !synced?.id;

	if (!wanted.length)
		return firstTime
			? { ...base, op: 'adopt', changes: [], detail: `matched by name → ${live.id}` }
			: { ...base, op: 'noop', changes: [] };

	if (firstTime) return firstSyncConflict({ base, live, wanted, adopt, force });
	if (drifted.length) return driftedResult({ base, synced, desired, live, wanted, drifted, adopt, force });
	return { ...base, op: 'update', changes: wanted };
}

/** Never synced, so every live value is a human's. Adopting the id is safe; overwriting the values they chose is the thing that must be asked for. */
/**
 * @param {{base: ActionBase, live: LiveCampaign|LiveAdGroup|LiveKeyword, wanted: Change[], adopt: boolean, force: boolean}} p
 * @returns {Action}
 */
function firstSyncConflict({ base, live, wanted, adopt, force }) {
	if (adopt) return { ...base, op: 'adopt', changes: [], adoptFields: live, detail: `keeping live values on ${live.id}` };
	if (force) return { ...base, op: 'update', changes: wanted, adopted: true };
	return { ...base, op: 'conflict', changes: wanted, drift: [], detail: 'existed before ship managed it' };
}

/**
 * @param {{base: ActionBase, synced: Record<string, Json>|null, desired: Record<string, Json>, live: LiveCampaign|LiveAdGroup|LiveKeyword, wanted: Change[], drifted: Change[], adopt: boolean, force: boolean}} p
 * @returns {Action}
 */
function driftedResult({ base, synced, desired, live, wanted, drifted, adopt, force }) {
	const intended = diff(synced, desired);
	if (!intended.length)
		// The plan has not changed; the account has. That is a manual override.
		return { ...base, op: 'preserve', changes: [], drift: drifted, detail: 'changed outside ship' };
	if (adopt) return { ...base, op: 'adopt', changes: [], adoptFields: live, drift: drifted };
	if (force) return { ...base, op: 'update', changes: wanted, drift: drifted };
	return { ...base, op: 'conflict', changes: wanted, drift: drifted, detail: 'changed both in the plan and outside ship' };
}

const DESTRUCTIVE = new Set(['pause']);
const MUTATING = new Set(['create', 'update', 'pause', 'orphan']);

/** @param {PlannedCampaign} cp @returns {Record<string, Json>} */
const desiredCampaign = (cp) => ({
	name: cp.name,
	dailyBudget: round2(Number(cp.dailyBudget)),
	status: cp.status ?? 'ENABLED',
});
/** @param {PlannedAdGroup} g @returns {Record<string, Json>} */
const desiredAdGroup = (g) => ({
	name: g.name,
	defaultBidAmount: round2(Number(g.defaultBidAmount)),
	automatedKeywordsOptIn: Boolean(g.automatedKeywordsOptIn),
	status: g.status ?? 'ENABLED',
});
/** @param {PlannedKeyword} k @param {PlannedAdGroup} g @returns {Record<string, Json>} */
const desiredKeyword = (k, g) => ({
	text: k.text,
	matchType: k.matchType,
	bidAmount: round2(Number(k.bid ?? k.bidAmount ?? g.defaultBidAmount)),
	status: k.status ?? 'ACTIVE',
});

/** @param {{text?: Json, matchType?: Json}} k @returns {string} */
const keywordKey = (k) => `${String(k.text ?? '').toLocaleLowerCase()}\u0000${String(k.matchType ?? '').toUpperCase()}`;

/**
 * @param {'campaign'|'adGroup'|'keyword'} level
 * @param {string} path
 * @param {Json} name
 * @param {string|null} id
 * @param {{status?: Json}} row
 * @param {boolean} prune
 * @returns {Action}
 */
const unplannedAction = (level, path, name, id, row, prune) => ({
	level,
	path,
	name,
	id,
	op: prune ? 'pause' : 'unplanned',
	changes: [{ field: 'status', from: row.status ?? null, to: PAUSED }],
	detail: 'live but absent from the plan',
});

/**
 * @param {{cpName: string, groupName: string, g: PlannedAdGroup, liveKeywords: LiveKeyword[], force: boolean, adopt: boolean, prune: boolean, actions: Action[]}} p
 * @returns {void}
 */
function reconcileKeywords({ cpName, groupName, g, liveKeywords, force, adopt, prune, actions }) {
	/** @type {Set<string|null>} */
	const claimed = new Set();
	for (const k of g.keywords ?? []) {
		const want = desiredKeyword(k, g);
		const kHit = k.apple?.id
			? match(liveKeywords, { id: k.apple.id })
			: { row: liveKeywords.find((h) => keywordKey(h) === keywordKey(want)) ?? null, by: 'name' };
		if (kHit.row) claimed.add(kHit.row.id);
		actions.push(
			reconcileOne({
				level: 'keyword',
				path: `${cpName} / ${groupName} / ${want.text} ${want.matchType}`,
				name: `${want.text} ${want.matchType}`,
				desired: want,
				live: kHit.row,
				synced: k.apple ?? null,
				force,
				adopt,
			}),
		);
	}
	for (const k of liveKeywords) {
		if (claimed.has(k.id) || isPaused(k)) continue;
		actions.push(
			unplannedAction(
				'keyword',
				`${cpName} / ${groupName} / ${k.text} ${k.matchType}`,
				`${k.text} ${k.matchType}`,
				k.id,
				k,
				prune,
			),
		);
	}
}

/**
 * @param {{cp: PlannedCampaign, cpName: string, liveGroups: LiveAdGroup[], force: boolean, adopt: boolean, prune: boolean, actions: Action[]}} p
 * @returns {void}
 */
function reconcileAdGroups({ cp, cpName, liveGroups, force, adopt, prune, actions }) {
	/** @type {Set<string|null>} */
	const claimed = new Set();
	for (const g of cp.adGroups ?? []) {
		const gHit = match(liveGroups, { id: g.apple?.id, name: g.name });
		if (gHit.row) claimed.add(gHit.row.id);
		actions.push(
			reconcileOne({
				level: 'adGroup',
				path: `${cpName} / ${g.name}`,
				name: g.name,
				desired: desiredAdGroup(g),
				live: gHit.row,
				synced: g.apple ?? null,
				force,
				adopt,
			}),
		);
		reconcileKeywords({
			cpName,
			groupName: g.name,
			g,
			liveKeywords: gHit.row?.keywords ?? [],
			force,
			adopt,
			prune,
			actions,
		});
	}
	for (const g of liveGroups) {
		if (claimed.has(g.id) || isPaused(g)) continue;
		actions.push(unplannedAction('adGroup', `${cpName} / ${g.name}`, g.name, g.id, g, prune));
	}
}

/**
 * @param {{cpName: string, cp: PlannedCampaign, liveNegatives: LiveKeyword[], actions: Action[]}} p
 * @returns {void}
 */
function reconcileNegatives({ cpName, cp, liveNegatives, actions }) {
	for (const n of cp.negativeKeywords ?? []) {
		if (liveNegatives.some((h) => keywordKey(h) === keywordKey(n))) continue;
		actions.push({
			level: 'negative',
			path: `${cpName} / −${n.text} ${n.matchType}`,
			name: `${n.text} ${n.matchType}`,
			id: null,
			op: 'create',
			changes: [{ field: 'text', from: null, to: n.text }],
		});
	}
}

/**
 * @param {{cp: PlannedCampaign, live: LiveCampaign[], force: boolean, adopt: boolean, prune: boolean, claimed: Set<string|null>, actions: Action[]}} p
 * @returns {void}
 */
function reconcileCampaign({ cp, live, force, adopt, prune, claimed, actions }) {
	const syncedCp = cp.apple ?? null;
	const hit = match(live, { id: syncedCp?.id, name: cp.name });
	if (hit.row) claimed.add(hit.row.id);
	const cpAction = reconcileOne({
		level: 'campaign',
		path: cp.name,
		name: cp.name,
		desired: desiredCampaign(cp),
		live: hit.row,
		synced: syncedCp,
		force,
		adopt,
	});
	cpAction.role = cp.role ?? null;
	actions.push(cpAction);

	reconcileAdGroups({
		cp,
		cpName: cp.name,
		liveGroups: hit.row?.adGroups ?? [],
		force,
		adopt,
		prune,
		actions,
	});
	reconcileNegatives({ cpName: cp.name, cp, liveNegatives: hit.row?.negativeKeywords ?? [], actions });
}

/**
 * Reconcile the plan against the account.
 *
 * @param {{planned?: PlannedCampaign[], live?: LiveCampaign[], force?: boolean, adopt?: boolean, prune?: boolean}} [opts]
 * @returns {ReconcileResult}
 */
export function reconcile({ planned = [], live = [], force = false, adopt = false, prune = false } = {}) {
	/** @type {Action[]} */
	const actions = [];
	/** @type {Set<string|null>} */
	const claimed = new Set();
	for (const cp of planned)
		reconcileCampaign({ cp, live, force, adopt, prune, claimed, actions });

	const unmanaged = live
		.filter((cp) => !claimed.has(cp.id))
		.map((cp) => ({ id: cp.id, name: cp.name, status: cp.status ?? null }));

	/** @type {Record<string, number>} */
	const summary = {};
	for (const a of actions) summary[a.op] = (summary[a.op] ?? 0) + 1;

	return {
		actions,
		summary,
		mutations: actions.filter((a) => MUTATING.has(a.op)),
		conflicts: actions.filter((a) => a.op === 'conflict'),
		destructive: actions.filter((a) => DESTRUCTIVE.has(a.op)),
		unplanned: actions.filter((a) => a.op === 'unplanned'),
		preserved: actions.filter((a) => a.op === 'preserve'),
		unmanaged,
	};
}

/** One line per transition, for a terminal or a `--json` consumer. */
/**
 * @param {Action} a
 * @returns {string}
 */
export const describeAction = (a) => {
	const fields = (a.changes ?? []).map((ch) => `${ch.field} ${ch.from ?? '—'} → ${ch.to}`).join(', ');
	const drift = (a.drift ?? []).map((ch) => `${ch.field} ${ch.from ?? '—'} → ${ch.to}`).join(', ');
	return [fields, drift ? `live drift: ${drift}` : '', a.detail ?? ''].filter(Boolean).join(' · ');
};

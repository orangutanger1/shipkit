// Apple Search Ads reconciliation: the whole plan against the whole account, as
// a list of transitions a human can read before any of them happen. Pure, so
// `--dry-run` and a real run print the same list by construction rather than by
// two code paths agreeing.
//
// A live object the plan does not mention is only ever a *candidate* for pausing,
// and only inside a campaign the plan owns: campaigns ship did not create are
// reported as unmanaged and never touched.
import { round2 } from './fmt.mjs';

/** Which live object a planned one is: id first, name only to adopt an unknown. */
function match(list, { id, name }) {
	if (id) {
		const byId = list.find((r) => r.id && String(r.id) === String(id));
		if (byId) return { row: byId, by: 'id' };
		return { row: null, by: 'orphan' };
	}
	const byName = list.find((r) => r.name === name);
	return byName ? { row: byName, by: 'name' } : { row: null, by: null };
}

const same = (a, b) => {
	if (typeof a === 'number' || typeof b === 'number') return round2(a) === round2(b);
	if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
	return String(a ?? '') === String(b ?? '');
};

const diff = (from, to, fields = Object.keys(to)) =>
	fields
		.filter((k) => to?.[k] !== undefined && !same(from?.[k], to?.[k]))
		.map((k) => ({ field: k, from: from?.[k] ?? null, to: to[k] }));

const PAUSED = 'PAUSED';
const isPaused = (row) => String(row?.status ?? '').toUpperCase() === PAUSED;

/**
 * Three-way reconcile of one object: what the plan wants, what Apple has, and
 * what `ship` last pushed (`synced`). The third leg is what makes a manual fix
 * survivable — without it "live differs from plan" and "a human raised this bid
 * an hour ago" are the same observation, and sync reverts the fix.
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
function firstSyncConflict({ base, live, wanted, adopt, force }) {
	if (adopt) return { ...base, op: 'adopt', changes: [], adoptFields: live, detail: `keeping live values on ${live.id}` };
	if (force) return { ...base, op: 'update', changes: wanted, adopted: true };
	return { ...base, op: 'conflict', changes: wanted, drift: [], detail: 'existed before ship managed it' };
}

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

const desiredCampaign = (cp) => ({
	name: cp.name,
	dailyBudget: round2(cp.dailyBudget),
	status: cp.status ?? 'ENABLED',
});
const desiredAdGroup = (g) => ({
	name: g.name,
	defaultBidAmount: round2(g.defaultBidAmount),
	automatedKeywordsOptIn: Boolean(g.automatedKeywordsOptIn),
	status: g.status ?? 'ENABLED',
});
const desiredKeyword = (k, g) => ({
	text: k.text,
	matchType: k.matchType,
	bidAmount: round2(k.bid ?? k.bidAmount ?? g.defaultBidAmount),
	status: k.status ?? 'ACTIVE',
});

const keywordKey = (k) => `${String(k.text ?? '').toLocaleLowerCase()}\u0000${String(k.matchType ?? '').toUpperCase()}`;

const unplannedAction = (level, path, name, id, row, prune) => ({
	level,
	path,
	name,
	id,
	op: prune ? 'pause' : 'unplanned',
	changes: [{ field: 'status', from: row.status ?? null, to: PAUSED }],
	detail: 'live but absent from the plan',
});

function reconcileKeywords({ cpName, groupName, g, liveKeywords, force, adopt, prune, actions }) {
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

function reconcileAdGroups({ cp, cpName, liveGroups, force, adopt, prune, actions }) {
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
 * @param {{planned:object[], live:object[], force?:boolean, adopt?:boolean, prune?:boolean}} opts
 */
export function reconcile({ planned = [], live = [], force = false, adopt = false, prune = false } = {}) {
	const actions = [];
	const claimed = new Set();
	for (const cp of planned)
		reconcileCampaign({ cp, live, force, adopt, prune, claimed, actions });

	const unmanaged = live
		.filter((cp) => !claimed.has(cp.id))
		.map((cp) => ({ id: cp.id, name: cp.name, status: cp.status ?? null }));

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
export const describeAction = (a) => {
	const fields = (a.changes ?? []).map((ch) => `${ch.field} ${ch.from ?? '—'} → ${ch.to}`).join(', ');
	const drift = (a.drift ?? []).map((ch) => `${ch.field} ${ch.from ?? '—'} → ${ch.to}`).join(', ');
	return [fields, drift ? `live drift: ${drift}` : '', a.detail ?? ''].filter(Boolean).join(' · ');
};

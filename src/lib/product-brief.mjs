// product/brief.json — what the app is, drafted from what the storefront says.
//
// `ship scout brief` answers a narrower question than it looks like it does:
// *is this keyword winnable*. That is a market answer, and a market answer is
// not a product. This turns it into one, and the split between the two halves
// is the whole design:
//
//   · the market half — verdict, viability, incumbent prices, the risks the
//     gates raised — is COMPUTED from the scout brief. It is copied forward on
//     every re-draft, so a `go` cannot be typed in by hand and a risk the
//     storefront raised cannot be deleted by editing the file;
//   · the product half — jobs, user, value prop, north star, activation,
//     retention, monetization — is the agent's, and is OMITTED rather than
//     guessed. `_todo` names each missing field and the gate refuses the file
//     by name until it is gone.
//
// Every field in the product half is either a closed vocabulary (flow ids,
// event names) or cites a review theme, so "the brief says so" is checkable
// rather than a matter of tone.
import { EVENT_VERBS, FLOW_IDS, flowsIn } from './flows.mjs';

/** @typedef {import('./util.mjs').Json} Json */

/** The fields an agent owns. A draft omits every one of these. */
export const AUTHORED = /** @type {const} */ ([
	'jobs', 'user', 'valueProp', 'northStar', 'activation', 'retention', 'monetization',
]);

/** What each authored field is asking for, printed beside the `_todo`. */
const PROMPTS = {
	jobs: 'jobs to be done, most important first, each citing a theme label from research themes.json',
	user: 'who this is for and the moment they reach for it (user.who, user.context)',
	valueProp: 'one sentence in the user\'s words',
	northStar: 'the single action that means it worked, and the flow it belongs to',
	activation: `the <flow>_<verb> event a new install must reach, and the window (${FLOW_IDS[0]}_${EVENT_VERBS[0]} shape)`,
	retention: `why anyone opens it twice, and which of ${flowsIn('retention').join('/')} carry it`,
	monetization: 'the model, and what sits behind the gate',
};

/**
 * Risks the storefront raised, as brief entries.
 *
 * These come out of the scout verdict's own gate reasons rather than being
 * re-derived, so the wording a human already read in `ship scout brief` is the
 * wording that lands in the file. `source: 'scout'` marks them as surviving a
 * re-draft — an agent may add risks and may not delete these.
 *
 * @param {{go?: boolean, reasons?: Array<{gate?: string, message?: string}>}|null|undefined} verdict
 * @returns {Array<{risk: string, severity: string, source: string}>}
 */
export function scoutRisks(verdict) {
	const reasons = verdict?.reasons ?? [];
	const risks = reasons.map(function asRisk(r) {
		return { risk: String(r.message ?? r.gate ?? 'gate failed'), severity: 'high', source: 'scout' };
	});
	// A brief with no risk at all reads as a brief nobody thought about; the
	// schema demands one, and "it cleared the gates" is the honest minimum.
	if (!risks.length)
		risks.push({
			risk: 'no storefront gate flagged this, which measures the market and not the execution',
			severity: 'low',
			source: 'scout',
		});
	return risks;
}

/**
 * What the top-10 charge. Free apps are kept: a market of free incumbents is
 * the single most important fact about whether this one can charge.
 * @param {Array<{name?: string|null, price?: number|null}>|null|undefined} incumbents
 * @returns {Array<{name: string, priceUsd: number}>}
 */
export function incumbentPrices(incumbents) {
	return (incumbents ?? [])
		.filter(function named(a) {
			return Boolean(a?.name);
		})
		.map(function priced(a) {
			return { name: String(a.name), priceUsd: Number(a.price) || 0 };
		});
}

/**
 * A draft brief from a scout brief.
 *
 * `previous` is the brief already on disk, if any: its authored fields are
 * carried forward so a re-draft refreshes the market half without destroying
 * the thinking. That is what makes this command safe to re-run after research
 * lands, which is the whole reason it is a command and not a scaffold step.
 *
 * @param {any} scout the scout brief artifact
 * @param {{source?: string, previous?: any, now?: string}} [opts]
 * @returns {any}
 */
export function draftBrief(scout, { source, previous = null, now = new Date().toISOString() } = {}) {
	/** @type {any} */
	const doc = {
		$schema: '../schema/product-brief.schema.json',
		generatedAt: now,
		slug: String(scout?.slug ?? ''),
		...(scout?.term ? { term: String(scout.term) } : {}),
		...(source ? { source } : {}),
		market: { country: String(scout?.market?.country ?? '').toLowerCase(), lang: String(scout?.market?.lang ?? 'en-US') },
		verdict: {
			go: Boolean(scout?.verdict?.go),
			viability: Number(scout?.viability) || 0,
			reasons: (scout?.verdict?.reasons ?? []).map(function message(/** @type {any} */ r) {
				return String(r?.message ?? '');
			}),
		},
		// Author-owned risks survive; the scout ones are re-derived every time,
		// so a gate that stopped firing stops being a risk without anyone editing.
		risks: [...scoutRisks(scout?.verdict), ...authoredRisks(previous)],
	};

	for (const field of AUTHORED) {
		const kept = previous?.[field];
		if (kept !== undefined && kept !== null) doc[field] = kept;
	}
	// `monetization.incumbentPrices` is computed even when the model is not
	// chosen yet: what the market charges is a fact, and the draft should carry
	// it into the decision rather than wait for it.
	const prices = incumbentPrices(scout?.incumbents);
	if (prices.length) doc.monetization = { ...(doc.monetization ?? { model: 'undecided' }), incumbentPrices: prices };

	const todo = AUTHORED.filter(function missing(f) {
		return doc[f] === undefined;
	});
	if (todo.length) doc._todo = todo.map(function prompt(f) {
		return `${f}: ${PROMPTS[f]}`;
	});
	return doc;
}

/** @param {any} previous @returns {Array<{risk: string, severity: string, source: string}>} */
function authoredRisks(previous) {
	return (previous?.risks ?? []).filter(function notScout(/** @type {any} */ r) {
		return r?.source && r.source !== 'scout';
	});
}

/**
 * Themes worth turning into jobs, most-supported first.
 *
 * Only `job` and `pain` themes qualify: a praise theme says the incumbent is
 * already doing something well, which is a risk, and a request is a feature
 * someone asked for, which is not a job. The agent still writes the job — this
 * only says which evidence is on the table.
 *
 * @param {{themes?: Array<{label?: string, kind?: string, support?: number}>}|null|undefined} themes
 * @param {number} [limit]
 * @returns {Array<{label: string, kind: string, support: number}>}
 */
export function jobSeeds(themes, limit = 8) {
	return (themes?.themes ?? [])
		.filter(function wanted(t) {
			return t?.kind === 'job' || t?.kind === 'pain';
		})
		.map(function seed(t) {
			return { label: String(t.label ?? ''), kind: String(t.kind), support: Number(t.support) || 0 };
		})
		.filter(function labelled(t) {
			return t.label !== '';
		})
		.sort(function bySupport(a, b) {
			return b.support - a.support;
		})
		.slice(0, limit);
}

/**
 * Checks a schema cannot express, all reported at once.
 *
 * The schema pins the shapes; these pin the joins between them. Every one is a
 * way the file can be internally valid and still not describe a product that
 * could be built.
 *
 * @param {any} doc
 * @param {{themes?: any}} [opts]
 * @returns {string[]}
 */
export function checkBrief(doc, { themes = null } = {}) {
	/** @type {string[]} */
	const issues = [];
	const known = new Set(jobSeedLabels(themes));

	for (const [i, job] of (doc?.jobs ?? []).entries())
		for (const label of job?.evidence ?? [])
			// Only checked when themes exist: a brief drafted before research is
			// allowed to cite nothing, but one drafted after may not cite a theme
			// that is not there.
			if (known.size && !known.has(label))
				issues.push(`jobs[${i}].evidence cites "${label}", which is not a theme in themes.json`);

	const retentionFlows = new Set(flowsIn('retention'));
	for (const flow of doc?.retention?.flows ?? [])
		if (!retentionFlows.has(flow))
			issues.push(`retention.flows lists "${flow}", which is not a retention flow (${[...retentionFlows].join(', ')})`);

	// The north star is what the product is for; an edge flow is what happens
	// when it goes wrong. Naming one as the goal is a brief describing failure.
	if (doc?.northStar?.flow && flowsIn('edge').includes(doc.northStar.flow))
		issues.push(`northStar.flow is "${doc.northStar.flow}", an edge flow — an edge case is not what the product is for`);

	const model = doc?.monetization?.model;
	if ((model === 'subscription' || model === 'freemium') && !doc?.monetization?.gate)
		issues.push(`monetization.model is "${model}" but nothing says what is behind the gate`);
	if (model === 'subscription' && !doc?.monetization?.period)
		issues.push('monetization.model is "subscription" but no period is named');
	if ((model === 'free' || model === 'undecided') && doc?.monetization?.gate)
		issues.push(`monetization.model is "${model}" but a gate is described — one of the two is wrong`);

	return issues;
}

/** @param {any} themes @returns {string[]} */
function jobSeedLabels(themes) {
	return (themes?.themes ?? []).map(function label(/** @type {any} */ t) {
		return String(t?.label ?? '');
	});
}

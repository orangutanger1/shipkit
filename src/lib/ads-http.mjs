// Apple Ads Platform API v1 — the I/O half.
//
// shipkit talks to v1 directly because `asc` 2.5.0 cannot: its raw passthrough
// refuses any path that does not start `v5/`. What shipkit does *not* do is
// handle credentials. v5 and v1 take the same client-credentials token, so the
// token is borrowed from asc's stored profile — no private key is read here, no
// secret is written, and `ship ads login` remains the only place credentials
// are set up.
//
// `fetch` and the token getter are both injected, which is what keeps the tests
// offline and this module at full coverage.
import { ShipError } from '../log.mjs';
import { ASC, run as exec } from '../exec.mjs';
import {
	PATHS, V1_BASE, errorTextV1, filter, isLegacyPayload, normaliseAdGroupV1, normaliseCampaignV1,
	normaliseKeywordV1, paginationOfV1, queryAll, rowsOfV1, suggestionRows, suggestionsBody,
} from './ads-v1.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {{fetch?: typeof globalThis.fetch, token?: () => Promise<string>, adAccountId: string|number}} V1Ctx */

/**
 * A bearer token from asc's stored Apple Ads profile.
 * `--confirm` is asc's own guard against printing a secret by accident; it is
 * passed here because this is exactly the deliberate use it guards.
 * @type {() => Promise<string>}
 */
async function ascToken() {
	const res = await exec(ASC, ['ads', 'auth', 'token', '--confirm', '--output', 'json'], { allowFail: true });
	if (res.code !== 0)
		throw new ShipError('could not get an Apple Ads access token', {
			hint: `${(res.stderr || res.stdout).trim().split('\n').slice(-4).join('\n')}\n\nRun \`ship ads status\` to check the stored profile.`,
		});
	return tokenFrom(res.stdout);
}

/**
 * The token out of asc's answer. Split from {@link ascToken} so the parsing is
 * testable without spawning anything, and so asc's key naming is in one place.
 * @type {(stdout: string) => string}
 */
export function tokenFrom(stdout) {
	let parsed;
	try {
		parsed = JSON.parse(String(stdout).slice(Math.max(0, String(stdout).search(/[[{]/))));
	} catch {
		throw new ShipError('asc returned no JSON for the Apple Ads token', { hint: 'try `asc ads auth token --confirm --output json` directly' });
	}
	const token = parsed?.access_token ?? parsed?.accessToken ?? parsed?.token;
	if (!token) throw new ShipError('the Apple Ads token response carried no token', { hint: `keys: ${Object.keys(parsed ?? {}).join(', ') || '(none)'}` });
	return String(token);
}

/**
 * The failure a bad call deserves. The status alone is misleading here: a 503
 * on this host means the path prefix is not routed — a typo, not an outage —
 * and a legacy error envelope means the path reached the old v5 service.
 * @type {(path: string, status: number, payload: Json|undefined, text: string) => ShipError}
 */
export function v1Error(path, status, payload, text) {
	if (status === 503)
		return new ShipError(`Apple Ads v1: /${path} is not a routed path`, {
			hint: 'a 503 from this host is an unrecognised path prefix, not an outage — check the spelling (`adgroups`, not `ad-groups`)',
		});
	if (isLegacyPayload(payload))
		return new ShipError(`Apple Ads v1: /${path} is not a v1 path`, {
			hint: 'the legacy v5 service answered, which means this path does not exist in v1',
		});
	return new ShipError(`Apple Ads v1: /${path} failed`, { hint: payload ? errorTextV1(payload, status) : `HTTP ${status} ${text.slice(0, 200)}` });
}

/**
 * One v1 call. Returns the parsed payload; throws with Apple's own field-level
 * complaint when it refuses the body.
 * @type {(path: string, opts: V1Ctx & {method?: string, body?: JsonObject|null}) => Promise<Json>}
 */
export async function v1Request(path, { method = 'GET', body = null, adAccountId, fetch: doFetch = globalThis.fetch, token = ascToken }) {
	if (!adAccountId)
		throw new ShipError('no Apple Ads ad account id', { hint: 'pass --org <id>, set ads.orgId in ship.config.json, or export ASC_ADS_ORG_ID — the ad account id is the old org id' });
	const res = await doFetch(new URL(path, V1_BASE).toString(), {
		method,
		headers: {
			Authorization: `Bearer ${await token()}`,
			'X-AP-Context': `adAccountId=${adAccountId}`,
			...(body ? { 'Content-Type': 'application/json' } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await res.text();
	let payload;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = null;
	}
	if (!res.ok) throw v1Error(path, res.status, payload, text);
	return payload;
}

/**
 * Every row of a `/query` resource, paged.
 * @type {(path: string, ctx: V1Ctx, opts?: {filters?: import('./ads-v1.mjs').Filter[], pageSize?: number, max?: number}) => Promise<Json[]>}
 */
export function v1Query(path, ctx, opts = {}) {
	return queryAll(async (page) => {
		const payload = await v1Request(path, { ...ctx, method: 'POST', body: page });
		return { rows: rowsOfV1(payload), pageSize: paginationOfV1(payload).pageSize || Number(/** @type {any} */ (page.pagination)?.pageSize ?? 0) };
	}, opts);
}

/**
 * Whether v1 answers for this account at all, and who it thinks we are. This is
 * the call `ship ads v1` makes: one read-only round trip that proves the token,
 * the host and the context header in one go.
 * @type {(ctx: V1Ctx) => Promise<{ok: boolean, orgId: Json, userId: Json, detail: string}>}
 */
export async function v1Me(ctx) {
	try {
		const payload = await v1Request(PATHS.me, ctx);
		const [row] = rowsOfV1(payload);
		const me = typeof row === 'object' && row !== null && !Array.isArray(row) ? row : {};
		return { ok: true, orgId: me.orgId ?? null, userId: me.userId ?? null, detail: '' };
	} catch (err) {
		const hint = err instanceof ShipError ? err.hint : '';
		return { ok: false, orgId: null, userId: null, detail: err instanceof Error ? `${err.message}${hint ? ` — ${hint}` : ''}` : String(err) };
	}
}

/**
 * The whole account over v1: campaigns, then their ad groups and keywords.
 *
 * Ad groups and keywords are flat top-level resources now — the parent id is a
 * filter, not a path segment — so this is still one call per campaign, but the
 * campaign no longer owns the route.
 * @type {(ctx: V1Ctx) => Promise<{campaigns: any[], adGroups: any[], keywords: any[]}>}
 */
export async function v1Account(ctx) {
	const campaigns = (await v1Query(PATHS.campaigns, ctx)).map(normaliseCampaignV1);
	/** @type {any[]} */
	const adGroups = [];
	/** @type {any[]} */
	const keywords = [];
	for (const cp of campaigns) {
		if (!cp.id) continue;
		const filters = [filter('campaignId', Number(cp.id))];
		adGroups.push(...(await v1Query(PATHS.adGroups, ctx, { filters })).map(normaliseAdGroupV1));
		keywords.push(...(await v1Query(PATHS.keywords, ctx, { filters })).map(normaliseKeywordV1));
	}
	return { campaigns, adGroups, keywords };
}

/**
 * Apple's popularity for one term, plus its expansion of it. This is the only
 * per-term demand number shipkit can measure rather than estimate; everything
 * else in `aso` infers demand from autocomplete rank.
 * @type {(ctx: V1Ctx, opts: {adamId: string|number, term?: string, countries?: string[], pageSize?: number}) => Promise<{text: string, popularity: number}[]>}
 */
export async function v1Suggestions(ctx, opts) {
	const payload = await v1Request(PATHS.keywordSuggestions, { ...ctx, method: 'POST', body: suggestionsBody(opts) });
	return suggestionRows(payload);
}

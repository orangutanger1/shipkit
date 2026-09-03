// The deterministic half of the evidence engine: storefront metadata, full-res
// marketing screenshots, and the public review RSS.
//
// Nothing here interprets anything, and nothing here touches the network or the
// disk — the caller injects `json`/`bytes` getters, which is what lets the whole
// module be covered from fixtures with `npm test` still offline.
//
// The references it produces are drafts: `flow`, `observations` and `doNotCopy`
// are the agent's to fill, so they are left out rather than guessed, and
// `research verify` is what refuses a draft that stayed one.
import { createHash } from 'node:crypto';
import { readImageSize } from './img-size.mjs';

/** Page 11 errors; 50 entries a page, so this is 500 reviews per sort per app. */
const REVIEWS_MAX_PAGE = 10;

const ITUNES = 'https://itunes.apple.com';

/** @typedef {{id: string, rating: number, version: string|null, date: string, title: string, body: string, sort: string}} Review */
/** @typedef {{name: string, trackId?: number, bundleId?: string, rating?: number, ratingCount?: number, price?: number, releasedAt?: string, updatedAt?: string, genres?: string[]}} RefApp */
/** @typedef {{id: string, provider: string, providerId: string, kind: string, app: RefApp, position: number|null, image: {path: string, sha256: string, w: number, h: number}, sourceUrl: string, capturedAt: string, confidence: string, _todo: string[]}} DraftReference */

/**
 * Apple serves any size off the same artwork path, so the trailing size segment
 * is the request: `320x480bb.jpg` is the thumbnail the lookup response hands
 * out, `1290x0w.png` is the real screen at full width. Anything that does not
 * end in a size segment is left alone rather than mangled.
 * @type {(url: string, width?: number) => string}
 */
export function fullResShot(url, width = 1290) {
	return String(url).replace(/\/\d+x\d+[a-z0-9-]*\.(?:jpe?g|png|webp)$/i, `/${width}x0w.png`);
}

/**
 * Stable across runs and providers, so the same source screen dedupes to one file.
 * @type {(provider: string, providerId: string) => string}
 */
export const refId = (provider, providerId) =>
	`ref_${createHash('sha1').update(`${provider}\n${providerId}`).digest('hex').slice(0, 16)}`;

/** @type {(buf: Buffer) => string} */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** @type {(trackId: number|string, opts: {country: string, sort: string, page: number}) => string} */
export const reviewsUrl = (trackId, { country, sort, page }) =>
	`${ITUNES}/${country.toLowerCase()}/rss/customerreviews/page=${page}/id=${trackId}/sortby=${sort}/json`;

/** @type {(ids: number|string, country: string) => string} */
export const lookupUrl = (ids, country) =>
	`${ITUNES}/lookup?${new URLSearchParams({ id: String(ids), country, entity: 'software' })}`;

/** @type {(node: any) => string|null} */
const label = (node) => (node && typeof node.label === 'string' ? node.label : null);

/**
 * One RSS page into review records. The feed's first entry is the app itself
 * rather than a review — it carries no `im:rating` — so rating is what
 * separates a review from the header, not position.
 * @type {(feed: any, sort: string) => Review[]}
 */
export function parseReviewFeed(feed, sort) {
	const raw = feed?.feed?.entry;
	const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
	/** @type {Review[]} */
	const out = [];
	for (const e of entries) {
		const rating = Number(label(e?.['im:rating']));
		const id = label(e?.id);
		if (!id || !Number.isInteger(rating) || rating < 1 || rating > 5) continue;
		out.push({
			id,
			rating,
			version: label(e?.['im:version']),
			date: label(e?.updated) ?? new Date(0).toISOString(),
			title: label(e?.title) ?? '',
			body: label(e?.content) ?? '',
			sort,
		});
	}
	return out;
}

/**
 * Both sorts into one corpus. A review that both orderings return is one
 * review; the first sort to claim it keeps the `sort` tag, and the result is
 * ordered newest first so a diff between runs is readable.
 * @type {(pages: Review[][]) => Review[]}
 */
export function mergeReviews(pages) {
	const byId = new Map();
	for (const page of pages) for (const r of page) if (!byId.has(r.id)) byId.set(r.id, r);
	return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/** @type {(result: any) => RefApp} */
export function appFromLookup(result) {
	const app = /** @type {any} */ ({ name: String(result?.trackName ?? `app ${result?.trackId ?? '?'}`) });
	/** @type {(key: string, value: any, ok?: (v: any) => boolean) => void} */
	const put = (key, value, ok = (v) => v !== undefined && v !== null) => {
		if (ok(value)) app[key] = value;
	};
	put('trackId', Number(result?.trackId), Number.isInteger);
	put('bundleId', result?.bundleId, (v) => typeof v === 'string' && v.length > 0);
	put('rating', Number(result?.averageUserRating), Number.isFinite);
	put('ratingCount', Number(result?.userRatingCount), Number.isInteger);
	put('price', Number(result?.price), (v) => Number.isFinite(v) && v >= 0);
	put('releasedAt', result?.releaseDate, (v) => typeof v === 'string');
	put('updatedAt', result?.currentVersionReleaseDate, (v) => typeof v === 'string');
	put('genres', result?.genres, Array.isArray);
	return /** @type {RefApp} */ (app);
}

/**
 * A reference with the agent's half deliberately absent. `_todo` is an
 * annotation the schema tolerates and every loader ignores; it exists so the
 * draft says what it is waiting for without pretending to satisfy the gate.
 * @type {(input: {provider: string, providerId: string, app: RefApp, position: number|null, sourceUrl: string, capturedAt: string, image: {path: string, sha256: string, w: number, h: number}}) => DraftReference}
 */
export function draftReference({ provider, providerId, app, position, sourceUrl, capturedAt, image }) {
	return {
		id: refId(provider, providerId),
		provider,
		providerId,
		kind: 'screen',
		app,
		position,
		image,
		sourceUrl,
		capturedAt,
		confidence: 'medium',
		_todo: ['flow', 'observations', 'doNotCopy'],
	};
}

/** @type {(buf: Buffer, path: string) => {path: string, sha256: string, w: number, h: number}|null} */
export function imageFacts(buf, path) {
	const size = readImageSize(buf);
	if (!size) return null;
	return { path, sha256: sha256(buf), w: size.width, h: size.height };
}

/** @typedef {{json: (url: string) => Promise<any>, bytes: (url: string) => Promise<Buffer|null>}} FetchIO */

/**
 * Everything one app costs: one lookup, up to `screensPerApp` images, and
 * `reviewPages` pages per sort. Requests are counted as they are made rather
 * than assumed, so `research verify` compares the budget against what happened.
 * @param {{trackId: number, name: string}} app
 * @param {{country: string, screensPerApp: number, reviewPages: number, sorts: string[], capturedAt: string}} opts
 * @param {FetchIO} io
 */
export async function fetchApp(app, opts, io) {
	const { country, screensPerApp, reviewPages, sorts, capturedAt } = opts;
	let requests = 0;

	const looked = await io.json(lookupUrl(app.trackId, country));
	requests++;
	const result = looked?.results?.[0];
	const meta = result ? appFromLookup(result) : { name: app.name, trackId: app.trackId };
	const sourceUrl = `https://apps.apple.com/${country.toLowerCase()}/app/id${app.trackId}`;

	const shots = Array.isArray(result?.screenshotUrls) ? result.screenshotUrls.slice(0, screensPerApp) : [];
	/** @type {DraftReference[]} */
	const references = [];
	/** @type {{path: string, buffer: Buffer}[]} */
	const assets = [];
	const skipped = [];
	for (const [i, thumb] of shots.entries()) {
		const url = fullResShot(thumb);
		const buf = await io.bytes(url);
		requests++;
		if (!buf) {
			skipped.push(url);
			continue;
		}
		const id = refId('appstore', `${app.trackId}#screen-${i + 1}`);
		const facts = imageFacts(buf, `assets/${id}.png`);
		if (!facts) {
			skipped.push(url);
			continue;
		}
		assets.push({ path: facts.path, buffer: buf });
		references.push(
			draftReference({
				provider: 'appstore',
				providerId: `${app.trackId}#screen-${i + 1}`,
				app: meta,
				position: i + 1,
				sourceUrl,
				capturedAt,
				image: facts,
			}),
		);
	}

	/** @type {Review[][]} */
	const pages = [];
	for (const sort of sorts) {
		for (let page = 1; page <= Math.min(reviewPages, REVIEWS_MAX_PAGE); page++) {
			const feed = await io.json(reviewsUrl(app.trackId, { country, sort, page }));
			requests++;
			const parsed = parseReviewFeed(feed, sort);
			// An empty page means the feed ran out early; the rest of this sort
			// would be empty too, and paying Apple for it is rude and pointless.
			if (!parsed.length) break;
			pages.push(parsed);
		}
	}
	const reviews = mergeReviews(pages);
	const corpus = /** @type {{trackId: number, country: string, fetchedAt: string, sorts: string[], count: number, reviews: Review[], appMeanRating?: number}} */ ({
		trackId: app.trackId,
		country: country.toLowerCase(),
		fetchedAt: capturedAt,
		sorts: [...sorts],
		count: reviews.length,
		reviews,
	});
	if (typeof meta.rating === 'number') corpus.appMeanRating = Math.round(meta.rating * 100) / 100;

	return { app: meta, references, assets, corpus, requests, skipped };
}

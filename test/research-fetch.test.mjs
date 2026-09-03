// The deterministic half of the evidence engine, driven entirely from fixtures.
// Nothing here touches the network: `fetchApp` takes its two getters as an
// argument precisely so `npm test` can prove the pipeline offline.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
	appFromLookup,
	draftReference,
	fetchApp,
	fullResShot,
	imageFacts,
	lookupUrl,
	mergeReviews,
	parseReviewFeed,
	refId,
	reviewsUrl,
} from '../src/lib/research-fetch.mjs';

/** A PNG whose IHDR says what we want it to say — `readImageSize` reads no further. */
function png(width, height) {
	const buf = Buffer.alloc(33);
	buf.writeUInt32BE(0x89504e47, 0);
	buf.writeUInt32BE(0x0d0a1a0a, 4);
	buf.writeUInt32BE(13, 8);
	buf.write('IHDR', 12);
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

const entry = (id, rating, over = {}) => ({
	id: { label: id },
	'im:rating': { label: String(rating) },
	'im:version': { label: '26.34.0' },
	updated: { label: '2026-08-01T12:00:00-07:00' },
	title: { label: `title ${id}` },
	content: { label: `body ${id}` },
	...over,
});

test('fullResShot swaps the size segment, and leaves anything else alone', () => {
	assert.equal(
		fullResShot('https://is1-ssl.mzstatic.com/image/thumb/abc/320x480bb.jpg'),
		'https://is1-ssl.mzstatic.com/image/thumb/abc/1290x0w.png',
	);
	assert.equal(fullResShot('https://x/abc/60x60bb-85.webp', 2000), 'https://x/abc/2000x0w.png');
	assert.equal(fullResShot('https://x/no-size-here'), 'https://x/no-size-here');
});

test('refId is stable per provider and source, and shaped like the schema wants', () => {
	assert.equal(refId('appstore', '341232718#screen-3'), refId('appstore', '341232718#screen-3'));
	assert.notEqual(refId('appstore', '341232718#screen-3'), refId('manual', '341232718#screen-3'));
	assert.match(refId('appstore', 'x'), /^ref_[0-9a-f]{16}$/);
});

test('urls are the documented public endpoints, lowercased storefront', () => {
	assert.equal(
		reviewsUrl(341232718, { country: 'US', sort: 'mostrecent', page: 2 }),
		'https://itunes.apple.com/us/rss/customerreviews/page=2/id=341232718/sortby=mostrecent/json',
	);
	assert.equal(lookupUrl(123, 'GB'), 'https://itunes.apple.com/lookup?id=123&country=GB&entity=software');
});

test('parseReviewFeed keeps reviews and drops the feed header entry', () => {
	const feed = {
		feed: { entry: [{ id: { label: 'app' }, 'im:name': { label: 'App' } }, entry('r1', 5), entry('r2', 1)] },
	};
	const rows = parseReviewFeed(feed, 'mostrecent');
	assert.deepEqual(rows.map((r) => r.id), ['r1', 'r2']);
	assert.equal(rows[0].rating, 5);
	assert.equal(rows[0].version, '26.34.0');
	assert.equal(rows[0].sort, 'mostrecent');
});

test('parseReviewFeed tolerates a single-entry feed, an empty one, and junk ratings', () => {
	assert.equal(parseReviewFeed({ feed: { entry: entry('solo', 4) } }, 'mosthelpful').length, 1);
	assert.deepEqual(parseReviewFeed({ feed: {} }, 'mostrecent'), []);
	assert.deepEqual(parseReviewFeed(null, 'mostrecent'), []);
	assert.deepEqual(parseReviewFeed({ feed: { entry: [entry('x', 9), entry('y', 0)] } }, 'mostrecent'), []);
});

test('parseReviewFeed falls back rather than dropping a review with missing text', () => {
	const [row] = parseReviewFeed(
		{ feed: { entry: [entry('r1', 3, { title: null, content: null, updated: null, 'im:version': null })] } },
		'mostrecent',
	);
	assert.deepEqual([row.title, row.body, row.version], ['', '', null]);
	assert.equal(row.date, '1970-01-01T00:00:00.000Z');
});

test('mergeReviews dedupes across sorts and orders newest first', () => {
	const a = [{ id: 'r1', rating: 5, date: '2026-01-01T00:00:00Z', sort: 'mostrecent' }];
	const b = [
		{ id: 'r1', rating: 5, date: '2026-01-01T00:00:00Z', sort: 'mosthelpful' },
		{ id: 'r2', rating: 2, date: '2026-02-01T00:00:00Z', sort: 'mosthelpful' },
	];
	const merged = mergeReviews([a, b]);
	assert.deepEqual(merged.map((r) => r.id), ['r2', 'r1']);
	assert.equal(merged.find((r) => r.id === 'r1').sort, 'mostrecent');
});

test('appFromLookup keeps the fields the storefront served and omits the ones it did not', () => {
	const app = appFromLookup({
		trackName: 'Flo',
		trackId: 1038369065,
		bundleId: 'com.flo.app',
		averageUserRating: 4.7466,
		userRatingCount: 1950228,
		price: 0,
		releaseDate: '2015-10-03T22:28:36Z',
		currentVersionReleaseDate: '2026-08-20T00:00:00Z',
		genres: ['Health & Fitness'],
	});
	assert.equal(app.name, 'Flo');
	assert.equal(app.ratingCount, 1950228);
	assert.deepEqual(app.genres, ['Health & Fitness']);
	const bare = appFromLookup({ trackId: 5 });
	assert.equal(bare.name, 'app 5');
	assert.equal('rating' in bare, false);
	assert.equal('bundleId' in bare, false);
});

test('imageFacts hashes the bytes it was given and reads the real dimensions', () => {
	const buf = png(1290, 2796);
	const facts = imageFacts(buf, 'assets/ref_x.png');
	assert.deepEqual(facts, {
		path: 'assets/ref_x.png',
		sha256: createHash('sha256').update(buf).digest('hex'),
		w: 1290,
		h: 2796,
	});
	assert.equal(imageFacts(Buffer.from('not an image'), 'assets/x.png'), null);
});

test('draftReference leaves the agent’s fields out and says so', () => {
	const ref = draftReference({
		provider: 'appstore',
		providerId: '1#screen-1',
		app: { name: 'A' },
		position: 1,
		sourceUrl: 'https://apps.apple.com/us/app/id1',
		capturedAt: '2026-09-02T00:00:00.000Z',
		image: { path: 'assets/x.png', sha256: 'a'.repeat(64), w: 1, h: 1 },
	});
	assert.equal('flow' in ref, false);
	assert.equal('doNotCopy' in ref, false);
	assert.deepEqual(ref._todo, ['flow', 'observations', 'doNotCopy']);
	assert.equal(ref.kind, 'screen');
});

/** A fixture storefront: one lookup, N screenshots, and two sorts of reviews. */
function fakeIO({ shots = 2, pages = { mostrecent: 2, mosthelpful: 1 } } = {}) {
	const calls = [];
	return {
		calls,
		json: async (url) => {
			calls.push(url);
			if (url.includes('/lookup')) {
				return {
					results: [
						{
							trackName: 'Flo',
							trackId: 1038369065,
							averageUserRating: 4.75,
							userRatingCount: 1950228,
							screenshotUrls: Array.from({ length: shots }, (_, i) => `https://x/shot${i}/320x480bb.jpg`),
						},
					],
				};
			}
			const [, sort] = url.match(/sortby=(\w+)/);
			const [, page] = url.match(/page=(\d+)/);
			if (Number(page) > pages[sort]) return { feed: {} };
			return { feed: { entry: [entry(`${sort}-${page}-a`, 5), entry(`${sort}-${page}-b`, 1)] } };
		},
		bytes: async (url) => {
			calls.push(url);
			return url.includes('shot1') ? png(1290, 2796) : png(640, 1136);
		},
	};
}

const APP = { trackId: 1038369065, name: 'Flo' };
const OPTS = {
	country: 'US',
	screensPerApp: 10,
	reviewPages: 10,
	sorts: ['mostrecent', 'mosthelpful'],
	capturedAt: '2026-09-02T00:00:00.000Z',
};

test('fetchApp turns one app into references, assets and a review corpus', async () => {
	const io = fakeIO();
	const haul = await fetchApp(APP, OPTS, io);
	assert.equal(haul.references.length, 2);
	assert.equal(haul.assets.length, 2);
	assert.deepEqual(haul.references.map((r) => r.position), [1, 2]);
	assert.equal(haul.references[1].image.w, 1290);
	assert.equal(haul.references[0].image.path, `assets/${haul.references[0].id}.png`);
	assert.equal(haul.corpus.count, 6);
	assert.equal(haul.corpus.appMeanRating, 4.75);
	assert.equal(haul.corpus.country, 'us');
	assert.deepEqual(haul.corpus.sorts, ['mostrecent', 'mosthelpful']);
});

test('fetchApp stops paging a sort the moment the feed runs dry', async () => {
	const io = fakeIO({ shots: 0, pages: { mostrecent: 1, mosthelpful: 0 } });
	const haul = await fetchApp(APP, OPTS, io);
	const pages = io.calls.filter((u) => u.includes('customerreviews'));
	// mostrecent: page 1 hits, page 2 is empty and ends it. mosthelpful: page 1
	// is empty. Three requests, not the twenty the budget would have allowed.
	assert.equal(pages.length, 3);
	assert.equal(haul.corpus.count, 2);
});

test('fetchApp obeys screensPerApp and counts every request it made', async () => {
	const io = fakeIO({ shots: 8, pages: { mostrecent: 0, mosthelpful: 0 } });
	const haul = await fetchApp(APP, { ...OPTS, screensPerApp: 3, reviewPages: 1 }, io);
	assert.equal(haul.references.length, 3);
	// 1 lookup + 3 images + 2 empty first pages.
	assert.equal(haul.requests, 6);
});

test('fetchApp records a screenshot it could not read rather than inventing one', async () => {
	const io = fakeIO({ shots: 2, pages: { mostrecent: 0, mosthelpful: 0 } });
	io.bytes = async (url) => (url.includes('shot0') ? null : Buffer.from('nope'));
	const haul = await fetchApp(APP, OPTS, io);
	assert.equal(haul.references.length, 0);
	assert.equal(haul.skipped.length, 2);
	assert.equal(haul.requests, 5);
});

test('fetchApp still writes a corpus when the lookup itself returns nothing', async () => {
	const io = fakeIO();
	io.json = async (url) => (url.includes('/lookup') ? null : { feed: {} });
	const haul = await fetchApp(APP, OPTS, io);
	assert.deepEqual(haul.app, { name: 'Flo', trackId: 1038369065 });
	assert.equal(haul.references.length, 0);
	assert.equal(haul.corpus.count, 0);
	assert.equal('appMeanRating' in haul.corpus, false);
});

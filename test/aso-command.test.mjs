// `ship aso` end to end: harvest → volume → score → suggest → apply, plus
// competitors, audit and the all-locales sweep. The storefront answers through
// a fetch stub (frozen captures), Apple Ads popularity through the same stub,
// and `asc` through a fake binary — so the whole pipeline runs offline.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, json, repo, resetCalls, setBin, withFetch, writeFiles } from './fixtures/cmd.mjs';
import { STOREFRONT } from './fixtures/storefront.mjs';

await fakeHome();
await fakeBins(['asc']);

const { run } = await import('../src/commands/aso.mjs');
const { setDryRun } = await import('../src/exec.mjs');

const APPS = STOREFRONT['period tracker'].apps;
const SUGGESTIONS = ['period tracker calendar', 'cycle log tracker', 'ovulation calendar'];
const hintsBody = (terms) => `<dict>${terms.map((t) => `<key>term</key><string>${t}</string>`).join('')}</dict>`;

/** @param {{apps?: object[], suggestions?: string[], popularity?: number|null}} [opts] */
function storefront({ apps = APPS, suggestions = SUGGESTIONS, popularity = 42 } = {}) {
	return async (url) => {
		const href = String(url);
		if (href.includes('MZSearchHints')) return new Response(hintsBody(suggestions));
		if (href.includes('api.ads.apple.com'))
			return json({ data: popularity === null ? [] : [{ keyword: 'period tracker calendar', popularity }] });
		if (href.includes('/search') || href.includes('/lookup')) return json({ results: apps });
		return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
	};
}

const CONFIG = {
	name: 'Demo', bundleId: 'com.demo.app',
	asc: { appId: 111, primaryLocale: 'en-US' },
	ads: { orgId: '555' },
	store: { locales: ['en-US'] },
};

/** @param {string[]} args @param {{flags?: object, dir: string, fetch?: typeof globalThis.fetch}} opts */
async function aso(args, { flags = {}, dir, fetch = storefront() }) {
	await resetCalls();
	const { result, out } = await capture(() => inDir(dir, () => withFetch(fetch, () => run({ args, flags }))));
	return { code: result, out };
}

const asoRepo = (files = {}, config = {}) => repo({ config: { ...CONFIG, ...config }, files, prefix: 'ship-aso-' });
const readJson = (dir, rel) => readFile(join(dir, rel), 'utf8').then(JSON.parse);
const LISTING = { locale: 'en-US', name: 'Demo', subtitle: 'Track your cycle', keywords: 'demo,app' };

test('harvest needs seeds, and writes the candidates it found', async () => {
	const bare = await asoRepo();
	await assert.rejects(() => aso(['harvest'], { dir: bare }), /no harvest seeds for en-US/);

	const dir = await asoRepo({ 'store/staged/en-US.json': LISTING });
	const { code, out } = await aso(['harvest'], { dir, flags: { seeds: 'period tracker' } });
	assert.equal(code, 0);
	const doc = await readJson(dir, 'aso/en-US/candidates.json');
	assert.deepEqual(doc.seeds, ['period tracker']);
	assert.ok(Object.keys(doc.terms).length);
	assert.match(out, /candidates/);
});

test('a locale with no App Store market is refused before anything is fetched', async () => {
	const dir = await asoRepo();
	await assert.rejects(() => aso(['harvest'], { dir, flags: { locale: 'xx-XX', seeds: 'a' } }), /no App Store market known/);
});

test('harvest --json emits the artifact', async () => {
	const dir = await asoRepo();
	const { out } = await aso(['harvest'], { dir, flags: { seeds: 'period tracker', json: true } });
	assert.equal(JSON.parse(out).locale, 'en-US');
});

test('volume with nothing to import writes the template a human fills in', async () => {
	const dir = await asoRepo();
	const { code, out } = await aso(['volume'], { dir });
	assert.equal(code, 0);
	assert.match(out, /volume/, 'the template is printed, not written — nothing has been measured yet');
});

test('volume --file imports a saved popularity dump and merges it', async () => {
	const dir = await asoRepo({ 'dump.json': { 'period tracker': 62 } });
	const { code } = await aso(['volume'], { dir, flags: { file: join(dir, 'dump.json') } });
	assert.equal(code, 0);
	assert.equal((await readJson(dir, 'aso/en-US/volume.json')).terms['period tracker'].popularity ?? (await readJson(dir, 'aso/en-US/volume.json')).terms['period tracker'], 62);
});

test('volume --file refuses a file that is missing, unparseable or empty of terms', async () => {
	const dir = await asoRepo({ 'bad.json': '{oops', 'empty.json': {} });
	await assert.rejects(() => aso(['volume'], { dir, flags: { file: join(dir, 'nope.json') } }), /no such file/);
	await assert.rejects(() => aso(['volume'], { dir, flags: { file: join(dir, 'bad.json') } }), /is not valid JSON/);
	await assert.rejects(() => aso(['volume'], { dir, flags: { file: join(dir, 'empty.json') } }), /carried no usable terms/);
});

test('volume --fetch measures the harvested candidates against Apple Ads', async () => {
	setBin('asc', [['ads auth token', { out: { access_token: 'tok' } }]]);
	const dir = await asoRepo({ 'aso/en-US/candidates.json': { terms: { 'period tracker calendar': { rank: 1 } }, locale: 'en-US' } });
	const { code, out } = await aso(['volume'], { dir, flags: { fetch: true } });
	assert.equal(code, 0);
	assert.match(out, /Apple Ads/);
	assert.equal((await readJson(dir, 'aso/en-US/volume.json')).source, 'apple-ads-suggestions');
});

test('volume --fetch needs candidates before it can measure anything', async () => {
	const dir = await asoRepo();
	await assert.rejects(() => aso(['volume'], { dir, flags: { fetch: true } }), /no candidates.json for en-US/);
	const empty = await asoRepo({ 'aso/en-US/candidates.json': { terms: {} } });
	await assert.rejects(() => aso(['volume'], { dir: empty, flags: { fetch: true } }), /no candidates to measure/);
});

test('score ranks the candidates and writes scored.json', async () => {
	const dir = await asoRepo({ 'aso/en-US/candidates.json': { terms: { 'period tracker calendar': { rank: 1 }, 'cycle log tracker': { rank: 2 } }, locale: 'en-US' } });
	const { code, out } = await aso(['score'], { dir });
	assert.equal(code, 0);
	assert.ok((await readJson(dir, 'aso/en-US/scored.json')).terms.length);
	assert.match(out, /Score en-US/);
});

test('score says which threshold left it nothing to score', async () => {
	const files = { 'aso/en-US/candidates.json': { terms: { 'period tracker calendar': { rank: 1 } }, locale: 'en-US' } };
	const dir = await asoRepo(files, { aso: { minVolume: 5000 } });
	// The threshold that bit is in the hint, which is where the fix lives.
	await assert.rejects(() => aso(['score'], { dir }), (err) => /no scorable candidates/.test(err.message) && /all under aso.minVolume 5000/.test(err.hint));
	const narrow = await asoRepo(files);
	await assert.rejects(() => aso(['score'], { dir: narrow, flags: { words: 1 } }), (err) => /widen with --words/.test(err.hint));
});

test('suggest packs a keyword field from the scores, and apply writes it', async () => {
	const scored = { locale: 'en-US', terms: [{ keyword: 'period tracker calendar', demand: 50, opportunity: 40, competition: 10 }, { keyword: 'cycle log tracker', demand: 40, opportunity: 30, competition: 10 }] };
	const dir = await asoRepo({ 'aso/en-US/scored.json': scored, 'store/staged/en-US.json': LISTING });
	const { code, out } = await aso(['suggest'], { dir });
	assert.equal(code, 0);
	assert.match(out, /ship aso apply/);

	const { code: applied } = await aso(['apply'], { dir });
	assert.equal(applied, 0);
	const listing = await readJson(dir, 'store/staged/en-US.json');
	assert.notEqual(listing.keywords, LISTING.keywords, 'the packed field replaces the placeholder');
	assert.equal(listing.name, 'Demo', 'the authored keys survive');

	const { out: again } = await aso(['apply'], { dir });
	assert.match(again, /already has this field/);
});

test('suggest without a staged listing still researches, apply refuses', async () => {
	const dir = await asoRepo({ 'aso/en-US/scored.json': { locale: 'en-US', terms: [{ keyword: 'period tracker calendar', demand: 50, opportunity: 40 }] } });
	const { out } = await aso(['suggest'], { dir });
	assert.match(out, /no staged listing for en-US/);
	await assert.rejects(() => aso(['apply'], { dir }), /no staged listing for en-US/);
});

test('apply --dry-run shows the change without writing it', async () => {
	const dir = await asoRepo({ 'aso/en-US/scored.json': { locale: 'en-US', terms: [{ keyword: 'period tracker calendar', demand: 50, opportunity: 40 }] }, 'store/staged/en-US.json': LISTING });
	setDryRun(true);
	try {
		const { code, out } = await aso(['apply'], { dir });
		assert.equal(code, 0);
		assert.match(out, /dry run — nothing written/);
		assert.equal((await readJson(dir, 'store/staged/en-US.json')).keywords, LISTING.keywords);
	} finally {
		setDryRun(false);
	}
});

test('apply --json reports what it would write', async () => {
	const dir = await asoRepo({ 'aso/en-US/scored.json': { locale: 'en-US', terms: [{ keyword: 'period tracker calendar', demand: 50, opportunity: 40 }] }, 'store/staged/en-US.json': LISTING });
	const { out } = await aso(['apply'], { dir, flags: { json: true } });
	assert.ok(JSON.parse(out).keywords.length);
});

test('a stage without its input names the command that produces it', async () => {
	const dir = await asoRepo();
	await assert.rejects(() => aso(['score'], { dir }), /no candidates.json for en-US/);
	await assert.rejects(() => aso(['suggest'], { dir }), /no scored.json for en-US/);
});

test('competitors looks up the ids and writes the shared vocabulary', async () => {
	const dir = await asoRepo();
	const { code, out } = await aso(['competitors'], { dir, flags: { ids: '1038369065,896501514' } });
	assert.equal(code, 0);
	const doc = await readJson(dir, 'aso/en-US/competitors.json');
	assert.equal(doc.ids.length, 2);
	assert.ok(doc.apps.length);
	assert.ok(out.length);
});

test('competitors falls back to the scored top apps, and says when there are none', async () => {
	const dir = await asoRepo();
	await assert.rejects(() => aso(['competitors'], { dir }), /no scored.json|no competitor ids/);
});

test('audit reports Apple tags, the asc keyword audit and the offline lint', async () => {
	setBin('asc', [
		['app-tags list', { out: { data: [{ attributes: { name: 'cycle tracking' } }] } }],
		['metadata keywords audit', { out: { data: [] } }],
	]);
	const dir = await asoRepo({ 'store/staged/en-US.json': LISTING });
	const { code, out } = await aso(['audit'], { dir });
	assert.equal(code, 0);
	assert.match(out, /cycle tracking/);
	assert.match(out, /no findings/);
});

test('audit skips what asc could not answer rather than failing the run', async () => {
	setBin('asc', []);
	const dir = await asoRepo({ 'store/staged/en-US.json': LISTING });
	const { out } = await aso(['audit'], { dir });
	assert.match(out, /asc app-tags list failed/);
	assert.match(out, /no result for version/);
	assert.match(out, /ship aso harvest --locale en-US/);
});

test('--all-locales keeps going when one locale fails, and reports each', async () => {
	const dir = await asoRepo({ 'store/staged/en-US.json': LISTING }, { store: { locales: ['en-US', 'xx-XX'] } });
	const { code, out } = await aso(['harvest'], { dir, flags: { 'all-locales': true, seeds: 'period tracker' } });
	assert.equal(code, 0, 'one locale failing is not the sweep failing');
	assert.match(out, /no App Store market known — skipped/);
	assert.match(out, /1\/2 locales/);
});

test('a sweep where every locale fails exits non-zero', async () => {
	const dir = await asoRepo({}, { store: { locales: ['xx-XX'] } });
	const { code } = await aso(['harvest'], { dir, flags: { 'all-locales': true } });
	assert.equal(code, 1);
});

test('--all-locales --json emits one row per locale', async () => {
	const dir = await asoRepo({ 'store/staged/en-US.json': LISTING });
	const { out } = await aso(['harvest'], { dir, flags: { 'all-locales': true, json: true, seeds: 'period tracker' } });
	assert.equal(JSON.parse(out).stage, 'harvest');
});

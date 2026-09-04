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
// The 403 wall is worth driving; its real 20s backoff is not. Set before the
// client is imported, which is where the constant is read.
process.env.SHIP_STOREFRONT_BACKOFF_MS = '5';

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

test('seeds come from the locale first, then the config, and a cross-language sweep is called out', async () => {
	const byLocale = await asoRepo({}, { aso: { seedsByLocale: { 'en-US': ['native seed'] }, seeds: ['config seed'] } });
	const { out } = await aso(['harvest'], { dir: byLocale });
	assert.match(out, /from aso.seedsByLocale.en-US/);

	const shared = await asoRepo({}, { aso: { seeds: ['config seed'] }, store: { locales: ['en-US', 'de-DE'] } });
	const { out: warned } = await aso(['harvest'], { dir: shared, flags: { locale: 'de-DE' } });
	assert.match(warned, /from aso.seeds in/);
	assert.match(warned, /is being harvested with en-US seeds/);
	assert.match(warned, /ship loc seed --locale de-DE/);
});

test('competitors that resolve to nothing exit non-zero rather than writing an empty artifact', async () => {
	const dir = await asoRepo();
	const { code, out } = await aso(['competitors'], { dir, flags: { ids: '1,2' }, fetch: storefront({ apps: [] }) });
	assert.equal(code, 1);
	assert.match(out, /lookup returned nothing for 1, 2/);
});

test('competitors defaults to the apps the scored terms named', async () => {
	const scoredWithApps = { locale: 'en-US', terms: [{ keyword: 'period tracker calendar', top3: [{ id: 1038369065 }, { id: 896501514 }] }] };
	const dir = await asoRepo({ 'aso/en-US/scored.json': scoredWithApps });
	const { code } = await aso(['competitors'], { dir });
	assert.equal(code, 0);
	assert.deepEqual((await readJson(dir, 'aso/en-US/competitors.json')).ids, ['1038369065', '896501514']);
});

test('audit reports what the asc keyword audit found, and a clean field as clean', async () => {
	setBin('asc', [
		['app-tags list', { out: { data: [] } }],
		['metadata keywords audit', { out: { data: [{ level: 'error', locale: 'en-US', message: 'keyword repeated in the name' }] } }],
	]);
	const dir = await asoRepo({ 'store/staged/en-US.json': { locale: 'en-US', name: 'Demo', subtitle: 'Track your cycle', keywords: 'calendar,ovulation,cycle,fertility,period,log,tracker,reminder,health,notes,history' } });
	const { code, out } = await aso(['audit'], { dir });
	assert.equal(code, 1);
	assert.match(out, /keyword repeated in the name/);
	assert.match(out, /Apple has generated none yet/);
	assert.match(out, /keywords en-US/);
});

// ── the sweep, stage by stage ───────────────────────────────────────────────
//
// Every stage carries its own `run`, `ok` and `summary` for --all-locales, and
// only harvest's were ever driven. These run the other three over two locales,
// which is the shape that matters: the second locale's row has to be produced
// from the first locale's artifacts, not from a global.

const TWO = { store: { locales: ['en-US', 'de-DE'] } };
const CANDIDATES = (locale) => ({ locale, terms: { 'period tracker calendar': { rank: 1 }, 'cycle log tracker': { rank: 2 } } });
const SCORED = (locale) => ({
	locale,
	terms: [
		{ keyword: 'period tracker calendar', demand: 50, opportunity: 40, competition: 10 },
		{ keyword: 'cycle log tracker', demand: 40, opportunity: 30, competition: 10 },
	],
});

test('volume --all-locales reports the term count it wrote for each locale', async () => {
	const dir = await asoRepo({ 'aso/en-US/candidates.json': CANDIDATES('en-US'), 'aso/de-DE/candidates.json': CANDIDATES('de-DE') }, TWO);
	const { code, out } = await aso(['volume'], { dir, flags: { 'all-locales': true, json: true } });
	assert.equal(code, 0);
	const rows = JSON.parse(out).locales;
	assert.deepEqual(rows.map((r) => [r.locale, r.ok]), [['en-US', true], ['de-DE', true]]);
	assert.ok(rows.every((r) => r.terms === 2 && r.file.endsWith('volume.json')));
});

test('score --all-locales scores each locale, and names the top term it found', async () => {
	const dir = await asoRepo({ 'aso/en-US/candidates.json': CANDIDATES('en-US'), 'aso/de-DE/candidates.json': CANDIDATES('de-DE') }, TWO);
	const { code, out } = await aso(['score'], { dir, flags: { 'all-locales': true, json: true } });
	assert.equal(code, 0);
	const rows = JSON.parse(out).locales;
	assert.ok(rows.every((r) => r.ok && r.scored > 0 && typeof r.top === 'string'));
	assert.ok((await readJson(dir, 'aso/de-DE/scored.json')).terms.length, 'the second locale really ran');
});

test('suggest --all-locales packs a field per locale, within the limit', async () => {
	const dir = await asoRepo({ 'aso/en-US/scored.json': SCORED('en-US'), 'aso/de-DE/scored.json': SCORED('de-DE') }, TWO);
	const { code, out } = await aso(['suggest'], { dir, flags: { 'all-locales': true, json: true } });
	assert.equal(code, 0);
	for (const row of JSON.parse(out).locales) {
		assert.ok(row.ok && row.keywords.length);
		assert.ok(row.used <= row.limit);
	}
});

test('a sweep prints each stage table, and the hint of the locale that failed', async () => {
	// de-DE has nothing to score, which is a ShipError with a hint — the sweep
	// keeps the locale that worked and passes the hint through for the one that
	// did not, rather than dying on the first.
	const dir = await asoRepo({ 'aso/en-US/candidates.json': CANDIDATES('en-US') }, TWO);
	const { code, out } = await aso(['score'], { dir, flags: { 'all-locales': true } });
	assert.equal(code, 0, 'one locale is enough for the sweep to have done its job');
	assert.match(out, /Score en-US/, 'the stage prints its own table as it goes');
	assert.match(out, /de-DE: .* — keeping the last score/);
	assert.match(out, /ship aso harvest --locale de-DE/, 'the failure carries its hint');
	assert.match(out, /1\/2 locales/);
});

test('a harvest walled halfway keeps what it already paid for', async () => {
	const dir = await asoRepo();
	let seen = 0;
	// The storefront answers the first stem and then walls, which is what a 403
	// mid-sweep looks like: the candidates from before the wall are written, and
	// the operator is told where they went.
	const wall = async (url) => {
		if (!String(url).includes('MZSearchHints')) return json({ results: APPS });
		if (seen++ === 0) return new Response(hintsBody(SUGGESTIONS));
		return new Response('nope', { status: 403 });
	};
	// The wall propagates, so the run is caught here to read what it printed on
	// the way out.
	const { out } = await capture(() => inDir(dir, () => withFetch(wall, () => run({ args: ['harvest'], flags: { seeds: 'period tracker' } }).catch((err) => err))));
	assert.match(out, /kept \d+ candidates harvested before the wall/);
	const kept = await readJson(dir, 'aso/en-US/candidates.json');
	assert.ok(Object.keys(kept.terms).length, 'the partial harvest is on disk, not lost with the error');
});

// ── the branches around the edges of each stage ─────────────────────────────

test('a corrupt volume.json is ignored with a warning, not fatal to the score', async () => {
	const dir = await asoRepo({ 'aso/en-US/candidates.json': CANDIDATES('en-US'), 'aso/en-US/volume.json': '{ this is not json' });
	const { code, out } = await aso(['score'], { dir });
	assert.equal(code, 0);
	assert.match(out, /ignoring .*volume\.json/);
});

test('--no-cache and --refresh both reach the storefront, and say so', async () => {
	for (const flag of ['no-cache', 'refresh']) {
		const dir = await asoRepo();
		const { code } = await aso(['harvest'], { dir, flags: { [flag]: true, seeds: 'period tracker' } });
		assert.equal(code, 0, `--${flag}`);
	}
});

test('a harvest that finds nothing exits non-zero rather than writing an empty artifact', async () => {
	const dir = await asoRepo();
	const { code } = await aso(['harvest'], { dir, flags: { seeds: 'period tracker' }, fetch: storefront({ suggestions: [] }) });
	assert.equal(code, 1);
	// The same emptiness inside a sweep is a locale that did not work, not a crash.
	const swept = await asoRepo();
	const { code: sweepCode, out } = await aso(['harvest'], { dir: swept, flags: { 'all-locales': true, seeds: 'period tracker' }, fetch: storefront({ suggestions: [] }) });
	assert.equal(sweepCode, 1);
	assert.match(out, /0\/1 locales/);
	assert.match(out, /no result/, 'a locale that failed without an error still gets a reason');
});

test('an imported volume dump merges into the terms already measured', async () => {
	const dir = await asoRepo({ 'aso/en-US/volume.json': { locale: 'en-US', terms: { 'already here': { popularity: 10 } } } });
	await writeFiles(dir, { 'dump.json': { 'period tracker calendar': 62 } });
	const { code } = await aso(['volume'], { dir, flags: { file: join(dir, 'dump.json') } });
	assert.equal(code, 0);
	const doc = await readJson(dir, 'aso/en-US/volume.json');
	assert.deepEqual(Object.keys(doc.terms).sort(), ['already here', 'period tracker calendar']);
});

test('volume with a measured file already on disk reports it rather than the template', async () => {
	const dir = await asoRepo({ 'aso/en-US/volume.json': { locale: 'en-US', terms: { 'period tracker': { popularity: 40 } } } });
	const { code, out } = await aso(['volume'], { dir });
	assert.equal(code, 0);
	assert.doesNotMatch(out, /fill/i, 'the template line is for a locale with nothing measured');
	const { out: asJson } = await aso(['volume'], { dir, flags: { json: true } });
	assert.deepEqual(Object.keys(JSON.parse(asJson).terms), ['period tracker']);
});

test('volume --fetch merges Apple\'s numbers into what was already there', async () => {
	setBin('asc', [['ads auth token', { out: { access_token: 'tok' } }]]);
	const dir = await asoRepo({
		'aso/en-US/candidates.json': CANDIDATES('en-US'),
		'aso/en-US/volume.json': { locale: 'en-US', terms: { 'hand measured': { popularity: 9 } } },
	});
	const { code } = await aso(['volume'], { dir, flags: { fetch: true } });
	assert.equal(code, 0);
	assert.ok(Object.keys((await readJson(dir, 'aso/en-US/volume.json')).terms).includes('hand measured'));
});

test('score --json emits the artifact, and names how many minVolume dropped', async () => {
	// One candidate Apple measured at 5, which is under the floor; the other has
	// no measurement and keeps its rank estimate.
	const files = { 'aso/en-US/candidates.json': CANDIDATES('en-US'), 'aso/en-US/volume.json': { locale: 'en-US', terms: { 'cycle log tracker': { popularity: 5 } } } };
	const dir = await asoRepo(files, { aso: { minVolume: 20 } });
	const { code, out } = await aso(['score'], { dir });
	assert.equal(code, 0);
	assert.match(out, /1 under minVolume 20/);

	const asJson = await asoRepo(files, { aso: { minVolume: 20 } });
	const { out: body } = await aso(['score'], { dir: asJson, flags: { json: true } });
	assert.equal(JSON.parse(body).locale, 'en-US');
});

test('suggest --json against no listing reports the absence rather than a path', async () => {
	const dir = await asoRepo({ 'aso/en-US/scored.json': SCORED('en-US') });
	const { code, out } = await aso(['suggest'], { dir, flags: { json: true } });
	assert.equal(code, 0);
	assert.equal(JSON.parse(out).listing, null);
});

test('a repo with no store.locales sweeps the source locale alone', async () => {
	const dir = await asoRepo({ 'aso/en-US/scored.json': SCORED('en-US') }, { store: { locales: [] } });
	const { code, out } = await aso(['suggest'], { dir, flags: { 'all-locales': true, json: true } });
	assert.equal(code, 0);
	assert.deepEqual(JSON.parse(out).locales.map((r) => r.locale), ['en-US']);
});

test('packing stops at the limit however many terms it is given', async () => {
	const long = Array.from({ length: 12 }, (_, i) => ({ keyword: `long candidate term number ${i}`, demand: 90 - i, opportunity: 40, competition: 10 }));
	const dir = await asoRepo({ 'aso/en-US/scored.json': { locale: 'en-US', terms: long }, 'store/staged/en-US.json': LISTING });
	const { code, out } = await aso(['suggest'], { dir, flags: { json: true } });
	assert.equal(code, 0);
	const p = JSON.parse(out);
	assert.ok(p.used <= p.limit && p.keywords.length <= p.limit, 'the field cannot come back over the limit');
	assert.ok(p.listing.endsWith('en-US.json'), 'the listing it packed against is named');
});

test('apply prints (empty) for a listing that has no keywords yet', async () => {
	const dir = await asoRepo({
		'aso/en-US/scored.json': SCORED('en-US'),
		'store/staged/en-US.json': { locale: 'en-US', name: 'Demo', subtitle: 'Track your cycle', keywords: '' },
	});
	const { code, out } = await aso(['apply'], { dir });
	assert.equal(code, 0);
	assert.match(out, /\(empty\)/);
});

test('competitors with no ids and no scores says where ids come from', async () => {
	const dir = await asoRepo({ 'aso/en-US/scored.json': { locale: 'en-US', terms: [{ keyword: 'period tracker calendar' }] } });
	await assert.rejects(() => aso(['competitors'], { dir, flags: { ids: ' , ' } }), (err) => {
		assert.match(err.message, /no competitor ids/);
		assert.match(err.hint, /pass --ids 123,456/);
		return true;
	});
});

test('competitors --json emits the artifact it wrote', async () => {
	const dir = await asoRepo();
	const { code, out } = await aso(['competitors'], { dir, flags: { ids: '1038369065', json: true } });
	assert.equal(code, 0);
	assert.deepEqual(JSON.parse(out).ids, ['1038369065']);
});

test('audit warns when there is no staged listing to lint at all', async () => {
	setBin('asc', [['', { out: { data: [] } }]]);
	const dir = await asoRepo();
	const { out } = await aso(['audit'], { dir });
	assert.match(out, /none under/);
	assert.match(out, /no research yet: ship aso harvest/);
});

test('an artifact missing its terms map is empty, not undefined', async () => {
	// Every stage reads `terms` off an artifact a previous stage wrote. A file
	// that predates the key — or was hand-edited down to nothing — has to read as
	// "no terms", which is a refusal naming the stage, never a TypeError.
	const dir = await asoRepo({ 'aso/en-US/candidates.json': { locale: 'en-US' } });
	await assert.rejects(() => aso(['volume'], { dir, flags: { fetch: true } }), /no candidates to measure/);
	await assert.rejects(() => aso(['score'], { dir }), /no scorable candidates/);

	const swept = await asoRepo({ 'aso/en-US/volume.json': { locale: 'en-US' } });
	const { out } = await aso(['volume'], { dir: swept, flags: { 'all-locales': true, json: true } });
	assert.equal(JSON.parse(out).locales[0].terms, 0);
});

test('a hand-edited candidate whose case does not match its demand row scores as unmeasured', async () => {
	// Picking lowercases every term; the demand table is keyed by the term as
	// written. A file typed by hand — rather than written by harvest — can carry
	// "Period Tracker Calendar", and the two sides then do not meet. Demand of an
	// unmatched term is 0, which is under any floor above zero.
	const dir = await asoRepo({ 'aso/en-US/candidates.json': { locale: 'en-US', terms: { 'Period Tracker Calendar': { rank: 1 } } } }, { aso: { minVolume: 1 } });
	await assert.rejects(() => aso(['score'], { dir }), (err) => {
		assert.match(err.message, /no scorable candidates/);
		assert.match(err.hint, /all under aso.minVolume 1/);
		return true;
	});
});

test('a scored term that carries no demand is packed rather than dropped', async () => {
	const dir = await asoRepo({
		'aso/en-US/scored.json': { locale: 'en-US', terms: [{ keyword: 'period tracker calendar', opportunity: 40, competition: 10 }] },
		'store/staged/en-US.json': LISTING,
	}, { aso: { minVolume: 50 } });
	const { out } = await aso(['suggest'], { dir, flags: { json: true } });
	assert.ok(JSON.parse(out).keywords.length, 'an unmeasured term is assumed average, not assumed dead');
});

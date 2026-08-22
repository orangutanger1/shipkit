// The ranking rule the whole ASO pipeline sorts by: opportunity = demand × competition.
//
// The supply-only score that shipped first ranked an uncontested keyword nobody
// types above every real term, so the fuse must be multiplicative — demand 0 is
// opportunity 0 no matter how weak the incumbents are. These tests pin that, the
// two demand signals feeding it, the code-point budget of the keyword field, and
// the fact that the request gate is per storefront rather than one global lock.
// Everything runs offline: pure functions, plus one stubbed fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	MIN_INTERVAL_MS,
	brandCollisions,
	demand,
	demandTable,
	gateFor,
	gateWait,
	hints,
	packKeywords,
	pickCandidates,
	saturation,
	score,
} from '../src/lib/appstore.mjs';
import { charCount } from '../src/lib/text.mjs';

/** A top-10 of near-invisible apps: nothing to outrank, so competition is high. */
const weakTop10 = Array.from({ length: 10 }, (_, i) => ({
	trackName: `Zen Timer ${i}`,
	trackId: 100 + i,
	userRatingCount: 10,
	averageUserRating: 4.5,
	sellerName: `Indie ${i}`,
	price: 0,
}));

/** The inverse: ten entrenched apps, all with the term in the title. */
const strongTop10 = Array.from({ length: 10 }, (_, i) => ({
	trackName: `habit tracker ${i}`,
	trackId: 200 + i,
	userRatingCount: 200_000,
	averageUserRating: 4.8,
	sellerName: `Corp ${i}`,
	price: 1.99,
}));

const NOW = Date.parse('2026-08-21T00:00:00.000Z');
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

/**
 * The trap the strength gates cannot see: ten apps that all shipped this
 * quarter, six of them with the query as their title. Every incumbent is weak
 * because none of them has existed long enough to be strong.
 */
const floodedTop10 = Array.from({ length: 10 }, (_, i) => ({
	trackName: i < 6 ? `Car Maintenance Log ${i}` : `Auto Care ${i}`,
	trackId: 300 + i,
	userRatingCount: i,
	sellerName: `Solo Dev ${i}`,
	releaseDate: daysAgo(20 + i * 5),
	price: 0,
}));

test('saturation separates a fresh stampede from a durable gap', () => {
	const flood = saturation(floodedTop10, { term: 'car maintenance log', now: NOW });
	assert.equal(flood.newEntrants, 10);
	assert.equal(flood.newEntrantsQuarter, 10);
	assert.equal(flood.freshUnproven, 10, 'nobody in this top-10 has 25 ratings');
	assert.equal(flood.clones, 6, 'six shipped this year, titled after the query, unused');
	assert.equal(flood.score, 84, '0.30 all-fresh + 0.30 all-unproven + 0.40 × 6/10 clones');

	// Same review counts, same weak incumbents — but they have been there for years.
	const old = saturation(
		floodedTop10.map((a) => ({ ...a, releaseDate: daysAgo(1_500) })),
		{ term: 'car maintenance log', now: NOW },
	);
	assert.equal(old.newEntrants, 0);
	assert.equal(old.clones, 0, 'named after the query but four years old is a dead category, not a race');
	assert.equal(old.score, 0, 'weak and old is the gap the sweep is looking for');
	assert.equal(old.medianAgeDays, 1_500);
});

test('an undated top-10 cannot fake a saturation pass or a saturation failure', () => {
	// weakTop10 carries no releaseDate: unknown ages are excluded from every
	// ratio rather than guessed at, so nothing fires on a lookup gap.
	const flood = saturation(weakTop10, { term: 'zen timer', now: NOW });
	assert.equal(flood.dated, 0);
	assert.equal(flood.clones, 0);
	assert.equal(flood.score, 0);
});

test('viability discounts a flooded term the opportunity score loves', () => {
	const s = score('car maintenance log', floodedTop10, { demand: 60, now: NOW });
	assert.ok(s.opportunity > 40, `supply-side scoring still calls it easy (${s.opportunity})`);
	assert.equal(s.saturation, 84);
	assert.equal(s.clones, 6);
	assert.equal(s.viability, 7, 'a stampede is worth nearly nothing however weak its runners are');
});

test('a brand word collides on a whole word anywhere in the title, not on a substring', () => {
	const results = [
		{ trackName: 'Car Maintenance Log - Glovebox', trackId: 1, userRatingCount: 41, releaseDate: daysAgo(60) },
		{ trackName: 'Glovebox', trackId: 2, userRatingCount: 900, releaseDate: daysAgo(900) },
		{ trackName: 'Gloveboxes Unlimited', trackId: 3, userRatingCount: 5, releaseDate: daysAgo(30) },
		{ trackName: 'Fuelio: Gas Log', trackId: 4, userRatingCount: 18_400, releaseDate: daysAgo(3_000) },
	];
	const hits = brandCollisions('Glovebox', results, { now: NOW });
	assert.deepEqual(
		hits.map((h) => h.id),
		[2, 1],
		'exact title first, then the suffix collision; the plural is not a collision',
	);
	assert.equal(hits[0].exact, true);
	assert.equal(hits[1].exact, false);
	assert.equal(hits[1].ageDays, 60);
});

test('demand is monotonic in autocomplete rank', () => {
	const at = (rank) => demand({ seeds: ['habit'], rank });
	const curve = [0, 1, 2, 3, 7, 11].map(at);
	for (let i = 1; i < curve.length; i++) assert.ok(curve[i] < curve[i - 1], `rank ${i} should score lower`);
	// The headline case: Apple's first suggestion beats its eighth.
	assert.ok(at(0) > at(7));
	assert.ok(curve.every((n) => n >= 0 && n <= 100));
});

test('demand rewards a term several distinct seeds surfaced', () => {
	const one = demand({ seeds: ['habit'], rank: 3 });
	const three = demand({ seeds: ['habit', 'routine', 'streak'], rank: 3 });
	assert.ok(three > one, 'a hub term beats a long-tail accident at the same rank');
	// Duplicate seeds are already deduped upstream; the count is what moves it.
	assert.equal(demand({ seeds: ['habit', 'routine'], rank: 3 }) > one, true);
});

test('demand falls back to the neutral middle when the artifact carries no rank', () => {
	assert.equal(demand(['habit']), 50);
	assert.ok(demand(['habit', 'routine']) > demand(['habit']), 'seed count still orders legacy entries');
	assert.equal(demand({ seeds: ['habit'] }), 50, 'a rankless object is legacy too');
});

test('opportunity is demand × competition, so no demand means no opportunity', () => {
	const uncontested = score('habit tracker', weakTop10, { demand: 0 });
	assert.equal(uncontested.competition, 93, 'the supply side still says "easy"');
	assert.equal(uncontested.opportunity, 0, 'a keyword nobody types is worth nothing');

	assert.equal(score('habit tracker', weakTop10, { demand: 100 }).opportunity, 93);
	assert.equal(score('habit tracker', weakTop10, { demand: 50 }).opportunity, 47);
	assert.equal(score('habit tracker', weakTop10).opportunity, 93, 'unknown demand is not a discount');
	// Monotone in demand at fixed competition — the sort order the pipeline uses.
	const rising = [0, 10, 40, 80, 100].map((d) => score('habit tracker', weakTop10, { demand: d }).opportunity);
	for (let i = 1; i < rising.length; i++) assert.ok(rising[i] > rising[i - 1]);
});

test('competition reads the supply side: weak incumbents high, entrenched ones low', () => {
	const easy = score('habit tracker', weakTop10);
	assert.equal(easy.competition, 93);
	assert.equal(easy.exactTitleMatches, 0);
	assert.equal(easy.weakAppsTop10, 10);
	assert.equal(easy.medianRatings, 10);
	assert.equal(easy.maxRatings, 10);
	assert.equal(easy.paidTop10, 0);
	assert.equal(easy.results, 10);
	assert.equal(easy.top3.length, 3);
	assert.deepEqual(easy.top3[0], { name: 'Zen Timer 0', id: 100, ratings: 10, stars: 4.5, seller: 'Indie 0' });

	const hard = score('habit tracker', strongTop10);
	assert.equal(hard.competition, 0);
	assert.equal(hard.exactTitleMatches, 10);
	assert.equal(hard.weakAppsTop10, 0);
	assert.equal(hard.medianRatings, 200_000);
	assert.equal(hard.paidTop10, 10);
	assert.ok(easy.competition > hard.competition);

	assert.equal(score('habit tracker', []), null, 'no results is no verdict, not a zero');
	assert.equal(score('habit tracker', null), null);
});

test('demandTable prefers measured impressions, then volume, then rank', () => {
	const terms = {
		'habit tracker': { seeds: ['habit'], rank: 0 },
		'streak counter': { seeds: ['streak'], rank: 6 },
		'daily routine': { seeds: ['routine'], rank: 2 },
	};
	const table = demandTable(terms, {
		volume: { terms: { 'streak counter': { popularity: 71, difficulty: 42 }, 'habit tracker': 5 } },
		analytics: {
			rows: [
				{ term: 'habit tracker', impressions: 10_000 },
				{ term: 'daily routine', impressions: 0 },
			],
		},
	});
	assert.deepEqual(table.get('habit tracker'), { demand: 100, source: 'analytics', difficulty: undefined });
	assert.deepEqual(table.get('streak counter'), { demand: 71, source: 'volume', difficulty: 42 });
	// Measured zero impressions is a disproved guess, not a missing signal.
	assert.deepEqual(table.get('daily routine'), { demand: 0, source: 'analytics', difficulty: undefined });
});

test('demandTable falls back to rank when neither file has the term', () => {
	const table = demandTable({ 'habit tracker': { seeds: ['habit'], rank: 0 } }, { volume: null, analytics: null });
	const row = table.get('habit tracker');
	assert.equal(row.source, 'rank');
	assert.ok(row.demand > 50);
	// An analytics file whose every row is zero carries no signal at all.
	const noSignal = demandTable(
		{ 'habit tracker': { seeds: ['habit'], rank: 0 } },
		{ analytics: { rows: [{ term: 'habit tracker', impressions: 0 }] } },
	);
	assert.equal(noSignal.get('habit tracker').source, 'rank');
});

test('a legacy candidates.json loads alongside the new candidate shape', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'shipkit-aso-'));
	const file = join(dir, 'candidates.json');
	await writeFile(
		file,
		JSON.stringify({
			generatedAt: new Date().toISOString(),
			locale: 'en-US',
			market: { country: 'US', lang: 'en_us' },
			seeds: ['habit', 'streak'],
			terms: {
				'habit tracker': ['habit', 'streak'], // legacy: term → seeds[]
				'streak counter': ['streak'],
				'daily routine': { seeds: ['habit'], rank: 1 }, // current shape, same file
			},
		}),
	);
	const artifact = JSON.parse(await readFile(file, 'utf8'));

	assert.deepEqual(pickCandidates(Object.keys(artifact.terms)), [
		'daily routine',
		'habit tracker',
		'streak counter',
	]);
	const table = demandTable(artifact.terms);
	assert.equal(table.size, 3);
	for (const [term, row] of table) {
		assert.equal(row.source, 'rank', term);
		assert.ok(row.demand > 0 && row.demand <= 100, term);
	}
	assert.ok(
		table.get('habit tracker').demand > table.get('streak counter').demand,
		'two seeds beat one when neither legacy entry has a rank',
	);
	assert.ok(table.get('daily routine').demand > table.get('habit tracker').demand, 'a real rank outranks the middle');
});

test('packKeywords budgets the Japanese field in code points, not UTF-16 units', () => {
	const scored = [
		{ keyword: '𠮷 𩸽 𠀋 𡈽' }, // astral ideographs: 1 character to ASC, 2 to String.length
		{ keyword: '𣇄 𤎼 𥝱 𦉰' },
		{ keyword: 'カレンダー予定' },
		{ keyword: 'タスク管理' },
		{ keyword: '習慣トラッカー' },
		{ keyword: '日程調整' },
		{ keyword: '時間割' },
		{ keyword: '家計簿' },
		{ keyword: '目標達成' },
		{ keyword: '仕事効率化' },
		{ keyword: 'メモ帳' },
		{ keyword: '買い物リスト' },
		{ keyword: '睡眠記録' },
		{ keyword: '瞑想' },
		{ keyword: '集中' },
		{ keyword: '健康管理' },
		{ keyword: '体重記録' },
		{ keyword: '勉強' },
		{ keyword: '資格' },
		{ keyword: 'ダイエット' },
		{ keyword: '節約' },
	];
	const packed = packKeywords(scored, { locale: 'ja', alreadyIndexed: 'カレンダー 予定' });
	const chosen = packed.keywords.split(',');

	assert.ok(charCount(packed.keywords) <= 100, `${charCount(packed.keywords)} code points`);
	assert.equal(packed.used, charCount(packed.keywords));
	assert.equal(packed.limit, 100);
	assert.ok(
		packed.keywords.length > 100,
		'a String.length budget would have stopped short of the real 100-character limit',
	);

	assert.ok(!packed.keywords.includes(', '), 'ASC counts the space, so the separator is a bare comma');
	assert.ok(!/\s/.test(packed.keywords));
	assert.ok(!chosen.includes(''), 'no empty slots');
	assert.equal(new Set(chosen).size, chosen.length, 'no word repeats');

	// Name and subtitle are indexed already; spending slots on them is pure waste.
	assert.ok(!chosen.includes('カレンダー'));
	assert.ok(!chosen.includes('予定'));
	assert.equal(packed.dropped, 2);

	// Highest value first, in scored order.
	assert.equal(chosen[0], '𠮷');
	assert.ok(chosen.indexOf('タスク') < chosen.indexOf('睡眠'));
	assert.ok(chosen.indexOf('睡眠') < chosen.indexOf('勉強'));

	// The field really is full: the tail of the list did not make it in.
	assert.ok(chosen.length < 38, `${chosen.length} of the available words packed`);
	assert.ok(!chosen.includes('ダイエット'), 'the first word that no longer fits is skipped');
});

test('packKeywords drops stop words and single letters in English', () => {
	const packed = packKeywords([{ keyword: 'the best habit tracker' }, { keyword: 'a streak pomodoro' }], {
		locale: 'en',
		alreadyIndexed: 'Habit — Daily Tracker',
	});
	const chosen = packed.keywords.split(',');
	// `the`/`best` are stop words, `a` is a single letter, `habit`/`tracker` are already indexed.
	assert.deepEqual(chosen, ['streak', 'pomodoro']);
	assert.ok(!packed.keywords.includes(', '));
	assert.equal(packed.used, charCount(packed.keywords));
});

test('the request gate is per storefront, not one global lock', () => {
	// Fake clock: the gate holds only timestamps, so no time actually passes here.
	const now = 5_000_000;
	const de = gateFor('test-DE');
	const jp = gateFor('test-JP');
	assert.notEqual(de, jp);
	assert.equal(gateFor('test-DE'), de, 'one gate per country, reused');

	assert.ok(gateWait(de, now) <= 0, 'a fresh storefront waits for nothing');

	de.last = now; // DE just answered
	assert.equal(gateWait(de, now + 1), MIN_INTERVAL_MS - 1, 'the same storefront waits out the floor');
	assert.ok(gateWait(de, now + MIN_INTERVAL_MS) <= 0, 'and is free again after it');
	assert.ok(gateWait(jp, now + 1) <= 0, 'while another storefront is untouched — N locales sweep at N req/s');

	de.until = now + 20_000; // DE refused us; the backoff is DE's alone
	assert.equal(gateWait(de, now + 5_000), 15_000);
	assert.ok(gateWait(jp, now + 5_000) <= 0, 'DE refusing us says nothing about JP');
});

test('two storefronts are fetched concurrently, under the one-per-second floor', async (t) => {
	const seen = [];
	const real = globalThis.fetch;
	globalThis.fetch = async (url) => {
		seen.push({ at: Date.now(), url: String(url) });
		await new Promise((r) => setTimeout(r, 20));
		return {
			ok: true,
			status: 200,
			text: async () => '<dict><key>term</key><string>habit tracker</string></dict>',
		};
	};
	t.after(() => {
		globalThis.fetch = real;
	});

	const started = Date.now();
	const [us, jp] = await Promise.all([hints('habit', 'US'), hints('習慣', 'JP')]);
	const elapsed = Date.now() - started;

	assert.deepEqual(us, ['habit tracker']);
	assert.deepEqual(jp, ['habit tracker']);
	assert.equal(seen.length, 2);
	assert.ok(elapsed < MIN_INTERVAL_MS, `two storefronts took ${elapsed}ms; a global lock would cost a second`);
	assert.ok(Math.abs(seen[0].at - seen[1].at) < 100, 'the two requests overlapped');
	assert.ok(seen.some((r) => r.url.includes('country=US')));
	assert.ok(seen.some((r) => r.url.includes('country=JP')));
});

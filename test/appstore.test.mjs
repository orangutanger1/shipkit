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
	commodity,
	saturation,
	score,
} from '../src/lib/appstore.mjs';
import { CAPTURED_AT, page, pages, top } from './fixtures/storefront.mjs';
import { charCount } from '../src/lib/text.mjs';

// Every page below is real, captured from the live storefront. See
// test/fixtures/storefront.mjs for provenance and how to refresh.
//
// Synthetic fixtures are how three false passes shipped in a row here: an
// invented top-10 only contains the naming conventions its author thought of,
// and each clone-detection bug was exactly a convention nobody thought of
// ("Aquarium Manager: Tank Log", "Walter Feeds & Speeds", "Sudoku.com"). Real
// pages are also better extremes than invented ones — nothing hand-written was
// going to guess a top-10 with a median of 96,704 ratings.
const NOW = CAPTURED_AT;

/**
 * The archetypes the scoring formula is stretched between, all real:
 *
 * - `boat maintenance log` — the stampede. 7 of 9 shipped inside a year, median
 *   0 ratings, four titled after the query. This is the incident the saturation
 *   gate was written for, and it is still live.
 * - `calorie counter` — the wall. Median 96,704 ratings, 8 of 9 with the term in
 *   the title, biggest at 2.35M.
 * - `feeds and speeds calculator` — weak *and old*: median 17 ratings, nothing
 *   titled after the query, incumbents from 2011-2013. The real "durable gap"
 *   shape, and the page that proved commodity was blind to subject-named
 *   categories.
 */
const STAMPEDE = top('boat maintenance log');
const WALL = top('calorie counter');
const DURABLE_GAP = top('feeds and speeds calculator');

test('saturation separates a fresh stampede from a durable gap', () => {
	const flood = saturation(STAMPEDE, { term: 'boat maintenance log', now: NOW });
	assert.equal(flood.results, 9);
	assert.equal(flood.newEntrants, 7, 'seven of the nine shipped inside a year');
	assert.equal(flood.newEntrantsQuarter, 3);
	assert.equal(flood.freshUnproven, 7, 'not one of the seven has 25 ratings');
	assert.equal(flood.clones, 4, 'four titled after the query, shipped this year, unused');
	assert.deepEqual(flood.cloneApps, [
		'Afloatly: Boat Maintenance Log',
		'Boat Maintenance Log : KEEL',
		'HullBook: Boat Maintenance Log',
		'Skipper: Boat Maintenance Log',
	]);
	assert.equal(flood.score, 64);
	assert.equal(flood.medianAgeDays, 113, 'the median incumbent is four months old');

	// The contrast that makes the age window deliberate rather than incidental:
	// weaker incumbents than the stampede (median 17 ratings against 0 is close,
	// and 9 of 10 are under 1,000), but they have held the page since 2011.
	const gap = saturation(DURABLE_GAP, { term: 'feeds and speeds calculator', now: NOW });
	assert.equal(gap.newEntrants, 0, 'nobody has entered this category in a year');
	assert.equal(gap.clones, 0);
	assert.equal(gap.score, 0, 'weak and old is the gap the sweep is looking for');
	assert.ok(gap.medianAgeDays > 3_000, `median age ${gap.medianAgeDays}d`);
});

test('an undated top-10 cannot fake a saturation pass or a saturation failure', () => {
	// A real page with the release dates removed, which is what a lookup gap
	// actually looks like: unknown ages are excluded from every ratio rather
	// than guessed at, so nothing fires either way.
	const undated = STAMPEDE.map(({ releaseDate: _dropped, ...rest }) => rest);
	const flood = saturation(undated, { term: 'boat maintenance log', now: NOW });
	assert.equal(flood.dated, 0);
	assert.equal(flood.clones, 0, 'four titles still match the query — but no date, no verdict');
	assert.equal(flood.score, 0);
	assert.equal(flood.medianAgeDays, null);
});

test('viability discounts a flooded term the opportunity score loves', () => {
	const s = score('boat maintenance log', STAMPEDE, { demand: 60, now: NOW });
	assert.ok(s.opportunity > 40, `supply-side scoring still calls it easy (${s.opportunity})`);
	assert.equal(s.competition, 76, 'median 0 ratings reads as "no incumbent to beat"');
	assert.equal(s.saturation, 64);
	assert.equal(s.clones, 4);
	assert.equal(s.commodity, 78);
	assert.equal(s.viability, 4, 'a stampede is worth nearly nothing however weak its runners are');

	// Same discount machinery, opposite cause: nothing fresh here, but the
	// product exists nine times over.
	const solved = score('calorie counter', WALL, { demand: 100, now: NOW });
	assert.equal(solved.saturation, 0, 'no stampede at all');
	assert.equal(solved.commodity, 100, 'and yet every result is this app');
	assert.equal(solved.viability, 0);
});

test('commodity sees the same product under permuted vocabulary, which clones cannot', () => {
	const term = 'aquarium water log';
	// The false pass this function exists to remove, on the real page: the gate
	// that shipped first tested `title.includes("aquarium water log")`, and no
	// title on this page contains that phrase.
	assert.equal(saturation(top(term), { term, now: NOW }).clones, 0, 'the false pass, still reproducible');

	const same = commodity(top(term), { term });
	assert.equal(same.matches, 5);
	assert.equal(same.share, 50);
	assert.deepEqual(same.subjects, ['aquarium', 'water']);
	const named = same.apps.map((a) => a.name);
	assert.ok(named.includes('Aquarium Manager: Tank Log'), 'permuted vocabulary, zero overlap with the query');
	assert.ok(named.includes('aquaPlanner'), 'a truncated compound still resolves to the subject');
});

test('commodity counts the real page for a term whose own words nobody uses', () => {
	// The documented ceiling of a token test, on the page that shows it worst.
	// Every one of these nine German apps is a car-maintenance logbook — Wartung
	// is maintenance, Fahrzeug-Logbuch is vehicle logbook — and not one uses a
	// word from "kfz scheckheft". No tokeniser derives that; only a human or a
	// translation does.
	const p = page('kfz scheckheft');
	const same = commodity(p.apps, { term: p.term, locale: p.locale });
	assert.deepEqual(same.subjects, ['kfz', 'scheckheft']);
	assert.equal(same.share, 0, 'commodity is a lower bound and here the bound is useless');

	// Which is why it is not the only gate. The same page is a 60 on saturation:
	// seven of nine shipped inside a year and none has traction. Two numbers
	// reading different evidence is the redundancy that catches this one.
	const flood = saturation(p.apps, { term: p.term, now: NOW });
	assert.equal(flood.score, 60);
	assert.ok(flood.freshUnproven >= 6, `${flood.freshUnproven} fresh and unproven`);
});

test('commodity segments a language with no word spacing', () => {
	// 家計簿 is one string with no boundaries a regex can see, and every app on
	// the page is a household account book. Whitespace tokenisation scores this
	// 0%; Intl.Segmenter scores it correctly.
	const p = page('家計簿');
	const same = commodity(p.apps, { term: p.term, locale: p.locale });
	assert.deepEqual(same.subjects, ['家計', '簿']);
	assert.equal(same.share, 100);
	assert.equal(same.proven, 9, 'and all nine have real ratings — a solved category, not a race');
});

test('commodity does not count adjacent products or substring accidents', () => {
	const same = commodity(top('aquarium water log'), { term: 'aquarium water log' });
	const named = same.apps.map((a) => a.name);
	assert.ok(!named.includes('Tap Tap Fish - AbyssRium'), 'an aquarium game is not an aquarium log');
	assert.ok(!named.includes('Fish Farm 3 - Aquarium'), 'nor is a fish-farm game');

	// Substring safety, on a real title: "Killer Sudoku by Sudoku.com" is caught
	// by the subject, but a word merely containing an artifact noun is not an
	// artifact noun. Camel-splitting plus word boundaries is what separates them.
	const catalogue = commodity([{ trackName: 'Catalog of Marine Biology', userRatingCount: 50 }], {
		term: 'aquarium water log',
	});
	assert.equal(catalogue.matches, 0, '"Catalog" contains "log" and is not a log');
});

test('a title covering every subject word counts, and that over-counts sometimes', () => {
	// The deliberate cost of the rule that catches subject-named categories: a
	// title carrying every subject word qualifies alone, so "Drink Water
	// Aquarium" — a drinking-reminder gimmick with a fish tank in it — counts.
	//
	// Kept, because the error directions are not symmetric. Under-counting
	// passes a solved term and costs an app; over-counting fails a live term and
	// costs a second look at a page whose matched titles the brief prints by
	// name. The gate is a prompt to look, not a substitute for looking.
	const same = commodity(top('aquarium water log'), { term: 'aquarium water log' });
	assert.ok(
		same.apps.some((a) => a.name === 'Drink Water Aquarium'),
		'covers both subjects, so it counts despite not being this product',
	);

	// Single-subject artifact-naming terms keep the stricter rule. Without it
	// every app merely mentioning the subject would count.
	const loose = commodity([{ trackName: 'Concrete Poetry Anthology', userRatingCount: 5 }], {
		term: 'concrete calculator',
	});
	assert.equal(loose.matches, 0, 'one subject word and no artifact noun is not this product');
});

test('commodity misses synonyms and pure brand words, and the fixture proves which', () => {
	// Named so a future reader knows these are known losses rather than passing
	// results. All four are the product; none is counted.
	const car = commodity(top('car maintenance log'), { term: 'car maintenance log' });
	const inCar = car.apps.map((a) => a.name);
	assert.equal(car.share, 80);
	assert.ok(!inCar.includes('Vehicle Maintenance Tracker'), '"vehicle" is a synonym for "car"');
	assert.ok(!inCar.includes('CARFAX Car Care'), '"care" is not in the artifact list, and this is that app');

	const aq = commodity(top('aquarium water log'), { term: 'aquarium water log' }).apps.map((a) => a.name);
	assert.ok(!aq.includes('Aquarimate'), 'a brand word that merely evokes the subject');
	assert.ok(!aq.includes('AquaCare:AI Aquarium Assistant'), '"assistant" is not an artifact noun');
});

test('commodity ignores age, so a solved category cannot pass by being old', () => {
	// The second half of the original bug: clones only counted inside 365 days,
	// so a category solved years ago scored zero. This page is a real one —
	// median incumbent age over nine years — and it is completely solved.
	const p = page('calorie counter');
	assert.equal(saturation(p.apps, { term: p.term, now: NOW }).score, 0, 'no stampede whatsoever');
	assert.ok(
		saturation(p.apps, { term: p.term, now: NOW }).medianAgeDays > 3_000,
		'these incumbents are a decade old',
	);
	assert.equal(commodity(p.apps, { term: p.term }).share, 100, 'and every result is this app');
});

test('commodity splits a served market from an unwon race by traction', () => {
	// Two real pages, same measurement, opposite diagnosis — and the remedies
	// are opposite too, which is why the number is reported split rather than
	// collapsed into a verdict.
	const served = commodity(top('calorie counter'), { term: 'calorie counter' });
	assert.equal(served.matches, 9);
	assert.equal(served.proven, 9, 'MyFitnessPal and eight others: solved, with paying users');
	assert.equal(served.unproven, 0);

	const race = commodity(top('boat maintenance log'), { term: 'boat maintenance log' });
	assert.equal(race.matches, 7);
	assert.equal(race.proven, 0, 'seven apps, not one with 25 ratings: a race that paid nobody');
	assert.equal(race.unproven, 7);
});

test('commodity sees a category that names itself by its subject, with no artifact noun', () => {
	// In machining "feeds and speeds" *is* the calculation, so incumbents feel
	// no need to add a category noun — and requiring one scored this real page
	// 0%, passing a term whose front page is three of exactly this app.
	const same = commodity(DURABLE_GAP, { term: 'feeds and speeds calculator' });
	assert.deepEqual(same.subjects, ['feeds', 'speeds'], '"and" is a stop word, "calculator" an artifact');
	assert.deepEqual(
		same.apps.map((a) => a.name),
		['Walter Feeds & Speeds', 'Feeds n Speeds', 'Adams Bits Feeds and Speeds'],
	);
	assert.ok(
		!same.apps.some((a) => a.name === 'Scientific Calculator Plus 991'),
		'an artifact noun with no subject word is a different product',
	);
	assert.ok(
		!same.apps.some((a) => a.name === 'FSWizard'),
		'a pure brand word is this product and cannot be seen — the documented blind spot',
	);
});

test('a one-word term is its own product name, so no artifact noun is required', () => {
	// The third false pass, and the one that proves the rule keys on the term's
	// shape rather than the titles'. "sudoku" names no artifact, so every title
	// carrying it is the same product — eight of eight, all with real ratings.
	// Demanding an artifact noun read this page as an unserved gap.
	for (const term of ['sudoku', 'metronome']) {
		const same = commodity(top(term), { term });
		assert.deepEqual(same.subjects, [term]);
		assert.equal(same.share, 100, `${term} is wholly solved`);
		assert.equal(same.unproven, 0);
	}

	// Not a blanket pass for one-word terms: the artifact noun is still required
	// when the term names one, which is what keeps "concrete calculator" honest.
	assert.equal(commodity(top('sudoku'), { term: 'sudoku tracker' }).share, 0, 'no sudoku *tracker* exists');
});

test('commodity is empty when the term has no subject word of its own', () => {
	// All-artifact terms describe no subject, so every logging app would match
	// and the number would mean nothing. Report zero instead.
	const same = commodity(top('habit tracker'), { term: 'log tracker' });
	assert.deepEqual(same.subjects, []);
	assert.equal(same.matches, 0);
});

test('commodity holds up across the whole captured corpus, not one category', () => {
	// A regression net over every real page: the numbers below are what the live
	// storefront said on the capture date. When one moves, the storefront moved —
	// re-run test/fixtures/capture.mjs and read the diff before editing this.
	const expected = {
		'period tracker': 89,
		'iv drip rate calculator': 50,
		'calorie counter': 100,
		'expense tracker': 44,
		'mortgage calculator': 60,
		'invoice maker': 89,
		'habit tracker': 78,
		'unit converter': 78,
		'wire size calculator': 30,
		sudoku: 100,
		flashcards: 100,
		'toddler games': 44,
		'photo editor': 78,
		metronome: 100,
		'reading tracker': 44,
		'flight tracker': 89,
		'hurricane tracker': 50,
		'golf gps': 78,
		'dive log': 50,
		'aquarium water log': 50,
		'feeds and speeds calculator': 30,
		'car maintenance log': 80,
		'car maintenance reminder': 80,
		'oil change': 30,
		'beehive inspection log': 60,
		'boat maintenance log': 78,
		'recipe manager': 89,
		'plant identifier': 67,
		'dog training': 78,
		'baby feeding log': 100,
		'kfz scheckheft': 0,
		家計簿: 100,
	};
	const actual = Object.fromEntries(
		pages().map((p) => [p.term, commodity(p.apps, { term: p.term, locale: p.locale }).share]),
	);
	assert.deepEqual(actual, expected);

	// The corpus has to stay broad, or the net above stops being one.
	assert.ok(pages().length >= 30, `${pages().length} pages`);
	assert.ok(new Set(pages().map((p) => p.genre)).size >= 12, 'at least a dozen App Store genres');
	assert.ok(new Set(pages().map((p) => p.country)).size >= 3, 'more than one storefront');
	assert.ok(
		pages().reduce((n, p) => n + p.apps.length, 0) >= 250,
		'a couple of hundred real listings behind the assertions',
	);
});

test('a brand word collides on a whole word anywhere in the title, not on a substring', () => {
	// Real page, real collision: "Steerlog: Car Maintenance Log" shipped three
	// weeks before the capture, which is exactly the situation `scout names` is
	// run to catch before you print the word on an icon.
	const hits = brandCollisions('Steerlog', top('car maintenance log'), { now: NOW });
	assert.deepEqual(hits.map((h) => h.name), ['Steerlog: Car Maintenance Log']);
	assert.equal(hits[0].exact, false, 'a prefix of a longer title, not the whole title');
	assert.equal(hits[0].ageDays, 24);

	// "Log" is a whole word in eight of these ten titles and a brand in none of
	// them; a substring test would report every one as taken.
	assert.equal(brandCollisions('Vehix', top('car maintenance log'), { now: NOW }).length, 1);
	assert.equal(
		brandCollisions('Steer', top('car maintenance log'), { now: NOW }).length,
		0,
		'"Steer" is a prefix of Steerlog, not a word in it',
	);
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
	// DURABLE_GAP is the real weak-incumbent page: median 17 ratings, nothing
	// titled after the query, 9 of 10 under a thousand ratings.
	const term = 'feeds and speeds calculator';
	const uncontested = score(term, DURABLE_GAP, { demand: 0, now: NOW });
	assert.equal(uncontested.competition, 87, 'the supply side still says "easy"');
	assert.equal(uncontested.opportunity, 0, 'a keyword nobody types is worth nothing');

	assert.equal(score(term, DURABLE_GAP, { demand: 100, now: NOW }).opportunity, 87);
	assert.equal(score(term, DURABLE_GAP, { demand: 50, now: NOW }).opportunity, 44);
	assert.equal(score(term, DURABLE_GAP, { now: NOW }).opportunity, 87, 'unknown demand is not a discount');
	// Monotone in demand at fixed competition — the sort order the pipeline uses.
	const rising = [0, 10, 40, 80, 100].map((d) => score(term, DURABLE_GAP, { demand: d, now: NOW }).opportunity);
	for (let i = 1; i < rising.length; i++) assert.ok(rising[i] > rising[i - 1]);
});

test('competition reads the supply side: weak incumbents high, entrenched ones low', () => {
	const easy = score('feeds and speeds calculator', DURABLE_GAP, { now: NOW });
	assert.equal(easy.competition, 87);
	assert.equal(easy.exactTitleMatches, 0, 'nobody named their app after the query');
	assert.equal(easy.weakAppsTop10, 9);
	assert.equal(easy.medianRatings, 17);
	assert.equal(easy.maxRatings, 12_325);
	assert.equal(easy.paidTop10, 2);
	assert.equal(easy.results, 10);
	assert.equal(easy.top3.length, 3);
	assert.deepEqual(easy.top3[0], {
		name: 'FSWizard',
		id: 741521897,
		ratings: 47,
		stars: 4.6383,
		seller: 'Eldar Gerfanov',
	});

	// The opposite end, also real: a median of 96,704 ratings and a 2.35M-rating
	// leader. Nothing hand-written was going to invent that page.
	const hard = score('calorie counter', WALL, { now: NOW });
	assert.equal(hard.competition, 0);
	assert.equal(hard.exactTitleMatches, 8);
	assert.equal(hard.weakAppsTop10, 0);
	assert.equal(hard.medianRatings, 96_704);
	assert.equal(hard.maxRatings, 2_352_291);
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

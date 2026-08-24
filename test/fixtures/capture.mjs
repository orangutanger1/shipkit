// Regenerates storefront.mjs from the live storefront. Not a test — run by hand
// when the frozen corpus goes stale:
//
//   node test/fixtures/capture.mjs
//
// then re-run the suite and read the diff. Changed numbers mean the storefront
// changed, which is the entire point of capturing real pages: a hand-written
// fixture can only contain the naming conventions its author already imagined,
// and every clone-detection bug in this repo was a convention nobody imagined.
//
// Apple throttles to one request per storefront per second and answers bursts
// with 403s, so this runs sequentially through the on-disk cache.
import { writeFile } from 'node:fs/promises';
import { hints, topResults, useCache } from '../../src/lib/appstore.mjs';

useCache({ dir: new URL('../../.cache/storefront', import.meta.url).pathname, mode: 'on' });

/**
 * Search pages to freeze. The spread is the point: a gate tuned on one category
 * passes that category and nothing else, and two of these markets exist
 * specifically to break token matching — German compounds whose incumbents
 * share none of the term's words, and Japanese with no word spacing at all.
 */
const TERMS = [
	// Health & Fitness / Medical
	['period tracker', 'US', 'en_us'],
	['iv drip rate calculator', 'US', 'en_us'],
	['calorie counter', 'US', 'en_us'],
	// Finance / Business
	['expense tracker', 'US', 'en_us'],
	['mortgage calculator', 'US', 'en_us'],
	['invoice maker', 'US', 'en_us'],
	// Productivity / Utilities
	['habit tracker', 'US', 'en_us'],
	['unit converter', 'US', 'en_us'],
	['wire size calculator', 'US', 'en_us'],
	// Games / Kids / Education
	['sudoku', 'US', 'en_us'],
	['flashcards', 'US', 'en_us'],
	['toddler games', 'US', 'en_us'],
	// Photo / Music / Books
	['photo editor', 'US', 'en_us'],
	['metronome', 'US', 'en_us'],
	['reading tracker', 'US', 'en_us'],
	// Travel / Weather / Navigation
	['flight tracker', 'US', 'en_us'],
	['hurricane tracker', 'US', 'en_us'],
	// Sports / Outdoors / Hobby
	['golf gps', 'US', 'en_us'],
	['dive log', 'US', 'en_us'],
	['aquarium water log', 'US', 'en_us'],
	['feeds and speeds calculator', 'US', 'en_us'],
	['beehive inspection log', 'US', 'en_us'],
	// Auto — the category the original clone incident happened in
	['car maintenance log', 'US', 'en_us'],
	['car maintenance reminder', 'US', 'en_us'],
	['oil change', 'US', 'en_us'],
	['boat maintenance log', 'US', 'en_us'],
	// Food / Lifestyle / Pets / Baby
	['recipe manager', 'US', 'en_us'],
	['plant identifier', 'US', 'en_us'],
	['dog training', 'US', 'en_us'],
	['baby feeding log', 'US', 'en_us'],
	// Non-Latin and no-space scripts
	['kfz scheckheft', 'DE', 'de_de'],
	['家計簿', 'JP', 'ja_jp'],
];

/**
 * Autocomplete rows to freeze. These are what `brief` actually drafts keywords
 * from, and they are mostly competitors' product names rather than queries —
 * the fact an invented suggestion list never reproduces.
 */
const ROWS = [
	['car maintenance log', 'US'],
	['maintenance log', 'US'],
	['car maintenance', 'US'],
	['car maintenance reminder', 'US'],
	['oil change', 'US'],
	['dive log', 'US'],
	['feeds and speeds calculator', 'US'],
];

const LOCALE = { US: 'en-US', DE: 'de-DE', JP: 'ja' };
const j = (v) => JSON.stringify(v);

const modal = (apps) => {
	const count = new Map();
	for (const a of apps) count.set(a.primaryGenreName, (count.get(a.primaryGenreName) ?? 0) + 1);
	return [...count].sort((x, y) => y[1] - x[1])[0][0];
};

const pages = [];
for (const [term, country, lang] of TERMS) {
	const apps = await topResults(term, { country, lang, limit: 10 });
	if (!apps?.length) {
		console.error(`MISS ${term}`);
		continue;
	}
	pages.push({ term, country, locale: LOCALE[country], genre: modal(apps), apps });
	console.error(`ok  ${term} (${apps.length})`);
}

const rows = [];
for (const [term, country] of ROWS) {
	const suggestions = await hints(term, country);
	rows.push([term, suggestions]);
	console.error(`ok  hints ${term} (${suggestions.length})`);
}

const genres = new Set(pages.map((p) => p.genre)).size;
const storefronts = new Set(pages.map((p) => p.country)).size;

let out = `// Real App Store search results and autocomplete rows, captured once and frozen.
//
// Every page here came from the live iTunes endpoints — the same calls
// \`topResults\` and \`hints\` make — so the titles, sellers, rating counts,
// prices and release dates are what the storefront actually served.
//
// Hand-written fixtures are what let three false passes ship in a row in the
// clone detection: an invented page contains the shapes its author thought of,
// and each bug was precisely a shape nobody thought of — "Aquarium Manager:
// Tank Log", "Walter Feeds & Speeds", "Sudoku.com - Number Games". A captured
// page argues back. Real pages are also better extremes than invented ones:
// nothing hand-written was going to guess a top-10 with a median of 96,704
// ratings, or a keyword harvest that is nine-tenths competitors' brand names.
//
// Frozen rather than fetched at test time, because a suite that calls Apple is
// a suite that fails on a plane, and because Apple throttles to one request per
// storefront per second.
//
// Spread: ${genres} primary genres across ${storefronts} storefronts.
//
// Regenerate with: node test/fixtures/capture.mjs
// DO NOT hand-edit below this line.

/** Storefront date of capture. Every age-dependent assertion pins \`now\` to it. */
export const CAPTURED_AT = Date.parse('${new Date().toISOString().slice(0, 10)}T00:00:00.000Z');

/**
 * term → the live top-10 as served, plus the market it was served in. \`genre\`
 * is the modal primaryGenreName of the page, recorded so the breadth of the
 * corpus is checkable rather than claimed.
 */
export const STOREFRONT = {
`;
for (const p of pages) {
	out += `\t${j(p.term)}: {\n\t\tterm: ${j(p.term)},\n\t\tcountry: ${j(p.country)},\n\t\tlocale: ${j(p.locale)},\n\t\tgenre: ${j(p.genre)},\n\t\tapps: [\n`;
	for (const a of p.apps)
		out +=
			`\t\t\t{ trackName: ${j(a.trackName)}, trackId: ${a.trackId}, sellerName: ${j(a.sellerName)},` +
			` userRatingCount: ${a.userRatingCount ?? 0}, averageUserRating: ${a.averageUserRating == null ? 'null' : Number(a.averageUserRating).toFixed(4)},` +
			` price: ${a.price ?? 0}, releaseDate: ${j(a.releaseDate ?? null)}, primaryGenreName: ${j(a.primaryGenreName ?? null)} },\n`;
	out += `\t\t],\n\t},\n`;
}
out += `};

/**
 * Real autocomplete rows. Apple orders these by popularity, so the row is both
 * the demand signal and the harvest pool — and it is the only place the
 * storefront tells you what people finish typing.
 */
export const HINTS = {
`;
for (const [term, suggestions] of rows) {
	out += `\t${j(term)}: [\n`;
	for (const s of suggestions) out += `\t\t${j(s)},\n`;
	out += `\t],\n`;
}
out += `};

/** The captured top-10 for a term. Throws on a typo rather than testing \`undefined\`. */
export function page(term) {
	const p = STOREFRONT[term];
	if (!p) throw new Error(\`no captured page for "\${term}" — add it to test/fixtures/capture.mjs\`);
	return p;
}

/** Just the results array, for the functions that take one. */
export const top = (term) => page(term).apps;

/** Every captured page, for corpus-wide assertions. */
export const pages = () => Object.values(STOREFRONT);

/** The captured autocomplete row for a term. */
export function hintsFor(term) {
	const h = HINTS[term];
	if (!h) throw new Error(\`no captured autocomplete for "\${term}"\`);
	return h;
}
`;

await writeFile(new URL('./storefront.mjs', import.meta.url), out);
console.error(`\nwrote storefront.mjs — ${pages.length} pages, ${rows.length} hint rows, ${genres} genres`);

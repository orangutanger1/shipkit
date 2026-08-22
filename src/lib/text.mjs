// Locale-aware text primitives shared by ASO, listings and localization.
//
// Everything here exists because whitespace tokenisation is wrong for a third
// of the App Store's revenue. `カレンダー 予定` has no word boundaries a regex
// can see, Thai has none at all, and German compounds mean a "word" in DE is
// frequently a whole English phrase. Apple still indexes those languages by
// token, so keyword-coverage logic that splits on /\s+/ silently spends slots
// it thinks it saved.
//
// Node ≥ 20 ships Intl.Segmenter, which knows the real boundaries. Use it.

/** Languages whose script has no inter-word spacing. */
export const NO_SPACE_LANGS = new Set(['ja', 'zh', 'ko', 'th', 'lo', 'my', 'km']);

/** ASC locale (`de-DE`, `zh-Hans`) → the BCP-47 language subtag. */
export const langOf = (locale) => String(locale ?? 'en').split(/[-_]/)[0].toLowerCase();

export const isNoSpaceLang = (locale) => NO_SPACE_LANGS.has(langOf(locale));

/**
 * Connective tissue that appears in every listing and carries no search intent.
 * Per language, because dropping English stop words from a German listing is
 * how `und`/`für` end up eating keyword slots.
 */
export const STOPWORDS = {
	en: new Set(['and', 'the', 'for', 'with', 'your', 'app', 'you', 'all', 'from', 'that', 'into', 'best', 'free']),
	de: new Set(['und', 'der', 'die', 'das', 'für', 'mit', 'dein', 'deine', 'app', 'von', 'auf', 'kostenlos']),
	fr: new Set(['et', 'le', 'la', 'les', 'des', 'pour', 'avec', 'votre', 'application', 'app', 'de', 'du', 'gratuit']),
	es: new Set(['y', 'el', 'la', 'los', 'las', 'para', 'con', 'tu', 'app', 'de', 'del', 'gratis']),
	it: new Set(['e', 'il', 'lo', 'la', 'per', 'con', 'tuo', 'app', 'di', 'del', 'gratis']),
	pt: new Set(['e', 'o', 'a', 'os', 'as', 'para', 'com', 'seu', 'app', 'de', 'do', 'grátis']),
	nl: new Set(['en', 'de', 'het', 'voor', 'met', 'jouw', 'app', 'van', 'gratis']),
	ja: new Set(['の', 'を', 'に', 'は', 'が', 'と', 'で', 'アプリ', '無料']),
	ko: new Set(['의', '을', '를', '이', '가', '앱', '무료']),
	zh: new Set(['的', '和', 'app', '应用', '免费']),
	ru: new Set(['и', 'в', 'на', 'для', 'с', 'ваш', 'приложение', 'бесплатно']),
	tr: new Set(['ve', 'ile', 'için', 'bir', 'uygulama', 'ücretsiz']),
};

export const stopwordsFor = (locale) => STOPWORDS[langOf(locale)] ?? STOPWORDS.en;

let SEGMENTERS = new Map();
function segmenter(lang) {
	let seg = SEGMENTERS.get(lang);
	if (!seg) {
		seg = new Intl.Segmenter(lang, { granularity: 'word' });
		SEGMENTERS.set(lang, seg);
	}
	return seg;
}

/**
 * Split text into word-like tokens, lowercased, using real Unicode boundaries.
 * @param {string} text
 * @param {string} [locale]
 * @returns {string[]}
 */
export function words(text, locale = 'en') {
	const s = String(text ?? '');
	if (!s.trim()) return [];
	const out = [];
	for (const { segment, isWordLike } of segmenter(langOf(locale)).segment(s)) {
		if (isWordLike) out.push(segment.toLocaleLowerCase(locale));
	}
	return out;
}

/**
 * Tokens Apple already indexes from a piece of listing copy.
 * Single-character tokens are kept for no-space languages (一, 家 are real
 * words) and dropped elsewhere, where they are always noise.
 */
export function indexedWords(text, locale = 'en') {
	const min = isNoSpaceLang(locale) ? 1 : 2;
	const stop = stopwordsFor(locale);
	return new Set(words(text, locale).filter((w) => w.length >= min && !stop.has(w)));
}

/** True when every token of `term` is already indexed by name/subtitle. */
export function isCovered(term, indexed, locale = 'en') {
	const toks = words(term, locale);
	return toks.length > 0 && toks.every((w) => indexed.has(w));
}

/**
 * Characters as Apple counts them for a field limit: code points, not UTF-16
 * units. An emoji or an astral CJK ideograph is one character to ASC and two
 * to `String.length`.
 */
export const charCount = (s) => Array.from(String(s ?? '')).length;

/** Number of code points a keyword string would occupy once packed. */
export const keywordFieldLength = (terms) => charCount(terms.join(','));

/**
 * Shared-token overlap between two phrases, 0-1. Used to detect a "translated"
 * keyword that is really the source phrase with the words swapped one-for-one.
 */
export function overlap(a, b, locale = 'en') {
	const A = new Set(words(a, locale));
	const B = new Set(words(b, locale));
	if (!A.size || !B.size) return 0;
	let hit = 0;
	for (const w of A) if (B.has(w)) hit++;
	return hit / Math.max(A.size, B.size);
}

/**
 * Store brands seen in a set of apps, as tokens.
 *
 * Autocomplete cannot be asked which of its suggestions are brands, but the
 * search API answers it for free: every publisher writes its own name into
 * `sellerName`. `valvoline`, `servicetitan` and `servicenow` all clear a
 * frequency filter on the query side — people really do type them — and only
 * die here.
 *
 * Deliberately publishers only. Screening on "a title token only one app uses"
 * was tried and took `mileage`, `fuel` and `garage` down with the brands: a
 * category word is often owned by one incumbent title and typed by everyone.
 * @param {{name?: string, seller?: string}[]} apps
 */
export function brandTokens(apps, locale = 'en') {
	const brands = new Set();
	for (const app of apps) for (const w of indexedWords(app?.seller ?? '', locale)) brands.add(w);
	return brands;
}

/**
 * How many distinct queries each token appears in.
 * Support is the only demand-side evidence a token carries on its own, and it
 * is what separates a brand the market types from one it does not.
 * @returns {Map<string, number>}
 */
export function tokenSupport(phrases, locale = 'en') {
	const support = new Map();
	for (const phrase of phrases)
		for (const w of new Set(words(phrase, locale))) support.set(w, (support.get(w) ?? 0) + 1);
	return support;
}

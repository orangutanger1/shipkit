// `ship design review`: the same rules as the token gate, run against the
// implementation instead of against the spec. Drift between `design/system.json`
// and the code becomes a gate failure rather than a code-review opinion.
//
// This is a lexical scan, not a type checker, and it says so: it reads sources
// it is handed and reports literals that are not in the system. That is enough,
// because every violation it can find is one a human would also have to find by
// reading, and it never has an opinion about anything it cannot count.

/** @typedef {{file: string, line: number, kind: string, message: string}} Violation */

/**
 * Emoji, roughly: the pictographic planes plus the dingbats that read as emoji
 * in UI. The variation selector is its own test rather than a class member —
 * inside a class it is a combining mark, which is a different match.
 */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

/** Style keys whose numeric value must come from the spacing series. */
const SPACING_KEYS =
	/\b(padding|paddingTop|paddingBottom|paddingLeft|paddingRight|paddingHorizontal|paddingVertical|margin|marginTop|marginBottom|marginLeft|marginRight|marginHorizontal|marginVertical|gap|rowGap|columnGap)\s*:\s*(-?\d+(?:\.\d+)?)/g;

/** @type {(re: RegExp, line: string) => RegExpExecArray[]} */
function matches(re, line) {
	re.lastIndex = 0;
	/** @type {RegExpExecArray[]} */
	const out = [];
	let m;
	while ((m = re.exec(line)) !== null) out.push(m);
	return out;
}

/**
 * Every colour the system declares, lowercased, both themes.
 * @type {(system: any) => Set<string>}
 */
export function systemColors(system) {
	/** @type {Set<string>} */
	const out = new Set();
	for (const theme of Object.values(system?.color?.themes ?? {}))
		for (const token of Object.values(/** @type {any} */ (theme) ?? {}))
			if (typeof (/** @type {any} */ (token)?.value) === 'string') out.add(/** @type {any} */ (token).value.toLowerCase());
	return out;
}

/** @type {(system: any) => {radii: Set<number>, spacing: Set<number>, sizes: Set<number>, durations: Set<number>}} */
export function systemNumbers(system) {
	return {
		radii: new Set(Object.values(system?.radii ?? {}).map((/** @type {any} */ r) => r?.value)),
		spacing: new Set(system?.spacing?.scale ?? []),
		sizes: new Set((system?.type?.ramp ?? []).map((/** @type {any} */ s) => s?.size)),
		durations: new Set(Object.values(system?.motion?.durations ?? {}).map((/** @type {any} */ d) => d?.value)),
	};
}

/**
 * What the styling rules deliberately allow. A noisy gate is a disabled gate,
 * so every exception is data here rather than a special case buried in a regex.
 */
export const EXCEPTIONS = {
	/** Platform constants, not design decisions: none of these come from a scale. */
	styleKeys: ['flex', 'flexGrow', 'flexShrink', 'opacity', 'zIndex', 'borderWidth', 'aspectRatio'],
	/** 0 and 1 are identity values everywhere in RN layout. */
	numbers: [0, 1],
	/** Expressions that are their own justification. */
	identifiers: ['StyleSheet.hairlineWidth', 'Platform.select', 'Dimensions'],
	/** Where tokens legitimately become literals. */
	dirs: ['src/theme/'],
};

const INLINE_NUMBER = /style=\{\{[^}]*?\b([a-zA-Z]+)\s*:\s*(-?\d+(?:\.\d+)?)/g;
const RAW_PRIMITIVE = /import\s*\{[^}]*\b(View|Text|Pressable|TouchableOpacity)\b[^}]*\}\s*from\s*'react-native'/;

/** @type {(ch: string) => string} */
function twice(ch) {
	return ch + ch;
}

/**
 * `#fff` and `#ffffff` are the same colour; the system stores the long form.
 * @type {(hex: string) => string}
 */
function expandHex(hex) {
	const body = hex.slice(1);
	return body.length === 3 ? `#${[...body].map(twice).join('')}`.toLowerCase() : hex.toLowerCase();
}

/**
 * One line, against one system. Split out so every rule below is a named
 * function c8 can see, and so a caller can scan a string it never wrote to disk.
 * @type {(line: string, at: {file: string, line: number}, sys: {colors: Set<string>, nums: ReturnType<typeof systemNumbers>}) => Violation[]}
 */
export function scanLine(line, at, sys) {
	/** @type {Violation[]} */
	const out = [];
	/** @type {(kind: string, message: string) => void} */
	const hit = (kind, message) => out.push({ ...at, kind, message });

	for (const m of matches(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g, line))
		if (!sys.colors.has(expandHex(m[0]))) hit('color', `${m[0]} is not a colour in design/system.json`);
	for (const m of matches(/\bborderRadius\s*:\s*(\d+(?:\.\d+)?)/g, line))
		if (!sys.nums.radii.has(Number(m[1]))) hit('radius', `borderRadius ${m[1]} is not in the declared radii scale`);
	for (const m of matches(SPACING_KEYS, line))
		if (!sys.nums.spacing.has(Number(m[2]))) hit('spacing', `${m[1]} ${m[2]} is off the spacing series`);
	for (const m of matches(/\bfontSize\s*:\s*(\d+(?:\.\d+)?)/g, line))
		if (!sys.nums.sizes.has(Number(m[1]))) hit('type', `fontSize ${m[1]} is not a step in the type ramp`);
	for (const m of matches(/\bduration\s*:\s*(\d+)/g, line))
		if (!sys.nums.durations.has(Number(m[1]))) hit('motion', `duration ${m[1]}ms is not a declared motion duration`);
	if (EMOJI.test(line)) hit('emoji', 'emoji in source — UI chrome carries none');
	if (/LinearGradient|linear-gradient/.test(line)) hit('gradient', 'gradient with no gradient token behind it');
	if (/\bStyleSheet\.create\s*\(/.test(line)) hit('stylesheet', 'StyleSheet.create outside src/theme — styling belongs in the primitives');
	for (const m of matches(INLINE_NUMBER, line))
		if (!EXCEPTIONS.styleKeys.includes(m[1]) && !EXCEPTIONS.numbers.includes(Number(m[2])))
			hit('inline-style', `inline ${m[1]} ${m[2]} — take it from the spacing scale via a primitive`);
	if (RAW_PRIMITIVE.test(line)) hit('raw-primitive', 'react-native primitive imported directly — screens compose src/theme/primitives');
	return out;
}

/**
 * Scan the implementation. `files` is `{path, source}` pairs the caller read,
 * so this module never touches the disk and the tests never write one; `tokens`
 * names the files that legitimately define tokens and are therefore exempt.
 * @type {(files: {path: string, source: string}[], system: any, opts?: {tokens?: Set<string>}) => Violation[]}
 */
export function reviewSources(files, system, { tokens = new Set() } = {}) {
	const sys = { colors: systemColors(system), nums: systemNumbers(system) };
	/** @type {Violation[]} */
	const out = [];
	for (const { path, source } of files) {
		if (tokens.has(path) || EXCEPTIONS.dirs.some((dir) => path.startsWith(dir))) continue;
		for (const [i, line] of source.split('\n').entries()) out.push(...scanLine(line, { file: path, line: i + 1 }, sys));
	}
	return out;
}

/**
 * Violations per kind, in a stable order, for the summary row.
 * @type {(violations: Violation[]) => Record<string, number>}
 */
export function tally(violations) {
	/** @type {Record<string, number>} */
	const out = {};
	for (const v of violations) out[v.kind] = (out[v.kind] ?? 0) + 1;
	return out;
}

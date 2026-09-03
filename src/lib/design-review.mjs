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
 * One line, against one system. Split out so every rule below is a named
 * function c8 can see, and so a caller can scan a string it never wrote to disk.
 * @type {(line: string, at: {file: string, line: number}, sys: {colors: Set<string>, nums: ReturnType<typeof systemNumbers>}) => Violation[]}
 */
export function scanLine(line, at, sys) {
	/** @type {Violation[]} */
	const out = [];
	/** @type {(kind: string, message: string) => void} */
	const hit = (kind, message) => out.push({ ...at, kind, message });

	for (const m of matches(/#[0-9a-fA-F]{6}\b/g, line))
		if (!sys.colors.has(m[0].toLowerCase())) hit('color', `${m[0]} is not a colour in design/system.json`);
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
		if (tokens.has(path)) continue;
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

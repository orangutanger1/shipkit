// One ux.json screen → one expo-router route file.
//
// This is a transcriber. Every decision it could make is one the spec already
// made: `elements` gives the order and the variants, `copy` gives the strings,
// `states` gives the branches, `events` gives the names. Where `elements` is
// absent it emits the null layout — every copy key as body text — and says so
// in the file, because a guessed layout is worse than an obviously unfinished
// one that a reader will replace.
import { withHeader } from './design-emit.mjs';

/** @type {(value: string) => string} */
const q = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** JSX text is written as a `copy` reference, so escaping is a JS-string problem only. */
/** @type {(id: string) => string} */
function componentName(id) {
	return String(id)
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map(capitalize)
		.join('') || 'Screen';
}

/** @type {(word: string) => string} */
function capitalize(word) {
	return word[0].toUpperCase() + word.slice(1);
}

/** @type {(entry: [string, string]) => string} */
function copyRow([key, text]) {
	return `\t${key}: ${q(text)},`;
}

/** @type {(el: any) => string} */
function elementLine(el) {
	if (el.component === 'Button') {
		const variant = el.variant ? ` variant="${el.variant}"` : '';
		const press = el.event ? ` onPress={() => track(EVENTS.${el.event})}` : '';
		return `\t\t\t<Button${variant}${press}>{copy.${el.copy}}</Button>`;
	}
	if (el.component === 'Text') return `\t\t\t<Text role="${el.variant ?? 'body'}">{copy.${el.copy}}</Text>`;
	if (el.component === 'StateView') return `\t\t\t<StateView kind="${el.variant}" />`;
	const variant = el.variant ? ` variant="${el.variant}"` : '';
	return `\t\t\t<${el.component}${variant} />`;
}

/** @type {(key: string) => string} */
function nullLayoutLine(key) {
	return `\t\t\t<Text role="body">{copy.${key}}</Text>`;
}

/** @type {(state: string) => string} */
function stateLine(state) {
	return `\tif (state === ${q(state)}) return <StateView kind="${state}" />;`;
}

/** @type {(screen: any) => string[]} */
function usedComponents(screen) {
	const set = new Set(['Screen', 'Text']);
	if ((screen?.states ?? []).some(isNonDefault)) set.add('StateView');
	for (const el of screen?.elements ?? []) set.add(el.component);
	if (!screen?.elements) set.add('Text');
	return [...set].sort();
}

/** @type {(state: string) => boolean} */
function isNonDefault(state) {
	return state !== 'default';
}

/** @type {(event: any) => boolean} */
function isViewed(event) {
	return event?.verb === 'viewed';
}

/**
 * @type {(screen: any, opts: {source: string}) => string}
 */
export function emitScreen(screen, { source }) {
	const name = componentName(screen?.id);
	const copyEntries = Object.entries(screen?.copy ?? {});
	const states = (screen?.states ?? []).filter(isNonDefault);
	const viewed = (screen?.events ?? []).find(isViewed);
	const elements = screen?.elements;
	const sells = Boolean(screen?.monetization?.offering);

	const imports = [
		viewed ? "import { useEffect } from 'react';" : null,
		`import { ${usedComponents(screen).join(', ')} } from '../src/theme/primitives';`,
		"import { useQa } from '../src/theme/provider';",
		"import { track } from '../src/analytics';",
		"import { EVENTS } from '../src/analytics/events';",
		sells ? "import { MONETIZATION } from '../src/purchases/catalog';" : null,
	].filter(Boolean);

	const bodyLines = elements?.length
		? elements.map(elementLine)
		: ['\t\t\t{/* No elements were specified in design/ux.json, so no layout was invented.', '\t\t\t    Every copy key is rendered as body text. Add `elements` to the screen. */}',
		   ...copyEntries.map(copyKeyOf).map(nullLayoutLine)];

	const body = `${imports.join('\n')}

const copy = {
${copyEntries.map(copyRow).join('\n')}
} as const;
${sells ? `\nexport const monetization = MONETIZATION.${screen.id};\n` : ''}
export default function ${name}() {
	const { state } = useQa();
${viewed ? `\tuseEffect(() => {\n\t\ttrack(EVENTS.${viewed.name});\n\t}, []);\n` : ''}${states.map(stateLine).join('\n')}${states.length ? '\n' : ''}
	return (
		<Screen>
${bodyLines.join('\n')}
			{/* IMPLEMENT: this screen's real UI. The scaffold proves the route,
			    the theme and the states; it does not pretend to be the product. */}
		</Screen>
	);
}
`;
	return withHeader(body, { source });
}

/** @type {(entry: [string, string]) => string} */
function copyKeyOf(entry) {
	return entry[0];
}

// Schema ⇄ validator drift guard. schema/*.json are the editor/CI-facing
// contract for the two JSON files ship reads; the hand-rolled validators in
// config.mjs and shots-spec.mjs are the runtime truth. These tests keep the
// two from drifting: a key the validator defaults or consumes must be
// documented in its schema, and a schema key must be something the validator
// actually accepts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalise } from '../src/config.mjs';
import { normaliseSpec } from '../src/lib/shots-spec.mjs';

const schemaDir = new URL('../schema/', import.meta.url);

/** Leaf and intermediate paths a schema describes, resolving local $refs. */
function schemaPaths(schema, node = schema, prefix = '', depth = 0) {
	if (depth > 12) return [];
	if (node.$ref) {
		const target = node.$ref.replace(/^#\//, '').split('/').reduce((acc, part) => acc[part], schema);
		return schemaPaths(schema, target, prefix, depth + 1);
	}
	if (node.type === 'object' || node.properties || node.patternProperties) {
		const out = [];
		for (const [key, sub] of Object.entries(node.properties ?? {})) {
			out.push(prefix + key, ...schemaPaths(schema, sub, `${prefix}${key}.`, depth + 1));
		}
		return out;
	}
	return [];
}

/** Paths a plain object carries, treating arrays and empty objects as leaves. */
function objectPaths(value, prefix = '') {
	const out = [];
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
	if (Object.keys(value).length === 0) return prefix ? [prefix.replace(/\.$/, '')] : [];
	for (const [key, sub] of Object.entries(value)) {
		out.push(prefix + key, ...objectPaths(sub, `${prefix}${key}.`));
	}
	return out;
}

test('ship.config.schema.json documents every key the config validator defaults or consumes', async () => {
	const schema = JSON.parse(await readFile(new URL('ship.config.schema.json', schemaDir), 'utf8'));
	const documented = new Set(schemaPaths(schema));
	const cfg = normalise({ name: 'x', bundleId: 'y' }, '/repo/ship.config.json');
	// Runtime-only keys the validator computes, not reads from the file.
	const runtime = new Set(['file', 'root', 'paths', 'versionDir', 'warnings']);
	const produced = objectPaths(cfg).filter((p) => !runtime.has(p.split('.')[0]));
	for (const path of produced) {
		assert.ok(documented.has(path), `${path} is defaulted/consumed by normalise() but missing from ship.config.schema.json`);
	}
});

test('every key ship.config.schema.json describes is one the config validator accepts', async () => {
	const schema = JSON.parse(await readFile(new URL('ship.config.schema.json', schemaDir), 'utf8'));
	const cfg = normalise({ name: 'x', bundleId: 'y' }, '/repo/ship.config.json');
	const produced = new Set(objectPaths(cfg));
	// Optional passthrough keys: deepMerge forwards them and named consumers
	// read them, but the validator carries no default for any of them.
	const optional = new Set(['$schema', 'version', 'eas.owner', 'eas.projectId', 'revenuecat.key']);
	for (const path of schemaPaths(schema)) {
		assert.ok(
			produced.has(path) || optional.has(path),
			`${path} is described by ship.config.schema.json but no validator code reads or defaults it`,
		);
	}
});

test('screenshot-spec.schema.json agrees with what normaliseSpec accepts and defaults', async () => {
	const schema = JSON.parse(await readFile(new URL('screenshot-spec.schema.json', schemaDir), 'utf8'));
	const cfg = { paths: { store: '/repo/store' }, asc: { primaryLocale: 'en-US' }, store: { locales: ['en-US'] } };
	const spec = {
		mode: 'device-frame',
		displayType: 'IPHONE_65',
		canvas: { w: 1242, h: 2688 },
		source: { figmaFile: 'f', page: 'p', frameIds: ['1'], note: 'n', instance: 'i' },
		raw: 'screenshots-raw',
		captions: 'captions.json',
		ref: 'ref',
		base: { dir: 'base', country: 'us', sourceLocale: 'en-US' },
		fonts: { default: '../assets/fonts/X.ttf' },
		type: { margin: 98 },
		band: { clearance: 4 },
		device: {
			w: 1076,
			h: 2174,
			screenIndex: 1,
			layers: [{ file: 'body.png', x: 0, y: 0, w: 10, h: 10 }],
			screenGroup: { x: 65.82, y: 49.35, w: 955.07, h: 2072.83 },
			artboard: { x: -4.94, y: -2.47, w: 962.48, h: 2077.76 },
		},
		capture: {
			url: 'http://localhost',
			viewport: { width: 100, height: 100 },
			screens: [{ path: 'p', frame: 'f', waitFor: 'w', evaluate: 'e' }],
		},
		frames: [{ key: '01', src: '01.png', bg: '#14100C', phone: { x: 83, y: 690 }, caption: { x: 165, y: 128, w: 909 } }],
	};
	const out = normaliseSpec(spec, cfg);
	const documented = Object.keys(schema.properties).filter((k) => k !== '$schema');
	// The validator is shape-tolerant by design (annotations like `_why` ride
	// along), so drift matters in one direction only: a schema key nothing
	// reads is dead config, and a consumed key missing from the schema is
	// undocumented surface. Both must fail loudly here.
	for (const key of documented) {
		assert.ok(key in out, `${key} is documented by the spec schema but normaliseSpec() drops it`);
	}
	for (const key of Object.keys(out)) {
		assert.ok(
			documented.includes(key) || key === 'file' || key === 'paths',
			`${key} comes out of normaliseSpec() but is missing from the spec schema (or the derived-key list)`,
		);
	}
});

test('the spec schema required keys are exactly the ones normaliseSpec refuses to load without', async () => {
	const schema = JSON.parse(await readFile(new URL('screenshot-spec.schema.json', schemaDir), 'utf8'));
	const cfg = { paths: { store: '/repo/store' }, asc: { primaryLocale: 'en-US' }, store: { locales: ['en-US'] } };
	const spec = {
		mode: 'device-frame',
		canvas: { w: 1242, h: 2688 },
		fonts: { default: '../assets/fonts/X.ttf' },
		frames: [{ key: '01', src: '01.png', bg: '#14100C', phone: { x: 83, y: 690 }, caption: { x: 165, y: 128, w: 909 } }],
	};
	for (const key of schema.required) {
		const broken = { ...spec };
		delete broken[key];
		assert.throws(() => normaliseSpec(broken, cfg), new RegExp(`${key}`), `removing required key ${key} did not fail the load`);
	}
});

test('the spec schema mode enum and the validator agree on every composition mode', async () => {
	const schema = JSON.parse(await readFile(new URL('screenshot-spec.schema.json', schemaDir), 'utf8'));
	const cfg = { paths: { store: '/repo/store' }, asc: { primaryLocale: 'en-US' }, store: { locales: ['en-US'] } };
	const base = {
		canvas: { w: 1242, h: 2688 },
		fonts: { default: '../assets/fonts/X.ttf' },
		// Both composition modes' mandatory extras: device-frame validates the
		// device block, caption-band requires mockTop/mockH on every frame.
		device: {
			w: 1076,
			h: 2174,
			screenIndex: 1,
			layers: [{ file: 'body.png', x: 0, y: 0, w: 10, h: 10 }],
			screenGroup: { x: 65.82, y: 49.35, w: 955.07, h: 2072.83 },
			artboard: { x: -4.94, y: -2.47, w: 962.48, h: 2077.76 },
		},
		frames: [{ key: '01', src: '01.png', bg: '#14100C', phone: { x: 83, y: 690 }, caption: { x: 165, y: 128, w: 909 }, mockTop: 595, mockH: 2251 }],
	};
	for (const mode of schema.properties.mode.enum) {
		assert.doesNotThrow(() => normaliseSpec({ ...base, mode }, cfg), `${mode} is in the schema enum but the validator rejects it`);
	}
	assert.throws(
		() => normaliseSpec({ ...base, mode: 'not-a-mode' }, cfg),
		/mode must be one of/,
		'the validator accepts a mode the schema enum does not list',
	);
});

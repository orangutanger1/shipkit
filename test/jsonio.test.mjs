import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJSONIfExists, readJSONOrNull, readJSONStrict, writeJSON } from '../src/lib/jsonio.mjs';

test('readJSONIfExists returns parsed content for a valid file', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-jsonio-'));
	try {
		const file = join(dir, 'a.json');
		await writeFile(file, '{"n":1}');
		assert.deepEqual(await readJSONIfExists(file), { n: 1 });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readJSONIfExists returns null when the file is absent', async () => {
	const missing = join(tmpdir(), 'ship-jsonio-nope', 'a.json');
	assert.equal(await readJSONIfExists(missing), null);
});

test('readJSONIfExists raises ShipError on malformed JSON', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-jsonio-'));
	try {
		const file = join(dir, 'bad.json');
		await writeFile(file, '{oops');
		await assert.rejects(readJSONIfExists(file), /is not valid JSON/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readJSONOrNull reads a valid file', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-jsonio-'));
	try {
		const file = join(dir, 'a.json');
		await writeFile(file, '[1,2]');
		assert.deepEqual(await readJSONOrNull(file), [1, 2]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readJSONOrNull treats a missing or malformed file as absent', async () => {
	assert.equal(await readJSONOrNull(join(tmpdir(), 'ship-jsonio-nope', 'a.json')), null);
	const dir = await mkdtemp(join(tmpdir(), 'ship-jsonio-'));
	try {
		const file = join(dir, 'bad.json');
		await writeFile(file, 'not json');
		assert.equal(await readJSONOrNull(file), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readJSONStrict raises ShipError when the file is missing', async () => {
	const missing = join(tmpdir(), 'ship-jsonio-nope', 'a.json');
	await assert.rejects(readJSONStrict(missing), /does not exist/);
});

test('readJSONStrict raises ShipError when the file is malformed', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-jsonio-'));
	try {
		const file = join(dir, 'bad.json');
		await writeFile(file, 'nope');
		await assert.rejects(readJSONStrict(file), /is not valid JSON/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readJSONStrict parses valid JSON', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-jsonio-'));
	try {
		const file = join(dir, 'ok.json');
		await writeFile(file, '{"ok":true}');
		assert.deepEqual(await readJSONStrict(file), { ok: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('writeJSON creates parents and writes tab-indented JSON', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-jsonio-'));
	try {
		const file = join(dir, 'deep', 'nested', 'out.json');
		assert.equal(await writeJSON(file, { a: 1 }), file);
		assert.equal(await readFile(file, 'utf8'), '{\n\t"a": 1\n}\n');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('writeJSON round-trips through readJSONIfExists', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-jsonio-'));
	try {
		const file = join(dir, 'rt.json');
		await mkdir(dir, { recursive: true });
		await writeJSON(file, { list: [1, 2] });
		assert.deepEqual(await readJSONIfExists(file), { list: [1, 2] });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

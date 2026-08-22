// A write that Apple refused must not read as a success. `asc()` collapses a
// rejected call, a skipped dry-run and a quiet success into the same `null`, so
// every mutating caller needs the exit status the JSON body cannot carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stub `asc` on disk. `ASC` is read from the environment at module load, so
 * the import has to happen after the variable is set — hence the dynamic import
 * and the fresh cache-busting query per stub.
 */
async function withStub(script, fn) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-exec-'));
	const bin = join(dir, 'asc');
	await writeFile(bin, script);
	await chmod(bin, 0o755);
	const prev = process.env.SHIP_ASC_BIN;
	process.env.SHIP_ASC_BIN = bin;
	try {
		const mod = await import(`../src/exec.mjs?stub=${encodeURIComponent(dir)}`);
		return await fn(mod);
	} finally {
		if (prev === undefined) delete process.env.SHIP_ASC_BIN;
		else process.env.SHIP_ASC_BIN = prev;
		await rm(dir, { recursive: true, force: true });
	}
}

test('a rejected write reports ok:false and keeps the reason', async () => {
	await withStub('#!/bin/sh\necho "error: forbidden" >&2\nexit 1\n', async ({ ascMutate }) => {
		const res = await ascMutate(['screenshots', 'upload']);
		assert.equal(res.ok, false);
		assert.equal(res.code, 1);
		// The operator needs Apple's words, not our summary of them.
		assert.match(res.stderr, /forbidden/);
	});
});

test('a write that succeeds with an empty body is not mistaken for a failure', async () => {
	// asc answers some writes with nothing at all; that is a success.
	await withStub('#!/bin/sh\nexit 0\n', async ({ ascMutate }) => {
		const res = await ascMutate(['screenshots', 'upload']);
		assert.equal(res.ok, true);
		assert.equal(res.data, null);
	});
});

test('a successful write parses its JSON body', async () => {
	await withStub('#!/bin/sh\necho \'{"uploaded":5}\'\n', async ({ ascMutate }) => {
		const res = await ascMutate(['screenshots', 'upload']);
		assert.equal(res.ok, true);
		assert.deepEqual(res.data, { uploaded: 5 });
	});
});

test('a warning line ahead of the JSON is salvaged, not read as a failure', async () => {
	await withStub('#!/bin/sh\necho "warning: deprecated flag"\necho \'{"uploaded":1}\'\n', async ({ ascMutate }) => {
		const res = await ascMutate(['screenshots', 'upload']);
		assert.equal(res.ok, true);
		assert.deepEqual(res.data, { uploaded: 1 });
	});
});

test('a dry-run skips the write and never claims it failed', async () => {
	await withStub('#!/bin/sh\necho "should not run" >&2\nexit 1\n', async ({ ascMutate, setDryRun }) => {
		setDryRun(true);
		try {
			const res = await ascMutate(['screenshots', 'upload']);
			assert.equal(res.skipped, true);
			assert.equal(res.ok, true);
		} finally {
			setDryRun(false);
		}
	});
});

// `ship meta pull` used to run asc with fallback:null, so an auth failure or
// 5xx folded nothing, reported success, and left stale trees in staged/. A
// failed asc call on the release path must fail the command, not exit 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withRepo(ascScript, fn) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-meta-'));
	const bin = join(dir, 'asc');
	await writeFile(bin, ascScript);
	const { chmod } = await import('node:fs/promises');
	await chmod(bin, 0o755);
	await mkdir(join(dir, 'app'), { recursive: true });
	await writeFile(
		join(dir, 'ship.config.json'),
		JSON.stringify({ name: 't', bundleId: 'com.t.app', version: '1.0.0', asc: { appId: '42' } }, null, '\t'),
	);
	const prevBin = process.env.SHIP_ASC_BIN;
	const prevCwd = process.cwd();
	process.env.SHIP_ASC_BIN = bin;
	process.chdir(dir);
	try {
		// ASC is resolved at module load, so the import waits for the stub —
		// and the cache-busting query keeps stubs from sharing a module record.
		const mod = await import(`../src/commands/meta.mjs?stub=${encodeURIComponent(dir)}`);
		return await fn(mod);
	} finally {
		process.chdir(prevCwd);
		if (prevBin === undefined) delete process.env.SHIP_ASC_BIN;
		else process.env.SHIP_ASC_BIN = prevBin;
		await rm(dir, { recursive: true, force: true });
	}
}

test('meta pull fails when asc exits non-zero instead of reporting success', async () => {
	await withRepo('#!/bin/sh\necho "error: unauthorized" >&2\nexit 1\n', async (meta) => {
		await assert.rejects(
			() => meta.run({ args: ['pull'], flags: {} }),
			(err) => {
				assert.match(err.message, /metadata pull exited 1/);
				return true;
			},
		);
	});
});

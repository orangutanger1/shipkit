// exec.mjs's failure surface: the process boundary itself. A binary that is not
// there, a non-zero exit, output that is not JSON, and the fetch helper's
// non-JSON body — every one of these has a caller that depends on the exact
// shape of the refusal.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { asc, eas, fetchJSON, isDryRun, run, setDryRun, setVerbose, which } from '../src/exec.mjs';
import { capture, fakeBins, inDir, json, repo, setBin, withFetch } from './fixtures/cmd.mjs';

const BIN = await fakeBins(['asc', 'npx']);

/** A shell script on disk, executable, at a path of our choosing. */
async function script(name, body) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-exec-'));
	const file = join(dir, name);
	await writeFile(file, `#!/bin/sh\n${body}\n`);
	await chmod(file, 0o755);
	return file;
}

test('a binary that is not on PATH is named, with the install line', async () => {
	await assert.rejects(() => run('/definitely/not/a/real/binary'), /\/definitely\/not\/a\/real\/binary not found on PATH/);
});

test('a non-zero exit throws with the tail of what the process said', async () => {
	const bin = await script('noisy', 'echo out; echo trouble >&2; exit 3');
	await assert.rejects(() => run(bin, ['a', 'b', 'c', 'd']), /exited 3/);
	const res = await run(bin, [], { allowFail: true });
	assert.equal(res.code, 3);
	assert.match(res.stderr, /trouble/);
});

test('capture:false streams the output through as well as collecting it', async () => {
	const bin = await script('chatty', 'echo hello; echo bye >&2');
	const { result, out } = await capture(() => run(bin, [], { capture: false }));
	assert.match(result.stdout, /hello/);
	assert.match(out, /hello/);
	assert.match(out, /bye/);
});

test('--verbose narrates the command before running it', async () => {
	const bin = await script('quiet', 'exit 0');
	setVerbose(true);
	try {
		const { out } = await capture(() => run(bin, ['--flag']));
		assert.match(out, /--flag/);
	} finally {
		setVerbose(false);
	}
});

test('a mutating command is announced and skipped under --dry-run', async () => {
	setDryRun(true);
	try {
		assert.equal(isDryRun(), true);
		const { result, out } = await capture(() => run('anything', ['at', 'all'], { mutating: true }));
		assert.equal(result.skipped, true);
		assert.match(out, /dry-run anything at all/);
	} finally {
		setDryRun(false);
		assert.equal(isDryRun(), false);
	}
});

test('asc output that is not JSON at all is refused, unless a fallback says otherwise', async () => {
	setBin('asc', [['^broken', { out: 'this is not json' }]]);
	await assert.rejects(() => asc(['broken']), /returned non-JSON output/);
	assert.equal(await asc(['broken'], { fallback: null }), null);
});

test('asc that says nothing is refused, unless a fallback says otherwise', async () => {
	setBin('asc', []);
	await assert.rejects(() => asc(['silent']), /produced no JSON output/);
	assert.deepEqual(await asc(['silent'], { fallback: [] }), []);
});

test('a warning line before the JSON is salvaged; an unsalvageable one is not', async () => {
	setBin('asc', [['^warned', { out: 'warning: clock skew\n{"data":[]}' }], ['^half', { out: 'note: {oops' }]]);
	assert.deepEqual(await asc(['warned']), { data: [] });
	assert.equal(await asc(['half'], { fallback: null }), null);
});

test('eas prefers the project\'s own pinned copy over npx', async () => {
	const dir = await repo({ config: null, prefix: 'ship-exec-' });
	const { out } = await capture(() => eas(['--version'], { cwd: dir, inherit: false, capture: true, allowFail: true }));
	assert.ok(out !== undefined, 'with no local copy the npx path runs');

	const local = join(dir, 'node_modules', '.bin');
	await writeFile(join(await mkdtemp(join(tmpdir(), 'x-')), 'unused'), '');
	const { mkdir, symlink } = await import('node:fs/promises');
	await mkdir(local, { recursive: true });
	await symlink(join(BIN, 'asc'), join(local, 'eas'));
	const res = await eas(['--version'], { cwd: dir, inherit: false, capture: true, allowFail: true });
	assert.equal(res.code, 0, 'the pinned copy is the one that runs');
});

test('fetchJSON hands back a non-JSON body rather than throwing on it', async () => {
	const text = await withFetch(async () => new Response('<html>proxy</html>'), () => fetchJSON('https://demo.example'));
	assert.equal(text, '<html>proxy</html>');
	const empty = await withFetch(async () => new Response('', { status: 200 }), () => fetchJSON('https://demo.example'));
	assert.equal(empty, null);
});

test('fetchJSON names the method, the URL and the status it was refused with', async () => {
	await assert.rejects(
		() => withFetch(async () => json({ message: 'nope' }, 403), () => fetchJSON('https://demo.example/x', { method: 'POST' })),
		/POST https:\/\/demo.example\/x → 403/,
	);
	await assert.rejects(
		() => withFetch(async () => new Response('plain text', { status: 500 }), () => fetchJSON('https://demo.example/x')),
		/GET https:\/\/demo.example\/x → 500/,
	);
});

test('which resolves a bare name on PATH, and a path only if it exists', async () => {
	assert.equal(await which(join(BIN, 'asc')), join(BIN, 'asc'));
	assert.equal(await which('/definitely/not/here'), null);
	assert.equal(await which('asc'), join(BIN, 'asc'));

	const saved = process.env.PATH;
	process.env.PATH = `:${BIN}`;
	try {
		assert.equal(await which('asc'), join(BIN, 'asc'), 'an empty PATH entry is skipped, not resolved against');
	} finally {
		process.env.PATH = saved;
	}

	delete process.env.PATH;
	try {
		assert.equal(await which('asc'), null);
	} finally {
		process.env.PATH = saved;
	}
});

test('a directory on PATH that is not executable is passed over', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-exec-'));
	await writeFile(join(dir, 'asc'), 'not executable');
	const saved = process.env.PATH;
	process.env.PATH = `${dir}:${BIN}`;
	try {
		assert.equal(await which('asc'), join(BIN, 'asc'));
	} finally {
		process.env.PATH = saved;
	}
});

test('inherit hands the child our own stdio instead of collecting it', async () => {
	const bin = await script('inheriting', 'echo through');
	const res = await run(bin, [], { inherit: true });
	assert.equal(res.code, 0);
	assert.equal(res.stdout, '', 'nothing is captured — the child wrote straight to the terminal');
});

test('a spawn failure that is not a missing binary is passed through as-is', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-exec-'));
	await assert.rejects(() => run(dir, [], { cwd: dir }), (err) => !/not found on PATH/.test(err.message));
});

test('a process killed by a signal reports code 0 rather than null', async () => {
	const bin = await script('suicide', 'kill -TERM $$');
	const res = await run(bin, [], { allowFail: true });
	assert.equal(res.code, 0, 'a signal leaves no exit code; the caller still gets a number');
});

test('a skipped dry-run read returns the fallback rather than parsing nothing', async () => {
	setDryRun(true);
	try {
		assert.equal(await asc(['whatever'], { fallback: null, mutating: true }), null);
	} finally {
		setDryRun(false);
	}
});

test('eas defaults to the current directory when no cwd is given', async () => {
	const dir = await repo({ config: null, prefix: 'ship-exec-' });
	const res = await inDir(dir, () => eas(['--version'], { inherit: false, capture: true, allowFail: true }));
	assert.equal(typeof res.code, 'number');
});

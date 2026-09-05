// `cli()` is the process entry point: everything here is about what the user's
// terminal and exit code look like when something goes wrong before, during or
// after a command runs. The commands are stand-ins registered into COMMANDS, so
// these tests describe the dispatcher rather than any real command.
import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS, cli } from '../src/cli.mjs';
import { ShipError } from '../src/log.mjs';
import { capture } from './fixtures/cmd.mjs';

/** Register a stand-in command for the duration of one test. */
async function withCommand(name, spec, fn) {
	COMMANDS[name] = { summary: 'a stand-in', group: 'Ship', ...spec };
	try {
		return await fn();
	} finally {
		delete COMMANDS[name];
	}
}

/** Run cli() against an argv, restoring argv, exit code and the EPIPE listeners after. */
async function ship(argv) {
	const savedArgv = process.argv;
	const savedCode = process.exitCode;
	const savedCwd = process.cwd();
	const listeners = [process.stdout, process.stderr].map((s) => s.listeners('error').length);
	process.argv = ['node', 'ship', ...argv];
	try {
		const { out } = await capture(() => cli());
		return { code: process.exitCode, out };
	} finally {
		process.argv = savedArgv;
		process.exitCode = savedCode;
		process.chdir(savedCwd);
		// cli() adds one EPIPE guard per stream per call; drop what this call added.
		for (const [i, stream] of [process.stdout, process.stderr].entries())
			for (const l of stream.listeners('error').slice(listeners[i])) stream.off('error', l);
	}
}

test('an unknown command suggests its neighbours, or the help when it has none', async () => {
	const near = await ship(['stat']);
	assert.match(near.out, /unknown command "stat"/);
	assert.match(near.out, /did you mean: /);

	const alone = await ship(['zzzz']);
	assert.match(alone.out, /run `ship --help`/);
});

test('a command with no help of its own falls back to its one-line summary', async () => {
	const { code, out } = await withCommand('standin', { load: async () => ({ run: () => 0 }) }, () =>
		ship(['standin', '--help']),
	);
	assert.equal(code, 0);
	assert.match(out, /standin: a stand-in/);
});

test('a ShipError prints its hint line by line and carries its own exit code', async () => {
	const spec = { load: async () => ({ run: () => { throw new ShipError('nope', { hint: 'first\nsecond', code: 3 }); } }) };
	const { code, out } = await withCommand('standin', spec, () => ship(['standin']));
	assert.equal(code, 3);
	assert.match(out, /✗ nope/);
	assert.match(out, /first/);
	assert.match(out, /second/);
});

test('anything else is an internal error: the stack is shown and the exit code is 70', async () => {
	const spec = { load: async () => ({ run: () => { throw new Error('kaboom'); } }) };
	const { code, out } = await withCommand('standin', spec, () => ship(['standin']));
	assert.equal(code, 70);
	assert.match(out, /internal error/);
	assert.match(out, /kaboom/);
});

test('a thrown non-Error still reaches the terminal rather than an empty report', async () => {
	const spec = { load: async () => ({ run: () => { throw 'a bare string'; } }) };
	const { code, out } = await withCommand('standin', spec, () => ship(['standin']));
	assert.equal(code, 70);
	assert.match(out, /a bare string/);
});

test('a command that returns nothing exits 0, and the short flags are honoured', async () => {
	let seen;
	const spec = { load: async () => ({ run: (ctx) => { seen = ctx.flags; } }) };
	const { code } = await withCommand('standin', spec, () => ship(['standin', '-n', '-v']));
	assert.equal(code, 0, 'a command that returns undefined has still succeeded');
	assert.equal(seen.n, true);
	assert.equal(seen.v, true);
});

test('--app runs the command from another directory', async () => {
	const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
	let cwd;
	const spec = { load: async () => ({ run: () => { cwd = process.cwd(); return 0; } }) };
	await withCommand('standin', spec, () => ship(['standin', '--app', `${root}/src`]));
	assert.equal(cwd, `${root}/src`);
});

test('a closed pipe ends the process quietly; any other stream error is raised', async () => {
	const savedExit = process.exit;
	const savedCode = process.exitCode;
	const savedArgv = process.argv;
	const exits = [];
	// @ts-expect-error — the stub records the exit instead of taking it.
	process.exit = (code) => exits.push(code);
	const before = process.stdout.listeners('error').length;
	try {
		process.argv = ['node', 'ship', 'zzzz'];
		await capture(() => cli());
		// Call the guard directly rather than emitting on the real stdout: emitting
		// would tear down the stream the test runner is reporting through.
		const guard = process.stdout.listeners('error').at(-1);

		// With process.exit stubbed the guard keeps going and rethrows; what is
		// being asserted is that the real one would have exited 0 first.
		assert.throws(() => guard(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })), /broken pipe/);
		assert.deepEqual(exits, [0], '`ship status | head` is a normal way to read a report');

		assert.throws(() => guard(new Error('disk went away')), /disk went away/);
	} finally {
		for (const l of process.stdout.listeners('error').slice(before)) process.stdout.off('error', l);
		for (const l of process.stderr.listeners('error').slice(before)) process.stderr.off('error', l);
		process.exit = savedExit;
		process.exitCode = savedCode;
		process.argv = savedArgv;
	}
});

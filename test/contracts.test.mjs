// Contracts every command module must honour.
//
// This file exists because of a real failure: a half-written module shipped with
// `run` declared twice, and nothing noticed until a human ran the command. The
// registry is the integration surface — if a command loads and exposes the right
// shape, `ship <cmd> --help` and `ship release` can both drive it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { COMMANDS, parseArgs } from '../src/cli.mjs';

const NAMES = Object.keys(COMMANDS);

test('the registry is not empty', () => {
	assert.ok(NAMES.length >= 14, `only ${NAMES.length} commands registered`);
});

for (const name of NAMES) {
	test(`${name} loads and exports run + help`, async () => {
		const mod = await COMMANDS[name].load();
		assert.equal(typeof mod.run, 'function', `${name}.run is not a function`);
		assert.equal(typeof mod.help, 'string', `${name}.help is not a string`);
		assert.ok(mod.help.includes(`ship ${name}`), `${name}.help does not name the command`);
	});
}

test('every command declares a group the usage screen renders', () => {
	const groups = new Set(['Setup', 'Discover', 'Ship', 'Grow']);
	for (const [name, spec] of Object.entries(COMMANDS)) {
		assert.ok(groups.has(spec.group), `${name} has unknown group ${spec.group}`);
		assert.ok(spec.summary?.length, `${name} has no summary`);
	}
});

test('a summary that lists subcommands lists the ones that exist', async () => {
	// `ship --help` promising `rc sync` when rc has no `sync` is a lie the user
	// only discovers by typing it.
	for (const [name, spec] of Object.entries(COMMANDS)) {
		const listed = spec.summary.split(':')[1];
		if (!listed?.includes('·')) continue;
		const mod = await COMMANDS[name].load();
		for (const sub of listed.split('·').map((s) => s.trim())) {
			assert.ok(
				mod.help.includes(sub),
				`\`ship --help\` advertises "${name} ${sub}" but \`ship ${name} --help\` never mentions it`,
			);
		}
	}
});

/**
 * Exit code of a real `bin/ship` invocation.
 * Deliberately a subprocess: stubbing process.stdout to silence main() also eats
 * the test runner's own reporter output, which silently hides other results.
 */
function exitCode(...argv) {
	const cli = new URL('../bin/ship', import.meta.url);
	return spawnSync(process.execPath, [cli.pathname, ...argv], { encoding: 'utf8' }).status;
}

test('--help and --version succeed; a bare invocation is a usage error', () => {
	// CI runs `ship <cmd> --help` over every module to prove it loads, so a
	// non-zero exit from an explicit help request fails the pipeline.
	assert.equal(exitCode('--help'), 0);
	assert.equal(exitCode('-h'), 0);
	assert.equal(exitCode('--version'), 0);
	assert.equal(exitCode(), 1, 'no command named is still an error');
	assert.equal(exitCode('nonsense'), 1, 'an unknown command is an error');
	for (const name of NAMES) assert.equal(exitCode(name, '--help'), 0, `ship ${name} --help`);
});

test('parseArgs: value flags, boolean flags, clusters, positionals', () => {
	const { flags, positional } = parseArgs(['aso', 'score', '--locale', 'en-US', '--top', '15', '-n', '--json']);
	assert.deepEqual(positional, ['aso', 'score']);
	assert.equal(flags.locale, 'en-US');
	assert.equal(flags.top, '15');
	assert.equal(flags.n, true);
	assert.equal(flags.json, true);
});

test('parseArgs: --key=value and a trailing flag with no value', () => {
	const { flags } = parseArgs(['--version=1.2.3', '--force']);
	assert.equal(flags.version, '1.2.3');
	assert.equal(flags.force, true);
});

test('parseArgs: a flag followed by another flag stays boolean', () => {
	const { flags } = parseArgs(['--dry-run', '--org', '123']);
	assert.equal(flags['dry-run'], true);
	assert.equal(flags.org, '123');
});

test('parseArgs: everything after -- is positional', () => {
	const { positional } = parseArgs(['ads', '--', '--not-a-flag']);
	assert.deepEqual(positional, ['ads', '--not-a-flag']);
});

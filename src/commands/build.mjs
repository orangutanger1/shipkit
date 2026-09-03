// EAS cloud build — plus the native fingerprint baseline that `ship ota` reads.
//
// The eas invocation is the boring half. The reason this is a command and not a
// shell alias is the lock written afterwards: without a baseline captured at the
// moment a binary was built, `ship ota` has nothing to diff the working tree
// against and must refuse every update. Build is therefore the only writer of
// .asc/native-lock.json, and OTA is only ever as trustworthy as this step.
import { loadConfig, resolveVersion } from '../config.mjs';
import { eas } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, warn } from '../log.mjs';
import { nativeConfigFingerprint, nativeFingerprint, readLock, writeLock } from '../lib/native.mjs';

/** @typedef {import('../lib/util.mjs').Flags} Flags */

export const help = `
${c.bold('ship build')} ${c.dim('— EAS cloud build for iOS, and the OTA baseline it leaves behind')}

${c.dim('usage:')} ship build [flags]

Runs ${c.cyan('eas build')} against the app in this repo, then records the native
dependency + expo-config fingerprint of the tree that was built. That record is
what lets ${c.cyan('ship ota')} tell a safe JS-only update from one that would crash
every installed client.

${c.bold('Flags')}
  ${c.cyan('--profile <name>')}  EAS build profile            ${c.dim('(default: eas.profile from ship.config.json)')}
  ${c.cyan('--version <v>')}     marketing version to record  ${c.dim('(default: app.json expo.version)')}
  ${c.cyan('--no-wait')}         queue the build and return instead of waiting
  ${c.cyan('--json')}            print a machine-readable summary, silence eas logs
  ${c.cyan('--dry-run')}         show the eas command, queue nothing, touch no lock

${c.bold('Notes')}
  ${c.dim('--local is rejected: local iOS builds need macOS + Xcode.')}
  ${c.dim('With --no-wait the baseline is recorded at queue time, not build time.')}
`;

/** `--no-wait` and `--wait=false` both mean "queue it and return".
 * @param {Flags} flags
 * @returns {boolean}
 */
function wantsWait(flags) {
	if (flags['no-wait']) return false;
	return !(flags.wait === false || flags.wait === 'false');
}

/** @param {import('../lib/util.mjs').SubCtx} ctx */
export async function run({ args, flags }) {
	if (args.length)
		throw new ShipError(`build: unexpected argument "${args[0]}"`, {
			hint: 'ship build has no subcommands — see `ship build --help`',
		});

	if (flags.local)
		throw new ShipError('local iOS builds are not possible on this host', {
			hint: [
				'A local iOS build needs macOS, Xcode and codesigning tooling; this is WSL2 Linux.',
				'EAS cloud build is the path: drop --local and run `ship build` again.',
			].join('\n'),
		});

	// loadConfig() without `optional` throws instead of resolving null.
	const cfg = /** @type {import('../config.mjs').Config} */ (await loadConfig());
	const version = await resolveVersion(cfg, /** @type {string|undefined} */ (flags.version));
	const profile = String(flags.profile ?? cfg.eas.profile);
	const platform = String(cfg.eas.platform);
	const wait = wantsWait(flags);
	const json = !!flags.json;

	heading(`build ${cfg.name} ${version}`);
	info(`profile ${c.cyan(profile)} · platform ${c.cyan(platform)} · ${wait ? 'waiting for completion' : c.yellow('not waiting')}`);

	const previous = await readLock(cfg);
	if (previous) note(`previous baseline: ${previous.version} recorded ${previous.builtAt}`);
	else note('no baseline on record yet — this build establishes the first one');

	step('eas build');
	const res = await eas(
		[
			'build',
			'--platform', platform,
			'--profile', profile,
			'--non-interactive',
			...(wait ? [] : ['--no-wait']),
		],
		// In --json mode eas' own progress output would corrupt our summary, so swallow it.
		{ cwd: cfg.paths.app, mutating: true, inherit: !json, capture: json },
	);

	if (res.skipped) {
		note('dry-run: nothing queued, native baseline left exactly as it was');
		if (json)
			process.stdout.write(
				`${JSON.stringify({ app: cfg.name, version, profile, platform, dryRun: true, lock: null }, null, 2)}\n`,
			);
		return 0;
	}

	const deps = await nativeFingerprint(cfg.paths.app);
	const config = await nativeConfigFingerprint(cfg.paths.app);
	const file = await writeLock(cfg, {
		version,
		deps,
		config,
		builtAt: new Date().toISOString(),
		profile,
		queued: !wait,
	});

	good(`build ${wait ? 'finished' : 'queued'} for ${cfg.name} ${version}`);
	good(`native baseline written → ${c.cyan(file)}`);
	note(`${Object.keys(deps).length} native dependencies + ${Object.keys(config).length} native config keys pinned`);
	note('`ship ota` diffs the working tree against this file; drift means a new binary is required');
	if (!wait)
		warn(
			'baseline recorded at queue time — if this build fails, re-run `ship build` before trusting `ship ota`',
		);

	if (json)
		process.stdout.write(
			`${JSON.stringify(
				{
					app: cfg.name,
					version,
					profile,
					platform,
					waited: wait,
					lock: file,
					nativeDeps: Object.keys(deps).length,
					nativeConfigKeys: Object.keys(config),
				},
				null,
				2,
			)}\n`,
		);
	return 0;
}

// OTA update — and the gate that decides whether one is even legal.
//
// Both tour and idea6 recorded the same incident: an OTA shipped against a
// changed native dependency graph breaks every installed client, because the JS
// bundle references native modules the installed binary does not contain. The
// crash is instant, it happens on launch, and it cannot be rolled back by the
// users it hit — they have a binary that can no longer run any bundle you serve
// on that channel. So the diff against the last build's fingerprint is not
// advice here, it is a precondition: `ship ota` refuses by default and only
// `--force` (with a warning nobody can miss) gets past it.
import { loadConfig, resolveVersion } from '../config.mjs';
import { eas } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { otaSafety } from '../lib/native.mjs';

export const help = `
${c.bold('ship ota')} ${c.dim('— publish a JS-only update, but only when that is actually safe')}

${c.dim('usage:')} ship ota --message "<what changed>" [flags]

Diffs the working tree's native dependency + expo-config fingerprint against the
baseline ${c.cyan('ship build')} recorded. Identical graph ${c.dim('→')} ${c.cyan('eas update')} runs.
Any drift ${c.dim('→')} the update is refused, because installed binaries would crash.

${c.bold('Flags')}
  ${c.cyan('--message <text>')}  update message  ${c.dim('(required unless --check)')}
  ${c.cyan('--branch <name>')}   EAS branch      ${c.dim('(default: eas.channel from ship.config.json)')}
  ${c.cyan('--version <v>')}     version to compare against the baseline ${c.dim('(default: app.json expo.version)')}
  ${c.cyan('--check')}           print the verdict and exit; publish nothing
  ${c.cyan('--force')}           publish despite drift ${c.dim('— this is how you brick installed clients')}
  ${c.cyan('--dry-run')}         show the eas command without running it

${c.bold('Exit codes')}
  ${c.dim('0 safe (or published)  ·  1 drift detected — run `ship build` instead')}
`;

/** Drift rows, flattened so one table tells the whole story. */
function driftRows(verdict) {
	const rows = [];
	for (const name of verdict.added) rows.push({ kind: 'added', name, detail: verdict.current.deps[name] ?? '' });
	for (const name of verdict.removed)
		rows.push({ kind: 'removed', name, detail: verdict.lock?.deps?.[name] ?? '' });
	for (const name of verdict.changed)
		rows.push({
			kind: 'changed',
			name,
			detail: `${verdict.lock?.deps?.[name] ?? '?'} → ${verdict.current.deps[name] ?? '?'}`,
		});
	for (const key of verdict.configChanged) rows.push({ kind: 'config', name: key, detail: 'expo config key changed' });
	return rows;
}

const KIND_COLOUR = { added: c.green, removed: c.red, changed: c.yellow, config: c.magenta };

export async function run({ args, flags }) {
	if (args.length)
		throw new ShipError(`ota: unexpected argument "${args[0]}"`, {
			hint: 'ship ota has no subcommands — see `ship ota --help`',
		});

	const cfg = await loadConfig();
	const version = await resolveVersion(cfg, flags.version);
	const branch = String(flags.branch ?? cfg.eas.channel);
	const check = !!flags.check;
	const force = !!flags.force;

	heading(`ota ${cfg.name} ${version}`);
	info(`branch ${c.cyan(branch)} · comparing working tree against the last native build`);

	const verdict = await otaSafety(cfg, version);

	if (verdict.safe) {
		process.stdout.write(`\n${c.green(c.bold('  OTA SAFE  '))} ${verdict.reason}\n\n`);
		if (verdict.lock) note(`baseline: ${verdict.lock.version} built ${verdict.lock.builtAt}`);
	} else {
		process.stdout.write(`\n${c.red(c.bold('  OTA UNSAFE  '))} ${c.red(verdict.reason)}\n\n`);
		const rows = driftRows(verdict);
		if (rows.length) {
			table(rows, [
				{ header: 'CHANGE', get: (r) => (KIND_COLOUR[r.kind] ?? c.dim)(r.kind) },
				{ header: 'NAME', get: (r) => r.name },
				{ header: 'DETAIL', get: (r) => r.detail },
			]);
			process.stdout.write('\n');
		}
		note('a JS bundle built from this tree references native code the installed binary does not have');
	}

	if (check) {
		note(verdict.safe ? '`--check` only — nothing published' : 'run `ship build` to cut a new binary and reset the baseline');
		return verdict.safe ? 0 : 1;
	}

	if (!verdict.safe) {
		if (!force)
			throw new ShipError('ota refused: native graph drifted since the last build', {
				hint: 'run `ship build` to ship a new binary — or `ship ota --force` if you accept crashing every installed client',
			});
		// Loud, red, and above the eas invocation so it is the last thing read
		// before the update goes out. --force exists for the rare case where the
		// operator knows the drift is cosmetic; it is not a way to skip thinking.
		warn(c.red(c.bold('--force: publishing an OTA over a CHANGED NATIVE GRAPH')));
		warn(c.red('every client running the previous binary may crash on launch and cannot self-recover'));
	}

	const message = flags.message == null ? '' : String(flags.message);
	if (!message.trim())
		throw new ShipError('ota: --message is required', {
			hint: 'eas update messages are the only changelog a rolled-back OTA leaves behind — `ship ota --message "fix paywall copy"`',
		});

	step('eas update');
	const res = await eas(['update', '--branch', branch, '--message', message, '--non-interactive'], {
		cwd: cfg.paths.app,
		mutating: true,
	});

	if (res.skipped) {
		note('dry run — no update published, baseline untouched');
		return 0;
	}
	if (res.code !== 0)
		throw new ShipError(`eas update failed (exit ${res.code})`, {
			hint: 'check the EAS output above; the baseline in .asc/native-lock.json is unchanged',
		});

	good(`OTA published to ${c.cyan(branch)} — ${message}`);
	note(`clients pick it up on next launch · verify with \`ship status\``);
	return 0;
}

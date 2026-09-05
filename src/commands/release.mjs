// The whole release, in order, with the gates left switched on.
//
// Every step here is runnable on its own; the value of the chain is that it
// refuses to continue past a failure. The historical failure mode was a human
// running preflight, skimming the warnings, and building anyway — so the exit
// code of each step is load-bearing, and only --force downgrades it to a warning.
// Steps are imported lazily so that a command module that is missing or broken
// surfaces as "release: cannot load the meta step" rather than a stack trace at
// CLI load time, and so `ship release --skip-build` never pays to parse EAS code.
import { loadConfig, resolveVersion } from '../config.mjs';
import { isDryRun } from '../exec.mjs';
import { errExitCode, errMessage, strOf } from '../lib/util.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';

/** @typedef {import('../lib/util.mjs').Flags} Flags */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */

export const help = `
${c.bold('ship release')} ${c.dim('— preflight → metadata → build → submit, aborting on the first failure')}

${c.dim('usage:')} ship release [flags]

${c.bold('Steps')}
  ${c.cyan('preflight')}  every readiness gate ${c.dim('(ship preflight)')}
  ${c.cyan('meta')}       stage then apply store listings ${c.dim('(ship meta stage; ship meta apply)')}
  ${c.cyan('build')}      EAS cloud build + native baseline ${c.dim('(ship build)')}
  ${c.cyan('submit')}     upload, wait for processing, submit for review ${c.dim('(ship submit)')}

${c.bold('Flags')}
  ${c.cyan('--from <step>')}    resume at preflight | meta | build | submit
  ${c.cyan('--skip-build')}     the binary is already built
  ${c.cyan('--skip-submit')}    stop after the build
  ${c.cyan('--version <v>')}    version for every step ${c.dim('(default: app.json expo.version)')}
  ${c.cyan('--force')}          keep going after a step fails ${c.dim('— each gate exists for a reason')}
  ${c.cyan('--dry-run')}        narrate the whole chain, mutate nothing

${c.bold('Notes')}
  ${c.dim('--dry-run is global state, so every child step inherits it automatically.')}
  ${c.dim('Flags you pass are forwarded verbatim to each step (--profile, --timeout, ...).')}
`;

const ORDER = ['preflight', 'meta', 'build', 'submit'];

/** Lazy module load with a diagnosable failure instead of a load-time crash. */
/** @param {string} name @returns {Promise<{run?: (ctx: SubCtx) => Promise<number>|number}>} */
async function load(name) {
	try {
		return await import(`./${name}.mjs`);
	} catch (err) {
		throw new ShipError(`release: cannot load the ${name} step`, {
			hint: `${errMessage(err)} — run \`ship ${name} --help\` to confirm the command exists`,
		});
	}
}

/** Run one step's `run()`, normalising exit codes and thrown ShipErrors into a result row. */
/**
 * @param {string} name
 * @param {string[][]} calls
 * @param {Flags} flags
 * @returns {Promise<{code: number, label: string}>}
 */
async function invoke(name, calls, flags) {
	const mod = await load(name);
	if (typeof mod.run !== 'function')
		throw new ShipError(`release: ${name}.mjs does not export run()`, {
			hint: 'every command module exports `help` and `run({ args, flags })`',
		});
	for (const args of calls) {
		const label = args.length ? `${name} ${args.join(' ')}` : name;
		const code = await mod.run({ args, flags });
		if (code) return { code, label };
	}
	return { code: 0, label: name };
}

/** @param {SubCtx} ctx @returns {Promise<number>} */
export async function run({ args, flags }) {
	if (args.length)
		throw new ShipError(`release: unexpected argument "${args[0]}"`, {
			hint: `release has no subcommands — use --from <${ORDER.join('|')}> to resume`,
		});

	const from = flags.from == null ? ORDER[0] : String(flags.from);
	const startAt = ORDER.indexOf(from);
	if (startAt < 0)
		throw new ShipError(`release: unknown step "${from}"`, { hint: `--from must be one of: ${ORDER.join(', ')}` });

	const cfg = await loadConfig();
	const version = await resolveVersion(cfg, strOf(flags.version));
	const force = !!flags.force;
	const dry = isDryRun();

	heading(`release ${cfg.name} ${version}`);
	info(`chain: ${ORDER.map((s, i) => (i < startAt ? c.dim(s) : c.cyan(s))).join(c.dim(' → '))}`);
	if (startAt > 0) note(`resuming at ${from} — earlier steps assumed done`);
	if (dry) note('dry run — every step narrates its mutations without performing them');
	if (force) warn('--force: a failing step will not stop the chain');

	// Steps are declared as (name, calls, skipped-because) so the summary at the
	// end can report skips as deliberately as it reports failures.
	const plan = ORDER.map((name) => {
		let skip = '';
		if (ORDER.indexOf(name) < startAt) skip = `before --from ${from}`;
		else if (name === 'build' && flags['skip-build']) skip = '--skip-build';
		else if (name === 'submit' && flags['skip-submit']) skip = '--skip-submit';
		return { name, skip, calls: name === 'meta' ? [['stage'], ['apply']] : [[]] };
	});

	const results = [];
	let failed = null;

	for (const entry of plan) {
		if (entry.skip) {
			results.push({ name: entry.name, status: 'skipped', detail: entry.skip });
			continue;
		}
		step(entry.name);
		let outcome;
		try {
			outcome = await invoke(entry.name, entry.calls, flags);
		} catch (err) {
			if (!force) throw err;
			warn(`${entry.name} threw: ${errMessage(err)}`);
			outcome = { code: errExitCode(err), label: entry.name };
		}

		if (outcome.code) {
			failed ??= outcome.label;
			results.push({ name: entry.name, status: 'failed', detail: `exit ${outcome.code}` });
			if (!force)
				throw new ShipError(`release stopped: ${outcome.label} exited ${outcome.code}`, {
					hint: `fix it, then resume with \`ship release --from ${entry.name}\``,
				});
			warn(`${entry.name} failed (exit ${outcome.code}) — continuing because --force`);
		} else {
			results.push({ name: entry.name, status: dry ? 'dry-run' : 'ran', detail: '' });
		}
	}

	heading('release summary');
	table(results, [
		{
			header: 'STEP',
			get: (r) => r.name,
		},
		{
			header: 'RESULT',
			get: (r) =>
				r.status === 'failed'
					? c.red(r.status)
					: r.status === 'skipped'
						? c.dim(r.status)
						: c.green(r.status),
		},
		{ header: 'WHY', get: (r) => r.detail },
	]);

	if (failed) {
		warn(`release completed with failures (first: ${failed})`);
		note(`resume with: ${c.cyan(`ship release --from ${failed.split(' ')[0]}`)}`);
	} else if (dry) {
		good(`dry run of the ${cfg.name} ${version} release finished — nothing was mutated`);
	} else {
		good(`${cfg.name} ${version} released`);
	}

	note(`check on it with: ${c.cyan(`ship status --version ${version}`)}`);
	return failed ? 1 : 0;
}

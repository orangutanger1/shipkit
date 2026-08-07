// Upload the binary, wait for Apple to finish chewing on it, then submit for review.
//
// The waiting is the whole point. `eas submit` returns as soon as Apple accepts
// the upload, but a build in PROCESSING cannot be attached to a version, so a
// review submission fired immediately afterwards fails with an error that reads
// like a permissions problem. Polling until VALID turns that into a wait.
// The validate gate before submission is the second half: `asc validate` runs
// the same checks review does and hands back an ordered remediation plan, which
// is strictly cheaper than a rejection three days later.
import { loadConfig, requireAppId, resolveVersion } from '../config.mjs';
import { asc, eas, isDryRun } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';

export const help = `
${c.bold('ship submit')} ${c.dim('— upload the latest build and submit it for App Review')}

${c.dim('usage:')} ship submit [flags]

  1. ${c.cyan('eas submit')} uploads the latest iOS build to App Store Connect
  2. polls ${c.cyan('asc builds list')} until Apple finishes processing it
  3. ${c.cyan('asc validate')} runs review's own checks and prints the remediation plan
  4. ${c.cyan('asc review submit')} attaches the build and submits the version

${c.bold('Flags')}
  ${c.cyan('--version <v>')}     version to submit      ${c.dim('(default: app.json expo.version)')}
  ${c.cyan('--profile <name>')}  EAS submit profile     ${c.dim('(default: eas.profile from ship.config.json)')}
  ${c.cyan('--skip-upload')}     the build is already in ASC — start at the poll
  ${c.cyan('--timeout <s>')}     seconds to wait for processing ${c.dim('(default: 900)')}
  ${c.cyan('--force')}           submit even though validate reported problems
  ${c.cyan('--json')}            machine-readable summary
  ${c.cyan('--dry-run')}         narrate every mutating step, perform none

${c.bold('Notes')}
  ${c.dim('Apple processing is routinely 5-15 minutes; --timeout exists for the bad days.')}
  ${c.dim('--force submits a version validate already told you will be rejected.')}
`;

const POLL_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** asc payloads arrive as `{data:[...]}`, a bare array, or `{builds:[...]}` depending on subcommand. */
function listOf(payload) {
	if (!payload) return [];
	if (Array.isArray(payload)) return payload;
	for (const key of ['data', 'builds', 'items', 'results']) {
		if (Array.isArray(payload[key])) return payload[key];
	}
	return [];
}

const attrs = (row) => row?.attributes ?? row ?? {};
const buildLabel = (b) => {
	const a = attrs(b);
	return `${a.version ?? a.buildNumber ?? '?'} (${a.uploadedDate ?? a.expirationDate ?? 'no date'})`;
};

/**
 * Wait for the newest build to reach VALID.
 * Returns the build row so the caller can hand its id to `asc review submit`.
 */
async function waitForProcessing(appId, timeoutSec) {
	const deadline = Date.now() + timeoutSec * 1000;
	let last = 'unknown';
	let attempt = 0;

	for (;;) {
		attempt += 1;
		const payload = await asc(['builds', 'list', '--app', appId, '--limit', '5'], {
			fallback: null,
			allowFail: true,
		});
		const builds = listOf(payload);
		const newest = builds[0];

		if (!newest) {
			last = 'no builds returned';
		} else {
			last = String(attrs(newest).processingState ?? 'unknown');
			if (last === 'VALID') {
				good(`build ${buildLabel(newest)} processed`);
				return newest;
			}
			if (last === 'FAILED' || last === 'INVALID')
				throw new ShipError(`build processing ${last.toLowerCase()} for ${buildLabel(newest)}`, {
					hint: 'Apple emails the reason — usually a missing entitlement or an invalid Info.plist key. Fix it and re-run `ship build`.',
				});
		}

		const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
		info(`poll ${attempt}: ${c.yellow(last)} ${c.dim(`(${left}s of budget left)`)}`);
		if (Date.now() + POLL_MS > deadline)
			throw new ShipError(`timed out after ${timeoutSec}s waiting for processing; last state was ${last}`, {
				hint: 'Apple is slow, not stuck — re-run `ship submit --skip-upload` to resume polling the same build',
			});
		await sleep(POLL_MS);
	}
}

/**
 * `asc validate` reports
 *   { summary:{errors,warnings,infos,blocking}, checks:[{id,severity,message,remediation,field}],
 *     remediation:{totalActionable, steps:[{order,blocking,severity,checkId,message,remediation,field}]} }
 * `blocking` is the number that matters: a non-blocking error (e.g. an advisory
 * privacy check) should not stop a submission that Apple would accept.
 */
function readValidation(payload) {
	const problems = listOf(payload?.checks).map((row) => ({
		level: String(row?.severity ?? 'info').toLowerCase(),
		id: row?.id ?? row?.checkId ?? '',
		text: String(row?.message ?? '').trim(),
	}));

	const plan = listOf(payload?.remediation?.steps)
		.slice()
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
		.map((s) => ({
			order: s.order,
			blocking: !!s.blocking,
			text: [s.message, s.remediation].filter(Boolean).join(` ${c.dim('→')} `),
		}));

	const summary = payload?.summary ?? {};
	const blocking = Number(summary.blocking ?? summary.errors ?? problems.filter((p) => p.level === 'error').length);
	return { clean: blocking === 0, blocking, summary, problems, plan };
}

const LEVEL_MARK = { error: () => c.red('✗'), warning: () => c.yellow('!'), info: () => c.dim('·') };

export async function run({ args, flags }) {
	if (args.length)
		throw new ShipError(`submit: unexpected argument "${args[0]}"`, {
			hint: 'ship submit has no subcommands — see `ship submit --help`',
		});

	const cfg = await loadConfig();
	const version = await resolveVersion(cfg, flags.version);
	const appId = requireAppId(cfg);
	const profile = String(flags.profile ?? cfg.eas.profile);
	const timeout = Number(flags.timeout ?? 900);
	const force = !!flags.force;
	const json = !!flags.json;
	const dry = isDryRun();

	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new ShipError(`submit: --timeout must be a positive number of seconds (got "${flags.timeout}")`);

	heading(`submit ${cfg.name} ${version}`);
	info(`app ${c.cyan(appId)} · profile ${c.cyan(profile)} · processing budget ${c.cyan(`${timeout}s`)}`);

	const summary = { app: appId, version, uploaded: false, buildId: null, validated: null, submitted: false, dryRun: dry };

	if (flags['skip-upload']) {
		step('eas submit');
		note('skipped — --skip-upload, expecting the build to already be in App Store Connect');
	} else {
		step('eas submit');
		const up = await eas(
			['submit', '--platform', 'ios', '--profile', profile, '--latest', '--non-interactive'],
			{ cwd: cfg.paths.app, mutating: true },
		);
		if (up.skipped) note('dry run — nothing uploaded');
		else if (up.code !== 0)
			throw new ShipError(`eas submit failed (exit ${up.code})`, {
				hint: 'the usual cause is an expired App Store Connect API key in the EAS submit profile',
			});
		else {
			summary.uploaded = true;
			good('binary uploaded to App Store Connect');
		}
	}

	step('wait for Apple to finish processing');
	let build = null;
	if (dry) {
		note(`dry run — would poll \`asc builds list --app ${appId} --limit 5\` every ${POLL_MS / 1000}s until VALID`);
	} else {
		build = await waitForProcessing(appId, timeout);
		summary.buildId = build?.id ?? null;
	}

	step('readiness check');
	const validation = await asc(['validate', '--app', appId, '--version', version], {
		fallback: null,
		allowFail: true,
	});
	if (!validation) {
		warn('asc validate returned nothing — treating readiness as unknown');
		if (!force)
			throw new ShipError('cannot confirm the version is submittable', {
				hint: 'run `asc validate --app ' + appId + ' --version ' + version + '` by hand, or pass --force',
			});
	} else {
		const { clean, problems, plan } = readValidation(validation);
		summary.validated = clean;
		if (problems.length)
			table(problems, [
				{ header: '', get: (p) => (LEVEL_MARK[p.level] ?? LEVEL_MARK.info)() },
				{ header: 'FINDING', get: (p) => p.text },
			]);
		if (plan.length) {
			process.stdout.write(`\n${c.bold('  remediation plan')}\n`);
			plan.forEach((s, i) => note(`${i + 1}. ${s.blocking ? `${c.red('blocking')} ` : ''}${s.text}`));
			process.stdout.write('\n');
		}
		if (clean) good('validate is clean — the version is submittable');
		else if (force) warn(c.red('--force: submitting a version validate says will be rejected'));
		else
			throw new ShipError('validate reported problems — not submitting', {
				hint: 'work the remediation plan above, then re-run `ship submit --skip-upload`',
			});
	}

	step('submit for review');
	const buildId = build?.id ?? (flags.build == null ? null : String(flags.build));
	if (dry) {
		note(`dry run — would run \`asc review submit --app ${appId} --version ${version} --build <id> --confirm\``);
	} else {
		if (!buildId)
			throw new ShipError('no processed build id to attach', {
				hint: '`asc builds list --app ' + appId + '` should show a VALID build; pass --build <id> to pick one explicitly',
			});
		const res = await asc(
			['review', 'submit', '--app', appId, '--version', version, '--build', buildId, '--confirm'],
			{ mutating: true, fallback: null, allowFail: true },
		);
		if (!res)
			throw new ShipError('asc review submit returned no result', {
				hint: 'check `asc submit status --app ' + appId + '` — the submission may still have gone through',
			});
		summary.submitted = true;
		good(`${cfg.name} ${version} submitted for review (build ${buildId})`);
	}

	note(`follow up with: ${c.cyan(`ship status --version ${version}`)}`);
	if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	return 0;
}

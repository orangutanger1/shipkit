// OTA update — and the two gates that decide whether one is even legal.
//
// Gate 1 is the native graph. Both tour and idea6 recorded the same incident:
// an OTA shipped against a changed native dependency graph breaks every
// installed client, because the JS bundle references native modules the
// installed binary does not contain. The crash is instant, it happens on
// launch, and it cannot be rolled back by the users it hit — they have a binary
// that can no longer run any bundle you serve on that channel. So the diff
// against the last build's fingerprint is not advice here, it is a precondition.
//
// Gate 2 is the environment. `eas update` inlines every `EXPO_PUBLIC_*` value
// into the bundle at publish time from whatever environment the publisher
// happened to have — and run bare, that is the operator's shell, not the EAS
// environment. On 2026-08-25 that shipped glovebox an OTA with the RevenueCat
// and PostHog keys absent: the paywall button killed the process and analytics
// went silent in the same instant. So `ship ota` never publishes a bundle it
// has not read: it re-execs itself under `eas env:exec <environment>`, exports
// locally with that environment loaded, verifies every key in
// `ota.requiredEnv` reaches the bundle *by value*, publishes with
// `--environment`, and then checks the manifest the update server serves.
import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, readExpoConfig, resolveVersion } from '../config.mjs';
import { eas, run as execRun } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { otaSafety } from '../lib/native.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../lib/util.mjs').Flags} Flags */
/** @typedef {import('../lib/util.mjs').Json} Json */
/** @typedef {import('../lib/util.mjs').JsonObject} JsonObject */
/** @typedef {Awaited<ReturnType<typeof otaSafety>>} Verdict */
/** @typedef {{kind: 'added'|'removed'|'changed'|'config', name: string, detail: string}} DriftRow */
/** One entry of `eas update --json`'s published array, as {@link verifyServed} reads it. */
/** @typedef {{platform?: string, id?: string}} UpdateEntry */

export const help = `
${c.bold('ship ota')} ${c.dim('— publish a JS-only update, but only when that is actually safe')}

${c.dim('usage:')} ship ota --message "<what changed>" [flags]

Diffs the working tree's native dependency + expo-config fingerprint against the
baseline ${c.cyan('ship build')} recorded. Identical graph ${c.dim('→')} the publish runs.
Any drift ${c.dim('→')} the update is refused, because installed binaries would crash.

Before publishing, the update is verified the way a phone sees it: the process
re-runs itself inside ${c.cyan('eas env:exec <environment>')}, exports the bundle with that
environment loaded, and refuses unless every key in ${c.cyan('ota.requiredEnv')} (ship.config.json)
is present in the exported bundle by value. The published update is then checked
against the manifest the update server actually serves.

${c.bold('Flags')}
  ${c.cyan('--message <text>')}     update message  ${c.dim('(required unless --check)')}
  ${c.cyan('--branch <name>')}      EAS branch      ${c.dim('(default: eas.channel from ship.config.json)')}
  ${c.cyan('--environment <name>')} EAS environment ${c.dim('(default: eas.environment, else production)')}
  ${c.cyan('--version <v>')}        version to compare against the baseline ${c.dim('(default: app.json expo.version)')}
  ${c.cyan('--check')}              print the verdict and exit; publish nothing
  ${c.cyan('--force')}              publish despite drift ${c.dim('— this is how you brick installed clients')}
  ${c.cyan('--dry-run')}            show the eas command without running it

${c.bold('Exit codes')}
  ${c.dim('0 safe (or published)  ·  1 drift detected — run `ship build` instead')}
`;

/**
 * Drift rows, flattened so one table tells the whole story.
 * @param {Verdict} verdict
 * @returns {DriftRow[]}
 */
function driftRows(verdict) {
	/** @type {DriftRow[]} */
	const rows = [];
	// verdict.current.deps is built by nativeFingerprint, so every name here
	// (drawn from Object.keys of that same object) already has a string value —
	// unlike the lock side below, which is untrusted JSON off disk and can hold
	// anything a hand-edited or stale-schema native-lock.json put there.
	for (const name of verdict.added) rows.push({ kind: 'added', name, detail: verdict.current.deps[name] });
	for (const name of verdict.removed)
		rows.push({ kind: 'removed', name, detail: verdict.lock?.deps?.[name] ?? '' });
	for (const name of verdict.changed)
		rows.push({
			kind: 'changed',
			name,
			detail: `${verdict.lock?.deps?.[name] ?? '?'} → ${verdict.current.deps[name]}`,
		});
	for (const key of verdict.configChanged) rows.push({ kind: 'config', name: key, detail: 'expo config key changed' });
	return rows;
}

/** @type {Record<DriftRow['kind'], (s: string) => string>} */
const KIND_COLOUR = { added: c.green, removed: c.red, changed: c.yellow, config: c.magenta };

/**
 * eas prefixes warnings sometimes; take the JSON wherever it starts.
 * @param {string} text
 * @returns {Json|null}
 */
function salvageJSON(text) {
	const t = String(text).trim();
	for (const start of [0, t.search(/[[{]/)]) {
		if (start < 0) continue;
		try {
			return JSON.parse(t.slice(start));
		} catch {
			/* try the next candidate */
		}
	}
	return null;
}

/**
 * What the phones will actually ask for. A published update that the channel
 * does not serve is the other way this goes wrong quietly: a branch mapped
 * somewhere else, or a runtime version no installed binary reports. Protocol 1
 * answers in `multipart/mixed`; the manifest is the first JSON object up to the
 * next boundary, and a protocol 0 bare-JSON response reads unchanged.
 * @param {string} url
 * @param {string} platform
 * @param {string} runtimeVersion
 * @param {string} branch
 * @returns {Promise<JsonObject>}
 */
async function servedManifest(url, platform, runtimeVersion, branch) {
	const res = await fetch(url, {
		headers: {
			'expo-platform': platform,
			'expo-runtime-version': runtimeVersion,
			'expo-channel-name': branch,
			'expo-protocol-version': '1',
			'expo-api-version': '1',
			'expo-expect-signature': 'false',
		},
	});
	const text = await res.text();
	if (!res.ok)
		throw new ShipError(`the update server answered ${res.status} for the ${platform} manifest`, {
			hint: text.slice(0, 300),
		});
	const start = text.indexOf('{');
	if (start === -1) throw new ShipError('the update server answered with no manifest at all');
	const boundary = text.indexOf('\n---', start);
	const body = boundary === -1 ? text.slice(start) : text.slice(start, boundary);
	try {
		return JSON.parse(body.trim());
	} catch (err) {
		throw new ShipError(`the update server answered with something that is not a manifest: ${/** @type {Error} */ (err).message}`);
	}
}

/**
 * The export-and-verify loop: rebuild per platform and prove the secrets landed in the bytes.
 * @param {{app: string, platforms: string[], required: string[], publicKeys: string[]}} opts
 */
async function exportAndVerify({ app, platforms, required, publicKeys }) {
	for (const platform of platforms) {
		// `--clear` is load-bearing, not hygiene. EXPO_PUBLIC_* values are inlined
		// by the transformer and Metro caches per file, not per environment, so an
		// earlier export without the EAS environment would otherwise hand this
		// gate a bundle whose keys were compiled out yesterday.
		await rm(join(app, 'dist'), { recursive: true, force: true });
		await execRun('npx', ['--yes', 'expo', 'export', '--platform', platform, '--clear'], {
			cwd: app,
			inherit: true,
			capture: false,
		});
		const bundleDir = join(app, 'dist', '_expo', 'static', 'js', platform);
		let bundles;
		try {
			bundles = (await readdir(bundleDir)).filter((n) => n.endsWith('.hbc') || n.endsWith('.js'));
		} catch {
			throw new ShipError(`no ${platform} bundle under ${bundleDir} — expo export produced nothing to verify`);
		}
		if (bundles.length !== 1)
			throw new ShipError(`expected exactly one ${platform} bundle in ${bundleDir}, found ${bundles.length}`);
		const bundlePath = join(bundleDir, bundles[0]);
		const text = await readFile(bundlePath, 'latin1');
		const digest = createHash('md5').update(text).digest('hex');

		// The value, not the variable name: `process.env.X` is compiled away, so
		// the only proof that inlining happened is the secret itself in the bytes.
		const absent = required.filter((key) => !text.includes(/** @type {string} */ (process.env[key])));
		if (absent.length)
			throw new ShipError(`${absent.join(', ')} did not reach the ${platform} bundle — this is the crash, refusing to publish`);
		const unverified = publicKeys.filter((k) => !required.includes(k) && !text.includes(/** @type {string} */ (process.env[k])));
		good(`${platform}: ${basename(bundlePath)} verified (md5 ${digest})`);
		if (unverified.length) note(`${unverified.join(', ')} defined but not inlined — fine if they are optional`);
	}
}

/**
 * Prove the branch actually serves what `eas update` just published.
 * @param {{cfg: Config, platforms: string[], entries: UpdateEntry[], branch: string, version: string}} opts
 */
async function verifyServed({ cfg, platforms, entries, branch, version }) {
	const updatesUrl = /** @type {{url?: string}|undefined} */ ((await readExpoConfig(cfg))?.updates)?.url;
	for (const platform of platforms) {
		const update = entries.find((e) => e?.platform === platform) ?? entries[0];
		if (!update?.id) throw new ShipError(`eas update published nothing identifiable for ${platform}`);
		if (!updatesUrl) {
			note(`no expo.updates.url in app.json — cannot verify what ${branch} serves`);
			continue;
		}
		const manifest = await servedManifest(updatesUrl, platform, version, branch);
		if (manifest?.id !== update.id)
			throw new ShipError(
				`${branch} serves ${manifest?.id ?? 'no update'} for ${platform}, not the ${update.id} just published — check the channel's branch mapping`,
			);
		good(`${platform}: ${branch} serves update ${update.id}`);
	}
}

/**
 * The inner half: runs under `eas env:exec <environment>`, so process.env is
 * exactly what the published bundle will be built with. Every check here is
 * the difference between the 2026-08-25 incident and its absence.
 * @param {{cfg: Config, flags: Flags, version: string}} opts
 */
async function publishInner({ cfg, flags, version }) {
	const app = cfg.paths.app;
	const branch = String(flags.branch ?? cfg.eas.channel);
	const environment = String(flags.environment ?? cfg.eas.environment ?? 'production');
	const scope = String(flags.platforms ?? 'ios');
	const platforms = scope === 'all' ? ['ios', 'android'] : scope.split(',').filter(Boolean);
	const message = flags['message-b64'] ? Buffer.from(String(flags['message-b64']), 'base64').toString('utf8') : '';
	if (!message.trim()) throw new ShipError('ota inner: no message to publish');

	const required = cfg.ota?.requiredEnv ?? [];
	const missingEnv = required.filter((key) => !process.env[key]);
	if (missingEnv.length)
		throw new ShipError(
			`${missingEnv.join(', ')} absent from the ${environment} environment — the bundle would ship without it`,
			{ hint: 'create them with `eas env:create`, or adjust ota.requiredEnv in ship.config.json' },
		);

	const publicKeys = Object.keys(process.env).filter((k) => k.startsWith('EXPO_PUBLIC_'));
	if (!publicKeys.length)
		warn(`the ${environment} environment defines no EXPO_PUBLIC_* values — if this app needs any, the bundle will not have them`);

	await exportAndVerify({ app, platforms, required, publicKeys });

	step(`eas update ${c.dim(`(${scope})`)}`);
	const res = await eas(
		[
			'update',
			'--branch',
			branch,
			'--platform',
			scope,
			'--environment',
			environment,
			'--message',
			message,
			'--json',
			'--non-interactive',
		],
		// allowFail, because the refusal below names the branch and prints eas's
		// own last lines; run()'s generic "exited N" would replace it.
		{ cwd: app, inherit: false, capture: true, allowFail: true },
	);
	if (res.code !== 0)
		throw new ShipError(`eas update failed (exit ${res.code})`, {
			hint: (res.stderr || res.stdout).trim().split('\n').slice(-6).join('\n'),
		});
	const published = salvageJSON(res.stdout);
	const entries = /** @type {UpdateEntry[]} */ (Array.isArray(published) ? published : published ? [published] : []);

	await verifyServed({ cfg, platforms, entries, branch, version });
	return 0;
}

/** @param {import('../lib/util.mjs').SubCtx} ctx */
export async function run({ args, flags }) {
	if (args.length)
		throw new ShipError(`ota: unexpected argument "${args[0]}"`, {
			hint: 'ship ota has no subcommands — see `ship ota --help`',
		});

	const cfg = await loadConfig();
	const version = await resolveVersion(cfg, /** @type {string|undefined} */ (flags.version));

	if (flags.inner) return publishInner({ cfg, flags, version });

	const branch = String(flags.branch ?? cfg.eas.channel);
	const environment = String(flags.environment ?? cfg.eas.environment ?? 'production');
	const check = !!flags.check;
	const force = !!flags.force;

	heading(`ota ${cfg.name} ${version}`);
	info(`branch ${c.cyan(branch)} · environment ${c.cyan(environment)} · comparing working tree against the last native build`);

	const verdict = await otaSafety(cfg, version);

	if (verdict.safe) {
		process.stdout.write(`\n${c.green(c.bold('  OTA SAFE  '))} ${verdict.reason}\n\n`);
		if (verdict.lock) note(`baseline: ${verdict.lock.version} built ${verdict.lock.builtAt}`);
	} else {
		process.stdout.write(`\n${c.red(c.bold('  OTA UNSAFE  '))} ${c.red(verdict.reason)}\n\n`);
		const rows = driftRows(verdict);
		if (rows.length) {
			table(rows, [
				// KIND_COLOUR carries every member of DriftRow['kind'] — driftRows()
				// never produces a fifth kind — so there is no default to fall back to.
				{ header: 'CHANGE', get: (r) => KIND_COLOUR[r.kind](r.kind) },
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

	// Scoped to the platforms the app actually declares. `eas update` with no
	// --platform exports "all", and its export step reads the Expo config per
	// platform: an iOS-only app (expo.platforms: ["ios"], no expo.android) fails
	// the whole publish on "Platform android is not configured to use the Metro
	// bundler", having already built the bundle it was asked for. Nothing about
	// that is a decision for the operator to make on the command line, so it is
	// read rather than flagged.
	const platforms = (await readExpoConfig(cfg))?.platforms;
	const scope = Array.isArray(platforms) && platforms.length ? platforms.join(',') : 'all';

	// Re-exec inside the EAS environment. `eas env:exec` is the only way to hold
	// those values in the process that exports the bundle, and it takes a bash
	// string — hence the base64 message. If the environment does not exist the
	// publish aborts here; a bundle from the wrong environment is the incident.
	const shipEntry = fileURLToPath(new URL('../../bin/ship', import.meta.url));
	const innerFlags = [
		'--inner',
		'--branch',
		branch,
		'--environment',
		environment,
		'--version',
		version,
		'--platforms',
		scope,
		'--message-b64',
		Buffer.from(message, 'utf8').toString('base64'),
	];
	step(`eas env:exec ${environment}`);
	const res = await eas(['env:exec', environment, `node ${shipEntry} ota ${innerFlags.join(' ')}`, '--non-interactive'], {
		cwd: cfg.paths.app,
		mutating: true,
		// The inner half has already printed why it refused; allowFail keeps that
		// reason as the last thing on screen instead of run()'s generic exit line.
		allowFail: true,
	});

	if (res.skipped) {
		note('dry run — no update published, baseline untouched');
		return 0;
	}
	if (res.code !== 0)
		throw new ShipError(`ota publish failed inside the ${environment} environment (exit ${res.code})`, {
			hint: 'the refusal reason is printed above; the baseline in .asc/native-lock.json is unchanged',
		});
	return 0;
}

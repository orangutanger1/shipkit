// Machine + repo health. Every other command assumes these facts hold, so this
// is the one place allowed to be chatty about credentials and tooling.
//
// Two hard-won rules encoded here:
//   · Apple Ads credentials are a *separate* store from App Store Connect ones —
//     a working `asc auth status` says nothing about `asc ads`.
//   · Astro is a macOS desktop app. On this Linux host it can only be reached
//     through an SSH tunnel to the Mac, so "unreachable" is never a failure.
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Report, c } from '../log.mjs';
// Aliased: every command module exports its own `run({args,flags})` entrypoint,
// so importing exec's `run` under that name shadows — or silently resolves to —
// the wrong function.
import { ASC, asc, run as exec, which } from '../exec.mjs';
import { loadConfig, optionalAppId, readExpoConfig } from '../config.mjs';
import { readJSONOrNull } from '../lib/jsonio.mjs';
import { tilde } from '../lib/util.mjs';
import { KEY_FILE, apiKey, listProjects, useKeyForProject } from '../lib/revenuecat.mjs';

export const help = `
${c.bold('ship doctor')} ${c.dim('— check credentials, tooling and MCP wiring')}

${c.dim('usage:')} ship doctor [flags]

Verifies, in order:
  ${c.cyan('node')}        runtime is new enough for this CLI
  ${c.cyan('asc')}         binary on PATH + App Store Connect credentials
  ${c.cyan('asc ads')}     Apple Ads credentials (stored separately from ASC)
  ${c.cyan('eas')}         eas-cli reachable via npx + logged-in account
  ${c.cyan('revenuecat')}  v2 REST key resolves and lists projects
  ${c.cyan('mcp')}         revenuecat / astro / apple-ads servers declared somewhere
  ${c.cyan('repo')}        ship.config.json identity matches ASC and app.json

${c.bold('Flags')}
  ${c.cyan('--deep')}   network-validate every stored asc credential
  ${c.cyan('--json')}   emit the report as JSON
`;

const MIN_NODE = 20;
const ASTRO_MCP = 'http://127.0.0.1:8089/mcp';
const MCP_SERVERS = ['revenuecat', 'astro', 'apple-ads'];
const WIRE_HINT = 'run `ship init` to wire MCP';

/**
 * Which file declares each MCP server, searched in the order a client resolves them.
 * @returns {Promise<Map<string, string>>} server name → declaring file
 */
async function mcpDeclarations(root) {
	const found = new Map();
	const claudeFile = join(homedir(), '.claude.json');
	const sources = [
		[join(root, '.mcp.json'), (j) => j.mcpServers],
		[join(root, '.omp', 'mcp.json'), (j) => j.mcpServers],
		[join(homedir(), '.omp', 'agent', 'mcp.json'), (j) => j.mcpServers],
		[claudeFile, (j) => ({ ...j.mcpServers, ...j.projects?.[root]?.mcpServers })],
	];
	for (const [file, pick] of sources) {
		const json = await readJSONOrNull(file);
		if (!json) continue;
		for (const name of Object.keys(pick(json) ?? {})) {
			if (!found.has(name)) found.set(name, file);
		}
	}
	return found;
}

async function checkNode(report) {
	const version = process.versions.node;
	const major = Number(version.split('.')[0]);
	if (major < MIN_NODE) report.fail('node', `v${version} — shipkit needs node >= ${MIN_NODE}`);
	else report.ok('node', `v${version}`);
}

async function checkAsc(report, { deep }) {
	const bin = await which(ASC);
	if (!bin) {
		report.fail('asc', 'not on PATH — install the App Store Connect CLI');
		report.skip('asc auth', 'skipped: asc missing');
		report.skip('asc ads auth', 'skipped: asc missing');
		return;
	}
	report.ok('asc', tilde(bin));

	const args = deep ? ['auth', 'status', '--validate'] : ['auth', 'status'];
	const status = await asc(args, { fallback: null });
	const creds = status?.credentials ?? [];
	if (!creds.length) {
		report.fail('asc auth', 'no stored App Store Connect credentials — run `asc auth login`');
	} else {
		const active = creds.find((cr) => cr.isDefault) ?? creds[0];
		const others = creds.length > 1 ? `, +${creds.length - 1} more` : '';
		const validated = active.validation ? ` · validation: ${active.validation}` : '';
		const level = active.validation && active.validation !== 'works' ? 'fail' : 'ok';
		report[level](
			'asc auth',
			`${active.name} (key ${active.keyId})${active.isDefault ? ' · default' : ' · NOT default'}${others}${validated}`,
		);
	}
	for (const w of status?.warnings ?? []) report.warn('asc auth', w);

	const ads = await asc(['ads', 'auth', 'status'], { fallback: null });
	const adsCreds = ads?.credentials ?? [];
	if (!adsCreds.length) {
		report.warn(
			'asc ads auth',
			'no Apple Ads credentials (separate from ASC) — asc ads auth login --name "Ads" --client-id SEARCHADS... --team-id SEARCHADS... --key-id KEY_ID --private-key ./private-key.pem --org ORG_ID',
		);
	} else {
		const active = ads.active?.name ?? adsCreds[0].name;
		report.ok('asc ads auth', `${active} (${adsCreds.length} credential${adsCreds.length > 1 ? 's' : ''})`);
	}
}

async function checkEas(report) {
	const version = await exec('npx', ['--yes', 'eas-cli@latest', '--version'], { allowFail: true });
	const line = version.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
	if (version.code !== 0 || !line) {
		report.fail('eas-cli', `npx eas-cli@latest --version exited ${version.code}`);
		report.skip('eas account', 'skipped: eas-cli unreachable');
		return;
	}
	report.ok('eas-cli', line);

	const who = await exec('npx', ['--yes', 'eas-cli@latest', 'whoami'], { allowFail: true });
	const account = who.stdout.trim().split('\n').filter(Boolean)[0] ?? '';
	if (who.code !== 0 || !account || /not logged in/i.test(who.stdout + who.stderr))
		report.warn('eas account', 'logged out — run `npx eas-cli@latest login`');
	else report.ok('eas account', account);
}

async function checkRevenueCat(report, cfg) {
	const key = await apiKey({ optional: true });
	if (!key) {
		report.skip('revenuecat', `no v2 key — set REVENUECAT_V2_KEY or write ${tilde(KEY_FILE)}`);
		return;
	}
	try {
		// Report the account that owns *this* repo's project, not whichever one the
		// ambient key happens to point at. Naming another account's projects here
		// as a green check is how a wrong-credential failure got read as a
		// misconfigured repo.
		let via = '';
		if (cfg?.revenuecat?.projectId) {
			const chosen = await useKeyForProject(cfg);
			if (chosen.switched) via = ` via ${tilde(chosen.source)}`;
		}
		const projects = await listProjects();
		const names = projects.map((p) => p.name).join(', ');
		report.ok(
			'revenuecat',
			`${projects.length} project${projects.length === 1 ? '' : 's'}${names ? `: ${names}` : ''}${via}`,
		);
	} catch (err) {
		report.fail('revenuecat', err.message);
	}
}

async function checkMcp(report, root) {
	const declared = await mcpDeclarations(root);
	for (const name of MCP_SERVERS) {
		const file = declared.get(name);
		if (file) report.ok(`mcp ${name}`, tilde(file));
		else report.skip(`mcp ${name}`, `not declared in any mcp config — ${WIRE_HINT}`);
	}

	// Astro only ever listens on the Mac; probing localhost proves whether a
	// tunnel is up, never whether the app is broken.
	let reachable = false;
	try {
		await fetch(ASTRO_MCP, { method: 'GET', signal: AbortSignal.timeout(1000) });
		reachable = true;
	} catch {
		reachable = false;
	}
	if (reachable) report.ok('astro endpoint', `reachable at ${ASTRO_MCP}`);
	else
		report.skip(
			'astro endpoint',
			`${ASTRO_MCP} unreachable — expected on Linux: Astro is a macOS desktop app, run it on the Mac and forward it with \`ssh -N -L 8089:127.0.0.1:8089 <mac-host>\``,
		);
}

async function checkRepo(report, cfg) {
	report.ok('config', tilde(cfg.file));

	const appId = optionalAppId(cfg);
	let ascBundleId = null;
	if (!appId) {
		report.fail('asc app', 'no asc.appId in ship.config.json — find it with `asc apps list`');
	} else {
		const app = await asc(['apps', 'view', '--id', String(appId)], { fallback: null });
		const attrs = app?.data?.attributes;
		if (!attrs) {
			report.fail('asc app', `id ${appId} did not resolve — check asc.appId against \`asc apps list\``);
		} else {
			ascBundleId = attrs.bundleId ?? null;
			const mismatch = ascBundleId && ascBundleId !== cfg.bundleId;
			report[mismatch ? 'fail' : 'ok'](
				'asc app',
				mismatch
					? `${attrs.name} is ${ascBundleId}, ship.config.json says ${cfg.bundleId}`
					: `${attrs.name} · ${ascBundleId ?? 'no bundle id'} · ${appId}`,
			);
		}
	}

	const expo = await readExpoConfig(cfg);
	const expoBundleId = expo?.ios?.bundleIdentifier;
	if (!expo)
		report.skip('bundle id', `no app.json under ${tilde(cfg.paths.app)} — cannot cross-check ios.bundleIdentifier`);
	else if (!expoBundleId)
		report.skip(
			'bundle id',
			'app.json has no ios.bundleIdentifier — this repo sets it from app.config.ts/js, which only Expo can evaluate',
		);
	else if (expoBundleId !== cfg.bundleId)
		report.fail('bundle id', `app.json says ${expoBundleId}, ship.config.json says ${cfg.bundleId}`);
	else report.ok('bundle id', cfg.bundleId);

	const staged = cfg.paths.staged;
	if (!existsSync(staged)) {
		report.warn('store/staged', `${tilde(staged)} missing — authored listings live here`);
	} else {
		const files = (await readdir(staged)).filter((f) => f.endsWith('.json'));
		report[files.length ? 'ok' : 'warn'](
			'store/staged',
			files.length ? `${files.length} locale file${files.length === 1 ? '' : 's'}` : `${tilde(staged)} is empty`,
		);
	}

	const aso = cfg.paths.aso;
	if (!existsSync(aso)) report.warn('aso dir', `${tilde(aso)} missing — run \`ship aso harvest\` to create it`);
	else report.ok('aso dir', tilde(aso));
}

async function doctor({ flags }) {
	const report = new Report('ship doctor');
	const cfg = await loadConfig(process.cwd(), { optional: true });

	await checkNode(report);
	await checkAsc(report, { deep: !!flags.deep });
	await checkEas(report);
	await checkRevenueCat(report, cfg);
	await checkMcp(report, cfg?.root ?? process.cwd());

	if (!cfg) report.skip('repo', `no ship.config.json from ${tilde(process.cwd())} — run \`ship init\` in an app repo`);
	else await checkRepo(report, cfg);

	return report.print({ json: !!flags.json });
}

export { doctor as run };

// ship init — adopt an app repo that already exists.
//
// Every value this command writes is one someone previously kept in their head
// and got wrong at 2am: the ASC app id that lives in eas.json and nowhere else,
// the entitlement string the paywall reads, the locale set that has to match
// what is already on App Store Connect. Detection is best-effort and always
// printed with its source (see lib/init-detect.mjs), because a silently guessed
// bundle id ships a build to the wrong app record.
//
// Re-running is the normal case, not the exception: repos grow a staged
// listing, an ASC record, a RevenueCat entitlement weeks apart. So the merge
// rule is "fill holes, never overwrite" — a human-set value outranks anything
// we can infer, and only --force disagrees.
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { CONFIG_NAME, normalise, saveConfig } from '../config.mjs';
import { isDryRun } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, warn } from '../log.mjs';
import { readJSONOrNull } from '../lib/jsonio.mjs';
import {
	ascAppIdFor,
	ascAppRecord,
	detectLegal,
	findAppDir,
	findDynamicConfig,
	literalFromConfig,
	listDir,
	localesIn,
	scanSources,
	sourceFiles,
} from '../lib/init-detect.mjs';
import {
	ensureDirectories,
	mergeFill,
	preview,
	shown,
	shipkitServers,
	updateGitignore,
	writeMcpServers,
	writeNpmScripts,
} from '../lib/init-write.mjs';

/** @typedef {import('../lib/util.mjs').Flags} Flags */
/** @typedef {import('../lib/util.mjs').Json} Json */
/** @typedef {import('../lib/util.mjs').JsonObject} JsonObject */
/** @typedef {import('../lib/init-detect.mjs').ScanHit} ScanHit */
/** @typedef {import('../lib/init-write.mjs').ConfigChange} ConfigChange */
/** @typedef {{file: string, name: string, text: string}} DynamicConfig */
/** @typedef {{expo: any, dynamic: DynamicConfig|null, dynBundle: string|null, bundleId: string, easJsonFile: string, easJson: any, ascAppId: string|null, ascSource: string, ascApp: JsonObject|null}} Identity */

export const help = `
${c.bold('ship init')} ${c.dim('— adopt an existing app repo')}

${c.dim('usage:')} ship init [--dir <repo>] [flags]

Detects the app's identity from app.json / app.config.* / eas.json / App Store
Connect, then writes ${c.cyan(CONFIG_NAME)}, MCP config, npm scripts and the
directories the rest of ${c.bold('ship')} expects. Safe to re-run: existing values are
kept, only holes are filled.

${c.bold('Flags')}
  ${c.cyan('--dir <path>')}  repo root to adopt ${c.dim('(default: cwd)')}
  ${c.cyan('--force')}       overwrite human-set config values and npm scripts
  ${c.cyan('--no-mcp')}      skip .omp/mcp.json and .mcp.json
  ${c.cyan('--dry-run')}     print every intended write, change nothing

${c.dim('Detected: name · version · bundleId · appDir · eas.projectId/owner/channel')}
${c.dim('          asc.appId · store.locales · legal urls · revenuecat.entitlement/keyEnv')}
`;

// ---------------------------------------------------------------- detection

/**
 * @param {string} root
 * @param {string} appPath
 * @returns {Promise<Identity>}
 */
async function detectIdentity(root, appPath) {
	/** @type {any} */
	const appJson = (await readJSONOrNull(join(appPath, 'app.json'))) ?? {};
	/** @type {any} */
	const expo = appJson.expo ?? appJson;
	const dynamic = await findDynamicConfig(appPath);

	// The dynamic config is evaluated last by Expo, so its literal wins when it
	// sets one unambiguously; literalFromConfig returns null for variant configs.
	const dynBundle = dynamic ? literalFromConfig(dynamic.text, 'bundleIdentifier') : null;
	const bundleId = dynBundle ?? expo.ios?.bundleIdentifier ?? null;
	if (!bundleId)
		throw new ShipError('cannot determine the iOS bundle identifier', {
			hint: `set expo.ios.bundleIdentifier in ${relative(root, join(appPath, 'app.json'))}`,
		});

	const easJsonFile = existsSync(join(appPath, 'eas.json')) ? join(appPath, 'eas.json') : join(root, 'eas.json');
	/** @type {any} */
	const easJson = (await readJSONOrNull(easJsonFile)) ?? {};
	const easAscId = easJson.submit?.production?.ios?.ascAppId ?? null;
	let ascAppId = easAscId ? String(easAscId) : null;
	let ascSource = ascAppId ? `${relative(root, easJsonFile)} submit.production.ios` : '';
	if (!ascAppId) {
		ascAppId = await ascAppIdFor(bundleId);
		ascSource = ascAppId ? 'asc apps list (matched bundleId)' : '';
	}
	const ascApp = await ascAppRecord(ascAppId);

	return { expo, dynamic, dynBundle, bundleId, easJsonFile, easJson, ascAppId, ascSource, ascApp };
}

/**
 * @param {string} label
 * @param {Json} value
 * @param {string} [source]
 */
function detection(label, value, source) {
	const val = value === null || value === undefined || value === '' ? c.dim('not found') : c.bold(String(value));
	process.stdout.write(`  ${c.cyan(label.padEnd(22))} ${val}${source ? ` ${c.dim(source)}` : ''}\n`);
}

/**
 * @param {{root: string, appDir: string, identity: Identity, easProjectId: string|null, easOwner: string|null, easChannel: string|null}} ctx
 */
function printDetections({ root, appDir, identity, easProjectId, easOwner, easChannel }) {
	const { expo, dynamic, dynBundle, bundleId, easJsonFile, ascAppId, ascSource, ascApp } = identity;

	step('detected');
	detection('appDir', appDir, appDir === '.' ? '(repo root)' : `${appDir}/app.json`);

	const name = ascApp?.name ?? expo.name ?? null;
	detection('name', name, ascApp?.name ? 'App Store Connect' : 'app.json expo.name');
	detection('version', expo.version ?? null, 'app.json expo.version');
	detection('bundleId', bundleId, dynBundle ? `${/** @type {{name: string}} */ (dynamic).name} (overrides app.json)` : 'app.json expo.ios');
	detection('eas.projectId', easProjectId, 'app.json expo.extra.eas');
	detection('eas.owner', easOwner, expo.owner ? 'app.json expo.owner' : '');
	detection('eas.channel', easChannel, easChannel ? `${relative(root, easJsonFile)} build.production` : '');
	detection('asc.appId', ascAppId, ascSource);
}

/**
 * @param {string} storeDir
 * @param {string} primaryLocale
 */
async function detectLocales(storeDir, primaryLocale) {
	let locales = await localesIn(join(storeDir, 'staged'));
	let localeSource = 'store/staged/*.json';
	if (!locales.length) {
		locales = await localesIn(join(storeDir, 'app-info'));
		localeSource = 'store/app-info/*.json';
	}
	if (!locales.length) {
		locales = [primaryLocale];
		localeSource = 'default (primary locale)';
	}
	return { locales, localeSource };
}

/**
 * @param {{appDir: string, identity: Identity, easProjectId: string|null, easOwner: string|null, easChannel: string|null, locales: string[], legal: Record<'privacyUrl'|'supportUrl'|'marketingUrl', string|null>, revenuecat: JsonObject}} ctx
 * @returns {JsonObject}
 */
function detectedConfig({ appDir, identity, easProjectId, easOwner, easChannel, locales, legal, revenuecat }) {
	const { bundleId, ascAppId, ascApp, expo } = identity;
	return {
		name: ascApp?.name ?? expo.name ?? null,
		bundleId,
		version: expo.version ?? null,
		appDir,
		asc: { appId: ascAppId, profile: null, primaryLocale: ascApp?.primaryLocale ?? 'en-US', platform: 'IOS' },
		eas: {
			projectId: easProjectId,
			owner: easOwner,
			profile: 'production',
			platform: 'ios',
			channel: easChannel ?? 'production',
		},
		store: { dir: 'store', locales },
		revenuecat,
		ads: { orgId: null, dir: 'aso/asa', targetCpi: null, subPrice: null },
		aso: { dir: 'aso', seeds: [], seedsByLocale: {}, minVolume: 0 },
		loc: { sourceLocale: null, glossary: 'store/glossary.json' },
		analytics: { dir: '.asc/analytics' },
		price: { dir: 'store/pricing', basePriceUsd: null },
		legal,
	};
}


/**
 * @param {JsonObject} merged
 * @param {{bundleId: string, primaryLocale: string, stagedCount: number, appInfoCount: number, versionCount: number}} ctx
 */
function printNextSteps(merged, ctx) {
	const { bundleId, primaryLocale, stagedCount, appInfoCount, versionCount } = ctx;
	/** @type {any} */
	const m = merged;
	/** @type {string[]} */
	const steps = [];
	if (!m.asc?.appId)
		steps.push(
			`No App Store Connect app record for ${c.bold(bundleId)}.\n` +
				`  Create one at https://appstoreconnect.apple.com/apps (+ → New App), then re-run ${c.cyan('ship init')}\n` +
				`  or set ${c.cyan('asc.appId')} in ${CONFIG_NAME}. Verify with ${c.cyan(`asc apps list --bundle-id ${bundleId}`)}.`,
		);
	if (!stagedCount)
		steps.push(
			appInfoCount || versionCount
				? `Store listings exist but are not staged — ${c.cyan('ship meta migrate')} converts the canonical tree into ${c.cyan('store/staged/*.json')}.`
				: `No store listings yet — ${c.cyan('ship meta pull')} downloads what App Store Connect already has, or write ${c.cyan(`store/staged/${primaryLocale}.json`)} by hand and run ${c.cyan('ship meta lint')}.`,
		);
	if (!m.revenuecat?.projectId)
		steps.push(`RevenueCat project not linked — ${c.cyan('ship rc projects')} lists the ids, then set ${c.cyan('revenuecat.projectId')}.`);
	if (!m.ads?.orgId)
		steps.push(`No Apple Search Ads org — ${c.cyan('ship ads status')} shows whether credentials are stored and how to add them.`);
	if (!m.legal?.privacyUrl)
		steps.push(`No privacy policy URL — App Store review rejects without one. Set ${c.cyan('legal.privacyUrl')} in ${CONFIG_NAME}.`);
	steps.push(`Confirm the machine is wired up: ${c.cyan('ship doctor')}, then ${c.cyan('ship status')} for the release dashboard.`);

	heading('next');
	steps.forEach((s, i) => process.stdout.write(`  ${c.bold(`${i + 1}.`)} ${s}\n`));
	if (isDryRun()) process.stdout.write(`\n${c.dim('dry run — re-run without --dry-run to apply.')}\n`);
}

// -------------------------------------------------------------------- entry

/**
 * @param {{root: string, detected: JsonObject, force: boolean}} ctx
 * @returns {Promise<JsonObject>}
 */
async function writeConfigStep({ root, detected, force }) {
	step(CONFIG_NAME);
	const configFile = join(root, CONFIG_NAME);
	const existing = existsSync(configFile) ? await readJSONOrNull(configFile) : null;
	if (existsSync(configFile) && existing === null)
		throw new ShipError(`${configFile} exists but is not valid JSON`, {
			hint: 'fix or delete it, then re-run `ship init`',
		});

	let merged = detected;
	if (existing && !force) {
		/** @type {ConfigChange[]} */
		const changes = [];
		merged = mergeFill(/** @type {JsonObject} */ (existing), detected, changes);
		if (changes.length) {
			info(`filling ${changes.length} empty field${changes.length === 1 ? '' : 's'}; every other value kept as-is`);
			for (const ch of changes) note(`${ch.path}: ${shown(ch.from)} ${c.dim('→')} ${c.green(shown(ch.to))}`);
		} else {
			good(`${CONFIG_NAME} already complete — nothing to fill`);
		}
	} else if (existing && force) {
		warn(`--force: replacing ${CONFIG_NAME} with detected values`);
	}

	// normalise() is the same gate loadConfig() uses; failing here beats failing
	// inside the next command with a half-written config on disk.
	normalise(structuredClone(merged), configFile);
	const configText = `${JSON.stringify(merged, null, '\t')}\n`;
	const wroteConfig = !existing || force || configText !== `${JSON.stringify(existing, null, '\t')}\n`;
	if (!wroteConfig) note('unchanged');
	else if (isDryRun()) {
		note(`${c.yellow('would write')} ${CONFIG_NAME}`);
		preview(configText);
	} else {
		await saveConfig(/** @type {any} */ (merged), configFile);
		good(`wrote ${CONFIG_NAME}`);
	}
	return merged;
}

/**
 * A source scan hit: value, or "ambiguous", or nothing — each with its own label.
 * @param {ScanHit} hit
 */
function detectionSource({ value, ambiguous, all }) {
	if (ambiguous) return `ambiguous: ${/** @type {string[]} */ (all).join(', ')} — left unset`;
	return value ? 'app sources' : '';
}

/**
 * @param {{root: string, appDir: string, appPath: string, storeDir: string, identity: Identity}} ctx
 */
async function detectStep({ root, appDir, appPath, storeDir, identity }) {
	const easProjectId = identity.expo.extra?.eas?.projectId ?? null;
	const easOwner = identity.expo.owner ?? null;
	const easChannel = identity.easJson.build?.production?.channel ?? null;
	printDetections({ root, appDir, identity, easProjectId, easOwner, easChannel });

	const primaryLocale = identity.ascApp?.primaryLocale ?? 'en-US';
	if (identity.ascApp?.primaryLocale) detection('asc.primaryLocale', primaryLocale, 'App Store Connect');

	const { locales, localeSource } = await detectLocales(storeDir, primaryLocale);
	detection(
		'store.locales',
		`${locales.length} · ${locales.slice(0, 6).join(', ')}${locales.length > 6 ? ', …' : ''}`,
		localeSource,
	);

	const scanned = await sourceFiles(appPath);
	const { entitlement, keyEnv } = await scanSources(scanned);
	detection('rc.entitlement', entitlement.value, detectionSource(entitlement));
	detection('rc.keyEnv', keyEnv.value, detectionSource(keyEnv));

	const { legal, from: legalFrom } = await detectLegal(root, storeDir, primaryLocale);
	detection('legal.privacyUrl', legal.privacyUrl, legalFrom.privacyUrl ?? '');
	detection('legal.supportUrl', legal.supportUrl, legalFrom.supportUrl ?? '');
	detection('legal.marketingUrl', legal.marketingUrl, legalFrom.marketingUrl ?? '');

	return {
		primaryLocale,
		locales,
		legal,
		easProjectId,
		easOwner,
		easChannel,
		entitlement,
		keyEnv,
	};
}

/** @param {{args: string[], flags: Flags}} ctx */
export async function run({ args, flags }) {
	const root = resolve(String(flags.dir ?? args[0] ?? process.cwd()));
	if (!existsSync(root)) throw new ShipError(`no such directory: ${root}`);
	const force = Boolean(flags.force);

	heading(`ship init ${c.dim(root)}`);
	if (isDryRun()) info(c.yellow('dry run — nothing will be written'));

	// ---- 1. locate the app -------------------------------------------------
	const appDir = await findAppDir(root);
	const appPath = join(root, appDir);
	const identity = await detectIdentity(root, appPath);

	// ---- 2. detect ---------------------------------------------------------
	const storeDir = join(root, 'store');
	const d = await detectStep({ root, appDir, appPath, storeDir, identity });

	const detected = detectedConfig({
		appDir,
		identity,
		easProjectId: d.easProjectId,
		easOwner: d.easOwner,
		easChannel: d.easChannel,
		locales: d.locales,
		legal: d.legal,
		revenuecat: {
			projectId: null,
			appId: null,
			entitlement: d.entitlement.value,
			keyEnv: d.keyEnv.value,
		},
	});

	// ---- 3. ship.config.json ----------------------------------------------
	const merged = await writeConfigStep({ root, detected, force });

	// ---- 4. MCP ------------------------------------------------------------
	step('mcp');
	if (flags['no-mcp']) {
		note('skipped (--no-mcp)');
	} else {
		const { servers, schema } = await shipkitServers();
		await writeMcpServers(root, servers, schema);
	}

	// ---- 5. npm scripts ----------------------------------------------------
	step('npm scripts');
	await writeNpmScripts(appPath, root, force);

	// ---- 6. directories ----------------------------------------------------
	step('directories');
	await ensureDirectories(root, storeDir);

	const stagedCount = (await localesIn(join(storeDir, 'staged'))).length;
	const appInfoCount = (await localesIn(join(storeDir, 'app-info'))).length;
	const versionCount = (await listDir(join(storeDir, 'version'))).length;
	// Canonical trees without a staged tree means listings exist but are not
	// authorable — `ship meta` reads staged/, so this repo is half-adopted.
	if (!stagedCount && (appInfoCount || versionCount))
		warn('store/app-info or store/version has content but store/staged is empty — run `ship meta pull` to author them');

	// ---- 7. .gitignore -----------------------------------------------------
	step('.gitignore');
	await updateGitignore(root);

	// ---- 8. next steps -----------------------------------------------------
	printNextSteps(merged, { bundleId: identity.bundleId, primaryLocale: d.primaryLocale, stagedCount, appInfoCount, versionCount });
	return 0;
}

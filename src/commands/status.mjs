// ship status — the one pane that replaces four browser tabs.
//
// `asc status` already aggregates app + builds + TestFlight + App Store version +
// submission + review + phased release into a single call, so this command does
// not hand-assemble any of that. It spends its budget on the three things App
// Store Connect cannot see: RevenueCat wiring, staged-listing depth, and OTA
// safety — the places where a release is broken but every console looks green.
//
// Every section is independently fault-isolated. A dashboard that dies whole
// because one endpoint 403s is worse than no dashboard: you stop trusting it and
// go back to opening tabs. A dead section prints a dim line and the rest render.
import { loadConfig, readExpoConfig, optionalAppId, resolveVersion } from '../config.mjs';
import { asc } from '../exec.mjs';
import { ShipError, c, note, heading } from '../log.mjs';
import { memo, strOf } from '../lib/util.mjs';
import {
	collectApp,
	collectBuilds,
	collectReview,
	collectTestFlight,
	renderApp,
	renderBuilds,
	renderReview,
	renderTestFlight,
} from '../lib/status-asc.mjs';
import {
	collectAds,
	collectListing,
	collectOta,
	collectRevenue,
	renderAds,
	renderListing,
	renderOta,
	renderRevenue,
} from '../lib/status-biz.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../exec.mjs').AscDash} AscDash */
/** @typedef {import('../lib/status-asc.mjs').StatusCtx} StatusCtx */
/** @typedef {import('../lib/util.mjs').Flags} Flags */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */
/**
 * A dashboard section: what to call it, how to gather it, how to print it. The
 * collector's return is the renderer's argument, which is why each pair is
 * declared together rather than as two loose functions.
 * @typedef {{name: string, title: string, collect: (ctx: StatusCtx) => Promise<any>, render: (data: any) => void}} Section
 */
/** @typedef {{section: Section, data?: any, error?: string}} SectionResult */

export const help = `
${c.bold('ship status')} ${c.dim('— release dashboard: ASC, TestFlight, RevenueCat, ads, listing, OTA')}

${c.dim('usage:')} ship status [flags]

${c.bold('Sections')}
  ${c.cyan('app')}         identity: name, bundle id, ASC app id, version, EAS project
  ${c.cyan('review')}      newest 3 App Store versions and their review states
  ${c.cyan('builds')}      newest 5 builds: processing state, upload and expiry
  ${c.cyan('testflight')}  beta groups and tester counts
  ${c.cyan('revenue')}     RevenueCat project, current offering, entitlement, catalogue
  ${c.cyan('ads')}         Apple Ads last-7-day spend, installs, derived CPI
  ${c.cyan('listing')}     staged locales and keyword-field utilisation
  ${c.cyan('ota')}         whether the next update can ship over the air

${c.bold('Flags')}
  ${c.cyan('--section <name>')}  render one section instead of all
  ${c.cyan('--json')}            one object containing every section

${c.dim('Read-only. Exit code is always 0 — gates live in `ship doctor` and `ship preflight`.')}
`;

const SECTIONS = [
	{ name: 'app', title: 'App', collect: collectApp, render: renderApp },
	{ name: 'review', title: 'Review', collect: collectReview, render: renderReview },
	{ name: 'builds', title: 'Builds', collect: collectBuilds, render: renderBuilds },
	{ name: 'testflight', title: 'TestFlight', collect: collectTestFlight, render: renderTestFlight },
	{ name: 'revenue', title: 'Revenue', collect: collectRevenue, render: renderRevenue },
	{ name: 'ads', title: 'Ads', collect: collectAds, render: renderAds },
	{ name: 'listing', title: 'Listing', collect: collectListing, render: renderListing },
	{ name: 'ota', title: 'OTA', collect: collectOta, render: renderOta },
];

/** Memoised, shared reads: sibling sections must not repeat network calls. */
/** @param {Config} cfg @param {Flags} flags @returns {Promise<StatusCtx>} */
async function buildContext(cfg, flags) {
	const appId = optionalAppId(cfg);
	/** @type {() => Promise<AscDash|null>} */
	const dash = memo(async () =>
		appId
			? /** @type {AscDash|null} */ (
					await asc(
						[
							'status',
							'--app', appId,
							'--platform', 'IOS',
							'--include', 'app,builds,testflight,appstore,submission,review,phased-release,links',
						],
						{ fallback: null },
					)
				)
			: null,
	);
	return {
		cfg,
		appId,
		dash,
		expo: memo(() => readExpoConfig(cfg).catch(() => null)),
		version: memo(async () => {
			const explicit = await resolveVersion(cfg, strOf(flags.version)).catch(() => null);
			if (explicit) return explicit;
			const d = await dash();
			return d?.appstore?.version ?? d?.builds?.latest?.version ?? null;
		}),
	};
}

/** @param {Flags} flags @returns {Section[]} */
function parseSection(flags) {
	if (flags.section === undefined) return SECTIONS;
	const want = String(flags.section).toLowerCase();
	const section = SECTIONS.find((s) => s.name === want);
	if (!section)
		throw new ShipError(`status: unknown section "${flags.section}"`, {
			hint: `sections: ${SECTIONS.map((s) => s.name).join(', ')}`,
		});
	return [section];
}

/** @param {StatusCtx} ctx @param {Section[]} chosen @returns {Promise<SectionResult[]>} */
async function collectSections(ctx, chosen) {
	return Promise.all(
		chosen.map(async (section) => {
			try {
				return { section, data: await section.collect(ctx) };
			} catch (err) {
				return { section, error: err instanceof Error ? err.message : String(err) };
			}
		}),
	);
}

/** @param {SectionResult[]} results @returns {void} */
function renderJson(results) {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const { section, data, error } of results) out[section.name] = error ? { error } : data;
	process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

/** @param {SectionResult[]} results @returns {void} */
function renderSections(results) {
	for (const { section, data, error } of results) {
		heading(section.title);
		if (error) {
			note(c.dim(`unavailable — ${error}`));
			continue;
		}
		try {
			section.render(data);
		} catch (err) {
			note(c.dim(`could not render — ${err instanceof Error ? err.message : String(err)}`));
		}
	}
}

/** @param {SubCtx} ctx @returns {Promise<number>} */
export async function run({ args, flags }) {
	if (args.length)
		throw new ShipError(`status: unexpected argument "${args[0]}"`, {
			hint: `status has no subcommands — use --section <${SECTIONS.map((s) => s.name).join('|')}>`,
		});

	const chosen = parseSection(flags);
	const cfg = await loadConfig();
	const ctx = await buildContext(cfg, flags);
	const results = await collectSections(ctx, chosen);

	if (flags.json) renderJson(results);
	else renderSections(results);

	// Always 0: this is a read-only pane, not a gate. `ship doctor` and
	// `ship preflight` own the exit codes that CI keys off.
	return 0;
}

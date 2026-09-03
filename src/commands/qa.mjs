// ship qa — the Tier 1 quality loop, and the artifact `ship preflight` gates on.
//
// The capture half is the only part that touches a browser, so it is a single
// injectable function: every rule in lib/qa-checks.mjs and lib/qa-run.mjs is
// handed observations it did not fetch, which is what keeps `npm test` offline
// and the rules at full coverage.
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, resolveVersion } from '../config.mjs';
import { ShipError, c, good, heading, note, step, table, warn } from '../log.mjs';
import { readJSONIfExists, readJSONStrict, writeJSON } from '../lib/jsonio.mjs';
import { appDep } from '../lib/appdeps.mjs';
import { assertArtifact } from '../lib/schemas.mjs';
import { cellId, cellUrl, planMatrix, textScale } from '../lib/qa-matrix.mjs';
import { probe } from '../lib/qa-probe.mjs';
import { checkObservation } from '../lib/qa-checks.mjs';
import { buildReport, checkDarkMode, checkRegression, checkStates, mergeTier2, tier2Rows } from '../lib/qa-run.mjs';
import { resolveSubcommand, strOf } from '../lib/util.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */
/** @typedef {import('../lib/qa-matrix.mjs').Cell} Cell */

export const help = `
${c.bold('ship qa')} ${c.dim('— the quality gate that runs without a simulator')}

  ${c.cyan('run')}       capture every screen and write qa/<version>/report.json
  ${c.cyan('check')}     gate the report already on disk, capturing nothing
  ${c.cyan('baseline')}  accept the current captures as the visual baseline

${c.bold('Flags')}
  ${c.cyan('--url <u>')}      web build to drive (default: design.qa.url)
  ${c.cyan('--version <v>')}  override the version under test
  ${c.cyan('--tier2 <f>')}    fold a macOS-lane report in before gating
  ${c.cyan('--json')}         print the report instead of a table

${c.dim('Tier 1 is headless RN-Web: layout, contrast, tap targets, safe area,')}
${c.dim('Dynamic Type and dark mode. Motion, native semantics and VoiceOver need')}
${c.dim('the macOS lane and are reported SKIPPED here — never PASS.')}
`;

const VIEWPORT = { width: 428, height: 926, deviceScaleFactor: 3 };

/** @type {(cfg: Config, version: string) => string} */
const reportPath = (cfg, version) => join(cfg.paths.qa, version, 'report.json');
/** @type {(cfg: Config) => string} */
const baselinePath = (cfg) => join(cfg.paths.qa, 'baseline.json');

/**
 * Drive the web build once per cell: measure in-page, then screenshot. The
 * screenshot is evidence for a human; the measurement is what the gate reads.
 * @type {(cfg: Config, base: string, cells: Cell[], dir: string) => Promise<import('../lib/qa-run.mjs').Capture[]>}
 */
async function captureCells(cfg, base, cells, dir) {
	const puppeteer = await appDep(cfg, 'puppeteer');
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
	/** @type {import('../lib/qa-run.mjs').Capture[]} */
	const out = [];
	try {
		for (const cell of cells) {
			const page = await browser.newPage();
			// The text scale is applied to the root font size as well as passed
			// through, so a build that only honours rem still grows its type.
			await page.setViewport(VIEWPORT);
			await page.setExtraHTTPHeaders({ 'Accept-Language': cell.locale });
			await page.goto(cellUrl(base, cell), { waitUntil: 'networkidle0' });
			await page.evaluate((/** @type {number} */ scale) => {
				/** @type {any} */ (globalThis).document.documentElement.style.fontSize = `${16 * scale}px`;
			}, textScale(cell.dynamicType));
			const obs = await page.evaluate(probe);
			const file = join(dir, `${cellId(cell)}.png`);
			const png = await page.screenshot({ path: file, type: 'png' });
			out.push({ cell, obs, file, sha256: createHash('sha256').update(png).digest('hex') });
			step(`${cellId(cell)}`);
			await page.close();
		}
	} finally {
		await browser.close();
	}
	return out;
}

/**
 * The spec `ship qa` drives. Refused by name while it is a draft, because
 * "ux.json is still a draft" beats a schema complaining about a missing route.
 * @type {(cfg: Config) => Promise<any>}
 */
async function loadSpec(cfg) {
	const file = join(cfg.paths.design, 'ux.json');
	const spec = /** @type {any} */ (await readJSONStrict(file));
	if (Array.isArray(spec?._todo) && spec._todo.length)
		throw new ShipError(`qa: ${file} is still a draft`, { hint: `fill ${spec._todo.join(', ')}, then drop _todo` });
	await assertArtifact('ux-spec', spec, 'ux.json');
	return spec;
}

/** @type {(cfg: Config, flags: any) => string} */
function resolveUrl(cfg, flags) {
	const url = strOf(flags.url) ?? cfg.design.qa.url;
	if (!url)
		throw new ShipError('qa: no web build to drive', {
			hint: 'start it (`npx expo start --web`) and set design.qa.url in ship.config.json, or pass --url',
		});
	return url;
}

/**
 * Print the report and turn it into an exit code. Only the rows that are not
 * PASS are tabulated — a clean run of two hundred checks is one green line.
 * @type {(report: any, flags: any) => number}
 */
function present(report, flags) {
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(report, null, '\t')}\n`);
		return report.summary.fail ? 1 : 0;
	}
	const open = report.checks.filter((/** @type {any} */ ch) => ch.status !== 'PASS' && ch.status !== 'SKIPPED');
	if (open.length)
		table(open.slice(0, 40), [
			{ header: 'check', get: (r) => r.id },
			{ header: '', get: (r) => (r.status === 'FAIL' ? c.red(r.status) : c.yellow(r.status)) },
			{ header: 'measured', get: (r) => (r.measured === undefined ? '' : `${r.measured}${r.threshold === undefined ? '' : ` / ${r.threshold}`}`) },
			{ header: 'problem', get: (r) => r.message ?? '' },
		]);
	if (open.length > 40) note(`… and ${open.length - 40} more`);
	const s = report.summary;
	step(`tier ${report.tier} · ${s.pass} pass · ${s.warn} warn · ${s.fail} fail · ${s.skipped} skipped`);
	if (s.skipped) note(`${s.skipped} check(s) need the macOS lane — see ci/qa.yml`);
	if (!s.fail) {
		good('every Tier 1 rule this version can prove, passes');
		return 0;
	}
	warn(`${s.fail} failing check(s)`);
	return 1;
}

/** @type {(ctx: SubCtx & {capture?: Function}) => Promise<number>} */
async function runQa({ flags, capture = captureCells }) {
	const cfg = await loadConfig();
	const version = await resolveVersion(cfg, strOf(flags.version));
	const spec = await loadSpec(cfg);
	const system = await readJSONIfExists(cfg.paths.designSystem);
	const base = resolveUrl(cfg, flags);
	// `design.qa` also holds the url, which is where the run happened, not part of
	// the matrix it covered.
	const { themes, locales, dynamicType } = cfg.design.qa;
	const matrix = { themes, locales, dynamicType };
	const cells = planMatrix(spec, matrix);

	heading(`qa ${c.dim(`${cfg.name} ${version} · ${cells.length} captures`)}`);
	const dir = join(cfg.paths.qa, version, 'captures');
	await mkdir(dir, { recursive: true });
	const caps = await capture(cfg, base, cells, dir);

	const baseline = await readJSONIfExists(baselinePath(cfg));
	const checks = [
		...caps.flatMap((/** @type {any} */ cap) => checkObservation(cap.obs, cap.cell, { system, evidence: cap.file })),
		...checkStates(caps, spec),
		...checkDarkMode(caps),
		...checkRegression(caps, /** @type {any} */ (baseline)),
		...tier2Rows(spec),
	];
	const tier2 = strOf(flags.tier2) ? await readJSONStrict(String(flags.tier2)) : null;
	const merged = tier2 ? mergeTier2(checks, tier2) : checks;
	const report = buildReport({ version, checks: merged, matrix, tier: tier2 ? 2 : 1 });
	await assertArtifact('qa-report', report, 'report.json');
	await writeJSON(reportPath(cfg, version), report);
	await writeJSON(join(cfg.paths.qa, version, 'observations.json'), caps.map((/** @type {any} */ cap) => ({ cell: cap.cell, sha256: cap.sha256, ...cap.obs })));
	return present(report, flags);
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function check({ flags }) {
	const cfg = await loadConfig();
	const version = await resolveVersion(cfg, strOf(flags.version));
	const file = reportPath(cfg, version);
	const report = await readJSONIfExists(file);
	if (!report)
		throw new ShipError(`qa: no report for ${version}`, { hint: `run \`ship qa\` to write ${file}` });
	await assertArtifact('qa-report', report, file);
	heading(`qa check ${c.dim(`${cfg.name} ${version}`)}`);
	return present(report, flags);
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function baseline({ flags }) {
	const cfg = await loadConfig();
	const version = await resolveVersion(cfg, strOf(flags.version));
	const obs = await readJSONIfExists(join(cfg.paths.qa, version, 'observations.json'));
	if (!Array.isArray(obs) || !obs.length)
		throw new ShipError(`qa: nothing captured for ${version}`, { hint: 'run `ship qa` first' });
	const map = Object.fromEntries(obs.map((/** @type {any} */ o) => [cellId(o.cell), o.sha256]));
	const out = await writeJSON(baselinePath(cfg), map);
	heading('qa baseline');
	good(`${Object.keys(map).length} captures accepted as the baseline in ${out}`);
	return 0;
}

const SUB = { run: runQa, check, baseline };

/** @type {(ctx: SubCtx & {capture?: Function}) => Promise<number>} */
export async function run({ args, flags, capture }) {
	const { fn, args: rest } = resolveSubcommand({ command: 'qa', args, subs: SUB, fallback: 'run' });
	return fn({ args: rest, flags, capture });
}

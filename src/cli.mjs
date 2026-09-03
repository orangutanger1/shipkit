// ship — one CLI for the whole iOS app lifecycle.
import { ShipError, c, heading } from './log.mjs';
import { setDryRun, setVerbose } from './exec.mjs';

/** @typedef {import('./lib/util.mjs').Flags} Flags */
/** @typedef {import('./lib/util.mjs').JsonObject} JsonObject */

/**
 * Command registry. Each entry lazily imports its module so startup stays fast
 * and a broken command can never take down `ship --help`.
 * @type {Record<string, {summary:string, load:() => Promise<{run:Function, help?:string}>, group:string}>}
 */
export const COMMANDS = {
	doctor: {
		group: 'Setup',
		summary: 'Check credentials, tooling and MCP wiring for this machine + repo',
		load: () => import('./commands/doctor.mjs'),
	},
	init: {
		group: 'Setup',
		summary: 'Adopt an existing app repo: write ship.config.json, MCP config and scripts',
		load: () => import('./commands/init.mjs'),
	},
	new: {
		group: 'Setup',
		summary: 'Scaffold a new Expo iOS app already wired to the full pipeline',
		load: () => import('./commands/new.mjs'),
	},
	scout: {
		group: 'Discover',
		summary: 'Idea front door before a repo exists: terms · brief · new',
		load: () => import('./commands/scout.mjs'),
	},
	research: {
		group: 'Discover',
		summary: 'Competitor evidence from the public storefront: plan · fetch · capture · verify · index',
		load: () => import('./commands/research.mjs'),
	},
	aso: {
		group: 'Discover',
		summary: 'Keyword research: harvest · volume · score · suggest · apply · competitors · audit',
		load: () => import('./commands/aso.mjs'),
	},
	design: {
		group: 'Build',
		summary: 'Token and screen contracts: system · spec · review',
		load: () => import('./commands/design.mjs'),
	},
	qa: {
		group: 'Build',
		summary: 'Simulator-free quality gate over the built screens: run · check · baseline',
		load: () => import('./commands/qa.mjs'),
	},
	meta: {
		group: 'Ship',
		summary: 'Store listings: lint · stage · pull · apply · migrate · keywords · cpp',
		load: () => import('./commands/meta.mjs'),
	},
	loc: {
		group: 'Ship',
		summary: 'Localization: seed · draft · review · lock · status',
		load: () => import('./commands/loc.mjs'),
	},
	shots: {
		group: 'Ship',
		summary: 'Screenshots: sizes · plan · validate · upload',
		load: () => import('./commands/shots.mjs'),
	},
	preflight: {
		group: 'Ship',
		summary: 'Full pre-submission readiness gate (offline + live checks)',
		load: () => import('./commands/preflight.mjs'),
	},
	build: {
		group: 'Ship',
		summary: 'EAS production build for iOS',
		load: () => import('./commands/build.mjs'),
	},
	submit: {
		group: 'Ship',
		summary: 'Upload the latest build and submit for App Store review',
		load: () => import('./commands/submit.mjs'),
	},
	ota: {
		group: 'Ship',
		summary: 'Decide OTA-vs-native from native dep drift, then eas update',
		load: () => import('./commands/ota.mjs'),
	},
	release: {
		group: 'Ship',
		summary: 'Gated end-to-end release: preflight → meta → build → submit',
		load: () => import('./commands/release.mjs'),
	},
	rc: {
		group: 'Grow',
		summary: 'RevenueCat: status · offerings · products · audit',
		load: () => import('./commands/rc.mjs'),
	},
	ads: {
		group: 'Grow',
		summary: 'Apple Search Ads: status · plan · snapshot · sync · mine · report',
		load: () => import('./commands/ads.mjs'),
	},
	status: {
		group: 'Grow',
		summary: 'One dashboard: review state, builds, revenue, ad spend',
		load: () => import('./commands/status.mjs'),
	},
	analytics: {
		group: 'Grow',
		summary: 'App Store analytics: pull · terms · funnel',
		load: () => import('./commands/analytics.mjs'),
	},
	price: {
		group: 'Grow',
		summary: 'Territory pricing: show · plan · apply',
		load: () => import('./commands/price.mjs'),
	},
	portfolio: {
		group: 'Grow',
		summary: 'Every app at once: revenue, spend, staleness, sunset candidates',
		load: () => import('./commands/portfolio.mjs'),
	},
};

/** Group order on the usage screen, and the closed set a command may declare. */
export const GROUPS = ['Setup', 'Discover', 'Build', 'Ship', 'Grow'];

/**
 * Split argv into long/short flags and positionals. `--flag value` consumes the
 * next token unless it looks like a flag; everything after `--` is positional.
 *
 * @param {string[]} argv
 * @returns {{flags: Flags, positional: string[]}}
 */
export function parseArgs(argv) {
	/** @type {Flags} */
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--') {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			if (eq > 0) {
				flags[a.slice(2, eq)] = a.slice(eq + 1);
			} else {
				const key = a.slice(2);
				const next = argv[i + 1];
				if (next === undefined || next.startsWith('-')) flags[key] = true;
				else {
					flags[key] = next;
					i++;
				}
			}
		} else if (a.startsWith('-') && a.length > 1) {
			for (const ch of a.slice(1)) flags[ch] = true;
		} else positional.push(a);
	}
	return { flags, positional };
}

function usage() {
	process.stdout.write(`
${c.bold('ship')} ${c.dim('— iOS app pipeline: research → build → ship → grow')}

${c.dim('usage:')} ship <command> [subcommand] [flags]
`);
	for (const group of GROUPS) {
		heading(group);
		for (const [name, spec] of Object.entries(COMMANDS)) {
			if (spec.group !== group) continue;
			process.stdout.write(`  ${c.cyan(name.padEnd(10))} ${spec.summary}\n`);
		}
	}
	process.stdout.write(`
${c.bold('Global flags')}
  ${c.cyan('--dry-run')}   plan every mutation, apply none
  ${c.cyan('--json')}      machine-readable output where supported
  ${c.cyan('--verbose')}   echo every subprocess
  ${c.cyan('--app <dir>')} operate on the repo at <dir> instead of cwd

${c.dim('Docs: ' + new URL('../README.md', import.meta.url).pathname)}
`);
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>}
 */
async function main(argv = process.argv.slice(2)) {
	const { flags, positional } = parseArgs(argv);
	const [name, ...rest] = positional;

	// `--version` is only the shipkit version when no command was named; every
	// command treats `--version` as the app's marketing version.
	if (!name && (flags.version || flags.V)) {
		const { readFile } = await import('node:fs/promises');
		const pkg = /** @type {JsonObject} */ (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')));
		process.stdout.write(`${pkg.version}\n`);
		return 0;
	}
	if (!name || flags.help || flags.h) {
		if (name && COMMANDS[name]) {
			const mod = await COMMANDS[name].load();
			process.stdout.write(mod.help ?? `${name}: ${COMMANDS[name].summary}\n`);
			return 0;
		}
		usage();
		// Asking for help is a successful request; being given no command at all is
		// a usage error. `ship --help` used to exit 1 and fail any CI step running it.
		return flags.help || flags.h ? 0 : 1;
	}

	const spec = COMMANDS[name];
	if (!spec) {
		const near = Object.keys(COMMANDS).filter((k) => k.startsWith(name[0]));
		throw new ShipError(`unknown command "${name}"`, {
			hint: near.length ? `did you mean: ${near.join(', ')}?` : 'run `ship --help`',
		});
	}

	setDryRun(flags['dry-run'] ?? flags.n);
	setVerbose(flags.verbose ?? flags.v);
	if (flags.app) process.chdir(String(flags.app));

	const mod = await spec.load();
	const code = await mod.run({ args: rest, flags });
	return typeof code === 'number' ? code : 0;
}

/**
 * Process entry point, called by `bin/ship`. knip cannot parse the
 * extensionless bin script, so the export is marked `@public` explicitly.
 * @public
 */
export async function cli() {
	// `ship status | head` closes the pipe mid-write. That is a normal way to read
	// a long report, not a crash, so swallow EPIPE instead of letting the
	// unhandled 'error' event dump a stack over the user's terminal.
	for (const stream of [process.stdout, process.stderr])
		stream.on('error', (err) => {
			if (err.code === 'EPIPE') process.exit(0);
			throw err;
		});

	try {
		process.exitCode = await main();
	} catch (err) {
		if (err instanceof ShipError) {
			process.stderr.write(`\n${c.red('✗')} ${err.message}\n`);
			if (err.hint)
				for (const line of err.hint.split('\n')) process.stderr.write(`  ${c.dim(line)}\n`);
			process.exitCode = err.exitCode;
		} else {
			process.stderr.write(
				`\n${c.red('✗ internal error')}\n${err instanceof Error ? err.stack ?? String(err) : String(err)}\n`,
			);
			process.exitCode = 70;
		}
	}
}

// Terminal output helpers. No dependencies, respects NO_COLOR / non-TTY.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

/** @param {string} code */
const wrap = (code) =>
	/** @param {string} s */ (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

/** @type {{dim: (s: string) => string, bold: (s: string) => string, red: (s: string) => string, green: (s: string) => string, yellow: (s: string) => string, blue: (s: string) => string, magenta: (s: string) => string, cyan: (s: string) => string, gray: (s: string) => string}} */
export const c = {
	dim: wrap('2'),
	bold: wrap('1'),
	red: wrap('31'),
	green: wrap('32'),
	yellow: wrap('33'),
	blue: wrap('34'),
	magenta: wrap('35'),
	cyan: wrap('36'),
	gray: wrap('90'),
};

/** @type {{ok: string, warn: string, fail: string, skip: string, arrow: string}} */
export const SYM = { ok: '✓', warn: '!', fail: '✗', skip: '-', arrow: '→' };

/** One structured finding inside a {@link Report}. */
/** @typedef {{level: 'ok'|'warn'|'fail'|'skip', name: string, detail: string}} ReportRow */

/** Structured findings shared by doctor/preflight. */
export class Report {
	/** @param {string} title */
	constructor(title) {
		this.title = title;
		/** @type {ReportRow[]} */
		this.rows = [];
	}
	/**
	 * @param {string} name
	 * @param {string} [detail]
	 * @returns {Report}
	 */
	ok(name, detail = '') {
		this.rows.push({ level: 'ok', name, detail });
		return this;
	}
	/**
	 * @param {string} name
	 * @param {string} [detail]
	 * @returns {Report}
	 */
	warn(name, detail = '') {
		this.rows.push({ level: 'warn', name, detail });
		return this;
	}
	/**
	 * @param {string} name
	 * @param {string} [detail]
	 * @returns {Report}
	 */
	fail(name, detail = '') {
		this.rows.push({ level: 'fail', name, detail });
		return this;
	}
	/**
	 * @param {string} name
	 * @param {string} [detail]
	 * @returns {Report}
	 */
	skip(name, detail = '') {
		this.rows.push({ level: 'skip', name, detail });
		return this;
	}
	/** @returns {ReportRow[]} */
	get failures() {
		return this.rows.filter((r) => r.level === 'fail');
	}
	/** @returns {ReportRow[]} */
	get warnings() {
		return this.rows.filter((r) => r.level === 'warn');
	}
	/** Process exit code: 1 when anything failed. @returns {number} */
	get code() {
		return this.failures.length ? 1 : 0;
	}
	/**
	 * @param {{json?: boolean}} [opts]
	 * @returns {number}
	 */
	print({ json = false } = {}) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ title: this.title, rows: this.rows }, null, 2)}\n`);
			return this.code;
		}
		/** @type {{ok: (s: string) => string, warn: (s: string) => string, fail: (s: string) => string, skip: (s: string) => string}} */
		const paint = { ok: c.green, warn: c.yellow, fail: c.red, skip: c.gray };
		heading(this.title);
		const width = Math.max(0, ...this.rows.map((r) => r.name.length));
		for (const r of this.rows) {
			const sym = paint[r.level](SYM[r.level]);
			const name = r.level === 'skip' ? c.gray(r.name.padEnd(width)) : r.name.padEnd(width);
			process.stdout.write(`  ${sym} ${name}  ${c.dim(r.detail)}\n`);
		}
		const f = this.failures.length;
		const w = this.warnings.length;
		process.stdout.write(
			`\n  ${f ? c.red(`${f} failing`) : c.green('all clear')}${w ? c.yellow(`, ${w} warning${w > 1 ? 's' : ''}`) : ''}\n`,
		);
		return this.code;
	}
}

/**
 * @param {string} s
 * @returns {void}
 */
export function heading(s) {
	process.stdout.write(`\n${c.bold(s)}\n`);
}
/**
 * @param {string} s
 * @returns {void}
 */
export function info(s) {
	process.stdout.write(`${c.cyan('·')} ${s}\n`);
}
/**
 * @param {string} s
 * @returns {void}
 */
export function step(s) {
	process.stdout.write(`${c.blue(SYM.arrow)} ${c.bold(s)}\n`);
}
/**
 * @param {string} s
 * @returns {void}
 */
export function good(s) {
	process.stdout.write(`${c.green(SYM.ok)} ${s}\n`);
}
/**
 * @param {string} s
 * @returns {void}
 */
export function warn(s) {
	process.stderr.write(`${c.yellow(SYM.warn)} ${s}\n`);
}
/**
 * @param {string} s
 * @returns {void}
 */
export function note(s) {
	process.stdout.write(`  ${c.dim(s)}\n`);
}

/**
 * Fatal error carrying an exit code; cli.mjs prints it without a stack trace.
 * @property {number} exitCode
 * @property {string} hint
 */
export class ShipError extends Error {
	/**
	 * @param {string} message
	 * @param {{code?: number, hint?: string}} [opts]
	 */
	constructor(message, { code = 1, hint = '' } = {}) {
		super(message);
		this.name = 'ShipError';
		/** @type {number} */
		this.exitCode = code;
		/** @type {string} */
		this.hint = hint;
	}
}

/**
 * @template T
 * @param {T[]} rows
 * @param {{header: string, get: (row: T) => import('./lib/util.mjs').Json}[]} columns
 * @returns {void}
 */
export function table(rows, columns) {
	if (!rows.length) {
		note('(none)');
		return;
	}
	const widths = columns.map((col) =>
		Math.max(col.header.length, ...rows.map((r) => String(col.get(r) ?? '').length)),
	);
	/** @param {import('./lib/util.mjs').Json[]} cells */
	const line = (cells) => `  ${cells.map((s, i) => String(s).padEnd(widths[i])).join('  ')}\n`;
	process.stdout.write(c.dim(line(columns.map((col) => col.header))));
	for (const r of rows) process.stdout.write(line(columns.map((col) => col.get(r) ?? '')));
}

// Terminal output helpers. No dependencies, respects NO_COLOR / non-TTY.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

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

export const SYM = { ok: '✓', warn: '!', fail: '✗', skip: '-', arrow: '→' };

/** Structured findings shared by doctor/preflight. */
export class Report {
	constructor(title) {
		this.title = title;
		this.rows = [];
	}
	ok(name, detail = '') {
		this.rows.push({ level: 'ok', name, detail });
		return this;
	}
	warn(name, detail = '') {
		this.rows.push({ level: 'warn', name, detail });
		return this;
	}
	fail(name, detail = '') {
		this.rows.push({ level: 'fail', name, detail });
		return this;
	}
	skip(name, detail = '') {
		this.rows.push({ level: 'skip', name, detail });
		return this;
	}
	get failures() {
		return this.rows.filter((r) => r.level === 'fail');
	}
	get warnings() {
		return this.rows.filter((r) => r.level === 'warn');
	}
	/** Process exit code: 1 when anything failed. */
	get code() {
		return this.failures.length ? 1 : 0;
	}
	print({ json = false } = {}) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ title: this.title, rows: this.rows }, null, 2)}\n`);
			return this.code;
		}
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

export function heading(s) {
	process.stdout.write(`\n${c.bold(s)}\n`);
}
export function info(s) {
	process.stdout.write(`${c.cyan('·')} ${s}\n`);
}
export function step(s) {
	process.stdout.write(`${c.blue(SYM.arrow)} ${c.bold(s)}\n`);
}
export function good(s) {
	process.stdout.write(`${c.green(SYM.ok)} ${s}\n`);
}
export function warn(s) {
	process.stderr.write(`${c.yellow(SYM.warn)} ${s}\n`);
}
export function note(s) {
	process.stdout.write(`  ${c.dim(s)}\n`);
}

/** Fatal error carrying an exit code; cli.mjs prints it without a stack trace. */
export class ShipError extends Error {
	constructor(message, { code = 1, hint = '' } = {}) {
		super(message);
		this.name = 'ShipError';
		this.exitCode = code;
		this.hint = hint;
	}
}

export function table(rows, columns) {
	if (!rows.length) {
		note('(none)');
		return;
	}
	const widths = columns.map((col) =>
		Math.max(col.header.length, ...rows.map((r) => String(col.get(r) ?? '').length)),
	);
	const line = (cells) => `  ${cells.map((s, i) => String(s).padEnd(widths[i])).join('  ')}\n`;
	process.stdout.write(c.dim(line(columns.map((col) => col.header))));
	for (const r of rows) process.stdout.write(line(columns.map((col) => col.get(r) ?? '')));
}

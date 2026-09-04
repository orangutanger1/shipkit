#!/usr/bin/env node
// Generic stand-in for any binary a command shells out to (asc, npx, eas, git).
// One script serves every name: the harness symlinks it as `asc`, `npx`, … and
// argv[1] tells us which name we were invoked under, so the response table is
// read from SHIP_FAKE_<NAME>. Keeping the table in the environment rather than
// on disk lets a test retune a binary between cases without rewriting a script.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const name = basename(process.argv[1] ?? 'bin');
const args = process.argv.slice(2);
const line = args.join(' ');

const log = process.env.SHIP_FAKE_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ bin: name, args })}\n`);

const key = `SHIP_FAKE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
/** @type {[string, {out?: string, err?: string, code?: number}][]} */
const rules = JSON.parse(process.env[key] || '[]');
// First match wins, so a table reads top-down like the command's own branches.
const hit = rules.find(([pattern]) => new RegExp(pattern).test(line));
const { out = '', err = '', code = 0, files = null } = hit ? hit[1] : {};
// Some binaries answer by writing files into the working directory they were
// given (asc analytics download), so a rule can name those too.
for (const [name, body] of Object.entries(files ?? {})) {
	const file = join(process.cwd(), name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, body);
}
if (out) process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
if (err) process.stderr.write(err);
process.exit(code);

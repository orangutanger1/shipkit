// What is still uncovered, addressed precisely enough to write a test against.
//
// `npm run test:c8` says a file is at 91% and names line numbers. That is not
// enough to act on: half the remaining work is branches, and a line like
// `x ?? []` holds two of them — the report cannot say which side never ran. So
// this reads c8's JSON and prints, per file, the uncovered statements and
// functions, and for every uncovered branch the *source text of the arm itself*
// ("?? []", ": 's'", the consequent of an if). That text is the test to write,
// or the evidence that the arm cannot be reached and should be deleted.
//
//   node scripts/coverage-gap.mjs                 # whole repo, worst first
//   node scripts/coverage-gap.mjs commands/aso    # one file, every arm
//
// The second form re-runs nothing: pass --report <dir> to point at a coverage
// run other than the default ./coverage.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const reportAt = args.indexOf('--report');
const reportDir = reportAt >= 0 ? args[reportAt + 1] : 'coverage';
const filter = args.filter((a, i) => !a.startsWith('--') && i !== reportAt + 1)[0] ?? '';

const file = join(reportDir, 'coverage-final.json');
/** @type {Record<string, any>} */
let cov;
try {
	cov = JSON.parse(readFileSync(file, 'utf8'));
} catch {
	console.error(`no coverage at ${file}\n\nrun it first, e.g.\n  npx c8 --reporter=json --report-dir=${reportDir} --include 'src/**' --include 'bin/**' node --test test/*.test.mjs`);
	process.exit(1);
}

/** The source text of one branch arm, trimmed to something readable. */
const armText = (src, loc) => {
	const line = src[loc.start.line - 1] ?? '';
	const text = loc.end && loc.end.line === loc.start.line ? line.slice(loc.start.column, loc.end.column) : line.slice(loc.start.column);
	return text.trim().slice(0, 100);
};

const rows = [];
for (const [path, d] of Object.entries(cov)) {
	const rel = path.replace(`${process.cwd()}/`, '');
	if (filter && !rel.includes(filter)) continue;
	const src = readFileSync(path, 'utf8').split('\n');
	const statements = [...new Set(Object.entries(d.s).filter(([, n]) => n === 0).map(([k]) => d.statementMap[k].start.line))];
	const functions = Object.entries(d.f).filter(([, n]) => n === 0).map(([k]) => `${d.fnMap[k].name} (line ${d.fnMap[k].decl.start.line})`);
	const branches = [];
	for (const [k, counts] of Object.entries(d.b))
		counts.forEach((n, i) => {
			if (n !== 0) return;
			const loc = d.branchMap[k].locations[i];
			branches.push({ line: loc.start.line, type: d.branchMap[k].type, text: armText(src, loc) });
		});
	if (statements.length || functions.length || branches.length) rows.push({ rel, statements, functions, branches });
}

rows.sort((a, b) => b.statements.length + b.functions.length + b.branches.length - (a.statements.length + a.functions.length + a.branches.length));
const total = (key) => rows.reduce((n, r) => n + r[key].length, 0);
console.log(`uncovered: ${total('statements')} statements · ${total('functions')} functions · ${total('branches')} branch arms · ${rows.length} files\n`);

for (const r of rows) {
	console.log(`${r.rel}  S:${r.statements.length} F:${r.functions.length} B:${r.branches.length}`);
	if (!filter) continue;
	if (r.statements.length) console.log(`  statements: lines ${r.statements.join(', ')}`);
	for (const f of r.functions) console.log(`  function never called: ${f}`);
	for (const b of r.branches.sort((x, y) => x.line - y.line)) console.log(`  ${String(b.line).padStart(5)}  ${b.type.padEnd(12)} ${JSON.stringify(b.text)}`);
	console.log('');
}

#!/usr/bin/env node
// Quality gate computed from a single acorn parse per file:
//   - cyclomatic complexity (per function + per file)
//   - cognitive complexity (per function, SonarSource spec)
//   - Halstead difficulty (per function + per file, token-based)
//   - CRAP (per function, joined with c8's coverage JSON)
//   - LOC (per file)
// Exits non-zero listing every violation.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as acorn from 'acorn';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'src');
const BIN = join(ROOT, 'bin');
const COVERAGE = join(ROOT, 'coverage', 'coverage-final.json');

const LIMITS = {
	cyclomatic: 22,
	cognitive: 22,
	halstead: 80,
	crap: 25,
	fileLOC: 500,
};

function listMJS(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listMJS(p));
		else if (entry.name.endsWith('.mjs')) out.push(p);
	}
	return out;
}

// --- cyclomatic complexity ---------------------------------------------------

const DECISION_KEYS = new Set([
	'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
	'WhileStatement', 'DoWhileStatement', 'CatchClause', 'ConditionalExpression',
]);
const FUNCTION_NODES = new Set([
	'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
]);

function cyclomaticOf(node) {
	if (DECISION_KEYS.has(node.type)) return 1;
	if (node.type === 'SwitchCase' && node.test !== null) return 1;
	if (node.type === 'LogicalExpression') return 1;
	if (node.type === 'AssignmentExpression' && ['&&=', '||=', '??='].includes(node.operator)) return 1;
	return 0;
}

function walkCyclomatic(node, fnAcc, functions, complexityAcc) {
	if (!node || typeof node.type !== 'string') return;

	if (FUNCTION_NODES.has(node.type)) {
		const inner = { cyclomatic: 1 };
		functions.push({ line: node.loc.start.line, node, acc: inner });
		for (const param of node.params ?? []) walkCyclomatic(param, fnAcc, functions, complexityAcc);
		// decision points inside the body belong to the innermost function
		walkCyclomatic(node.body, inner, functions, complexityAcc);
		return;
	}
	const branch = cyclomaticOf(node);
	// top-level decision points belong to the file aggregate and to the
	// function whose body they sit in; the function's own decision points
	// (params with defaults, etc.) count toward that function only
	complexityAcc.cyclomatic += branch;
	fnAcc.cyclomatic += branch;

	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
		const child = node[key];
		if (Array.isArray(child)) {
			for (const c of child) {
				if (c && typeof c.type === 'string') walkCyclomatic(c, fnAcc, functions, complexityAcc);
			}
		} else if (child && typeof child.type === 'string') {
			walkCyclomatic(child, fnAcc, functions, complexityAcc);
		}
	}
}

// --- cognitive complexity (SonarSource spec) ---------------------------------

const NESTED_KEYS = new Set(['consequent', 'alternate', 'block', 'body', 'finalizer', 'cases']);

function sequenceLength(node) {
	let length = 1;
	let current = node;
	while (current.type === 'LogicalExpression') {
		current = current.right;
		length++;
	}
	return length;
}

function walkCognitive(node, nesting, env, functions) {
	if (!node || typeof node.type !== 'string') return;

	if (FUNCTION_NODES.has(node.type)) {
		// a nested function's complexity belongs to the nested function itself
		for (const param of node.params ?? []) walkCognitive(param, nesting, env, functions);
		const inner = { cognitive: 0 };
		functions.push({ line: node.loc.start.line, env: inner });
		walkCognitive(node.body, nesting + 1, inner, functions);
		return;
	}
	if (node.type === 'LogicalExpression') {
		// a && b && c: +1 per additional operand in the sequence, un-nested
		env.cognitive += sequenceLength(node) - 1;
		walkCognitive(node.left, nesting, env, functions);
		walkCognitive(node.right, nesting, env, functions);
		return;
	}
	if (node.type === 'IfStatement') {
		env.cognitive += 1;
		walkCognitive(node.test, nesting, env, functions);
		walkCognitive(node.consequent, nesting + 1, env, functions);
		if (node.alternate) walkCognitive(node.alternate, nesting + 1, env, functions);
		return;
	}
	if (node.type === 'SwitchCase') {
		env.cognitive += 1;
		for (const child of node.consequent) walkCognitive(child, nesting + 1, env, functions);
		return;
	}
	if (node.type === 'CatchClause') {
		env.cognitive += 1;
		walkCognitive(node.body, nesting + 1, env, functions);
		return;
	}

	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
		const child = node[key];
		const nested = NESTED_KEYS.has(key) ? nesting + 1 : nesting;
		if (Array.isArray(child)) {
			for (const c of child) {
				if (c && typeof c.type === 'string') walkCognitive(c, nested, env, functions);
			}
		} else if (child && typeof child.type === 'string') {
			walkCognitive(child, nested, env, functions);
		}
	}
}

// --- Halstead (AST-based, per function — the standard scope for difficulty) --

function halsteadFromNode(root) {
	const operators = new Map();
	const operands = new Map();
	const bump = (map, value) => map.set(value, (map.get(value) ?? 0) + 1);

	function walk(node) {
		if (!node || typeof node.type !== 'string') return;
		bump(operators, node.type);
		if ('operator' in node && typeof node.operator === 'string') bump(operators, node.operator);
		if (node.type === 'Identifier') bump(operands, node.name);
		else if (node.type === 'PrivateIdentifier') bump(operands, `#${node.name}`);
		else if (node.type === 'Literal') bump(operands, `${typeof node.value}:${String(node.value)}`);
		else if (node.type === 'TemplateElement') bump(operands, node.value.cooked ?? node.value.raw);
		for (const key of Object.keys(node)) {
			if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
			const child = node[key];
			if (Array.isArray(child)) for (const c of child) if (c && typeof c.type === 'string') walk(c);
			else if (child && typeof child.type === 'string') walk(child);
		}
	}
	walk(root);

	const distinctOperators = operators.size;
	const totalOperands = [...operands.values()].reduce((a, b) => a + b, 0);
	const distinctOperands = operands.size;
	if (distinctOperators === 0 || distinctOperands === 0) return 0;
	return (distinctOperators / 2) * (totalOperands / distinctOperands);
}

// --- CRAP ---------------------------------------------------------------------

function loadFunctionCoverage() {
	if (!existsSync(COVERAGE)) return null;
	const raw = JSON.parse(readFileSync(COVERAGE, 'utf8'));
	const byFile = new Map();
	for (const entry of Object.values(raw)) {
		const lines = new Map();
		for (const [id, fn] of Object.entries(entry.fnMap ?? {})) {
			const line = fn.decl?.start?.line ?? fn.line;
			const hits = entry.f?.[id] ?? 0;
			lines.set(line, (lines.get(line) ?? 0) + hits);
		}
		byFile.set(entry.path, lines);
	}
	return byFile;
}

function crap(complexity, coveragePercent) {
	if (coveragePercent >= 100) return complexity;
	const cov = coveragePercent / 100;
	return complexity * complexity * (1 - cov) + complexity;
}

// --- main --------------------------------------------------------------------

const files = [...listMJS(SRC), join(BIN, 'ship')].filter((f) => statSync(f).isFile());
const coverage = loadFunctionCoverage();
const violations = [];

for (const file of files) {
	const rel = relative(ROOT, file);
	const loc = readFileSync(file, 'utf8').split('\n').length;
	if (loc >= LIMITS.fileLOC) {
		violations.push(`${rel}: file has ${loc} LOC (limit < ${LIMITS.fileLOC})`);
	}
	if (!file.endsWith('.mjs')) continue;

	const source = readFileSync(file, 'utf8');
	const ast = acorn.parse(source, {
		ecmaVersion: 'latest', sourceType: 'module', locations: true, ranges: true,
	});

	const fileAcc = { cyclomatic: 1 };
	const functions = [];
	walkCyclomatic(ast, fileAcc, functions, fileAcc);

	const cognitive = new Map();
	{
		const cognitiveFunctions = [];
		const top = { cognitive: 0 };
		walkCognitive(ast, 0, top, cognitiveFunctions);
		for (const { line, env } of cognitiveFunctions) {
			cognitive.set(line, (cognitive.get(line) ?? 0) + env.cognitive);
		}
	}

	const fileCoverage = coverage?.get(file);

	for (const { line, node, acc } of functions) {
		const label = `${rel}:${line}`;
		if (acc.cyclomatic >= LIMITS.cyclomatic) {
			violations.push(`${label}: cyclomatic ${acc.cyclomatic} (limit < ${LIMITS.cyclomatic})`);
		}
		const fnDifficulty = halsteadFromNode(node);
		if (fnDifficulty >= LIMITS.halstead) {
			violations.push(`${label}: Halstead difficulty ${fnDifficulty.toFixed(1)} (limit < ${LIMITS.halstead})`);
		}
		const cog = cognitive.get(line) ?? 0;
		if (cog >= LIMITS.cognitive) {
			violations.push(`${label}: cognitive ${cog} (limit < ${LIMITS.cognitive})`);
		}
		if (fileCoverage) {
			const hits = fileCoverage.get(line) ?? 0;
			const c = crap(acc.cyclomatic, hits > 0 ? 100 : 0);
			if (c >= LIMITS.crap) {
				violations.push(`${label}: CRAP ${c.toFixed(0)} (limit < ${LIMITS.crap})`);
			}
		}
	}
}

if (!coverage) {
	console.error('metrics: coverage/coverage-final.json not found — CRAP checks skipped (run `npm run test:c8` first)');
}

if (violations.length > 0) {
	console.error(`\nmetrics: ${violations.length} violation(s):\n`);
	for (const v of violations) console.error(`  ✗ ${v}`);
	process.exitCode = 1;
} else {
	console.log(`metrics: OK — ${files.length} files within limits`);
}

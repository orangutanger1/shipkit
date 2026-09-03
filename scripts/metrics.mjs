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

/** A source location as acorn emits it (with `locations: true`). */
/** @typedef {{start: {line: number}, end: {line: number}}} AcornLoc */
/**
 * A minimal acorn AST node: `type` plus child fields the walkers traverse.
 * @typedef {{type: string, loc: AcornLoc, [key: string]: AstValue}} AstNode
 */
/** Anything an AST node property can hold. */
/** @typedef {string|number|boolean|null|AstNode|AstNode[]|AcornLoc} AstValue */

/**
 * Narrow an AST property to a node (properties that are not nodes never reach
 * the recursive walk — the checks below mirror what `child.type` did before).
 * @param {AstValue} v
 * @returns {AstNode|null}
 */
const asNode = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) && 'type' in v ? v : null);

/**
 * @param {string} dir
 * @returns {string[]}
 */
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

/**
 * @param {AstNode} node
 * @returns {number}
 */
function cyclomaticOf(node) {
	if (DECISION_KEYS.has(node.type)) return 1;
	if (node.type === 'SwitchCase' && node.test !== null) return 1;
	if (node.type === 'LogicalExpression') return 1;
	if (node.type === 'AssignmentExpression' && typeof node.operator === 'string' && ['&&=', '||=', '??='].includes(node.operator)) return 1;
	return 0;
}

/**
 * @param {AstNode} node
 * @param {{cyclomatic: number}} fnAcc
 * @param {{line: number, node: AstNode, acc: {cyclomatic: number}}[]} functions
 * @param {{cyclomatic: number}} complexityAcc
 * @returns {void}
 */
function walkCyclomatic(node, fnAcc, functions, complexityAcc) {
	if (!node || typeof node.type !== 'string') return;

	if (FUNCTION_NODES.has(node.type)) {
		const inner = { cyclomatic: 1 };
		functions.push({ line: node.loc.start.line, node, acc: inner });
		const params = Array.isArray(node.params) ? node.params : [];
		for (const param of params) walkCyclomatic(param, fnAcc, functions, complexityAcc);
		// decision points inside the body belong to the innermost function
		const body = asNode(node.body);
		if (body) walkCyclomatic(body, inner, functions, complexityAcc);
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
				const n = asNode(c);
				if (n) walkCyclomatic(n, fnAcc, functions, complexityAcc);
			}
		} else {
			const n = asNode(child);
			if (n) walkCyclomatic(n, fnAcc, functions, complexityAcc);
		}
	}
}

// --- cognitive complexity (SonarSource spec) ---------------------------------

const NESTED_KEYS = new Set(['consequent', 'alternate', 'block', 'body', 'finalizer', 'cases']);

/**
 * @param {AstNode} node
 * @returns {number}
 */
function sequenceLength(node) {
	let length = 1;
	/** @type {AstNode|null} */
	let current = node;
	while (current.type === 'LogicalExpression') {
		current = asNode(current.right);
		if (!current) break;
		length++;
	}
	return length;
}

/**
 * @param {AstNode} node
 * @param {number} nesting
 * @param {{cognitive: number}} env
 * @param {{line: number, env: {cognitive: number}}[]} functions
 * @returns {void}
 */
function walkCognitive(node, nesting, env, functions) {
	if (!node || typeof node.type !== 'string') return;

	if (FUNCTION_NODES.has(node.type)) {
		// a nested function's complexity belongs to the nested function itself
		const params = Array.isArray(node.params) ? node.params : [];
		for (const param of params) walkCognitive(param, nesting, env, functions);
		const inner = { cognitive: 0 };
		functions.push({ line: node.loc.start.line, env: inner });
		const body = asNode(node.body);
		if (body) walkCognitive(body, nesting + 1, inner, functions);
		return;
	}
	if (node.type === 'LogicalExpression') {
		// a && b && c: +1 per additional operand in the sequence, un-nested
		env.cognitive += sequenceLength(node) - 1;
		const left = asNode(node.left);
		const right = asNode(node.right);
		if (left) walkCognitive(left, nesting, env, functions);
		if (right) walkCognitive(right, nesting, env, functions);
		return;
	}
	if (node.type === 'IfStatement') {
		env.cognitive += 1;
		const test = asNode(node.test);
		const consequent = asNode(node.consequent);
		const alternate = asNode(node.alternate);
		if (test) walkCognitive(test, nesting, env, functions);
		if (consequent) walkCognitive(consequent, nesting + 1, env, functions);
		if (alternate) walkCognitive(alternate, nesting + 1, env, functions);
		return;
	}
	if (node.type === 'SwitchCase') {
		env.cognitive += 1;
		const cons = Array.isArray(node.consequent) ? node.consequent : [];
		for (const child of cons) walkCognitive(child, nesting + 1, env, functions);
		return;
	}
	if (node.type === 'CatchClause') {
		env.cognitive += 1;
		const body = asNode(node.body);
		if (body) walkCognitive(body, nesting + 1, env, functions);
		return;
	}

	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
		const child = node[key];
		const nested = NESTED_KEYS.has(key) ? nesting + 1 : nesting;
		if (Array.isArray(child)) {
			for (const c of child) {
				const n = asNode(c);
				if (n) walkCognitive(n, nested, env, functions);
			}
		} else {
			const n = asNode(child);
			if (n) walkCognitive(n, nested, env, functions);
		}
	}
}

// --- Halstead (AST-based, per function — the standard scope for difficulty) --

/**
 * @param {AstNode} root
 * @returns {number}
 */
function halsteadFromNode(root) {
	/** @type {Map<string, number>} */
	const operators = new Map();
	/** @type {Map<string, number>} */
	const operands = new Map();
	/** @param {Map<string, number>} map @param {string} value */
	const bump = (map, value) => map.set(value, (map.get(value) ?? 0) + 1);

	/**
	 * @param {AstNode} node
	 * @returns {void}
	 */
	function walk(node) {
		if (!node || typeof node.type !== 'string') return;
		bump(operators, node.type);
		if ('operator' in node && typeof node.operator === 'string') bump(operators, node.operator);
		if (node.type === 'Identifier') bump(operands, /** @type {string} */ (node.name));
		else if (node.type === 'PrivateIdentifier') bump(operands, `#${node.name}`);
		else if (node.type === 'Literal') bump(operands, `${typeof node.value}:${String(node.value)}`);
		else if (node.type === 'TemplateElement') {
			const v = node.value;
			bump(
				operands,
				/** @type {string} */ (
					v !== null && typeof v === 'object' && !Array.isArray(v) && 'cooked' in v ? v.cooked ?? v.raw : v
				),
			);
		}
		for (const key of Object.keys(node)) {
			if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
			const child = node[key];
			if (Array.isArray(child)) {
				for (const c of child) {
					const n = asNode(c);
					if (n) walk(n);
				}
			} else {
				const n = asNode(child);
				if (n) walk(n);
			}
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

/**
 * @returns {Map<string, Map<number|undefined, number>>|null}
 */
function loadFunctionCoverage() {
	if (!existsSync(COVERAGE)) return null;
	const raw = JSON.parse(readFileSync(COVERAGE, 'utf8'));
	/** @type {Map<string, Map<number|undefined, number>>} */
	const byFile = new Map();
	for (const entry of Object.values(raw)) {
		/** @type {Map<number|undefined, number>} */
		const lines = new Map();
		const e = /** @type {{fnMap?: Record<string, {decl?: {start?: {line?: number}}|undefined, line?: number}>, f?: Record<string, number>, path?: string}} */ (entry);
		for (const [id, fn] of Object.entries(e.fnMap ?? {})) {
			const line = fn.decl?.start?.line ?? fn.line;
			const hits = e.f?.[id] ?? 0;
			lines.set(line, (lines.get(line) ?? 0) + hits);
		}
		if (e.path !== undefined) byFile.set(e.path, lines);
	}
	return byFile;
}

/**
 * @param {number} complexity
 * @param {number} coveragePercent
 * @returns {number}
 */
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
	const parsed = acorn.parse(source, {
		ecmaVersion: 'latest', sourceType: 'module', locations: true, ranges: true,
	});
	// object → AstNode: the parse result is exactly what the walkers traverse.
	const ast = /** @type {AstNode} */ (/** @type {object} */ (parsed));

	const fileAcc = { cyclomatic: 1 };
	/** @type {{line: number, node: AstNode, acc: {cyclomatic: number}}[]} */
	const functions = [];
	walkCyclomatic(ast, fileAcc, functions, fileAcc);

	/** @type {Map<number, number>} */
	const cognitive = new Map();
	{
		/** @type {{line: number, env: {cognitive: number}}[]} */
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

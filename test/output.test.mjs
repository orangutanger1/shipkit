import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emit, kvTable } from '../src/lib/output.mjs';

function captureStdout(fn) {
	const chunks = [];
	const original = process.stdout.write;
	process.stdout.write = (chunk) => {
		chunks.push(chunk);
		return true;
	};
	try {
		const result = fn();
		return { result, output: chunks.join('') };
	} finally {
		process.stdout.write = original;
	}
}

test('emit prints pretty JSON and returns 0', () => {
	const { result, output } = captureStdout(() => emit({ a: 1 }));
	assert.equal(result, 0);
	assert.equal(output, '{\n  "a": 1\n}\n');
});

test('emit prints arrays the same way', () => {
	const { output } = captureStdout(() => emit([1, 2]));
	assert.equal(output, '[\n  1,\n  2\n]\n');
});

test('kvTable renders a two-column field/value table', () => {
	const { output } = captureStdout(() =>
		kvTable([
			['name', 'My App'],
			['bundleId', 'com.acme.myapp'],
		]),
	);
	assert.match(output, /field\s+value/);
	assert.match(output, /name\s+My App/);
	assert.match(output, /bundleId\s+com\.acme\.myapp/);
});

test('kvTable prints the empty placeholder when there are no pairs', () => {
	const { output } = captureStdout(() => kvTable([]));
	assert.match(output, /\(none\)/);
});

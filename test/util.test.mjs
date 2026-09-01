import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memo, settle, median, strOf, resolveSubcommand } from '../src/lib/util.mjs';
import { ShipError } from '../src/log.mjs';

test('memo caches the async result across calls', async () => {
	let calls = 0;
	const get = memo(async () => {
		calls++;
		return calls;
	});
	assert.equal(await get(), 1);
	assert.equal(await get(), 1);
	assert.equal(calls, 1);
});

test('memo propagates a rejected call to every waiter of that same promise', async () => {
	const get = memo(async () => {
		throw new Error('boom');
	});
	await assert.rejects(get(), /boom/);
	await assert.rejects(get(), /boom/);
});

test('settle returns the value on success', async () => {
	assert.deepEqual(await settle(async () => 7), { value: 7, error: null });
});

test('settle converts a rejection into an error string', async () => {
	const r = await settle(async () => {
		throw new Error('kaboom');
	});
	assert.deepEqual(r, { value: null, error: 'kaboom' });
});

test('settle stringifies non-Error rejections', async () => {
	const r = await settle(() => Promise.reject(42));
	assert.deepEqual(r, { value: null, error: '42' });
});

test('median picks the middle value', () => {
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 3, 2]), 3); // mean of the middle pair, rounded
	assert.equal(median([]), 0);
	assert.equal(median([5]), 5);
	assert.equal(median([10, 2]), 6);
});

test('median does not mutate its input', () => {
	const xs = [3, 1, 2];
	median(xs);
	assert.deepEqual(xs, [3, 1, 2]);
});

test('strOf returns the first non-empty string, else undefined', () => {
	assert.equal(strOf(undefined, '', 'x', 'y'), 'x');
	assert.equal(strOf(undefined, 5), undefined);
	assert.equal(strOf(), undefined);
});

function makeSubs() {
	return {
		status: ({ args }) => `status:${args.join(',')}`,
		audit: ({ args }) => `audit:${args.join(',')}`,
	};
}

test('resolveSubcommand strips the subcommand word and keeps the rest', () => {
	const { fn, args } = resolveSubcommand({ command: 'rc', args: ['audit', '--full'], subs: makeSubs() });
	assert.equal(fn({ args }), 'audit:--full');
});

test('resolveSubcommand falls back to the default subcommand', () => {
	const { fn, args } = resolveSubcommand({ command: 'rc', args: [], subs: makeSubs(), fallback: 'status' });
	assert.equal(fn({ args }), 'status:');
});

test('resolveSubcommand raises ShipError with the valid names on an unknown sub', () => {
	assert.throws(
		() => resolveSubcommand({ command: 'rc', args: ['nope'], subs: makeSubs(), fallback: 'status' }),
		(err) => {
			assert.ok(err instanceof ShipError);
			assert.match(err.message, /rc: unknown subcommand "nope"/);
			assert.match(err.hint, /status, audit/);
			return true;
		},
	);
});

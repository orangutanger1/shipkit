// The storefront client's cache and its behaviour when Apple refuses. Apple
// answers one request per storefront per second and 403s a burst, so every
// path here — the on-disk cache, the wall, the retry, the give-up — is what
// stands between a sweep and an afternoon of nothing.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { capture, withFetch } from './fixtures/cmd.mjs';

// The storefront backoff is 20 seconds of real waiting per refusal, read once
// at load — so it is set before the module is imported, not per test.
process.env.SHIP_STOREFRONT_BACKOFF_MS = '5';
const { CACHE_TTL_MS, StorefrontWall, harvest, hints, lookup, marketFor, topResults, throttledFetch, useCache } =
	await import('../src/lib/appstore-client.mjs');

const dir = () => mkdtemp(join(tmpdir(), 'ship-store-'));
const ok = (body) => async () => new Response(body);
const status = (code) => async () => new Response('', { status: code });

test('the cache is off until a command points it at a repo', async () => {
	useCache({ mode: 'off' });
	let calls = 0;
	const counting = async () => {
		calls += 1;
		return new Response('{"results":[]}');
	};
	await withFetch(counting, async () => {
		await topResults('a', { country: 'ZZ' });
		await topResults('a', { country: 'ZZ' });
	});
	assert.equal(calls, 2, 'with no cache every call goes to Apple');
});

test('a cached response is served without asking Apple again, and expires', async () => {
	const cacheDir = await dir();
	useCache({ dir: cacheDir });
	let calls = 0;
	const counting = async () => {
		calls += 1;
		return new Response('{"results":[{"trackId":1}]}');
	};
	await withFetch(counting, async () => {
		await topResults('cached', { country: 'ZY' });
		await topResults('cached', { country: 'ZY' });
	});
	assert.equal(calls, 1, 'the second read came off disk');

	useCache({ dir: cacheDir, ttlMs: -1 });
	await withFetch(counting, () => topResults('cached', { country: 'ZY' }));
	assert.equal(calls, 2, 'an expired entry is re-fetched');
});

test('--refresh re-fetches but still repopulates, so a wall mid-sweep is cheap to resume', async () => {
	const cacheDir = await dir();
	useCache({ dir: cacheDir, mode: 'refresh' });
	let calls = 0;
	const counting = async () => {
		calls += 1;
		return new Response('{"results":[]}');
	};
	await withFetch(counting, async () => {
		await topResults('refreshed', { country: 'ZX' });
		await topResults('refreshed', { country: 'ZX' });
	});
	assert.equal(calls, 2);
});

test('a cache entry that is not readable JSON, or holds no body, is simply a miss', async () => {
	const cacheDir = await dir();
	useCache({ dir: cacheDir });
	await withFetch(ok('{"results":[]}'), () => topResults('poison', { country: 'ZW' }));

	const { readdir } = await import('node:fs/promises');
	const country = join(cacheDir, 'ZW');
	const [file] = await readdir(country);
	await writeFile(join(country, file), 'not json');
	assert.deepEqual(await withFetch(ok('{"results":[]}'), () => topResults('poison', { country: 'ZW' })), []);

	await writeFile(join(country, file), JSON.stringify({ at: Date.now(), body: { not: 'a string' } }));
	assert.deepEqual(await withFetch(ok('{"results":[]}'), () => topResults('poison', { country: 'ZW' })), []);
});

test('a cache directory that cannot be written to is slow, not broken', async () => {
	const file = join(await dir(), 'a-file');
	await writeFile(file, 'not a directory');
	useCache({ dir: file });
	assert.deepEqual(await withFetch(ok('{"results":[]}'), () => topResults('unwritable', { country: 'ZV' })), []);
});

test('a refused request answers null, or throws the wall when the caller must stop', async () => {
	useCache({ mode: 'off' });
	assert.equal(await withFetch(status(403), () => throttledFetch('https://x.example', { country: 'ZU', tries: 1 })), null);
	await assert.rejects(
		() => withFetch(status(429), () => throttledFetch('https://x.example', { country: 'ZT', tries: 1, hard: true })),
		StorefrontWall,
	);
});

test('a server error and a transport failure both give up after the last try', async () => {
	useCache({ mode: 'off' });
	assert.equal(await withFetch(status(500), () => throttledFetch('https://x.example', { country: 'ZS', tries: 1 })), null);

	const { result, out } = await capture(() =>
		withFetch(async () => {
			throw new Error('socket hang up');
		}, () => throttledFetch('https://x.example', { country: 'ZR', tries: 1 })),
	);
	assert.equal(result, null);
	assert.match(out, /request failed: socket hang up/);
});

test('a request that is asked for bytes skips the cache and answers a buffer', async () => {
	const cacheDir = await dir();
	useCache({ dir: cacheDir });
	const png = await withFetch(async () => new Response(Buffer.from([1, 2, 3])), () =>
		throttledFetch('https://x.example/img.png', { country: 'ZQ', endpoint: 'shot', term: 'x', bytes: true }),
	);
	assert.ok(Buffer.isBuffer(png));
});

test('hints and lookup tolerate an answer that is not what they asked for', async () => {
	useCache({ mode: 'off' });
	assert.deepEqual(await withFetch(ok('not xml'), () => hints('a', 'GB')), []);
	assert.deepEqual(await withFetch(ok('not json'), () => lookup([1, null], { country: 'ZN' })), []);
	assert.equal(await withFetch(ok('not json'), () => topResults('a', { country: 'ZL' })), null);
});

test('a storefront Apple does not have is answered with nothing, without asking', async () => {
	useCache({ mode: 'off' });
	assert.deepEqual(await hints('a', 'ZZ'), [], 'no request is made at all — the harness would fail one');
});

test('a harvest that hits the wall carries the candidates it already had', async () => {
	useCache({ mode: 'off' });
	let calls = 0;
	// Thrown rather than answered 403: a wall propagates immediately, where a
	// refusal would first spend the retry budget and its backoff.
	const walled = async () => {
		calls += 1;
		if (calls > 1) throw new StorefrontWall('FR');
		return new Response('<dict><key>term</key><string>oil change reminder</string></dict>');
	};
	let partial = null;
	await assert.rejects(
		() => withFetch(walled, () => harvest(['oil change', 'service log'], 'FR', { onPartial: (p) => { partial = p; } })),
		(err) => err instanceof StorefrontWall && Object.keys(err.partial).length > 0,
	);
	assert.ok(partial && Object.keys(partial).length, 'the caller is handed what was already paid for');
});

test('the cache TTL is a week, and the ambient default is off', () => {
	assert.equal(CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('a server error is retried, and the retry can succeed', async () => {
	useCache({ mode: 'off' });
	let calls = 0;
	const flaky = async () => {
		calls += 1;
		return calls === 1 ? new Response('', { status: 502 }) : new Response('recovered');
	};
	assert.equal(await withFetch(flaky, () => throttledFetch('https://x.example', { country: 'ZI', tries: 2 })), 'recovered');
});

test('a transport failure is retried too', async () => {
	useCache({ mode: 'off' });
	let calls = 0;
	const flaky = async () => {
		calls += 1;
		if (calls === 1) throw new Error('socket hang up');
		return new Response('recovered');
	};
	assert.equal(await withFetch(flaky, () => throttledFetch('https://x.example', { country: 'ZH', tries: 2 })), 'recovered');
});

test('a term that appears higher under a shorter stem keeps the better rank', async () => {
	useCache({ mode: 'off' });
	const body = (terms) => new Response(`<dict>${terms.map((t) => `<key>term</key><string>${t}</string>`).join('')}</dict>`);
	let calls = 0;
	// The full seed ranks the term second; the truncation ranks it first, which
	// is the demand signal the harvest keeps.
	const stemmed = async () => {
		calls += 1;
		return calls === 1 ? body(['other thing', 'oil change reminder']) : body(['oil change reminder']);
	};
	const found = await withFetch(stemmed, () => harvest(['oil change log'], 'IT'));
	assert.equal(found['oil change reminder'].rank, 0);
	assert.ok(found['oil change reminder'].stemDepth > 0, 'and records that it took a truncation to surface it');
});

test('a locale resolves to its market by full code, by language, or not at all', () => {
	assert.deepEqual(marketFor('de-DE'), { country: 'DE', lang: 'de_de' });
	assert.deepEqual(marketFor('ja-JP'), { country: 'JP', lang: 'ja_jp' }, 'a language-only entry answers for its region variants');
	assert.equal(marketFor('xx-XX'), null);
	assert.equal(marketFor(undefined), null);
});

test('a refusal is retried after the storefront backoff, and can then succeed', async () => {
	useCache({ mode: 'off' });
	let calls = 0;
	const refused = async () => {
		calls += 1;
		return calls === 1 ? new Response('', { status: 429 }) : new Response('let through');
	};
	assert.equal(await withFetch(refused, () => throttledFetch('https://x.example', { country: 'ZG', tries: 2 })), 'let through');
});

test('a request with no tries left answers nothing rather than asking', async () => {
	useCache({ mode: 'off' });
	assert.equal(await throttledFetch('https://x.example', { country: 'ZF', tries: 0 }), null);
});

test('an answer with no results block reads as no results', async () => {
	useCache({ mode: 'off' });
	assert.deepEqual(await withFetch(ok('{}'), () => topResults('a', { country: 'ZE' })), []);
	assert.deepEqual(await withFetch(ok('{}'), () => lookup([1], { country: 'ZD' })), []);
});

test('a suggestion that is an app\'s marketed name is not a query anybody types', async () => {
	useCache({ mode: 'off' });
	const body = new Response('<dict><key>term</key><string>Flo: Period Tracker</string><key>term</key><string>period tracker</string></dict>');
	const found = await withFetch(async () => body.clone(), () => harvest(['period'], 'ES'));
	assert.deepEqual(Object.keys(found), ['period tracker']);
});

test('an endpoint asked for without a cache directory is simply uncached', async () => {
	useCache({ mode: 'off' });
	assert.equal(await withFetch(ok('body'), () => throttledFetch('https://x.example', { country: 'ZC', endpoint: 'e', term: 't' })), 'body');
});

test('nothing at all from Apple leaves hints, lookup and search empty-handed', async () => {
	useCache({ mode: 'off' });
	const empty = async () => new Response('', { status: 403 });
	assert.deepEqual(await withFetch(empty, () => hints('a', 'SE')), []);
	assert.deepEqual(await withFetch(empty, () => lookup([1], { country: 'ZB' })), []);
	assert.equal(await withFetch(empty, () => topResults('a', { country: 'ZA' })), null);
});

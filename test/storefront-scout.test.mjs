// storefront-scout.mjs — the App Store half of `ship scout`: markets, artifact
// paths, the terms sweep, autocomplete/prior-sweep pooling, incumbents,
// claims, and brief I/O. Everything network-shaped is stubbed through
// `globalThis.fetch`; nothing here reaches apps.apple.com or itunes.apple.com
// for real. See test/appstore.test.mjs for the same fetch-stub pattern this
// file follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	artifactFile,
	claimsAudit,
	enableCache,
	incumbentsOf,
	marketOf,
	readBrief,
	resolveBrief,
	sweepTerms,
	termPool,
	writeArtifact,
} from '../src/lib/storefront-scout.mjs';
import { hints } from '../src/lib/appstore.mjs';

/** Swap `globalThis.fetch` for the duration of `fn`, always restoring it. */
async function withFetch(handler, fn) {
	const real = globalThis.fetch;
	globalThis.fetch = handler;
	try {
		return await fn();
	} finally {
		globalThis.fetch = real;
	}
}

/** A hints XML body for a fixed set of suggestions, in order. */
const hintsBody = (terms) =>
	`<dict>${terms.map((t) => `<key>term</key><string>${t}</string>`).join('')}</dict>`;

/** A minimal itunes /search or /lookup JSON body. */
const resultsBody = (results) => JSON.stringify({ results });

// ─── marketOf ────────────────────────────────────────────────────────────────

test('marketOf resolves a known storefront code case-insensitively', () => {
	assert.deepEqual(marketOf('us'), { country: 'US', lang: 'en_us' });
	assert.deepEqual(marketOf('DE'), { country: 'DE', lang: 'de_de' });
});

test('marketOf defaults to US when no code is given', () => {
	assert.deepEqual(marketOf(undefined), { country: 'US', lang: 'en_us' });
});

test('marketOf throws a ShipError naming the supported storefronts', () => {
	assert.throws(() => marketOf('zz'), (err) => {
		assert.match(err.message, /no App Store storefront "zz"/);
		assert.match(err.hint, /us /);
		return true;
	});
});

// ─── artifactFile / writeArtifact ───────────────────────────────────────────

test('artifactFile joins --out, the storefront and the artifact kind', () => {
	const file = artifactFile({ out: '/tmp/scout' }, { country: 'US', lang: 'en_us' }, 'car-log', 'brief');
	assert.equal(file, join('/tmp/scout', 'us', 'car-log-brief.json'));
});

test('artifactFile defaults --out to "scout" resolved against cwd', () => {
	const file = artifactFile({}, { country: 'DE', lang: 'de_de' }, 'x', 'terms');
	assert.equal(file, join(process.cwd(), 'scout', 'de', 'x-terms.json'));
});

test('writeArtifact tab-indents JSON and creates directories on demand', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-artifact-'));
	try {
		const file = join(dir, 'a', 'b', 'x-brief.json');
		const written = await writeArtifact(file, { term: 'x', n: 1 });
		assert.equal(written, file);
		const text = await readFile(file, 'utf8');
		assert.equal(text, '{\n\t"term": "x",\n\t"n": 1\n}\n');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── enableCache (behavioural: a real cache hit skips the network) ──────────

test('enableCache turns on the on-disk response cache so a repeated hints() call skips the network', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-cache-'));
	try {
		enableCache({ out: dir });
		let calls = 0;
		await withFetch(
			async () => {
				calls++;
				return { ok: true, status: 200, text: async () => hintsBody(['habit tracker']) };
			},
			async () => {
				const first = await hints('habit', 'GB');
				const second = await hints('habit', 'GB');
				assert.deepEqual(first, ['habit tracker']);
				assert.deepEqual(second, ['habit tracker']);
			},
		);
		assert.equal(calls, 1, 'the second call must be served from the on-disk cache');
	} finally {
		enableCache({ out: '/does/not/matter/off' });
		await rm(dir, { recursive: true, force: true });
	}
});

test('enableCache with --refresh still repopulates but does not read back', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-cache-refresh-'));
	try {
		enableCache({ out: dir, refresh: true });
		let calls = 0;
		await withFetch(
			async () => {
				calls++;
				return { ok: true, status: 200, text: async () => hintsBody(['streak counter']) };
			},
			async () => {
				await hints('streak', 'AU');
				await hints('streak', 'AU');
			},
		);
		assert.equal(calls, 2, 'refresh mode always re-fetches');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── sweepTerms ──────────────────────────────────────────────────────────────

test('sweepTerms harvests, picks candidates, and scores them without a wall', async () => {
	const market = { country: 'CA', lang: 'en_us' };
	await withFetch(
		async (url) => {
			const u = String(url);
			if (u.includes('MZSearchHints')) {
				return { ok: true, status: 200, text: async () => hintsBody(['car log', 'car tracker']) };
			}
			if (u.includes('itunes.apple.com/search')) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						resultsBody([
							{ trackId: 1, trackName: 'Car Log App', sellerName: 'Acme', userRatingCount: 10, price: 0 },
						]),
				};
			}
			return { ok: true, status: 200, text: async () => '{}' };
		},
		async () => {
			const progress = [];
			const { candidates, walled, scored } = await sweepTerms({
				seeds: ['car'],
				market,
				maxWords: 3,
				limit: 5,
				onProgress: (...args) => progress.push(args),
			});
			assert.equal(walled, null);
			assert.ok(Object.keys(candidates).length > 0);
			assert.ok(scored.length > 0);
			assert.ok(progress.length > 0, 'onProgress must be threaded through to harvest/scoreAll');
		},
	);
});

// NOTE: sweepTerms's `catch (err)` branch for a StorefrontWall — where
// `harvest`'s partial candidates are recovered and scored anyway — is not
// covered here. Reaching it requires appstore-client.mjs's throttledFetch to
// exhaust all 5 retries on 403/429, which only throws after paying its own
// internal 20s backoff (BACKOFF_MS) at least once — a real, non-configurable
// timer inside src/lib/appstore-client.mjs, not something a stubbed fetch can
// shortcut. That's tens of seconds of wall-clock per attempt with no network
// involved, which is impractical for this suite; the behaviour itself
// (`if (!('partial' in err) || !err.partial) throw err;` and the assembly of
// `walled`) is otherwise inspectable by reading appstore-client.mjs's own
// `harvest()`, which already attaches `.partial` before throwing.

// ─── termPool / priorSweep / autocomplete ───────────────────────────────────

test('termPool falls back to live autocomplete when there is no prior sweep', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-pool-'));
	try {
		await withFetch(
			async () => ({ ok: true, status: 200, text: async () => hintsBody(['widget', 'widget pro', 'widgets']) }),
			async () => {
				const r = await termPool({ out: dir }, { country: 'FR', lang: 'en_us' }, 'widget');
				assert.equal(r.prior, null);
				assert.equal(r.rank, 0);
				assert.ok(r.suggestions.includes('widget'));
				assert.ok(r.pool.includes('widget'));
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('termPool autocompletes a long term with a truncated second probe when the first misses', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-pool2-'));
	try {
		let seenTerms = [];
		await withFetch(
			async (url) => {
				const u = new URL(String(url));
				const term = u.searchParams.get('term');
				seenTerms.push(term);
				// The full 8-char term never appears in its own row; the truncated
				// 6-char stem does, at position 1 — so rank must come from probe 2.
				if (term === 'habitual') return { ok: true, status: 200, text: async () => hintsBody(['other']) };
				return { ok: true, status: 200, text: async () => hintsBody(['other', 'habitual']) };
			},
			async () => {
				const r = await termPool({ out: dir }, { country: 'DE', lang: 'en_us' }, 'habitual');
				assert.deepEqual(seenTerms, ['habitual', 'habitual'.slice(0, -2)]);
				assert.equal(r.rank, 1);
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('termPool reads a prior terms.json sweep instead of calling autocomplete again', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-pool3-'));
	try {
		const marketDir = join(dir, 'us');
		await mkdir(marketDir, { recursive: true });
		await writeFile(
			join(marketDir, 'car-terms.json'),
			JSON.stringify({
				candidates: { 'car log': { seeds: ['car'], rank: 2 }, legacy: ['a', 'b'] },
				terms: [
					{ keyword: 'car log', opportunity: 50, demand: 40, top3: [{ name: 'X', seller: 'Y' }] },
					{ keyword: 'car tracker', opportunity: 80, demand: 20, top3: [] },
				],
			}),
		);
		let fetchCalls = 0;
		await withFetch(
			async () => {
				fetchCalls++;
				return { ok: true, status: 200, text: async () => hintsBody([]) };
			},
			async () => {
				const r = await termPool({ out: dir }, { country: 'US', lang: 'en_us' }, 'car log');
				assert.equal(r.prior.rank, 2);
				assert.equal(r.prior.demand, 40);
				assert.deepEqual(r.prior.seeds, ['car']);
				assert.deepEqual(r.prior.cohort, ['car tracker']);
				assert.deepEqual(r.prior.apps, [{ name: 'X', seller: 'Y' }]);
				assert.equal(r.demand, 40, 'a prior demand is reused rather than recomputed');
				// termPool always re-fetches suggestions live (a prior sweep never stores
				// them) -- only the rank/demand lookup is skipped when already known.
				assert.equal(fetchCalls, 2);
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('termPool reads the legacy bare-array candidate shape and still needs live rank', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-pool4-'));
	try {
		const marketDir = join(dir, 'us');
		await mkdir(marketDir, { recursive: true });
		await writeFile(
			join(marketDir, 'z-terms.json'),
			JSON.stringify({ candidates: { widget: ['seed1'] }, terms: [] }),
		);
		await withFetch(
			async () => ({ ok: true, status: 200, text: async () => hintsBody(['widget']) }),
			async () => {
				const r = await termPool({ out: dir }, { country: 'US', lang: 'en_us' }, 'widget');
				assert.deepEqual(r.prior.seeds, ['seed1']);
				assert.equal(r.prior.rank, null);
				assert.equal(r.rank, 0, 'no rank on the legacy entry falls back to a live lookup');
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('priorSweep skips an unparseable terms.json and keeps looking', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-pool5-'));
	try {
		const marketDir = join(dir, 'us');
		await mkdir(marketDir, { recursive: true });
		// Alphabetically first, and broken — must be skipped rather than throwing.
		await writeFile(join(marketDir, 'aaa-terms.json'), '{ not json');
		await writeFile(
			join(marketDir, 'bbb-terms.json'),
			JSON.stringify({ candidates: { term1: { seeds: ['s'], rank: 5 } }, terms: [] }),
		);
		await withFetch(
			async () => ({ ok: true, status: 200, text: async () => hintsBody([]) }),
			async () => {
				const r = await termPool({ out: dir }, { country: 'US', lang: 'en_us' }, 'term1');
				assert.equal(r.prior.rank, 5);
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('priorSweep is null when the market directory has no matching term', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-pool6-'));
	try {
		await withFetch(
			async () => ({ ok: true, status: 200, text: async () => hintsBody(['x']) }),
			async () => {
				const r = await termPool({ out: dir }, { country: 'US', lang: 'en_us' }, 'nope');
				assert.equal(r.prior, null);
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('priorSweep is null when every terms.json under the market exists but names other terms', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-pool7-'));
	try {
		const marketDir = join(dir, 'us');
		await mkdir(marketDir, { recursive: true });
		await writeFile(
			join(marketDir, 'other-terms.json'),
			JSON.stringify({ candidates: { 'some other term': { seeds: ['x'], rank: 1 } }, terms: [] }),
		);
		await withFetch(
			async () => ({ ok: true, status: 200, text: async () => hintsBody(['x']) }),
			async () => {
				const r = await termPool({ out: dir }, { country: 'US', lang: 'en_us' }, 'not present anywhere');
				assert.equal(r.prior, null);
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── incumbentsOf / sellsInApp ───────────────────────────────────────────────

const market = { country: 'US', lang: 'en_us' };

test('incumbentsOf refreshes through lookup and reports hasIap true from the storefront page', async () => {
	await withFetch(
		async (url) => {
			const u = String(url);
			if (u.includes('itunes.apple.com/lookup')) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						resultsBody([
							{
								trackId: 1,
								trackName: 'Fresh Name',
								sellerName: 'Acme',
								userRatingCount: 100,
								averageUserRating: 4.567,
								price: 0,
								trackViewUrl: 'https://apps.apple.com/us/app/id1',
							},
						]),
				};
			}
			if (u.includes('apps.apple.com')) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						`<script type="application/json" id="serialized-server-data">${JSON.stringify({
							data: [{ data: { titleOfferDisplayProperties: { hasInAppPurchases: true } } }],
						})}</script>`,
				};
			}
			throw new Error(`unexpected fetch ${u}`);
		},
		async () => {
			const out = await incumbentsOf([{ trackId: 1, trackName: 'Stale Name' }], market);
			assert.equal(out.length, 1);
			assert.equal(out[0].name, 'Fresh Name');
			assert.equal(out[0].stars, 4.6);
			assert.equal(out[0].hasIap, true);
		},
	);
});

test('incumbentsOf: no trackViewUrl skips the network and reports hasIap null', async () => {
	await withFetch(
		async (url) => {
			if (String(url).includes('lookup')) return { ok: true, status: 200, text: async () => resultsBody([{ trackId: 2, trackName: 'No URL' }]) };
			throw new Error('should not fetch the storefront page with no url');
		},
		async () => {
			const out = await incumbentsOf([{ trackId: 2, trackName: 'No URL' }], market);
			assert.equal(out[0].hasIap, null);
			assert.equal(out[0].url, null);
		},
	);
});

test('incumbentsOf: a non-ok storefront page response reports hasIap null', async () => {
	await withFetch(
		async (url) => {
			if (String(url).includes('lookup'))
				return { ok: true, status: 200, text: async () => resultsBody([{ trackId: 3, trackName: 'N', trackViewUrl: 'https://apps.apple.com/x' }]) };
			return { ok: false, status: 500, text: async () => '' };
		},
		async () => {
			const out = await incumbentsOf([{ trackId: 3, trackName: 'N', trackViewUrl: 'https://apps.apple.com/x' }], market);
			assert.equal(out[0].hasIap, null);
		},
	);
});

test('incumbentsOf: a page with no serialized-server-data block reports hasIap null', async () => {
	await withFetch(
		async (url) => {
			if (String(url).includes('lookup'))
				return { ok: true, status: 200, text: async () => resultsBody([{ trackId: 4, trackName: 'N', trackViewUrl: 'https://apps.apple.com/x' }]) };
			return { ok: true, status: 200, text: async () => '<html>no offer data here</html>' };
		},
		async () => {
			const out = await incumbentsOf([{ trackId: 4, trackName: 'N', trackViewUrl: 'https://apps.apple.com/x' }], market);
			assert.equal(out[0].hasIap, null);
		},
	);
});

test('incumbentsOf: a fetch that throws is swallowed and reports hasIap null', async () => {
	await withFetch(
		async (url) => {
			if (String(url).includes('lookup'))
				return { ok: true, status: 200, text: async () => resultsBody([{ trackId: 5, trackName: 'N', trackViewUrl: 'https://apps.apple.com/x' }]) };
			throw new Error('network is down');
		},
		async () => {
			const out = await incumbentsOf([{ trackId: 5, trackName: 'N', trackViewUrl: 'https://apps.apple.com/x' }], market);
			assert.equal(out[0].hasIap, null);
		},
	);
});

test('incumbentsOf: an offer whose hasInAppPurchases is not a boolean reports null', async () => {
	await withFetch(
		async (url) => {
			if (String(url).includes('lookup'))
				return { ok: true, status: 200, text: async () => resultsBody([{ trackId: 6, trackName: 'N', trackViewUrl: 'https://apps.apple.com/x' }]) };
			return {
				ok: true,
				status: 200,
				text: async () =>
					`<script type="application/json" id="serialized-server-data">${JSON.stringify({ data: [{ data: {} }] })}</script>`,
			};
		},
		async () => {
			const out = await incumbentsOf([{ trackId: 6, trackName: 'N', trackViewUrl: 'https://apps.apple.com/x' }], market);
			assert.equal(out[0].hasIap, null);
		},
	);
});

test('incumbentsOf falls back to the search result when lookup omits an id', async () => {
	await withFetch(
		async (url) => {
			if (String(url).includes('lookup')) return { ok: true, status: 200, text: async () => resultsBody([]) };
			throw new Error('should not reach the storefront page with no url');
		},
		async () => {
			const out = await incumbentsOf([{ trackId: 7, trackName: 'Search-only', userRatingCount: 3 }], market);
			assert.equal(out[0].name, 'Search-only');
			assert.equal(out[0].ratings, 3);
		},
	);
});

test('incumbentsOf only refreshes the top 3', async () => {
	await withFetch(
		async (url) => {
			if (String(url).includes('lookup')) {
				const ids = new URL(String(url)).searchParams.get('id');
				assert.equal(ids.split(',').length, 3);
				return { ok: true, status: 200, text: async () => resultsBody([]) };
			}
			throw new Error('no per-app fetch expected with no trackViewUrl');
		},
		async () => {
			const results = [1, 2, 3, 4, 5].map((n) => ({ trackId: n, trackName: `App ${n}` }));
			const out = await incumbentsOf(results, market);
			assert.equal(out.length, 3);
		},
	);
});

// ─── claimsAudit ─────────────────────────────────────────────────────────────

test('claimsAudit is empty with no ids, without calling lookup', async () => {
	await withFetch(
		async () => {
			throw new Error('must not fetch with no ids');
		},
		async () => {
			assert.deepEqual(await claimsAudit([], market), { corpus: 0, claims: [] });
		},
	);
});

test('claimsAudit is empty when lookup returns nothing for the given ids', async () => {
	await withFetch(
		async () => ({ ok: true, status: 200, text: async () => resultsBody([]) }),
		async () => {
			assert.deepEqual(await claimsAudit([{ trackId: 1 }], market), { corpus: 0, claims: [] });
		},
	);
});

test('claimsAudit counts and ranks the claims a category already makes', async () => {
	await withFetch(
		async () =>
			({
				ok: true,
				status: 200,
				text: async () =>
					resultsBody([
						{ trackId: 1, trackName: 'A', description: 'Works completely offline, no ads.' },
						{ trackId: 2, trackName: 'B', description: 'On-device and private, no account needed.' },
						{ trackId: 3, trackName: 'C', description: 'A simple tracker for your day.' },
					]),
			}),
		async () => {
			const audit = await claimsAudit([{ trackId: 1 }, { trackId: 2 }, { trackId: 3 }], market);
			assert.equal(audit.corpus, 3);
			const byClaim = Object.fromEntries(audit.claims.map((c) => [c.claim, c]));
			assert.equal(byClaim.offline.apps, 1);
			assert.equal(byClaim['no ads'].apps, 1);
			assert.equal(byClaim['no account'].apps, 1);
			assert.deepEqual(byClaim['privacy / on-device'].holders, ['B']);
			// Ranked most-taken first, and a claim nobody makes is dropped entirely.
			assert.ok(audit.claims.every((c) => c.apps > 0));
			for (let i = 1; i < audit.claims.length; i++) assert.ok(audit.claims[i - 1].apps >= audit.claims[i].apps);
		},
	);
});

// ─── readBrief ───────────────────────────────────────────────────────────────

test('readBrief throws with a hint when the file does not exist', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-brief-'));
	try {
		await assert.rejects(() => readBrief(join(dir, 'nope-brief.json')), (err) => {
			assert.match(err.message, /no scout brief at/);
			assert.match(err.hint, /ship scout brief/);
			return true;
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readBrief throws on unparseable JSON', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-brief2-'));
	try {
		const file = join(dir, 'bad-brief.json');
		await writeFile(file, '{ not json');
		await assert.rejects(() => readBrief(file), /is not valid JSON/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readBrief throws when the document is missing term or listing.name', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-brief3-'));
	try {
		const file = join(dir, 'incomplete-brief.json');
		await writeFile(file, JSON.stringify({ term: 'x' }));
		await assert.rejects(() => readBrief(file), /is not a scout brief/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readBrief resolves a relative path against cwd and returns the parsed doc plus file', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-brief4-'));
	const prevCwd = process.cwd();
	process.chdir(dir);
	try {
		await writeFile(join(dir, 'good-brief.json'), JSON.stringify({ term: 'car log', listing: { name: 'CarLog' } }));
		const doc = await readBrief('good-brief.json');
		assert.equal(doc.term, 'car log');
		assert.equal(doc.file, join(dir, 'good-brief.json'));
	} finally {
		process.chdir(prevCwd);
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── resolveBrief ────────────────────────────────────────────────────────────

test('resolveBrief prefers --from over everything else', async () => {
	const r = await resolveBrief({ from: '/explicit/path.json', term: 'ignored' }, market);
	assert.equal(r, '/explicit/path.json');
});

test('resolveBrief builds the artifact path from --term when there is no --from', async () => {
	const r = await resolveBrief({ out: '/tmp/scout', term: 'Car Maintenance Log!' }, { country: 'US', lang: 'en_us' });
	assert.equal(r, join('/tmp/scout', 'us', 'car-maintenance-log-brief.json'));
});

test('resolveBrief picks the one brief under --out when neither flag is given', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-resolve-'));
	try {
		const marketDir = join(dir, 'us');
		await mkdir(marketDir, { recursive: true });
		await writeFile(join(marketDir, 'only-brief.json'), '{}');
		const r = await resolveBrief({ out: dir }, { country: 'US', lang: 'en_us' });
		assert.equal(r, join(marketDir, 'only-brief.json'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('resolveBrief throws when there is no brief under --out', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-resolve2-'));
	try {
		await assert.rejects(() => resolveBrief({ out: dir }, { country: 'US', lang: 'en_us' }), (err) => {
			assert.match(err.message, /no brief under/);
			assert.match(err.hint, /ship scout brief/);
			return true;
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('resolveBrief throws naming one of several briefs when it cannot pick', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-scout-resolve3-'));
	try {
		const marketDir = join(dir, 'us');
		await mkdir(marketDir, { recursive: true });
		await writeFile(join(marketDir, 'a-brief.json'), '{}');
		await writeFile(join(marketDir, 'b-brief.json'), '{}');
		await assert.rejects(() => resolveBrief({ out: dir }, { country: 'US', lang: 'en_us' }), (err) => {
			assert.match(err.message, /2 briefs under/);
			assert.match(err.hint, /pick one: --from/);
			return true;
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

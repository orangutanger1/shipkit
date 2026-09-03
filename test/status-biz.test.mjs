// `ship status` biz sections: RevenueCat, Apple Ads, listing depth, OTA safety.
// asc() is stubbed via SHIP_ASC_BIN pointed at test/fixtures/fake-asc.mjs (mode
// picked with FAKE_ASC_MODE), RevenueCat's fetch is stubbed on globalThis.fetch,
// and OTA reads real files under a temp app dir. No live network anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// exec.mjs binds ASC once at first import, so the stub binary must live at one
// fixed path for the whole process — this file's own process, since `node
// --test` runs each test file in its own worker.
const STUB_BIN = new URL('./fixtures/fake-asc.mjs', import.meta.url).pathname;
process.env.SHIP_ASC_BIN = STUB_BIN;
process.env.REVENUECAT_V2_KEY = 'test-key';

const {
	collectRevenue, renderRevenue,
	collectAds, renderAds,
	collectListing, renderListing,
	collectOta, renderOta,
} = await import('../src/lib/status-biz.mjs');

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

async function withFetch(handler, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

/* -------------------------------------------------------------- revenue -- */

test('collectRevenue reports skipped when no project resolves (zero or many projects)', async () => {
	await withFetch(
		async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) }),
		async () => {
			await assert.rejects(() => collectRevenue({ cfg: { revenuecat: {} } }), /no projects/);
		},
	);
});

test('collectRevenue collects offerings/entitlements/products for the single resolved project', async () => {
	await withFetch(
		async (url) => {
			const u = String(url);
			if (u.includes('/projects') && !u.includes('/projects/')) {
				return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ id: 'proj1', name: 'Proj One' }] }) };
			}
			if (u.includes('/offerings')) {
				return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ id: 'off1', lookup_key: 'default', is_current: true }] }) };
			}
			if (u.includes('/entitlements')) {
				return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ id: 'ent1', lookup_key: 'pro' }] }) };
			}
			if (u.includes('/products')) {
				return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ id: 'p1' }, { id: 'p2' }] }) };
			}
			if (u.includes('/packages')) {
				return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ id: 'pkg1' }] }) };
			}
			throw new Error(`unexpected fetch ${u}`);
		},
		async () => {
			const d = await collectRevenue({ cfg: { revenuecat: { entitlement: 'pro' } } });
			assert.equal(d.project.id, 'proj1');
			assert.equal(d.offerings, 1);
			assert.deepEqual(d.currentOffering, { lookup_key: 'default', packages: 1 });
			assert.equal(d.entitlementPresent, true);
			assert.equal(d.products, 2);
		},
	);
});

test('collectRevenue reports no current offering and an unset entitlement', async () => {
	await withFetch(
		async (url) => {
			const u = String(url);
			if (u.includes('/projects') && !u.includes('/projects/')) {
				return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ id: 'proj1', name: 'Proj One' }] }) };
			}
			if (u.includes('/offerings')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
			if (u.includes('/entitlements')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
			if (u.includes('/products')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
			throw new Error(`unexpected fetch ${u}`);
		},
		async () => {
			const d = await collectRevenue({ cfg: { revenuecat: {} } });
			assert.equal(d.currentOffering, null);
			assert.equal(d.entitlement, null);
			assert.equal(d.entitlementPresent, null);
		},
	);
});

test('renderRevenue prints the skipped note in dim', async () => {
	const { output } = captureStdout(() => renderRevenue({ skipped: 'no RevenueCat API key' }));
	assert.match(output, /skipped — no RevenueCat API key/);
});

test('renderRevenue colours a missing current offering, missing entitlement, and zero products red', async () => {
	const { output } = captureStdout(() =>
		renderRevenue({
			project: { id: 'p1', name: 'Proj' },
			currentOffering: null,
			entitlement: 'pro',
			entitlementPresent: false,
			products: 0,
		}),
	);
	assert.match(output, /none marked current/);
	assert.match(output, /pro \(missing\)/);
});

test('renderRevenue shows a present entitlement and packaged current offering', async () => {
	const { output } = captureStdout(() =>
		renderRevenue({
			project: { id: 'p1', name: 'Proj' },
			currentOffering: { lookup_key: 'default', packages: 3 },
			entitlement: 'pro',
			entitlementPresent: true,
			products: 5,
		}),
	);
	assert.match(output, /default/);
	assert.match(output, /3 packages/);
});

test('renderRevenue shows unset entitlement in dim', async () => {
	const { output } = captureStdout(() =>
		renderRevenue({ project: { id: 'p1', name: 'Proj' }, currentOffering: null, entitlement: null, entitlementPresent: null, products: 0 }),
	);
	assert.match(output, /unset/);
});

/* ------------------------------------------------------------------ ads -- */

test('collectAds reports not configured when asc has no credentials', async () => {
	process.env.FAKE_ASC_MODE = 'no-auth';
	const d = await collectAds({ cfg: {} });
	assert.equal(d.configured, false);
});

test('collectAds reports configured-without-org when credentials exist but no org resolves', async () => {
	process.env.FAKE_ASC_MODE = 'no-org';
	const d = await collectAds({ cfg: {} });
	assert.equal(d.configured, true);
	assert.equal(d.org, null);
});

test('collectAds aggregates totals across report rows (total and granularity fallback) and computes cpi', async () => {
	process.env.FAKE_ASC_MODE = 'full';
	const d = await collectAds({ cfg: {} });
	assert.equal(d.configured, true);
	assert.equal(d.org, '555');
	assert.equal(d.campaigns, 2);
	assert.equal(d.spend, 15);
	assert.equal(d.installs, 4);
	assert.equal(d.taps, 14);
	assert.equal(d.impressions, 140);
	assert.equal(d.cpi, 15 / 4);
});

test('collectAds reports a null cpi when there are zero installs', async () => {
	process.env.FAKE_ASC_MODE = 'zero-installs';
	const d = await collectAds({ cfg: {} });
	assert.equal(d.cpi, null);
	delete process.env.FAKE_ASC_MODE;
});

test('collectAds prefers ads.orgId from config over the ASC active org', async () => {
	process.env.FAKE_ASC_MODE = 'full';
	const d = await collectAds({ cfg: { ads: { orgId: 'cfg-org' } } });
	assert.equal(d.org, 'cfg-org');
	delete process.env.FAKE_ASC_MODE;
});

test('renderAds notes when ads is not configured', async () => {
	const { output } = captureStdout(() => renderAds({ configured: false }));
	assert.match(output, /not configured/);
});

test('renderAds warns when credentials exist but no org id', async () => {
	const { output } = captureStdout(() => renderAds({ configured: true, org: null }));
	assert.match(output, /no org id/);
});

test('renderAds prints campaigns, spend, and a dash cpi when cpi is null', async () => {
	const { output } = captureStdout(() =>
		renderAds({ configured: true, org: '555', campaigns: 2, spend: 15, installs: 0, taps: 14, cpi: null }),
	);
	assert.match(output, /campaigns/);
	assert.match(output, /15\.00/);
});

test('renderAds prints a formatted cpi when present', async () => {
	const { output } = captureStdout(() =>
		renderAds({ configured: true, org: '555', campaigns: 2, spend: 15, installs: 4, taps: 14, cpi: 3.75 }),
	);
	assert.match(output, /3\.75/);
});

/* -------------------------------------------------------------- listing -- */

async function withStagedListings(locales, fn) {
	const root = await mkdtemp(join(tmpdir(), 'ship-status-biz-'));
	const staged = join(root, 'store', 'staged');
	await mkdir(staged, { recursive: true });
	for (const [locale, data] of Object.entries(locales)) {
		await writeFile(join(staged, `${locale}.json`), JSON.stringify({ locale, ...data }));
	}
	try {
		return await fn({ paths: { staged } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('collectListing reports zero locales when nothing is staged', async () => {
	await withStagedListings({}, async (cfg) => {
		const d = await collectListing({ cfg });
		assert.equal(d.locales, 0);
		assert.equal(d.min, 0);
		assert.equal(d.max, 0);
		assert.deepEqual(d.underfilled, []);
	});
});

test('collectListing measures the comma-joined keyword field length per locale, and flags underfilled ones', async () => {
	await withStagedListings(
		{
			'en-US': { keywords: 'oil,tyre,brakes,mileage' }, // short — underfilled
			'de-DE': { keywords: Array.from({ length: 20 }, (_, i) => `wort${i}`).join(',') }, // long
		},
		async (cfg) => {
			const d = await collectListing({ cfg });
			assert.equal(d.locales, 2);
			const enRow = d.byLocale.find((l) => l.locale === 'en-US');
			assert.equal(enRow.used, 'oil,tyre,brakes,mileage'.length);
			assert.ok(d.underfilled.includes('en-US'));
		},
	);
});

test('renderListing notes the empty state when there are no staged locales', async () => {
	const { output } = captureStdout(() => renderListing({ locales: 0 }));
	assert.match(output, /no staged listings/);
});

test('renderListing prints min/median/max and warns about underfilled locales', async () => {
	const { output } = captureStdout(() =>
		renderListing({ locales: 2, limit: 100, min: 20, median: 50, max: 80, underfilled: ['en-US'] }),
	);
	assert.match(output, /2 staged locales/);
	assert.match(output, /under 80%/);
	assert.match(output, /en-US/);
});

test('renderListing is quiet about underfilled locales when none are', () => {
	const { output } = captureStdout(() => renderListing({ locales: 1, limit: 100, min: 90, median: 90, max: 90, underfilled: [] }));
	assert.doesNotMatch(output, /under 80%/);
});

/* ------------------------------------------------------------------ ota -- */

async function withAppDir(fn) {
	const root = await mkdtemp(join(tmpdir(), 'ship-status-ota-'));
	const app = join(root, 'app');
	await mkdir(app, { recursive: true });
	await writeFile(join(app, 'package.json'), JSON.stringify({ dependencies: {} }));
	try {
		return await fn({ root, paths: { app } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('collectOta throws when the version cannot be determined', async () => {
	await assert.rejects(() => collectOta({ version: async () => null, cfg: {} }), /cannot determine app version/);
});

test('collectOta reports unsafe with no native build recorded when there is no lock file', async () => {
	await withAppDir(async (cfg) => {
		const d = await collectOta({ cfg, version: async () => '1.0.0' });
		assert.equal(d.safe, false);
		assert.match(d.reason, /no native build recorded/);
		assert.equal(d.lockVersion, null);
	});
});

test('collectOta reports safe when the lock matches the current native graph exactly', async () => {
	await withAppDir(async (cfg) => {
		await mkdir(join(cfg.root, '.asc'), { recursive: true });
		await writeFile(
			join(cfg.root, '.asc', 'native-lock.json'),
			JSON.stringify({ version: '1.0.0', deps: {}, config: {} }),
		);
		const d = await collectOta({ cfg, version: async () => '1.0.0' });
		assert.equal(d.safe, true);
		assert.equal(d.lockVersion, '1.0.0');
	});
});

test('renderOta prints green when safe and lists no drift', () => {
	const { output } = captureStdout(() =>
		renderOta({ safe: true, reason: 'native graph identical to the last build — OTA is safe', added: [], removed: [], changed: [], configChanged: [] }),
	);
	assert.match(output, /OTA safe/);
	assert.doesNotMatch(output, /added:/);
});

test('renderOta prints yellow with reason and every drift category present', () => {
	const { output } = captureStdout(() =>
		renderOta({
			safe: false,
			reason: '3 native change(s) since the last build — installed clients would crash on this bundle',
			added: ['expo-camera'],
			removed: ['expo-av'],
			changed: ['react-native'],
			configChanged: ['ios'],
		}),
	);
	assert.match(output, /native build required/);
	assert.match(output, /added: expo-camera/);
	assert.match(output, /removed: expo-av/);
	assert.match(output, /changed: react-native/);
	assert.match(output, /config: ios/);
});

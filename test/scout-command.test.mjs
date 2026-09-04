// `ship scout` end to end: terms, brief, names and the handoff to `new`.
// Apple's storefront is the only dependency and it is stubbed on
// globalThis.fetch — search and lookup answer with frozen captures, the hints
// endpoint with the plist Apple actually serves. One request per second is why
// none of this is allowed to be real.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { capture, inDir, repo, withFetch } from './fixtures/cmd.mjs';
import { STOREFRONT } from './fixtures/storefront.mjs';

const { run } = await import('../src/commands/scout.mjs');

const APPS = STOREFRONT['period tracker'].apps;
const hintsBody = (terms) => `<dict>${terms.map((t) => `<key>term</key><string>${t}</string>`).join('')}</dict>`;

/**
 * The storefront, as far as scout can tell.
 * @param {{apps?: object[], suggestions?: string[], page?: string}} [opts]
 * @returns {typeof globalThis.fetch}
 */
function storefront({ apps = APPS, suggestions = ['period tracker calendar', 'cycle log tracker', 'ovulation calendar'], page = '<html>Track your cycle. No subscription.</html>' } = {}) {
	return async (url) => {
		const href = String(url);
		if (href.includes('MZSearchHints')) return new Response(hintsBody(suggestions));
		if (href.includes('/search') || href.includes('/lookup')) return new Response(JSON.stringify({ results: apps }), { headers: { 'content-type': 'application/json' } });
		return new Response(page, { headers: { 'content-type': 'text/html' } });
	};
}

/**
 * @param {string[]} args
 * @param {{flags?: object, dir?: string, fetch?: typeof globalThis.fetch}} [opts]
 * @returns {Promise<{code: number|void, out: string}>}
 */
async function scout(args, { flags = {}, dir, fetch = storefront() } = {}) {
	const { result, out } = await capture(() => inDir(dir, () => withFetch(fetch, () => run({ args, flags }))));
	return { code: result, out };
}

const workdir = () => repo({ config: null, prefix: 'ship-scout-' });
const readArtifact = (dir, name) => readFile(join(dir, 'scout', 'us', name), 'utf8').then(JSON.parse);

test('a subcommand is required, and an unknown one names the ones that exist', async () => {
	const dir = await workdir();
	await assert.rejects(() => scout([], { dir }), /a subcommand is required/);
	await assert.rejects(() => scout(['sniff'], { dir }), /unknown subcommand "sniff"/);
});

test('terms sweeps the seeds and writes a scored artifact', async () => {
	const dir = await workdir();
	const { code, out } = await scout(['terms', 'period tracker'], { dir, flags: { limit: 5 } });
	assert.equal(code, 0);
	const artifact = await readArtifact(dir, 'period-tracker-terms.json');
	assert.deepEqual(artifact.seeds, ['period tracker']);
	assert.ok(artifact.terms.length, 'something scored');
	assert.match(out, /sorted by viability/);
	assert.match(out, /ship scout brief/);
});

test('terms needs at least one seed', async () => {
	const dir = await workdir();
	await assert.rejects(() => scout(['terms', '  '], { dir }), /at least one seed is required/);
});

test('terms --json emits the artifact instead of the table', async () => {
	const dir = await workdir();
	const { out } = await scout(['terms', 'period tracker'], { dir, flags: { json: true, limit: 3 } });
	assert.equal(JSON.parse(out).market.country, 'US');
});

test('terms reports a throttled storefront rather than pretending nothing is there', async () => {
	const dir = await workdir();
	const { code, out } = await scout(['terms', 'period tracker'], { dir, flags: { limit: 3 }, fetch: storefront({ apps: [], suggestions: [] }) });
	assert.equal(code, 1);
	assert.match(out, /nothing scored/);
});

test('brief scores one term, prints the verdict and writes the artifact', async () => {
	const dir = await workdir();
	const { code, out } = await scout(['brief', 'period tracker'], { dir });
	assert.equal(code, 0);
	const artifact = await readArtifact(dir, 'period-tracker-brief.json');
	assert.equal(artifact.term, 'period tracker');
	assert.ok(artifact.listing.name, 'the brief drafts a listing');
	assert.ok(artifact.verdict.reasons.length, 'a market with a 1.9M-rating incumbent trips a gate');
	assert.match(out, /NO-GO/);
	assert.match(out, /--moat/, 'the override for each tripped gate is named');
});

test('brief needs a term, and refuses a storefront that answered with nothing', async () => {
	const dir = await workdir();
	await assert.rejects(() => scout(['brief'], { dir }), /a term is required/);
	await assert.rejects(() => scout(['brief', 'period tracker'], { dir, fetch: storefront({ apps: [] }) }), /no App Store results/);
});

test('brief --strict exits 1 on a NO-GO, and --sub-price adds the CPI band', async () => {
	const dir = await workdir();
	const { code } = await scout(['brief', 'period tracker'], { dir, flags: { strict: true } });
	assert.equal(code, 1, 'a NO-GO under --strict is a failing exit');
	const { out } = await scout(['brief', 'period tracker'], { dir, flags: { json: true, 'sub-price': 4.99 } });
	assert.ok(JSON.parse(out).asa.cpi.high > 0, '--sub-price derives the CPI band the term can support');
});

test('brief with every gate relaxed is a GO, and says what comes next', async () => {
	const dir = await workdir();
	const relaxed = { moat: 9_000_000, 'min-volume': 0, 'max-exact': 99, 'max-saturation': 100, 'max-clones': 99, 'max-commodity': 100 };
	const { code, out } = await scout(['brief', 'period tracker'], { dir, flags: relaxed });
	assert.equal(code, 0);
	assert.match(out, /GO/);
	assert.match(out, /ship scout names/);
});

test('names finds the brand words already on the storefront', async () => {
	const dir = await workdir();
	const { code, out } = await scout(['names', 'stardust'], { dir, flags: { strict: true } });
	assert.equal(code, 1, '--strict makes a collision a failure');
	assert.match(out, /already carry "stardust"/);
	const artifact = await readArtifact(dir, 'stardust-names.json');
	assert.ok(artifact.collisions.length);
	assert.equal(artifact.verdict.free, false);
});

test('a brand word nobody has taken comes back free', async () => {
	const dir = await workdir();
	const { code, out } = await scout(['names', 'zibbleflux'], { dir });
	assert.equal(code, 0);
	assert.match(out, /no title in the top/);
	assert.match(out, /trademark register/);
});

test('names needs a name, and --json skips the table', async () => {
	const dir = await workdir();
	await assert.rejects(() => scout(['names', ' '], { dir }), /a name is required/);
	const { out } = await scout(['names', 'stardust'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(out).slug, 'stardust');
});

test('new refuses until exactly one brief names the app', async () => {
	const dir = await workdir();
	await assert.rejects(() => scout(['new', 'demo'], { dir }), /no brief under/);
	await scout(['brief', 'period tracker'], { dir });
	await scout(['brief', 'cycle log'], { dir });
	await assert.rejects(() => scout(['new', 'demo'], { dir }), /2 briefs under/);
});

// A stand-in for puppeteer: a browser that navigates nowhere and screenshots a
// solid page. `page.screenshot({path})` writes a real PNG at the viewport size,
// which is what the capture step's callers go on to measure and composite.
// Every call is recorded on `module.exports.calls` so a test can assert the
// locale headers, seeds and selectors the capture actually asked for.
'use strict';
const sharp = require('../sharp/index.cjs');

const calls = [];
const observed = { value: null };
// Real page.evaluate runs the function in the page. Off by default because most
// callers pass DOM code that only a browser can run; a test that has stood up a
// fake `document` on globalThis turns it on to see the effect for itself. Only
// the argument-taking calls are run — the argument-less ones are the page's
// measurements, and those are answered by `observed`.
const inProcess = { run: false };

const page = (viewport) => {
	const state = { viewport: { width: 400, height: 800 } };
	const api = {
		async setViewport(v) {
			state.viewport = v;
			calls.push(['setViewport', v]);
		},
		async setExtraHTTPHeaders(h) {
			calls.push(['headers', h]);
		},
		setDefaultTimeout(ms) {
			calls.push(['timeout', ms]);
		},
		async goto(url) {
			calls.push(['goto', String(url)]);
		},
		async evaluate(fn, arg) {
			calls.push(['evaluate', typeof fn === 'string' ? fn : 'fn', arg ?? null]);
			if (inProcess.run && typeof fn === 'function' && arg !== undefined) fn(arg);
			// What the in-page probe "measured". A test sets `observed.value` to the
			// shape lib/qa-checks.mjs is meant to receive; every other evaluate call
			// in the callers ignores the return.
			return observed.value;
		},
		async addStyleTag(opts) {
			calls.push(['style', opts.content?.slice(0, 20) ?? '']);
		},
		async waitForSelector(sel) {
			calls.push(['waitFor', sel]);
		},
		async screenshot({ path }) {
			calls.push(['screenshot', path]);
			const img = sharp({ create: { width: state.viewport.width, height: state.viewport.height, channels: 4, background: { r: 240, g: 240, b: 240, alpha: 1 } } }).png();
			await img.toFile(path);
			// puppeteer hands the bytes back as well as writing them; the qa capture
			// hashes what it got rather than re-reading the file.
			return require('node:fs').readFileSync(path);
		},
		async close() {
			calls.push(['close']);
		},
	};
	void viewport;
	return api;
};

module.exports = {
	calls,
	observed,
	inProcess,
	async launch(opts) {
		calls.push(['launch', opts?.headless ?? null]);
		return {
			async newPage() {
				return page();
			},
			async close() {
				calls.push(['browserClose']);
			},
		};
	},
};

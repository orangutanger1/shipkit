// A stand-in for puppeteer: a browser that navigates nowhere and screenshots a
// solid page. `page.screenshot({path})` writes a real PNG at the viewport size,
// which is what the capture step's callers go on to measure and composite.
// Every call is recorded on `module.exports.calls` so a test can assert the
// locale headers, seeds and selectors the capture actually asked for.
'use strict';
const sharp = require('../sharp/index.cjs');

const calls = [];

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
		},
		async addStyleTag(opts) {
			calls.push(['style', opts.content?.slice(0, 20) ?? '']);
		},
		async waitForSelector(sel) {
			calls.push(['waitFor', sel]);
		},
		async screenshot({ path }) {
			calls.push(['screenshot', path]);
			await sharp({ create: { width: state.viewport.width, height: state.viewport.height, channels: 4, background: { r: 240, g: 240, b: 240, alpha: 1 } } })
				.png()
				.toFile(path);
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

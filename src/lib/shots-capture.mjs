// Acquiring the raw inputs a render composites.
//
// There is no simulator on Linux, so neither path here is a simulator shot:
//
// device-frame  drive the app's own web build in headless Chromium at the exact
//               device pixel size. Real code, real bundled faces, real business
//               logic, and the strings come from the app's own i18n bundle — so
//               the screens are translated by the binary, not by an image
//               editor. This is only faithful for an app whose UI is plain
//               View/Text/Pressable, where React Native Web renders what iOS
//               renders; anything drawing to a native canvas or reading a native
//               database will not survive the trip, which is exactly why
//               caption-band mode exists.
//
// caption-band  download the finished composites Apple is already serving. No
//               app involvement at all.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appDep } from './appdeps.mjs';
import { ShipError, note, step, warn } from '../log.mjs';

/** @typedef {import('../config.mjs').Config} Config */

/** A web scrollbar down the right edge is the one thing in these frames that
 *  could not exist on an iPhone, and it is what a reviewer notices. */
const KILL_SCROLLBARS = '::-webkit-scrollbar { display: none !important; }';

const CAPTURE_DEFAULTS = {
	viewport: { width: 428, height: 926, deviceScaleFactor: 3 },
	hideScrollbars: true,
	settleMs: 600,
	timeoutMs: 30000,
	localeParam: null,
};

/**
 * Date placeholders, resolved in UTC at capture time.
 *
 * A committed seed with hardcoded dates rots: "today" becomes last spring, and
 * a screen that lists today's activity renders empty. UTC, not local time,
 * because these apps bucket by the UTC date in a timestamp — a "today" row
 * written from a local-time Date lands on yesterday and produces exactly the
 * empty list this is meant to prevent.
 *
 *   {{today}}        2026-08-21
 *   {{today-3}}      three days earlier
 *   {{today+21}}     three weeks out — an expiry that is due, not expired
 *   {{month}}        2026-08
 *   {{month-1}}      the previous calendar month
 *   {{now}} {{now-2}} full ISO timestamps
 */
/**
 * @template T
 * @param {T} value
 * @param {Date} [now]
 * @returns {T}
 */
function resolveDates(value, now = new Date()) {
	if (typeof value === 'string')
		return /** @type {T} */ (/** @type {unknown} */ (value.replaceAll(/\{\{(today|month|now)(?:([-+])(\d+))?\}\}/g, (_, kind, sign, n) => {
			const d = new Date(now);
			const delta = (sign === '-' ? -1 : 1) * Number(n ?? 0);
			if (kind === 'month') d.setUTCMonth(d.getUTCMonth() + delta);
			else d.setUTCDate(d.getUTCDate() + delta);
			const iso = d.toISOString();
			return kind === 'month' ? iso.slice(0, 7) : kind === 'today' ? iso.slice(0, 10) : iso;
		})));
	if (Array.isArray(value)) return /** @type {T} */ (value.map((v) => resolveDates(v, now)));
	if (value && typeof value === 'object')
		return /** @type {T} */ (Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDates(v, now)])));
	return value;
}

/**
 * Recursive object merge; arrays and scalars are replaced wholesale. Both sides
 * come from parsed JSON, so a value is never `undefined` — only absent.
 */
/** @param {any} base @param {any} over @returns {any} */
function merge(base, over) {
	if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
	if (Array.isArray(base) || typeof base !== 'object' || base === null) return over;
	const out = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
	return out;
}

/**
 * localStorage payload for one locale: the shared seed, overlaid per locale,
 * with date placeholders resolved.
 *
 * Overlaying matters more than it looks. The browser profile is reused across
 * locale passes, so a later pass inherits the previous locale's storage — the
 * de-DE run would otherwise bill a German barn in dollars. Every pass writes
 * the full merged set, never a patch.
 *
 * The overlay is deep, so a locale states only what differs — one currency
 * code, not a second copy of the whole fixture that then drifts from it.
 */
/**
 * @param {{default?: Record<string, any>, byLocale?: Record<string, Record<string, any>>}|null} seed
 * @param {string} locale
 * @param {Date} [now]
 * @returns {Record<string, any>}
 */
export function seedFor(seed, locale, now = new Date()) {
	return resolveDates(merge(seed?.default ?? {}, seed?.byLocale?.[locale] ?? {}), now);
}

/**
 * Screenshot a set of app routes, once per locale.
 * @param {Config} cfg
 * @param {any} spec the resolved shots spec — see lib/shots-spec.mjs
 * @param {string[]} locales
 * @param {{onFrame?: (f: {locale: string, frame: string, file: string}) => void}} [opts]
 * @returns {Promise<Array<{locale:string, frame:string, file:string}>>}
 */
export async function captureWeb(cfg, spec, locales, { onFrame } = {}) {
	const capture = { ...CAPTURE_DEFAULTS, ...spec.capture };
	if (!capture.url)
		throw new ShipError('spec.capture.url is not set', {
			hint: 'start the web build (`npx expo start --web`) and point capture.url at it',
		});

	const puppeteer = await appDep(cfg, 'puppeteer');
	const seed = capture.storage?.seed
		? JSON.parse(await readFile(join(cfg.paths.store, capture.storage.seed), 'utf8'))
		: (capture.storage ?? null);
	const byFrame = new Map(spec.frames.map((/** @type {any} */ f) => [f.key, f]));
	const screens = capture.screens ?? [];
	if (!screens.length) throw new ShipError('spec.capture.screens[] is empty — nothing to capture');

	const browser = await puppeteer.launch({
		headless: true,
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
	});
	const written = [];
	try {
		for (const locale of locales) {
			const page = await browser.newPage();
			await page.setViewport(capture.viewport);
			await page.setExtraHTTPHeaders({ 'Accept-Language': locale });
			page.setDefaultTimeout(capture.timeoutMs);

			// Storage has to be written against the app's own origin, so land on
			// it first, seed, then reload into a seeded app.
			await page.goto(capture.url, { waitUntil: 'domcontentloaded' });
			const payload = seedFor(seed, locale);
			if (Object.keys(payload).length)
				await page.evaluate((/** @type {Record<string, unknown>} */ entries) => {
					for (const [k, v] of Object.entries(entries))
						globalThis.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
				}, payload);

			for (const screen of screens) {
				const frame = byFrame.get(screen.frame);
				if (!frame) throw new ShipError(`capture.screens references unknown frame ${screen.frame}`);
				// Routes carry placeholders too: an invoice screen is addressed by
				// month, and a hardcoded one drifts out of the seeded fixture.
				const url = new URL(resolveDates(screen.path ?? '/'), capture.url);
				if (capture.localeParam) url.searchParams.set(capture.localeParam, locale);
				await page.goto(url.toString(), { waitUntil: 'networkidle0' });
				if (capture.hideScrollbars) await page.addStyleTag({ content: KILL_SCROLLBARS });
				if (screen.waitFor) await page.waitForSelector(screen.waitFor);
				if (screen.evaluate) await page.evaluate(screen.evaluate);
				if (capture.settleMs) await new Promise((r) => setTimeout(r, capture.settleMs));

				const dest = join(spec.paths.raw, locale, spec.displayType, frame.src);
				await mkdir(join(spec.paths.raw, locale, spec.displayType), { recursive: true });
				await page.screenshot({ path: dest, type: 'png' });
				written.push({ locale, frame: frame.key, file: dest });
				onFrame?.({ locale, frame: frame.key, file: dest });
			}
			await page.close();
		}
	} finally {
		await browser.close();
	}
	return written;
}

/**
 * Download the composites the App Store is serving right now, as the base every
 * caption-band render repaints. One call, no credentials: the public lookup
 * endpoint carries the URLs.
 */
/**
 * @param {Config} cfg
 * @param {any} spec the resolved shots spec — see lib/shots-spec.mjs
 * @param {{force?: boolean}} [opts]
 */
export async function fetchLiveComposites(cfg, spec, { force = false } = {}) {
	const appId = cfg.asc.appId;
	if (!appId) throw new ShipError('asc.appId is required to download live screenshots');
	const country = (spec.base?.country ?? cfg.asc.primaryLocale ?? 'en-US').split('-').pop().toLowerCase();
	const res = await fetch(`https://itunes.apple.com/lookup?id=${appId}&country=${country}`);
	if (!res.ok) throw new ShipError(`App Store lookup failed: ${res.status}`);
	const body = /** @type {{results?: {screenshotUrls?: string[]}[]}} */ (await res.json());
	const urls = body.results?.[0]?.screenshotUrls ?? [];
	if (!urls.length)
		throw new ShipError('the App Store is serving no screenshots for this app', {
			hint: 'caption-band mode repaints existing composites; there is nothing to repaint yet',
		});

	await mkdir(spec.paths.base, { recursive: true });
	const dims = `${spec.canvas.w}x${spec.canvas.h}`;
	const written = [];
	for (const [i, url] of urls.entries()) {
		const frame = spec.frames[i];
		if (!frame) break;
		const dest = join(spec.paths.base, frame.base);
		if (existsSync(dest) && !force) {
			note(`${frame.base} already present`);
			written.push(dest);
			continue;
		}
		// Apple serves every size off one path; ask for the spec's canvas.
		const full = `${url.slice(0, url.lastIndexOf('/'))}/${dims}bb.png`;
		const img = await fetch(full);
		if (!img.ok) {
			warn(`${frame.key}: ${img.status} fetching ${dims}`);
			continue;
		}
		await writeFile(dest, Buffer.from(await img.arrayBuffer()));
		step(`fetched ${frame.base}`);
		written.push(dest);
	}
	return written;
}

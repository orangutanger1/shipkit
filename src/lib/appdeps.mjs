// Heavyweight image/browser libraries, resolved from the app repo — never from
// shipkit.
//
// shipkit declares zero dependencies on purpose: `ship --help`, `ship doctor`
// and every ASC command must work from a bare checkout, and `sharp` alone is a
// ~30MB platform-specific binary. Rendering screenshots is the one job that
// genuinely needs native code, and the app repo that renders them already
// carries those packages (barn-billing ships sharp + fontkit in devDependencies
// for exactly this). So resolve them out of the *app's* node_modules at call
// time and fail with the install line when they are absent, rather than making
// every other command pay for them.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ShipError } from '../log.mjs';

const CACHE = new Map();

/**
 * Package name → the npm install line that provides it, and the subcommand that
 * needs it. Printed verbatim on a miss; a hint the operator has to translate is
 * a hint that costs a round trip.
 */
const PROVIDES = {
	sharp: { pkg: 'sharp', why: 'compositing' },
	fontkit: { pkg: 'fontkit', why: 'caption glyph outlines' },
	puppeteer: { pkg: 'puppeteer', why: 'headless capture' },
};

/**
 * Resolution order: the app repo first (its lockfile pins the version the
 * renders were calibrated against), then shipkit itself, then the ambient
 * resolver so a globally linked install still works. Anything else and we would
 * be silently rendering with a different sharp than the one that produced the
 * committed reference.
 */
function resolvers(cfg) {
	const roots = [cfg?.paths?.app, cfg?.root].filter(Boolean);
	return [
		...roots.map((r) => createRequire(join(r, 'noop.cjs'))),
		createRequire(import.meta.url),
	];
}

/**
 * Load an optional native dependency from the app repo.
 * @param {import('../config.mjs').Config} cfg
 * @param {'sharp'|'fontkit'|'puppeteer'} name
 * @returns {Promise<any>} the module's default export when it has one
 */
export async function appDep(cfg, name) {
	const key = `${cfg?.root ?? ''}:${name}`;
	if (CACHE.has(key)) return CACHE.get(key);

	let last;
	for (const require of resolvers(cfg)) {
		try {
			const mod = require(name);
			const value = mod?.default && name !== 'fontkit' ? mod.default : mod;
			CACHE.set(key, value);
			return value;
		} catch (err) {
			last = err;
		}
	}

	const { pkg, why } = PROVIDES[name] ?? { pkg: name, why: 'rendering' };
	throw new ShipError(`${name} is not installed in this repo — it is what does the ${why}`, {
		hint: `npm i -D ${pkg}\n${last?.message ?? ''}`.trim(),
	});
}

/** Which of the render dependencies resolve here. Used by `ship doctor`. */
export async function probeDeps(cfg, names = Object.keys(PROVIDES)) {
	const out = {};
	for (const name of names) {
		try {
			await appDep(cfg, name);
			out[name] = true;
		} catch {
			out[name] = false;
		}
	}
	return out;
}

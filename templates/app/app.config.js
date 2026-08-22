/**
 * Two installable identities and one list of shipped languages, from one config.
 *
 * iOS allows exactly one app per bundle identifier. When the development build
 * and the TestFlight build share one, installing from TestFlight silently
 * replaces the dev client — Fast Refresh just disappears, with no error
 * anywhere. Suffixing the identifier and the URL scheme for the dev variant
 * lets both live on the phone at once, and makes it obvious on the home screen
 * which one you opened.
 *
 * `APP_VARIANT=development` comes from the `development` profile in eas.json
 * for builds, and from the `start`/`ios` scripts for the local dev server. The
 * dev server has to agree with the installed app about the scheme, or the deep
 * link the QR code encodes opens the wrong app.
 *
 * CFBundleLocalizations is derived from `src/i18n/` rather than typed out
 * again. iOS hands the app only the languages the bundle declares: on a German
 * phone an app that never declared `de` is offered `en`, the German catalogue
 * never activates, and the German store listing you paid for sells an English
 * binary. Two hand-maintained lists is how that happens, so there is one —
 * adding `src/i18n/fr.ts` is the whole change.
 *
 * Anything not overridden here comes straight from app.json.
 */
const { readdirSync } = require('node:fs');
const { join } = require('node:path');

const IS_DEV = process.env.APP_VARIANT === 'development';

/** One `src/i18n/<language code>.ts` per shipped language; `index.ts` is not one. */
const localizations = () => {
	const dir = join(__dirname, 'src', 'i18n');
	const codes = readdirSync(dir)
		.filter((f) => /^[a-z]{2}(-[A-Za-z]{2,4})?\.ts$/.test(f))
		.map((f) => f.replace(/\.ts$/, ''))
		.sort();
	if (!codes.length) throw new Error(`app.config.js: no string catalogues in ${dir}`);
	return codes;
};

module.exports = ({ config }) => {
	const ios = {
		...config.ios,
		infoPlist: { ...config.ios.infoPlist, CFBundleLocalizations: localizations() },
	};
	if (!IS_DEV) return { ...config, ios };

	return {
		...config,
		name: `${config.name} (dev)`,
		scheme: `${config.scheme}dev`,
		ios: { ...ios, bundleIdentifier: `${ios.bundleIdentifier}.dev` },
	};
};

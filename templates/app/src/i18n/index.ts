// Hand-rolled, because the job is looking a key up in a record and every i18n
// framework that does it for you also brings a plural engine, an ICU parser and
// a loader you would then have to keep off the startup path.
//
// Two operational facts shape this file:
//
//   1. iOS only offers the app the languages the bundle declares in
//      CFBundleLocalizations. On a German phone, an app that forgot to declare
//      `de` gets `en` back from getLocales() and this catalogue never activates
//      — the German listing sells an English binary. app.config.js derives that
//      plist array from the file names in this directory so the two cannot
//      drift; a catalogue is named for its language code for that reason.
//   2. The preferred-language list is fixed when the process launches, so this
//      resolves once. Nothing here reacts to a language change, because iOS
//      restarts the app when the user makes one. (The screenshot job relaunches
//      the app between locales for the same reason.)
//
// The fallback is whole-catalogue, not per-key: `Strings` forces every locale to
// be complete, so there is no such thing as a half-translated screen.
import { getLocales } from 'expo-localization';
import { de } from './de';
import { en, type StringKey, type Strings } from './en';

export const SOURCE_LANGUAGE = 'en';

const CATALOGUES = { en, de } satisfies Record<string, Strings>;

export type Language = keyof typeof CATALOGUES;

/** First device language we actually ship, in the user's own order of preference. */
const resolve = (): Language => {
	for (const { languageCode } of getLocales())
		if (languageCode && languageCode in CATALOGUES) return languageCode as Language;
	return SOURCE_LANGUAGE;
};

export const language: Language = resolve();

const strings = CATALOGUES[language];

export const t = (key: StringKey): string => strings[key];

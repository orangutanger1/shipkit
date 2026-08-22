// The source of truth for every string the user can read, and the only file a
// new key is added to first: `Strings` is derived from this object, so a locale
// that has not caught up fails `tsc` instead of shipping an English sentence
// into the middle of a German screen.
//
// Keys are named after the surface they render on, never after the English
// words they currently hold — rewording the copy must not rename a key in every
// other catalogue.
export const en = {
	'app.name': '__NAME__',
	'home.subtitle.pro': 'Pro unlocked. Everything is yours.',
	'home.subtitle.free': 'The free tier. There is more.',
	'home.action.upgrade': 'Upgrade to Pro',
	'home.action.busy': 'One moment…',
	'home.action.restore': 'Restore purchases',
	'error.title': 'Something went wrong',
	'error.action.retry': 'Try again',
};

export type StringKey = keyof typeof en;

/** A complete catalogue. Every locale file is annotated with this on purpose. */
export type Strings = Record<StringKey, string>;

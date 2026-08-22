// German. Second locale on purpose: a one-locale i18n layer is untested
// plumbing, and the first real translation is where the mechanism either works
// or falls over (missing key, plural, a label that no longer fits the button).
//
// Feature names come from `store/glossary.json`. Whatever this file calls a
// feature is what the German App Store listing must call it, and the reverse —
// a user who searched for one word and finds another in the binary bounces.
import type { Strings } from './en';

export const de: Strings = {
	// The app name is a brand, not copy. It is a glossary `neverTranslate` entry.
	'app.name': '__NAME__',
	'home.subtitle.pro': 'Pro ist freigeschaltet. Alles gehört dir.',
	'home.subtitle.free': 'Die kostenlose Version. Es geht noch mehr.',
	'home.action.upgrade': 'Pro freischalten',
	'home.action.busy': 'Einen Moment…',
	'home.action.restore': 'Käufe wiederherstellen',
	'error.title': 'Da ist etwas schiefgelaufen',
	'error.action.retry': 'Erneut versuchen',
};

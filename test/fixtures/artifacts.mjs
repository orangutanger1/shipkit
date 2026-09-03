// Minimal valid documents for every schema/*.schema.json. Tests mutate a clone
// to prove a rule bites, so these stay as small as the schema allows.
const SHA = 'a'.repeat(64);
const NOW = '2026-09-02T12:00:00Z';

const token = (value) => ({ value, cite: 'HIG:color/contrast' });
const SEMANTIC = ['background', 'surface', 'surfaceAlt', 'text', 'textMuted', 'textInverse', 'accent', 'accentText', 'border', 'success', 'warning', 'danger'];
const theme = (hex) => Object.fromEntries(SEMANTIC.map((k) => [k, token(hex)]));

export const plan = {
	slug: '2026-09-02',
	createdAt: NOW,
	provider: 'appstore',
	country: 'US',
	product: { category: 'health-fitness', audience: 'lapsed runners' },
	flows: ['paywall'],
	apps: [{ trackId: 341232718, name: 'Reference App', rank: 1, score: 25.02, ratings: 210433, stars: 4.7, why: '4.7★ over 210,433 ratings' }],
	sorts: ['mostrecent', 'mosthelpful'],
	budget: { apps: 12, screensPerApp: 10, reviewPages: 10, requests: { lookup: 1, screenshots: 10, reviews: 20, total: 31 } },
	outputs: {
		references: '2026-09-02/references',
		reviews: '2026-09-02/reviews',
		assets: '2026-09-02/assets',
		themes: '2026-09-02/themes.json',
		patterns: '2026-09-02/patterns.json',
		index: '2026-09-02/index.json',
	},
};

export const reference = {
	id: 'ref_a1b2c3',
	provider: 'appstore',
	providerId: '341232718#screen-3',
	kind: 'screen',
	app: { name: 'Reference App', trackId: 341232718, rating: 4.7, ratingCount: 210433, ratingVelocity: null, hasIap: true },
	flow: 'paywall',
	position: 3,
	image: { path: 'assets/ref_a1b2c3.png', sha256: SHA, w: 1290, h: 2796 },
	sourceUrl: 'https://apps.apple.com/us/app/id341232718',
	capturedAt: NOW,
	observations: { summary: 'Annual plan preselected, monthly one tap away.' },
	doNotCopy: 'Wordmark, illustration style, and the plan naming.',
	confidence: 'high',
};

export const reviews = {
	trackId: 341232718,
	country: 'us',
	fetchedAt: NOW,
	sorts: ['mostrecent', 'mosthelpful'],
	count: 2,
	appMeanRating: 4.7,
	reviews: [
		{ id: 'r1', rating: 2, version: '26.34.0', date: NOW, title: 'Logging is slow', body: 'Six taps to log a meal.', sort: 'mostrecent' },
		{ id: 'r2', rating: 5, version: '26.34.0', date: NOW, title: 'Great', body: 'Worth it.', sort: 'mosthelpful' },
	],
};

export const themes = {
	generatedAt: NOW,
	themes: [{
		label: 'logging friction',
		kind: 'pain',
		trackId: 341232718,
		support: 1,
		ratingSkew: -2.7,
		versions: ['26.34.0'],
		quotes: ['Six taps to log a meal.'],
		reviewIds: ['r1'],
		flow: 'create',
	}],
};

export const patterns = {
	generatedAt: NOW,
	claims: [{
		id: 'claim_annual-preselected',
		claim: 'Paywalls preselect the annual plan and show the monthly price beside it.',
		kind: 'evidence',
		flow: 'paywall',
		refs: ['ref_a1b2c3', 'ref_d4e5f6', 'ref_112233'],
		counterexamples: [],
		confidence: 'high',
		assumptions: [],
	}],
};

export const designSystem = {
	generatedAt: NOW,
	brand: { name: 'Demo', direction: 'Calm, dense, and legible at a glance.' },
	color: { accentHue: 212, themes: { light: theme('#1b6ef3'), dark: theme('#7fb0ff') } },
	type: {
		family: { text: 'SF Pro Text' },
		ramp: [
			{ name: 'title', size: 28, lineHeight: 34, weight: 700, cite: 'HIG:typography/ios' },
			{ name: 'headline', size: 20, lineHeight: 25, weight: 600, cite: 'HIG:typography/ios' },
			{ name: 'body', size: 17, lineHeight: 22, weight: 400, cite: 'HIG:typography/ios' },
			{ name: 'caption', size: 13, lineHeight: 18, weight: 400, cite: 'HIG:typography/ios' },
		],
	},
	spacing: { base: 4, scale: [4, 8, 12, 16, 24], cite: 'HIG:layout/spacing' },
	radii: { card: token(12) },
	motion: {
		durations: { standard: token(250) },
		curves: { standard: token('cubic-bezier(0.2, 0, 0, 1)') },
		reducedMotion: 'Cross-fade in place; no translation, no spring.',
	},
	haptics: { 'paywall.completed': token('success') },
};

export const uxSpec = {
	generatedAt: NOW,
	screens: [{
		id: 'paywall',
		route: '/paywall',
		flow: 'paywall',
		purpose: 'Sell the annual plan after first value is visible.',
		components: ['plan-picker'],
		copy: { title: 'Keep going' },
		states: ['default', 'loading', 'error'],
		events: [{ name: 'paywall_viewed', flow: 'paywall', verb: 'viewed' }],
		monetization: { offering: 'default', entitlement: 'pro' },
	}],
	flows: [{ id: 'paywall', screens: ['paywall'], success: 'Purchase completes and the entitlement is active.' }],
};

export const qaReport = {
	version: '1.0.0',
	generatedAt: NOW,
	tier: 1,
	matrix: { themes: ['light', 'dark'], locales: ['en-US'], dynamicType: ['default', 'xl'] },
	checks: [
		{ id: 'tap-target-paywall-cta', category: 'tap-target', requiresTier: 1, status: 'PASS', screen: 'paywall', measured: 48, threshold: 44 },
		{ id: 'motion-paywall-entry', category: 'motion', requiresTier: 2, status: 'SKIPPED', screen: 'paywall', message: 'Tier 2 did not run.' },
	],
	summary: { pass: 1, warn: 0, fail: 0, skipped: 1 },
};

/** Every fixture keyed by the schema it must satisfy. */
export const ARTIFACTS = {
	'research-plan': plan,
	'research-reference': reference,
	'research-reviews': reviews,
	'research-themes': themes,
	'research-patterns': patterns,
	'design-system': designSystem,
	'ux-spec': uxSpec,
	'qa-report': qaReport,
};

/** A deep clone, so a test can break one field without leaking into the next. */
export const clone = (value) => structuredClone(value);

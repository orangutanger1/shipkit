// The mechanical review blockers. Every assertion here maps to a submission that
// gets held, bounced or pulled from a storefront, so a refactor that inverts one
// costs a release cycle. Pure predicates only: no network, no asc, no fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	COMPLIANCE_CODE_KEY,
	levelOf,
	validationItems,
	validationRow,
	ENCRYPTION_KEY,
	ageRatingGaps,
	classifyAsc,
	contentRightsAnswer,
	euLocalesIn,
	euTraderRequired,
	missingComplianceCode,
	missingEncryptionKey,
	privacyDeclarationCount,
} from '../src/commands/preflight.mjs';

const expo = (infoPlist) => ({ name: 'app', ios: { infoPlist } });

test('export compliance: an app.json without the encryption key is a blocker', () => {
	// Absent means every build parks in "Waiting for Export Compliance".
	assert.equal(missingEncryptionKey(expo({})), true);
	assert.equal(missingEncryptionKey({ name: 'app' }), true);
	assert.equal(missingEncryptionKey(null), true);
	assert.equal(missingEncryptionKey(expo({ [ENCRYPTION_KEY]: null })), true);
});

test('export compliance: false and true both count as answered', () => {
	assert.equal(missingEncryptionKey(expo({ [ENCRYPTION_KEY]: false })), false);
	assert.equal(missingEncryptionKey(expo({ [ENCRYPTION_KEY]: true })), false);
});

test('export compliance: an unwrapped `expo` block is read the same way', () => {
	assert.equal(missingEncryptionKey({ expo: { ios: { infoPlist: { [ENCRYPTION_KEY]: false } } } }), false);
	assert.equal(missingEncryptionKey({ expo: { ios: { infoPlist: {} } } }), true);
});

test('export compliance: non-exempt encryption still needs the compliance code', () => {
	assert.equal(missingComplianceCode(expo({ [ENCRYPTION_KEY]: true })), true);
	assert.equal(missingComplianceCode(expo({ [ENCRYPTION_KEY]: true, [COMPLIANCE_CODE_KEY]: 'abc-123' })), false);
	// Declaring exemption asks nothing further.
	assert.equal(missingComplianceCode(expo({ [ENCRYPTION_KEY]: false })), false);
	assert.equal(missingComplianceCode(expo({})), false);
});

test('eu trader: an EU locale in store.locales requires the declaration', () => {
	assert.equal(euTraderRequired(['en-US', 'de-DE']), true);
	assert.equal(euTraderRequired(['fi']), true);
	assert.deepEqual(euLocalesIn(['en-US', 'de-DE', 'ja', 'it']), ['de-DE', 'it']);
});

test('eu trader: non-EU storefronts do not require it', () => {
	assert.equal(euTraderRequired(['en-US', 'ja', 'ko', 'zh-Hans']), false);
	// Norway, the UK, Ukraine and Turkey are not EU member states.
	assert.equal(euTraderRequired(['no', 'en-GB', 'uk', 'tr', 'ru']), false);
	// Language variants Apple also ships outside the EU must not trigger it.
	assert.equal(euTraderRequired(['fr-CA', 'es-MX', 'pt-BR']), false);
	assert.equal(euTraderRequired([]), false);
	assert.equal(euTraderRequired(undefined), false);
});

test('eu trader: locale matching ignores case and stray whitespace', () => {
	assert.deepEqual(euLocalesIn([' de-DE ', 'NL-nl']), [' de-DE ', 'NL-nl']);
});

const ageRating = (attrs) => ({ data: { type: 'ageRatingDeclarations', id: 'x', attributes: attrs } });

test('age rating: a fully answered questionnaire has no gaps', () => {
	const gaps = ageRatingGaps(
		ageRating({ gambling: false, violenceCartoonOrFantasy: 'NONE', ageRatingOverride: 'NONE', kidsAgeBand: null }),
	);
	assert.deepEqual(gaps, []);
});

test('age rating: unanswered questions are named, overrides are not', () => {
	const gaps = ageRatingGaps(ageRating({ gambling: null, contests: 'NONE', koreaAgeRatingOverride: null }));
	assert.deepEqual(gaps, ['gambling']);
});

test('age rating: a missing declaration is distinct from an incomplete one', () => {
	// null tells the caller "no declaration exists", [] tells it "complete".
	assert.equal(ageRatingGaps(null), null);
	assert.equal(ageRatingGaps({ data: null }), null);
	assert.equal(ageRatingGaps({}), null);
	assert.equal(ageRatingGaps({ data: { type: 'ageRatingDeclarations', id: 'x' } }), null);
});

test('content rights: an answered declaration comes back, either way', () => {
	assert.equal(
		contentRightsAnswer({ app_id: '1', content_rights_declaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' }),
		'DOES_NOT_USE_THIRD_PARTY_CONTENT',
	);
	assert.equal(
		contentRightsAnswer({ data: { attributes: { contentRightsDeclaration: 'USES_THIRD_PARTY_CONTENT' } } }),
		'USES_THIRD_PARTY_CONTENT',
	);
});

test('content rights: unanswered is null, whatever shape that arrives in', () => {
	assert.equal(contentRightsAnswer({ app_id: '1', content_rights_declaration: null }), null);
	assert.equal(contentRightsAnswer({ data: { attributes: { contentRightsDeclaration: 'NOT_ANSWERED' } } }), null);
	assert.equal(contentRightsAnswer({}), null);
	assert.equal(contentRightsAnswer(null), null);
});

test('privacy labels: an empty declaration set is zero', () => {
	assert.equal(privacyDeclarationCount({ declarations: [] }), 0);
	assert.equal(privacyDeclarationCount({}), 0);
	assert.equal(privacyDeclarationCount(null), 0);
});

test('privacy labels: declared data usages are counted through any envelope', () => {
	assert.equal(privacyDeclarationCount({ declarations: [{ dataType: 'EMAIL' }, { dataType: 'DEVICE_ID' }] }), 2);
	assert.equal(privacyDeclarationCount({ data: { dataUsages: [{ purpose: 'ANALYTICS' }] } }), 1);
	assert.equal(privacyDeclarationCount([{ purpose: 'ANALYTICS' }, {}, {}]), 3);
});

test('asc probe: a clean JSON answer is `ok`', () => {
	const res = classifyAsc({ code: 0, stdout: '{"authenticated":true}\n', stderr: '' });
	assert.equal(res.state, 'ok');
	assert.equal(res.payload.authenticated, true);
});

test('asc probe: an old CLI degrades to `unsupported`, never a failure', () => {
	// A preflight that hard-fails because asc is one version behind is one nobody runs.
	const res = classifyAsc({ code: 1, stdout: '', stderr: 'Error: unknown command "content-rights" for "asc apps"' });
	assert.equal(res.state, 'unsupported');
	assert.match(res.detail, /unknown command/);
});

test('asc probe: missing credentials degrade to `unauthorized`, never a failure', () => {
	assert.equal(classifyAsc({ code: 1, stderr: 'no stored credentials; run `asc auth login`' }).state, 'unauthorized');
	assert.equal(classifyAsc({ code: 1, stderr: 'request failed: 401 Unauthorized' }).state, 'unauthorized');
});

test('asc probe: any other non-zero exit stays an error the report can show', () => {
	const res = classifyAsc({ code: 1, stdout: '', stderr: 'App Store Connect returned 500' });
	assert.equal(res.state, 'error');
	assert.equal(res.payload, null);
});

test('asc probe: a banner before the JSON body does not lose the payload', () => {
	const res = classifyAsc({ code: 0, stdout: '[experimental] discouraged\n{"declarations":[{"a":1}]}\n' });
	assert.equal(res.state, 'ok');
	assert.equal(privacyDeclarationCount(res.payload), 1);
});

test('asc probe: silence is `empty`, not a bogus payload', () => {
	assert.deepEqual(classifyAsc({ code: 0, stdout: '   ' }), { state: 'empty', payload: null, detail: '' });
	assert.equal(classifyAsc().state, 'empty');
});

// ─── severity words, from two different vendors ─────────────────────────────

test('every severity word asc and RevenueCat use maps to a report level', () => {
	// These arrive as free text from two tools that do not agree with each
	// other. A word that falls through reads as a failure, which is the safe
	// direction — but only the ones that really are failures should get there.
	for (const word of ['error', 'invalid', 'blocker', 'critical']) assert.equal(levelOf(word), 'fail');
	for (const word of ['warning', 'caution']) assert.equal(levelOf(word), 'warn');
	for (const word of ['info', 'notice', 'passed', 'pass', 'valid']) assert.equal(levelOf(word), 'ok');
	for (const word of ['skipped', 'not_applicable']) assert.equal(levelOf(word), 'skip');
	assert.equal(levelOf('WARNING'), 'warn', 'the comparison is case-insensitive');
	assert.equal(levelOf('ok'), 'ok', 'a word that is already a level passes through');
});

test('a severity nobody recognises is a failure, unless the caller says otherwise', () => {
	// An unknown word must not read as "fine": a new asc severity would then
	// silently stop blocking submissions.
	assert.equal(levelOf('kerfuffle'), 'fail');
	assert.equal(levelOf('kerfuffle', 'warn'), 'warn');
	assert.equal(levelOf(''), 'fail');
});

// ─── the validate payload, in the shapes asc has sent ───────────────────────

test('validationItems finds the rows wherever the payload put them', () => {
	assert.deepEqual(validationItems({ remediation: { steps: [{ id: 'a' }] }, checks: [{ id: 'b' }] }), [{ id: 'a' }],
		'the remediation plan is already in fix order, so it wins over checks');
	assert.deepEqual(validationItems({ checks: [{ id: 'b' }] }), [{ id: 'b' }]);
	assert.deepEqual(validationItems({ data: { attributes: { problems: [{ id: 'c' }] } } }), [{ id: 'c' }]);
	assert.deepEqual(validationItems([{ id: 'd' }]), [{ id: 'd' }], 'a bare array is the rows themselves');
	assert.deepEqual(validationItems({ data: { checks: [{ id: 'e' }] } }), [{ id: 'e' }],
		'a data envelope with no attributes wrapper is read straight through');
});

test('a validate payload with nothing in it is no rows, not a crash', () => {
	for (const empty of [undefined, null, '', 0, 'a banner line', { remediation: { steps: [] }, checks: [] }, { data: {} }])
		assert.deepEqual(validationItems(empty), [], `${JSON.stringify(empty)} is empty`);
});

test('a validation row names its check, its fix and what it is about', () => {
	const row = validationRow({
		checkId: 'ITMS-90683',
		message: 'Missing purpose string',
		remediation: 'Add NSCameraUsageDescription',
		resourceType: 'bundle',
		resourceId: 'com.demo.app',
		severity: 'error',
	}, 0);
	assert.equal(row.level, 'fail');
	assert.equal(row.name, 'ITMS-90683');
	assert.match(row.detail, /Missing purpose string/);
	assert.match(row.detail, /Add NSCameraUsageDescription/);
	assert.match(row.detail, /\(bundle com\.demo\.app\)/);
});

test('a resource named only by type carries no subject', () => {
	// Half a reference is worse than none: "(bundle)" tells the operator nothing
	// about which bundle.
	const row = validationRow({ id: 'x', message: 'Something', resourceType: 'bundle' }, 0);
	assert.equal(row.detail, 'Something');
});

test('a validation row reads its severity from whichever field carries it', () => {
	assert.equal(validationRow({ id: 'a', level: 'warning' }, 0).level, 'warn');
	assert.equal(validationRow({ id: 'a', status: 'invalid' }, 0).level, 'fail');
	assert.equal(validationRow({ id: 'a' }, 0).level, 'fail', 'no severity anywhere is still a failure');
});

test('asc\'s own `blocking` verdict outranks the severity beside it', () => {
	// asc marks a step blocking when it stops a submission. A step it calls
	// blocking but labels "warning" still has to fail the preflight.
	assert.equal(validationRow({ id: 'a', severity: 'warning', blocking: true }, 0).level, 'fail');
	assert.equal(validationRow({ id: 'a', severity: 'info' }, 0).level, 'skip',
		'an info step is an unverifiable note, not work');
});

test('a validation row that is a bare string, or not an object at all, is still a row', () => {
	assert.deepEqual(validationRow('Missing icon', 0), { level: 'fail', name: '#1', detail: 'Missing icon' });
	assert.deepEqual(validationRow(42, 3), { level: 'fail', name: '#4', detail: '' });
	assert.equal(validationRow({ message: 'no id here' }, 6).name, '#7', 'a row with no name is numbered');
});

// ─── salvaging asc's stdout ─────────────────────────────────────────────────

test('asc probe: a banner before the JSON is stepped over, and unparseable output is not JSON', () => {
	// asc occasionally prefixes a warning line. Failing on that would report a
	// broken CLI for a run that succeeded.
	assert.deepEqual(classifyAsc({ stdout: 'warning: update available\n{"ok":true}' }).payload, { ok: true });
	assert.equal(classifyAsc({ stdout: 'no json at all here' }).state, 'empty');
	assert.equal(classifyAsc({ stdout: '{not really json' }).state, 'empty');
});

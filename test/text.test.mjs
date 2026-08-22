// Locale-aware tokenisation. These are the cases whitespace splitting gets wrong
// and that silently corrupted keyword-coverage logic for every CJK storefront.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	charCount,
	indexedWords,
	isCovered,
	isNoSpaceLang,
	keywordFieldLength,
	langOf,
	overlap,
	stopwordsFor,
	words,
} from '../src/lib/text.mjs';

test('langOf strips the region from an ASC locale', () => {
	assert.equal(langOf('de-DE'), 'de');
	assert.equal(langOf('zh-Hans'), 'zh');
	assert.equal(langOf('en'), 'en');
	assert.equal(langOf(undefined), 'en');
});

test('Japanese has no spaces and still segments into words', () => {
	assert.ok(isNoSpaceLang('ja-JP'));
	assert.deepEqual(words('カレンダー予定管理', 'ja').length >= 2, true);
	// A whitespace tokeniser returns exactly one token here, which is the bug.
	assert.notEqual(words('カレンダー予定管理', 'ja').length, 1);
});

test('words lowercases and drops punctuation, keeping diacritics', () => {
	assert.deepEqual(words('KFZ-Scheckheft, führen!', 'de'), ['kfz', 'scheckheft', 'führen']);
});

test('stop words are per language, not English everywhere', () => {
	assert.ok(stopwordsFor('de-DE').has('und'));
	assert.ok(!stopwordsFor('de-DE').has('and'));
	assert.ok(stopwordsFor('xx-XX').has('the'), 'unknown languages fall back to English');
});

test('indexedWords drops stop words and single letters outside CJK', () => {
	const idx = indexedWords('Glovebox: The Car Maintenance App', 'en-US');
	assert.ok(idx.has('glovebox'));
	assert.ok(idx.has('maintenance'));
	assert.ok(!idx.has('the'), 'stop word kept');
	assert.ok(!idx.has('app'), 'Apple indexes "app" for free');
});

test('indexedWords keeps single-character tokens for no-space languages', () => {
	const idx = indexedWords('家計簿', 'ja-JP');
	assert.ok(idx.size >= 1);
	for (const w of idx) assert.ok(w.length >= 1);
});

test('isCovered is true only when every token is already indexed', () => {
	const idx = indexedWords('Car Maintenance Log', 'en-US');
	assert.equal(isCovered('car log', idx, 'en-US'), true);
	assert.equal(isCovered('car service log', idx, 'en-US'), false);
	assert.equal(isCovered('', idx, 'en-US'), false);
});

test('charCount counts code points, which is what ASC counts', () => {
	assert.equal(charCount('日本語🚗'), 4);
	assert.notEqual(charCount('日本語🚗'), '日本語🚗'.length);
	assert.equal(charCount(null), 0);
});

test('keywordFieldLength measures the packed comma-separated field', () => {
	assert.equal(keywordFieldLength(['car', 'log']), 7);
	// No space after the comma: each one would waste an indexed character.
	assert.equal(keywordFieldLength(['a', 'b', 'c']), 5);
});

test('overlap detects a word-for-word translation of the same phrase', () => {
	assert.equal(overlap('car maintenance log', 'car maintenance log', 'en'), 1);
	assert.equal(overlap('car maintenance log', 'boat rental price', 'en'), 0);
	assert.ok(overlap('car maintenance log', 'car maintenance', 'en') > 0.5);
});

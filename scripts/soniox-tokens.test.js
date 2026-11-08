const assert = require('assert');
const {
  applySonioxTokens,
  buildSonioxStartMessage,
  emptyCaption,
  floatToPcm16le,
  liveCaptionText,
  takeCommittedPhrase,
} = require('../out-tsc/soniox/soniox-tokens.js');

function apply(state, tokens) {
  return applySonioxTokens(state, tokens);
}

let state = emptyCaption();
state = apply(state, [{ text: 'Hel', is_final: false, language: 'en' }]);
assert.strictEqual(liveCaptionText(state), 'Hel');
state = apply(state, [{ text: 'Hello', is_final: false, language: 'en' }]);
assert.strictEqual(liveCaptionText(state), 'Hello');
assert.strictEqual(state.finalText, '');

state = apply(state, [{ text: 'Hello', is_final: true, language: 'en' }]);
assert.strictEqual(state.provisional, '');
const committed = takeCommittedPhrase(state);
assert.ok(committed);
assert.strictEqual(committed.text, 'Hello');
state = committed.next;
assert.strictEqual(liveCaptionText(state), '');

state = apply(state, [
  { text: ' there', is_final: true, language: 'en' },
  { text: ' friend', is_final: false, language: 'en' },
]);
assert.strictEqual(liveCaptionText(state), ' there friend');
assert.strictEqual(takeCommittedPhrase(state), null);
state = apply(state, [{ text: ' friend', is_final: true, language: 'en' }]);
const second = takeCommittedPhrase(state);
assert.strictEqual(second.text, 'there friend');

let mixed = emptyCaption();
mixed = apply(mixed, [
  { text: 'مرحبا', is_final: false, language: 'ar' },
  { text: ' Angular', is_final: false, language: 'en' },
]);
assert.strictEqual(liveCaptionText(mixed), 'مرحبا Angular');
mixed = apply(mixed, [
  { text: 'مرحبا', is_final: true, language: 'ar' },
  { text: ' Angular', is_final: true, language: 'en' },
]);
const arabic = takeCommittedPhrase(mixed);
assert.strictEqual(arabic.text, 'مرحبا Angular');
assert.strictEqual(arabic.next.language, 'en');

const pcm = floatToPcm16le(Float32Array.of(0, 1, -1));
assert.strictEqual(pcm.length, 6);
assert.strictEqual(pcm.readInt16LE(0), 0);
assert.strictEqual(pcm.readInt16LE(2), 32767);
assert.strictEqual(pcm.readInt16LE(4), -32768);

const config = buildSonioxStartMessage();
assert.strictEqual(config.model, 'stt-rt-v6');
assert.strictEqual(config.audio_format, 'pcm_s16le');
assert.strictEqual(config.sample_rate, 16000);
assert.strictEqual(config.num_channels, 1);
assert.deepStrictEqual(config.language_hints, ['en', 'fr', 'de', 'ar']);
assert.strictEqual(config.enable_language_identification, true);
assert.strictEqual(config.language_hints_strict, undefined);
assert.strictEqual(config.translation, undefined);
assert.strictEqual(config.api_key, undefined);
assert.ok(config.context.terms.includes('Mohamed Iheb Ben Slama'));
assert.ok(config.context.terms.includes('ESPRIT'));
assert.ok(config.context.terms.includes('Spring Boot'));
assert.ok(config.context.terms.includes('Angular'));

console.log('soniox token checks passed');

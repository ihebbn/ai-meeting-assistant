import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cleanupTranscript, guessLanguageFromScript } from './text';

describe('cleanupTranscript', () => {
  it('removes annotations, filler and noise tags', () => {
    assert.equal(cleanupTranscript('um hello *cough* [MUSIC] (laughs) world'), 'hello world');
  });

  it('trims edge punctuation and collapses whitespace', () => {
    assert.equal(cleanupTranscript(' ,.  good   morning ., '), 'good morning');
  });

  it('returns an empty string for noise-only input', () => {
    assert.equal(cleanupTranscript('[BLANK_AUDIO] *click*'), '');
  });

  it('keeps Arabic and French text intact', () => {
    assert.equal(cleanupTranscript('مرحبا بالعالم'), 'مرحبا بالعالم');
    assert.equal(cleanupTranscript('Bonjour, ça va très bien'), 'Bonjour, ça va très bien');
  });
});

describe('guessLanguageFromScript', () => {
  it('detects Arabic script', () => {
    assert.equal(guessLanguageFromScript('مرحبا'), 'ar');
  });

  it('detects French diacritics', () => {
    assert.equal(guessLanguageFromScript('déjà vu'), 'fr');
  });

  it('falls back to English for plain Latin text', () => {
    assert.equal(guessLanguageFromScript('hello there'), 'en');
  });

  it('returns null when there is no letter', () => {
    assert.equal(guessLanguageFromScript('123 ...'), null);
  });
});

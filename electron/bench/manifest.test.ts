import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseManifest } from './manifest';

const ok = { id: 'a', audio: 'a.wav', reference: 'hello world' };

describe('parseManifest', () => {
  it('accepts an array and applies defaults', () => {
    const [clip] = parseManifest([ok]);
    assert.deepEqual(clip, { ...ok, language: 'auto', tags: [] });
  });

  it('accepts the { clips } form', () => {
    assert.equal(parseManifest({ clips: [ok] }).length, 1);
  });

  it('rejects empty, malformed and duplicate input', () => {
    assert.throws(() => parseManifest([]), /no clips/);
    assert.throws(() => parseManifest({}), /array of clips/);
    assert.throws(() => parseManifest([ok, ok]), /duplicate id/);
  });

  it('validates fields with precise messages', () => {
    assert.throws(() => parseManifest([{ ...ok, id: '' }]), /"id"/);
    assert.throws(() => parseManifest([{ ...ok, audio: 3 }]), /"audio"/);
    assert.throws(() => parseManifest([{ ...ok, reference: ' ' }]), /"reference"/);
    assert.throws(() => parseManifest([{ ...ok, language: 'de' }]), /"language"/);
    assert.throws(() => parseManifest([{ ...ok, tags: [1] }]), /"tags"/);
  });
});

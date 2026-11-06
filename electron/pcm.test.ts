import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { toFloat32Pcm } from './pcm';

describe('toFloat32Pcm', () => {
  it('returns a Float32Array unchanged (same instance)', () => {
    const input = Float32Array.from([0.1, -0.2]);
    assert.equal(toFloat32Pcm(input), input);
  });

  it('wraps an ArrayBuffer and drops trailing partial samples', () => {
    const source = Float32Array.from([0.5, -0.5, 0.25]);
    const bytes = source.buffer.slice(0, 10); // 2 full samples + 2 stray bytes
    const out = toFloat32Pcm(bytes);
    assert.deepEqual(Array.from(out), [0.5, -0.5]);
  });

  it('converts legacy number[] and sanitises non-numbers', () => {
    const out = toFloat32Pcm([0.5, 'x', null, 1]);
    assert.deepEqual(Array.from(out), [0.5, 0, 0, 1]);
  });

  it('returns an empty array for unsupported input', () => {
    assert.equal(toFloat32Pcm(undefined).length, 0);
    assert.equal(toFloat32Pcm('abc').length, 0);
    assert.equal(toFloat32Pcm({}).length, 0);
  });
});

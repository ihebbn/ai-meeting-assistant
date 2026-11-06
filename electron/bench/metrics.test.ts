import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  charErrors,
  editDistance,
  normalizeForScoring,
  percentile,
  rate,
  sumErrors,
  wordErrors,
} from './metrics';

describe('normalizeForScoring', () => {
  it('lowercases and strips punctuation consistently', () => {
    assert.equal(normalizeForScoring("Hello, World! It's fine."), 'hello world it s fine');
  });

  it('removes Arabic diacritics and unifies alef forms', () => {
    assert.equal(normalizeForScoring('أَهْلاً'), 'اهلا');
    assert.equal(normalizeForScoring('إسلام'), normalizeForScoring('اسلام'));
  });
});

describe('editDistance', () => {
  it('handles empty sequences', () => {
    assert.equal(editDistance([], ['a', 'b']), 2);
    assert.equal(editDistance(['a'], []), 1);
    assert.equal(editDistance([], []), 0);
  });

  it('counts substitution, insertion and deletion', () => {
    assert.equal(editDistance(['a', 'b', 'c'], ['a', 'x', 'c']), 1);
    assert.equal(editDistance(['a', 'b'], ['a', 'b', 'c']), 1);
    assert.equal(editDistance(['a', 'b', 'c'], ['a', 'c']), 1);
  });
});

describe('wordErrors / charErrors', () => {
  it('scores a perfect match as zero errors', () => {
    assert.deepEqual(wordErrors('the cat sat', 'The cat, sat.'), { errors: 0, refLength: 3 });
  });

  it('computes WER = 1/3 for one wrong word out of three', () => {
    const count = wordErrors('the cat sat', 'the dog sat');
    assert.equal(rate(count), 1 / 3);
  });

  it('can exceed 100% with many insertions', () => {
    const count = wordErrors('hi', 'hi there my friend');
    assert.equal(count.errors, 3);
    assert.equal(rate(count), 3);
  });

  it('counts characters ignoring spaces', () => {
    assert.deepEqual(charErrors('ab cd', 'abcd'), { errors: 0, refLength: 4 });
  });

  it('returns null rate for an empty reference', () => {
    assert.equal(rate(wordErrors('', 'anything')), null);
  });
});

describe('sumErrors', () => {
  it('pools errors and reference lengths (micro average)', () => {
    const total = sumErrors([
      { errors: 1, refLength: 10 },
      { errors: 3, refLength: 30 },
    ]);
    assert.deepEqual(total, { errors: 4, refLength: 40 });
  });
});

describe('percentile', () => {
  it('uses nearest-rank', () => {
    const v = [10, 20, 30, 40, 50];
    assert.equal(percentile(v, 50), 30);
    assert.equal(percentile(v, 95), 50);
    assert.equal(percentile(v, 0), 10);
  });

  it('returns null for an empty list and does not mutate input', () => {
    assert.equal(percentile([], 50), null);
    const v = [3, 1, 2];
    percentile(v, 50);
    assert.deepEqual(v, [3, 1, 2]);
  });
});

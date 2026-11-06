import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { type ClipResult, formatTable, summarize } from './summary';

function result(over: Partial<ClipResult>): ClipResult {
  return {
    clipId: 'c',
    backend: 'qwen',
    language: 'en',
    tags: [],
    durationSec: 2,
    wallMs: 400,
    hypothesis: '',
    wer: { errors: 0, refLength: 10 },
    cer: { errors: 0, refLength: 50 },
    ...over,
  };
}

describe('summarize', () => {
  it('pools errors across clips (micro average) per backend', () => {
    const rows = summarize(
      [
        result({ clipId: 'a', wer: { errors: 1, refLength: 10 } }),
        result({ clipId: 'b', wer: { errors: 3, refLength: 30 } }),
      ],
      () => ['all'],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.wer, 4 / 40);
    assert.equal(rows[0]!.clips, 2);
  });

  it('keeps backends separate and sorts deterministically', () => {
    const rows = summarize(
      [result({ backend: 'whisper' }), result({ backend: 'qwen' })],
      () => ['all'],
    );
    assert.deepEqual(
      rows.map((r) => r.backend),
      ['qwen', 'whisper'],
    );
  });

  it('excludes failed clips from rates and counts them as failures', () => {
    const rows = summarize(
      [
        result({ wer: { errors: 2, refLength: 10 } }),
        result({ error: 'boom', wer: { errors: 10, refLength: 10 } }),
      ],
      () => ['all'],
    );
    assert.equal(rows[0]!.clips, 1);
    assert.equal(rows[0]!.failures, 1);
    assert.equal(rows[0]!.wer, 0.2);
  });

  it('groups by tag so a clip can appear in several groups', () => {
    const rows = summarize([result({ tags: ['x', 'y'] })], (r) => r.tags);
    assert.deepEqual(
      rows.map((r) => r.group),
      ['x', 'y'],
    );
  });

  it('computes latency percentiles and real-time factor', () => {
    const rows = summarize(
      [
        result({ wallMs: 100, durationSec: 1 }),
        result({ wallMs: 300, durationSec: 1 }),
        result({ wallMs: 500, durationSec: 2 }),
      ],
      () => ['all'],
    );
    assert.equal(rows[0]!.latencyP50Ms, 300);
    assert.equal(rows[0]!.realTimeFactor, 0.9 / 4);
  });
});

describe('formatTable', () => {
  it('renders a header, separator and rows', () => {
    const text = formatTable(summarize([result({})], () => ['en']));
    const lines = text.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /group\s+backend/);
    assert.match(lines[2]!, /en\s+qwen/);
  });
});

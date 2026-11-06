import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEFAULT_SEGMENTER_CONFIG,
  type SegmenterConfig,
  SpeechSegmenter,
  speechRatio,
} from './segmenter';

const RATE = 16000;
const BLOCK_MS = 100;
const BLOCK = (RATE * BLOCK_MS) / 1000;

function config(over: Partial<SegmenterConfig> = {}): SegmenterConfig {
  return { ...DEFAULT_SEGMENTER_CONFIG, gate: 0.005, ...over };
}

function tone(samples: number, amplitude = 0.1): Float32Array {
  return Float32Array.from({ length: samples }, (_, i) =>
    amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE),
  );
}

function rmsOf(block: Float32Array): number {
  let sum = 0;
  for (const s of block) {
    sum += s * s;
  }
  return Math.sqrt(sum / block.length);
}

/** Feed `count` blocks starting at `startMs`; returns the first utterance and its time. */
function feed(
  seg: SpeechSegmenter,
  block: Float32Array,
  count: number,
  startMs: number,
  stepMs = BLOCK_MS,
): { utterance: Float32Array | null; at: number | null; next: number } {
  const rms = rmsOf(block);
  for (let i = 0; i < count; i += 1) {
    const now = startMs + i * stepMs;
    const out = seg.push(block, rms, now);
    if (out) {
      return { utterance: out, at: now, next: now + stepMs };
    }
  }
  return { utterance: null, at: null, next: startMs + count * stepMs };
}

describe('SpeechSegmenter', () => {
  it('ignores silence and buffers nothing', () => {
    const seg = new SpeechSegmenter(config());
    const { utterance } = feed(seg, new Float32Array(BLOCK), 50, 0);
    assert.equal(utterance, null);
    assert.equal(seg.bufferedSamples, 0);
    assert.equal(seg.isSpeaking, false);
  });

  it('flushes after 420 ms of silence following speech', () => {
    const seg = new SpeechSegmenter(config());
    const speech = feed(seg, tone(BLOCK), 10, 0);
    assert.equal(speech.utterance, null);
    assert.equal(seg.isSpeaking, true);

    // First silent block at t=1000 starts the timer; 400 ms later is not enough.
    const early = feed(seg, new Float32Array(BLOCK), 5, 1000);
    assert.equal(early.utterance, null);

    const flushed = feed(seg, new Float32Array(BLOCK), 1, 1500);
    assert.ok(flushed.utterance);
    // 10 speech blocks + 6 trailing silent blocks (t=1000..1500).
    assert.equal(flushed.utterance!.length, 16 * BLOCK);
    assert.equal(seg.bufferedSamples, 0);
    assert.equal(seg.isSpeaking, false);
  });

  it('drops a mostly-silent utterance and reports the ratio', () => {
    const skipped: number[] = [];
    const seg = new SpeechSegmenter(config(), (r) => skipped.push(r));
    // One 10 ms speech block, then silence until the flush.
    const tiny = tone(160);
    seg.push(tiny, rmsOf(tiny), 0);
    const { utterance } = feed(seg, new Float32Array(160), 60, 10, 10);
    assert.equal(utterance, null);
    assert.equal(skipped.length, 1);
    assert.ok(skipped[0]! < 0.14);
    assert.equal(seg.bufferedSamples, 0);
  });

  it('drops utterances shorter than the minimum length', () => {
    const seg = new SpeechSegmenter(config({ minUtteranceSec: 5 }));
    feed(seg, tone(BLOCK), 3, 0);
    const { utterance } = feed(seg, new Float32Array(BLOCK), 10, 300);
    assert.equal(utterance, null);
    assert.equal(seg.bufferedSamples, 0);
  });

  it('force-flushes at the max length and keeps an overlap tail', () => {
    const seg = new SpeechSegmenter(config());
    const { utterance, at } = feed(seg, tone(BLOCK), 60, 0);
    assert.ok(utterance);
    assert.equal(utterance!.length, Math.floor(RATE * 5.5));
    // 5.5 s of 100 ms blocks completes on the 55th block (index 54).
    assert.equal(at, 54 * BLOCK_MS);
    assert.equal(seg.bufferedSamples, Math.floor(RATE * 0.45));
    assert.equal(seg.isSpeaking, true);
  });

  it('applies the gate: quiet blocks never start an utterance', () => {
    const seg = new SpeechSegmenter(config({ gate: 0.05 }));
    const quiet = tone(BLOCK, 0.01);
    const { utterance } = feed(seg, quiet, 30, 0);
    assert.equal(utterance, null);
    assert.equal(seg.isSpeaking, false);
  });

  it('reset clears state', () => {
    const seg = new SpeechSegmenter(config());
    feed(seg, tone(BLOCK), 5, 0);
    seg.reset();
    assert.equal(seg.bufferedSamples, 0);
    assert.equal(seg.isSpeaking, false);
  });
});

describe('speechRatio', () => {
  it('is 0 for audio shorter than one frame', () => {
    assert.equal(speechRatio(new Float32Array(100), 0.005), 0);
  });

  it('is 1 for continuous speech and 0 for silence', () => {
    assert.equal(speechRatio(tone(RATE), 0.005), 1);
    assert.equal(speechRatio(new Float32Array(RATE), 0.005), 0);
  });
});

const assert = require('assert');
const path = require('path');
const pipeline = require(path.join(__dirname, '..', 'out-tsc', 'listen', 'listen-pipeline.js'));
const merge = require(path.join(
  __dirname,
  '..',
  'out-tsc',
  'merge',
  'asr',
  'transcript-merge.js',
));

const {
  MIC_LIVE_PEAK,
  MIN_SPEECH_SEC,
  SPEECH_RMS,
  TARGET_RATE,
  FairQueue,
  UtteranceAssembler,
  applyMakeup,
  cleanupCaption,
  downsampleTo16k,
  dropRepeatedPrefix,
  frameRms,
  keepSearchingMics,
  mixChannels,
  pushQueued,
  speechDurationSec,
} = pipeline;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${name}`);
}

function tone(ms, amp, rate = TARGET_RATE) {
  const n = Math.max(1, Math.round((rate * ms) / 1000));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * amp;
  }
  return out;
}

function pushFrames(assembler, samples, startMs) {
  const frame = 160;
  let t = startMs;
  const emitted = [];
  for (let offset = 0; offset < samples.length; offset += frame) {
    const slice = samples.subarray(offset, Math.min(samples.length, offset + frame));
    const chunk = assembler.push(slice, t);
    t += (slice.length / TARGET_RATE) * 1000;
    if (chunk) {
      emitted.push(chunk);
    }
  }
  return emitted;
}

check('quiet default mic does not end the device search', () => {
  assert.strictEqual(keepSearchingMics(0.001), true);
  assert.strictEqual(keepSearchingMics(MIC_LIVE_PEAK), false);
  assert.strictEqual(keepSearchingMics(0.02), false);
});

check('makeup lifts quiet speech over the gate and leaves silence alone', () => {
  const quiet = tone(80, 0.002);
  assert.ok(frameRms(quiet) < SPEECH_RMS);
  const gained = applyMakeup(quiet, 'you');
  assert.ok(frameRms(gained) >= SPEECH_RMS);
  const silence = new Float32Array(1600);
  assert.strictEqual(applyMakeup(silence, 'you'), silence);
  const loud = tone(40, 0.4);
  assert.strictEqual(applyMakeup(loud, 'system'), loud);
});

check('silent extra channel is not averaged into the live channel', () => {
  const left = tone(20, 0.4);
  const right = new Float32Array(left.length);
  const mixed = mixChannels([left, right]);
  assert.ok(Math.abs(mixed[10] - left[10]) < 1e-6);
  const both = mixChannels([left, left]);
  assert.ok(Math.abs(both[10] - left[10]) < 1e-5);
});

check('48 kHz audio is resampled to 16 kHz and 16 kHz stays the same length', () => {
  const input = tone(100, 0.2, 48000);
  const down = downsampleTo16k(input, 48000);
  assert.strictEqual(down.length, Math.floor(input.length / 3));
  const same = downsampleTo16k(tone(100, 0.2), 16000);
  assert.strictEqual(same.length, tone(100, 0.2).length);
});

check('silence and sub-word clicks do not count as speech', () => {
  const assembler = new UtteranceAssembler();
  const silent = pushFrames(assembler, new Float32Array(TARGET_RATE), 0);
  assert.strictEqual(silent.length, 0);
  assert.ok(speechDurationSec(tone(30, 0.3)) < MIN_SPEECH_SEC);
  assert.ok(speechDurationSec(tone(120, 0.3)) >= MIN_SPEECH_SEC);
});

check('a short phrase is emitted once, with leading and trailing audio', () => {
  const assembler = new UtteranceAssembler();
  const samples = new Float32Array(TARGET_RATE);
  samples.set(tone(200, 0.25), Math.floor(TARGET_RATE * 0.1));
  const emitted = pushFrames(assembler, samples, 0);
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].reason, 'silence');
  assert.ok(emitted[0].pcm.length > Math.floor(TARGET_RATE * 0.2));
  assert.ok(speechDurationSec(emitted[0].pcm) >= MIN_SPEECH_SEC);
});

check('uninterrupted speech flushes before the whole recording piles up', () => {
  const assembler = new UtteranceAssembler();
  const emitted = pushFrames(assembler, tone(2200, 0.25), 0);
  assert.ok(emitted.some((chunk) => chunk.reason === 'max'));
  assert.ok(emitted[0].pcm.length <= Math.floor(TARGET_RATE * 0.75) + 200);
  assert.ok(emitted[0].pcm.length >= Math.floor(TARGET_RATE * 0.4));
});

check('room noise does not keep a finished phrase open', () => {
  const assembler = new UtteranceAssembler();
  const noise = tone(400, 0.004);
  const speech = tone(220, 0.12);
  const tail = tone(500, 0.004);
  const samples = new Float32Array(noise.length + speech.length + tail.length);
  samples.set(noise, 0);
  samples.set(speech, noise.length);
  samples.set(tail, noise.length + speech.length);
  const frame = 160;
  let t = 0;
  let flushedAt = -1;
  for (let offset = 0; offset < samples.length; offset += frame) {
    const slice = samples.subarray(offset, Math.min(samples.length, offset + frame));
    const chunk = assembler.push(slice, t);
    t += (slice.length / TARGET_RATE) * 1000;
    if (chunk && flushedAt < 0) {
      flushedAt = t;
      assert.strictEqual(chunk.reason, 'silence');
    }
  }
  const speechEnd = ((noise.length + speech.length) / TARGET_RATE) * 1000;
  assert.ok(flushedAt > 0);
  assert.ok(flushedAt < speechEnd + 400);
});

check('a backed-up queue merges audio instead of discarding it', () => {
  const queue = [];
  const merge = (a, b) => {
    const pcm = new Float32Array(a.pcm.length + b.pcm.length);
    pcm.set(a.pcm, 0);
    pcm.set(b.pcm, a.pcm.length);
    return { pcm };
  };
  let dropped = 0;
  for (let i = 0; i < 5; i += 1) {
    dropped += pushQueued(queue, { pcm: new Float32Array(100) }, 4, 10000, merge);
  }
  assert.strictEqual(dropped, 0);
  assert.strictEqual(
    queue.reduce((sum, item) => sum + item.pcm.length, 0),
    500,
  );
});

check('audio that cannot be merged is dropped and counted', () => {
  const queue = [];
  const merge = (a, b) => {
    const pcm = new Float32Array(a.pcm.length + b.pcm.length);
    pcm.set(a.pcm, 0);
    pcm.set(b.pcm, a.pcm.length);
    return { pcm };
  };
  let dropped = 0;
  for (let i = 0; i < 5; i += 1) {
    dropped += pushQueued(queue, { pcm: new Float32Array(5000) }, 4, 8000, merge);
  }
  assert.ok(dropped >= 1);
});

check('mic and system chunks alternate while both queues have audio', () => {
  const fair = new FairQueue();
  const mic = [1, 2, 3];
  const system = ['a', 'b'];
  const order = [];
  for (let i = 0; i < 5; i += 1) {
    const next = fair.pull(mic, system);
    order.push(`${next.source}:${next.item}`);
  }
  assert.deepStrictEqual(order, ['you:1', 'system:a', 'you:2', 'system:b', 'you:3']);
});

check('overlap words are removed and parenthetical speech is kept', () => {
  assert.strictEqual(
    dropRepeatedPrefix('hello there friend', 'friend how are you'),
    'how are you',
  );
  assert.strictEqual(dropRepeatedPrefix('hello there', 'there'), '');
  assert.strictEqual(dropRepeatedPrefix('Hello,', 'hello world'), 'world');
  assert.strictEqual(dropRepeatedPrefix('hello there', 'completely new'), 'completely new');
  assert.strictEqual(cleanupCaption('meet at (the office) today'), 'meet at (the office) today');
  assert.strictEqual(cleanupCaption('hello (music) there'), 'hello there');
  assert.strictEqual(cleanupCaption('thanks for watching'), '');
  assert.strictEqual(cleanupCaption('OK'), 'OK');
  assert.strictEqual(cleanupCaption('Do you? '.repeat(12).trim()), '');
  assert.strictEqual(cleanupCaption('hear me?'), 'hear me?');
});

check('a system final does not erase the in-progress mic placeholder', () => {
  const existing = [
    { id: 'you-interim-live', speaker: 'You', text: '…' },
    { id: 'system-interim-live', speaker: 'System audio', text: '…' },
    { id: 'you-1', speaker: 'You', text: 'hello' },
  ];
  const next = merge.commitTranscriptLine(existing, {
    id: 'sys-1',
    speaker: 'System audio',
    text: 'from the call',
    at: 't',
  });
  assert.ok(next.some((line) => line.id === 'you-interim-live'));
  assert.ok(!next.some((line) => line.id === 'system-interim-live'));
  assert.ok(next.some((line) => line.id === 'sys-1'));
  const afterYou = merge.commitTranscriptLine(next, {
    id: 'you-2',
    speaker: 'You · whisper',
    text: 'more words',
    at: 't',
  });
  assert.ok(!afterYou.some((line) => line.id === 'you-interim-live'));
  assert.ok(afterYou.some((line) => line.id === 'sys-1'));
  assert.ok(afterYou.some((line) => line.text === 'more words'));
});

console.log(`listen pipeline tests passed: ${passed}`);

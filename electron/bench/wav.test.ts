import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { decodeWav, loadAudio16kMono, mixToMono, resampleTo } from './wav';

function buildWav(opts: {
  sampleRate: number;
  channels: number;
  frames: number;
  fill: (frame: number, channel: number) => number;
  format?: 'pcm16' | 'float32' | 'pcm8';
}): Buffer {
  const format = opts.format ?? 'pcm16';
  const bits = format === 'pcm16' ? 16 : format === 'float32' ? 32 : 8;
  const audioFormat = format === 'float32' ? 3 : 1;
  const bytesPer = bits / 8;
  const dataSize = opts.frames * opts.channels * bytesPer;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(audioFormat, 20);
  buf.writeUInt16LE(opts.channels, 22);
  buf.writeUInt32LE(opts.sampleRate, 24);
  buf.writeUInt32LE(opts.sampleRate * opts.channels * bytesPer, 28);
  buf.writeUInt16LE(opts.channels * bytesPer, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < opts.frames; i += 1) {
    for (let c = 0; c < opts.channels; c += 1) {
      const pos = 44 + (i * opts.channels + c) * bytesPer;
      const v = opts.fill(i, c);
      if (format === 'pcm16') {
        buf.writeInt16LE(Math.round(v * 32767), pos);
      } else if (format === 'float32') {
        buf.writeFloatLE(v, pos);
      } else {
        buf.writeUInt8(Math.round(v * 127 + 128), pos);
      }
    }
  }
  return buf;
}

describe('decodeWav', () => {
  it('decodes PCM16 mono', () => {
    const wav = buildWav({ sampleRate: 16000, channels: 1, frames: 4, fill: (i) => i / 8 });
    const { channels, sampleRate } = decodeWav(wav);
    assert.equal(sampleRate, 16000);
    assert.equal(channels.length, 1);
    assert.equal(channels[0]!.length, 4);
    assert.ok(Math.abs(channels[0]![2]! - 0.25) < 1e-3);
  });

  it('decodes float32 stereo', () => {
    const wav = buildWav({
      sampleRate: 8000,
      channels: 2,
      frames: 3,
      format: 'float32',
      fill: (_i, c) => (c === 0 ? 0.5 : -0.5),
    });
    const { channels } = decodeWav(wav);
    assert.equal(channels.length, 2);
    assert.equal(channels[0]![0], 0.5);
    assert.equal(channels[1]![0], -0.5);
  });

  it('rejects non-WAV input and unsupported encodings', () => {
    assert.throws(() => decodeWav(Buffer.from('not a wav file at all')), /RIFF/);
    const pcm8 = buildWav({ sampleRate: 8000, channels: 1, frames: 2, format: 'pcm8', fill: () => 0 });
    assert.throws(() => decodeWav(pcm8), /Unsupported WAV encoding/);
  });
});

describe('mixToMono / resampleTo', () => {
  it('averages channels', () => {
    const mono = mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    assert.deepEqual(Array.from(mono), [0.5, 0.5]);
  });

  it('downsamples 48 kHz to 16 kHz with the right length', () => {
    const out = resampleTo(new Float32Array(48000).fill(0.25), 48000, 16000);
    assert.equal(out.length, 16000);
    assert.ok(Math.abs(out[100]! - 0.25) < 1e-6);
  });

  it('upsamples 8 kHz to 16 kHz with the right length', () => {
    const out = resampleTo(new Float32Array(8000).fill(0.5), 8000, 16000);
    assert.equal(out.length, 16000);
    assert.ok(Math.abs(out[5]! - 0.5) < 1e-6);
  });
});

describe('loadAudio16kMono', () => {
  it('returns 16 kHz mono with the correct duration', () => {
    const wav = buildWav({ sampleRate: 32000, channels: 2, frames: 64000, fill: () => 0.1 });
    const audio = loadAudio16kMono(wav);
    assert.equal(audio.sampleRate, 16000);
    assert.equal(audio.samples.length, 32000);
    assert.equal(audio.durationSec, 2);
  });
});

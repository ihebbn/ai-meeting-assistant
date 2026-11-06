/**
 * Minimal WAV reader for benchmark clips: PCM 16-bit or 32-bit float, any channel
 * count, mixed down to mono and resampled to 16 kHz. No Electron imports.
 */

export type DecodedAudio = {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
};

export const TARGET_SAMPLE_RATE = 16000;

export function decodeWav(buffer: Buffer): { channels: Float32Array[]; sampleRate: number } {
  if (
    buffer.length < 12 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Not a RIFF/WAVE file.');
  }

  let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null =
    null;
  let data: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(buffer.length, start + size);
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }

  if (!format || !data) {
    throw new Error('WAV is missing a fmt or data chunk.');
  }
  const { audioFormat, channels, sampleRate, bits } = format;
  const isPcm16 = audioFormat === 1 && bits === 16;
  const isFloat32 = audioFormat === 3 && bits === 32;
  if (!isPcm16 && !isFloat32) {
    throw new Error(
      `Unsupported WAV encoding (format=${audioFormat}, bits=${bits}). Use PCM 16-bit or float32.`,
    );
  }
  if (channels < 1) {
    throw new Error('WAV has no channels.');
  }

  const bytesPerSample = bits / 8;
  const frames = Math.floor(data.length / (bytesPerSample * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const pos = (i * channels + c) * bytesPerSample;
      out[c]![i] = isPcm16 ? data.readInt16LE(pos) / 32768 : data.readFloatLE(pos);
    }
  }
  return { channels: out, sampleRate };
}

export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) {
    return channels[0]!;
  }
  const frames = channels[0]!.length;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (const channel of channels) {
      sum += channel[i]!;
    }
    mono[i] = sum / channels.length;
  }
  return mono;
}

/** Box-average when downsampling (same approach as the app), linear when upsampling. */
export function resampleTo(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  if (ratio > 1) {
    for (let i = 0; i < outLength; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j += 1) {
        sum += input[j]!;
      }
      out[i] = sum / (end - start);
    }
    return out;
  }
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    const frac = pos - base;
    const a = input[base]!;
    const b = input[Math.min(input.length - 1, base + 1)]!;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function loadAudio16kMono(buffer: Buffer): DecodedAudio {
  const { channels, sampleRate } = decodeWav(buffer);
  const samples = resampleTo(mixToMono(channels), sampleRate, TARGET_SAMPLE_RATE);
  return { samples, sampleRate: TARGET_SAMPLE_RATE, durationSec: samples.length / TARGET_SAMPLE_RATE };
}

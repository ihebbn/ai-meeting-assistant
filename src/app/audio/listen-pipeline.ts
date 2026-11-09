/** Pure capture / queue helpers shared by the listening service and unit tests. */

export const TARGET_RATE = 16000;
/** Send a chunk this often during uninterrupted speech so captions are not held for a long window. */
export const MAX_UTTERANCE_SEC = 0.75;
export const OVERLAP_SEC = 0.16;
export const PREROLL_SEC = 0.18;
export const SILENCE_FLUSH_MS = 160;
export const MIN_UTTERANCE_SEC = 0.12;
/** Ignore isolated clicks; keep short words such as “hi” / “ok”. */
export const MIN_SPEECH_SEC = 0.08;
export const SPEECH_RMS = 0.004;
export const SILENCE_RMS = 0.0018;
/** Peak (not RMS) that means a probe heard a live microphone. */
export const MIC_LIVE_PEAK = 0.006;
export const MAX_QUEUED_UTTERANCES = 4;
export const MAX_MERGED_SEC = 8;

const SPEECH_FRAME = 320;

export type SourceName = 'you' | 'system';
export type FlushReason = 'silence' | 'max';

export type AssembledUtterance = {
  pcm: Float32Array;
  startedAt: number;
  endedAt: number;
  reason: FlushReason;
};

/** Keep looking while this probe is quiet. A live peak stops the search even if muted flaps. */
export function keepSearchingMics(peak: number): boolean {
  return peak < MIC_LIVE_PEAK;
}

export function frameRms(samples: Float32Array): number {
  if (!samples.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

export function peakAbs(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    peak = Math.max(peak, Math.abs(samples[i]!));
  }
  return peak;
}

/** Raise quiet speech before the energy gate. Leave silence and already-loud audio alone. */
export function applyMakeup(input: Float32Array, source: SourceName): Float32Array {
  const peak = peakAbs(input);
  if (peak < 0.0012 || peak >= 0.12) {
    return input;
  }
  const target = source === 'you' ? 0.22 : 0.18;
  const cap = source === 'you' ? 4 : 3;
  const gain = Math.min(cap, target / peak);
  if (gain <= 1.05) {
    return input;
  }
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = clampSample(input[i]! * gain);
  }
  return out;
}

export function mixChannels(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) {
    return new Float32Array();
  }
  if (channels.length < 2) {
    return Float32Array.from(first);
  }
  const second = channels[1]!;
  let energy = 0;
  const n = Math.min(first.length, second.length);
  for (let i = 0; i < n; i += 1) {
    const s = second[i]!;
    energy += s * s;
  }
  // A silent extra channel would halve a mono (or dual-mono-with-empty) signal.
  if (energy < 1e-8) {
    return Float32Array.from(first);
  }
  const out = new Float32Array(first.length);
  for (let i = 0; i < first.length; i += 1) {
    const right = i < second.length ? second[i]! : 0;
    out[i] = clampSample((first[i]! + right) * 0.5);
  }
  return out;
}

export function downsampleTo16k(input: Float32Array, sampleRate: number): Float32Array {
  if (!input.length || !Number.isFinite(sampleRate) || sampleRate < 1000) {
    return new Float32Array();
  }
  if (Math.abs(sampleRate - TARGET_RATE) < 1) {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      out[i] = clampSample(input[i]!);
    }
    return out;
  }
  const ratio = sampleRate / TARGET_RATE;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    const count = Math.max(1, end - start);
    for (let j = start; j < end; j += 1) {
      sum += input[j]!;
    }
    out[i] = clampSample(sum / count);
  }
  return out;
}

export function speechDurationSec(pcm: Float32Array, sampleRate = TARGET_RATE): number {
  if (pcm.length < SPEECH_FRAME || sampleRate <= 0) {
    return 0;
  }
  let speechFrames = 0;
  for (let i = 0; i + SPEECH_FRAME <= pcm.length; i += SPEECH_FRAME) {
    let sum = 0;
    for (let j = 0; j < SPEECH_FRAME; j += 1) {
      const s = pcm[i + j]!;
      sum += s * s;
    }
    if (Math.sqrt(sum / SPEECH_FRAME) >= SPEECH_RMS) {
      speechFrames += 1;
    }
  }
  return (speechFrames * SPEECH_FRAME) / sampleRate;
}

export function padPcm(pcm: Float32Array, sampleRate: number, minSec: number): Float32Array {
  const minSamples = Math.floor(sampleRate * minSec);
  if (pcm.length >= minSamples) {
    return pcm;
  }
  const out = new Float32Array(minSamples);
  out.set(pcm, 0);
  return out;
}

export class SampleRing {
  private readonly data: Float32Array;
  private pos = 0;
  private filled = 0;

  constructor(private readonly capacity: number) {
    this.data = new Float32Array(Math.max(1, capacity));
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i += 1) {
      this.data[this.pos] = samples[i]!;
      this.pos = (this.pos + 1) % this.data.length;
      if (this.filled < this.data.length) {
        this.filled += 1;
      }
    }
  }

  snapshot(): Float32Array {
    const out = new Float32Array(this.filled);
    if (!this.filled) {
      return out;
    }
    if (this.filled < this.data.length) {
      out.set(this.data.subarray(0, this.filled));
      return out;
    }
    const tail = this.data.length - this.pos;
    out.set(this.data.subarray(this.pos), 0);
    out.set(this.data.subarray(0, this.pos), tail);
    return out;
  }

  clear(): void {
    this.pos = 0;
    this.filled = 0;
    this.data.fill(0);
  }
}

class PcmBuffer {
  private data = new Float32Array(0);
  length = 0;

  append(samples: Float32Array): void {
    if (!samples.length) {
      return;
    }
    if (this.length + samples.length > this.data.length) {
      const next = new Float32Array(
        Math.max(this.data.length ? this.data.length * 2 : 4096, this.length + samples.length),
      );
      next.set(this.data.subarray(0, this.length), 0);
      this.data = next;
    }
    this.data.set(samples, this.length);
    this.length += samples.length;
  }

  takeAll(): Float32Array {
    const out = this.data.slice(0, this.length);
    this.length = 0;
    return out;
  }

  takeLeaveTail(tail: number): Float32Array {
    const keep = Math.max(0, Math.min(tail, this.length));
    const end = this.length - keep;
    const out = this.data.slice(0, end);
    if (keep) {
      this.data.copyWithin(0, end, this.length);
    }
    this.length = keep;
    return out;
  }

  clear(): void {
    this.length = 0;
  }
}

/**
 * Energy gate with preroll and a lower hang threshold.
 * Emits independent 16 kHz PCM chunks. Callers send each chunk as its own request.
 */
export class UtteranceAssembler {
  private readonly buffer = new PcmBuffer();
  private readonly preroll: SampleRing;
  private readonly maxSamples: number;
  private speaking = false;
  private silentSince = -1;
  private startedAt = 0;
  /** Background level, so boosted room noise does not keep a phrase open. */
  private noise = 0;
  private peakRms = 0;

  constructor() {
    this.preroll = new SampleRing(Math.floor(TARGET_RATE * PREROLL_SEC));
    this.maxSamples = Math.floor(TARGET_RATE * MAX_UTTERANCE_SEC);
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  reset(): void {
    this.buffer.clear();
    this.preroll.clear();
    this.speaking = false;
    this.silentSince = -1;
    this.startedAt = 0;
    this.noise = 0;
    this.peakRms = 0;
  }

  push(frame: Float32Array, now: number): AssembledUtterance | null {
    if (!frame.length) {
      return null;
    }
    this.preroll.push(frame);
    const rms = frameRms(frame);
    const { start, hang } = this.gates(rms);
    let emitted: AssembledUtterance | null = null;

    if (!this.speaking) {
      if (rms >= start) {
        this.speaking = true;
        this.startedAt = Math.max(0, now - PREROLL_SEC * 1000);
        this.silentSince = -1;
        this.buffer.append(this.preroll.snapshot());
      }
    } else {
      this.buffer.append(frame);
      if (rms >= hang) {
        this.silentSince = -1;
      } else if (this.silentSince < 0) {
        this.silentSince = now;
      }
      if (this.silentSince >= 0 && now - this.silentSince >= SILENCE_FLUSH_MS) {
        emitted = this.finish('silence', now);
      }
    }

    if (!emitted && this.speaking && this.buffer.length >= this.maxSamples) {
      emitted = this.finish('max', now);
    }
    return emitted;
  }

  private finish(reason: FlushReason, now: number): AssembledUtterance | null {
    const overlap = Math.floor(TARGET_RATE * OVERLAP_SEC);
    const pcm =
      reason === 'max' && this.buffer.length > overlap * 2
        ? this.buffer.takeLeaveTail(overlap)
        : this.buffer.takeAll();
    const startedAt = this.startedAt;
    const endedAt = reason === 'silence' ? Math.max(startedAt, now - SILENCE_FLUSH_MS) : now;
    if (reason === 'max' && this.buffer.length > 0) {
      this.speaking = true;
      this.startedAt = Math.max(0, now - OVERLAP_SEC * 1000);
      this.silentSince = -1;
    } else {
      this.speaking = false;
      this.silentSince = -1;
      this.startedAt = now;
      this.peakRms = Math.max(this.noise, this.peakRms * 0.25);
    }
    if (pcm.length < Math.floor(TARGET_RATE * MIN_UTTERANCE_SEC)) {
      return null;
    }
    return { pcm, startedAt, endedAt, reason };
  }

  private gates(rms: number): { start: number; hang: number } {
    if (this.noise <= 0) {
      if (rms > 0 && rms < SPEECH_RMS) {
        this.noise = rms;
      }
    } else if (rms <= this.noise * 2.5) {
      this.noise = this.noise * 0.9 + rms * 0.1;
    }
    if (rms > this.peakRms) {
      this.peakRms = rms;
    } else {
      this.peakRms *= 0.997;
    }
    return {
      start: Math.max(SPEECH_RMS, this.noise * 4),
      hang: Math.max(SILENCE_RMS, this.noise * 2.5, this.peakRms * 0.22),
    };
  }
}

export function pushQueued<T extends { pcm: Float32Array }>(
  queue: T[],
  item: T,
  maxItems: number,
  maxMergedSamples: number,
  merge: (a: T, b: T) => T,
): number {
  queue.push(item);
  let dropped = 0;
  while (queue.length > maxItems) {
    const a = queue[0];
    const b = queue[1];
    if (a && b && a.pcm.length + b.pcm.length <= maxMergedSamples) {
      queue.splice(0, 2, merge(a, b));
    } else {
      queue.shift();
      dropped += 1;
    }
  }
  return dropped;
}

export class FairQueue<T> {
  private turn = 0;

  reset(): void {
    this.turn = 0;
  }

  pull(mic: T[], system: T[]): { source: SourceName; item: T } | null {
    const hasMic = mic.length > 0;
    const hasSystem = system.length > 0;
    if (!hasMic && !hasSystem) {
      return null;
    }
    let source: SourceName;
    if (hasMic && hasSystem) {
      source = this.turn % 2 === 0 ? 'you' : 'system';
      this.turn += 1;
    } else {
      source = hasMic ? 'you' : 'system';
    }
    const item = (source === 'you' ? mic : system).shift();
    if (!item) {
      return null;
    }
    return { source, item };
  }
}

export function dropRepeatedPrefix(previous: string, next: string): string {
  const prevWords = tokenize(previous);
  const nextWords = tokenize(next);
  if (!prevWords.length || !nextWords.length) {
    return next.trim();
  }
  const max = Math.min(6, prevWords.length, nextWords.length);
  for (let n = max; n >= 1; n -= 1) {
    const suffix = prevWords
      .slice(-n)
      .map(normalizeToken)
      .join(' ');
    const prefix = nextWords
      .slice(0, n)
      .map(normalizeToken)
      .join(' ');
    if (suffix && suffix === prefix) {
      return nextWords.slice(n).join(' ');
    }
  }
  return nextWords.join(' ');
}

export function cleanupCaption(text: string): string {
  let t = text
    .replace(/\((?:music|applause|laughter|inaudible|blank_audio|silence|noise|background)[^)]*\)/gi, ' ')
    .replace(/\[(?:music|applause|laughter|inaudible|blank_audio|silence|noise|background)[^\]]*\]/gi, ' ')
    .replace(/\*(?:music|applause|laughter|inaudible|blank_audio|silence|noise)\*/gi, ' ')
    .replace(/\b(uh|um|erm|inaudible|blank_audio|gibberish)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();
  if (!t || t.length < 2) {
    return '';
  }
  if (!/\p{L}|\p{N}/u.test(t)) {
    return '';
  }
  if (isHallucination(t)) {
    return '';
  }
  return t;
}

function isHallucination(text: string): boolean {
  const t = text.trim();
  if (
    /^(thanks for watching!?|thank you for watching!?|thanks for listening!?|please subscribe|subtitles by.*|amara\.org|www\.|http)/i.test(
      t,
    )
  ) {
    return true;
  }
  const compact = t.replace(/[\s,.!?…]+/g, '');
  if (compact.length >= 8 && /^(.)\1+$/u.test(compact)) {
    return true;
  }
  const tokens = t.split(/[\s,./!?…]+/).filter(Boolean);
  if (tokens.length >= 6) {
    const first = tokens[0]!.toLowerCase();
    if (tokens.every((tok) => tok.toLowerCase() === first) && first.length <= 6) {
      return true;
    }
  }
  return isRepeatedLoop(tokens);
}

/** "Do you? Do you? Do you?" is a common decode loop on noise, not speech. */
function isRepeatedLoop(tokens: string[]): boolean {
  const words = tokens.map((tok) => tok.toLowerCase());
  if (words.length < 6) {
    return false;
  }
  for (let size = 1; size <= 3; size += 1) {
    if (words.length < size * 4) {
      continue;
    }
    const unit = words.slice(0, size).join('\0');
    let matched = 0;
    for (let i = 0; i + size <= words.length; i += size) {
      if (words.slice(i, i + size).join('\0') !== unit) {
        break;
      }
      matched += size;
    }
    if (matched >= size * 4 && matched / words.length >= 0.8) {
      return true;
    }
  }
  return false;
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function clampSample(value: number): number {
  if (value > 1) {
    return 1;
  }
  if (value < -1) {
    return -1;
  }
  return value;
}

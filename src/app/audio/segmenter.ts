/**
 * Splits a continuous 16 kHz stream into utterances using an RMS gate.
 * Framework-free and clock-injected so it can be unit tested. This is the logic that
 * previously lived inline in ListeningService; behaviour is intentionally unchanged.
 */

export type SegmenterConfig = {
  /** RMS at or above which a block counts as speech. */
  gate: number;
  /** RMS used to score speech density of a finished utterance. */
  speechRms: number;
  sampleRate: number;
  /** Force a flush once an utterance reaches this length. */
  maxUtteranceSec: number;
  /** Audio kept when a max-length flush happens, so words are not cut mid-phrase. */
  overlapSec: number;
  minUtteranceSec: number;
  /** Silence after speech that ends an utterance. */
  silenceFlushMs: number;
  /** Utterances with a lower share of speech frames are dropped. */
  minSpeechRatio: number;
};

export const DEFAULT_SEGMENTER_CONFIG: Omit<SegmenterConfig, 'gate'> = {
  speechRms: 0.005,
  sampleRate: 16000,
  maxUtteranceSec: 5.5,
  overlapSec: 0.45,
  minUtteranceSec: 0.35,
  silenceFlushMs: 420,
  minSpeechRatio: 0.14,
};

export class SpeechSegmenter {
  private samples: number[] = [];
  private speaking = false;
  private silentSince: number | null = null;

  constructor(
    private readonly config: SegmenterConfig,
    /** Called when a finished utterance is dropped for being mostly silence/noise. */
    private readonly onSkip?: (speechRatio: number) => void,
  ) {}

  get bufferedSamples(): number {
    return this.samples.length;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  reset(): void {
    this.samples.length = 0;
    this.speaking = false;
    this.silentSince = null;
  }

  /**
   * Feed one block of 16 kHz audio with its RMS (measured on the raw input) and the
   * current time in ms. Returns a finished utterance, or null.
   */
  push(block: Float32Array, rms: number, nowMs: number): Float32Array | null {
    const { sampleRate, maxUtteranceSec, overlapSec, silenceFlushMs } = this.config;
    let utterance: Float32Array | null = null;

    // Cap the live buffer so a slow consumer never lets noise pile up.
    const hardCap = Math.floor(sampleRate * (maxUtteranceSec + overlapSec + 1));
    if (this.samples.length > hardCap) {
      this.samples.splice(0, this.samples.length - hardCap);
    }

    if (rms >= this.config.gate) {
      this.speaking = true;
      this.silentSince = null;
      this.append(block);
    } else if (this.speaking) {
      this.append(block);
      if (this.silentSince === null) {
        this.silentSince = nowMs;
      }
      if (nowMs - this.silentSince >= silenceFlushMs) {
        utterance = this.flush(false);
      }
    }

    if (this.samples.length >= Math.floor(sampleRate * maxUtteranceSec)) {
      utterance = this.flush(true) ?? utterance;
    }
    return utterance;
  }

  private append(block: Float32Array): void {
    for (let i = 0; i < block.length; i += 1) {
      this.samples.push(block[i]!);
    }
  }

  private flush(hitMaxLength: boolean): Float32Array | null {
    const { sampleRate, overlapSec, minUtteranceSec, minSpeechRatio } = this.config;
    if (this.samples.length < Math.floor(sampleRate * minUtteranceSec)) {
      this.reset();
      return null;
    }

    const overlap = Math.floor(sampleRate * overlapSec);
    const chunk = Float32Array.from(this.samples);
    if (hitMaxLength && chunk.length > overlap * 2) {
      this.samples.splice(0, this.samples.length - overlap);
      this.speaking = true;
      this.silentSince = null;
    } else {
      this.reset();
    }

    const ratio = speechRatio(chunk, this.config.speechRms);
    if (ratio < minSpeechRatio) {
      this.onSkip?.(ratio);
      return null;
    }
    return chunk;
  }
}

/** Share of 512-sample frames whose RMS reaches the speech threshold. */
export function speechRatio(pcm: Float32Array, speechRms: number): number {
  const frame = 512;
  if (pcm.length < frame) {
    return 0;
  }
  let speech = 0;
  let total = 0;
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let sum = 0;
    for (let j = 0; j < frame; j += 1) {
      const s = pcm[i + j]!;
      sum += s * s;
    }
    total += 1;
    if (Math.sqrt(sum / frame) >= speechRms) {
      speech += 1;
    }
  }
  return total ? speech / total : 0;
}

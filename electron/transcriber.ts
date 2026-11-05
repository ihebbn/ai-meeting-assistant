import * as path from 'path';
import { app } from 'electron';

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text?: string } | { text?: string }[]>;

/**
 * base.en is already cached for this install and returns quickly.
 * small.en is more accurate but its first download blocked live captions.
 */
const MODEL_ID = 'Xenova/whisper-base.en';

let asrPromise: Promise<AsrPipeline> | null = null;
let ready = false;
let lastError: string | null = null;
let loading = false;

export function isTranscriberReady(): boolean {
  return ready;
}

export function isTranscriberLoading(): boolean {
  return loading;
}

export function getTranscriberError(): string | null {
  return lastError;
}

export function getTranscriberModelId(): string {
  return MODEL_ID;
}

export async function ensureTranscriber(): Promise<void> {
  if (ready) {
    return;
  }
  await loadTranscriber();
}

async function loadTranscriber(): Promise<AsrPipeline> {
  if (!asrPromise) {
    loading = true;
    asrPromise = (async () => {
      lastError = null;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const transformers = require('@xenova/transformers') as {
        pipeline: (
          task: string,
          model: string,
          options?: Record<string, unknown>,
        ) => Promise<AsrPipeline>;
        env: {
          cacheDir: string;
          allowLocalModels: boolean;
          useBrowserCache: boolean;
        };
      };
      transformers.env.cacheDir = path.join(app.getPath('userData'), 'model-cache');
      transformers.env.allowLocalModels = true;
      transformers.env.useBrowserCache = false;
      const pipe = await transformers.pipeline(
        'automatic-speech-recognition',
        MODEL_ID,
        { quantized: true },
      );
      ready = true;
      loading = false;
      return pipe;
    })().catch((err: unknown) => {
      asrPromise = null;
      ready = false;
      loading = false;
      lastError = String(err);
      throw err;
    });
  }
  return asrPromise;
}

let chain: Promise<unknown> = Promise.resolve();

export async function transcribePcm(
  pcm: Float32Array,
  sampleRate: number,
): Promise<string> {
  if (pcm.length < sampleRate * 0.2) {
    return '';
  }
  const raw =
    pcm instanceof Float32Array ? pcm : Float32Array.from(pcm as ArrayLike<number>);
  const audio = normalizePcm(raw);

  const run = async (): Promise<string> => {
    const asr = await withTimeout(
      loadTranscriber(),
      45_000,
      'Speech model load timed out — check network and retry Listen.',
    );
    const result = await withTimeout(
      asr(audio, {
        sampling_rate: sampleRate,
        language: 'english',
        task: 'transcribe',
        temperature: 0,
        do_sample: false,
      }),
      20_000,
      'Transcription timed out.',
    );
    const text = Array.isArray(result)
      ? result.map((r) => r.text ?? '').join(' ')
      : (result.text ?? '');
    return cleanupTranscript(text);
  };

  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function normalizePcm(pcm: Float32Array, targetPeak = 0.8): Float32Array {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    peak = Math.max(peak, Math.abs(pcm[i]!));
  }
  if (peak < 1e-5) {
    return pcm;
  }
  if (peak >= 0.35 && peak <= 0.95) {
    return pcm;
  }
  const scale = Math.min(targetPeak / peak, 3);
  if (Math.abs(scale - 1) < 0.08) {
    return pcm;
  }
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    const v = pcm[i]! * scale;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

function cleanupTranscript(text: string): string {
  return text
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(uh|um|erm|inaudible|music|blank_audio|gibberish|clicks?|clicking|sighs?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();
}

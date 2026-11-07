import * as path from 'path';
import { app } from 'electron';
import type { AsrLanguageId } from './constants';

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text?: string } | { text?: string }[]>;

const MODEL_EN = 'Xenova/whisper-base.en';
const MODEL_MULTI = 'Xenova/whisper-base';

let asrPromise: Promise<AsrPipeline> | null = null;
let loadedModelId: string | null = null;
let ready = false;
let loading = false;
let lastError: string | null = null;
let chain: Promise<unknown> = Promise.resolve();
let listenGeneration = 0;

export type WhisperTranscriptResult = {
  text: string;
  language: string | null;
  latencyMs: number;
  backend: 'whisper';
};

export function isWhisperReady(): boolean {
  return ready;
}

export function isWhisperLoading(): boolean {
  return loading;
}

export function getWhisperError(): string | null {
  return lastError;
}

export function getWhisperModelId(): string {
  return loadedModelId || MODEL_MULTI;
}

export function bumpWhisperListenGeneration(): void {
  listenGeneration += 1;
}

function modelForLanguage(language: AsrLanguageId): string {
  return language === 'en' ? MODEL_EN : MODEL_MULTI;
}

export async function ensureWhisperBackend(
  language: AsrLanguageId = 'auto',
): Promise<void> {
  await loadWhisper(modelForLanguage(language));
}

async function loadWhisper(modelId: string): Promise<AsrPipeline> {
  if (asrPromise && loadedModelId === modelId && ready) {
    return asrPromise;
  }
  loading = true;
  ready = false;
  loadedModelId = modelId;
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
      modelId,
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
  return asrPromise;
}

export async function transcribeWithWhisper(
  pcm: Float32Array,
  sampleRate: number,
  language: AsrLanguageId,
): Promise<WhisperTranscriptResult> {
  if (pcm.length < sampleRate * 0.2) {
    return { text: '', language: null, latencyMs: 0, backend: 'whisper' };
  }
  const generation = listenGeneration;
  const modelId = modelForLanguage(language);
  const audio = normalizePcm(
    pcm instanceof Float32Array ? pcm : Float32Array.from(pcm as ArrayLike<number>),
  );

  const run = async (): Promise<WhisperTranscriptResult> => {
    const started = Date.now();
    const asr = await withTimeout(
      loadWhisper(modelId),
      45_000,
      'Whisper model load timed out — check network and retry Listen.',
    );
    if (generation !== listenGeneration) {
      return { text: '', language: null, latencyMs: 0, backend: 'whisper' };
    }
    const options: Record<string, unknown> = {
      sampling_rate: sampleRate,
      task: 'transcribe',
      temperature: 0,
      do_sample: false,
    };
    // Leave language unset in Auto so Whisper can detect per segment.
    if (language !== 'auto') {
      options['language'] = whisperLanguageName(language);
    }
    const result = await withTimeout(
      asr(audio, options),
      20_000,
      'Whisper transcription timed out.',
    );
    if (generation !== listenGeneration) {
      return { text: '', language: null, latencyMs: 0, backend: 'whisper' };
    }
    const text = cleanupTranscript(
      Array.isArray(result)
        ? result.map((r) => r.text ?? '').join(' ')
        : (result.text ?? ''),
    );
    return {
      text,
      language: text ? inferLanguage(text, language) : null,
      latencyMs: Date.now() - started,
      backend: 'whisper',
    };
  };

  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function whisperLanguageName(language: Exclude<AsrLanguageId, 'auto'>): string {
  switch (language) {
    case 'fr':
      return 'french';
    case 'ar':
      return 'arabic';
    default:
      return 'english';
  }
}

function inferLanguage(text: string, requested: AsrLanguageId): string | null {
  if (requested !== 'auto') {
    return requested;
  }
  if (/[\u0600-\u06FF]/.test(text)) {
    return 'ar';
  }
  if (/[àâäæçéèêëïîôœùûüÿÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜŸ]/.test(text)) {
    return 'fr';
  }
  if (/[A-Za-z]/.test(text)) {
    return 'en';
  }
  return null;
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
  const cleaned = text
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(
      /\b(uh|um|erm|inaudible|music|blank_audio|gibberish|clicks?|clicking|sighs?)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();
  if (!cleaned) {
    return '';
  }
  if (
    /^(thanks for watching!?|thank you for watching!?|thanks for listening!?|please subscribe)/i.test(
      cleaned,
    )
  ) {
    return '';
  }
  const compact = cleaned.replace(/[\s,.!?…]+/g, '');
  if (compact.length >= 8 && /^(.)\1+$/u.test(compact)) {
    return '';
  }
  const tokens = cleaned.split(/[\s,./!?…]+/).filter(Boolean);
  if (tokens.length >= 6) {
    const first = tokens[0]!.toLowerCase();
    if (tokens.every((tok) => tok.toLowerCase() === first) && first.length <= 6) {
      return '';
    }
  }
  return cleaned;
}

/**
 * Forked with ELECTRON_RUN_AS_NODE so Qwen decode stays off the Electron UI process.
 * Protocol: parent <-> child JSON messages over IPC.
 */
import * as path from 'path';
import { cleanupTranscript, guessLanguageFromScript } from './text';

type InitMessage = {
  type: 'init';
  modelDir: string;
};

type TranscribeMessage = {
  type: 'transcribe';
  id: number;
  sampleRate: number;
  languageHint: string | null;
  pcm: Float32Array;
};

type CancelMessage = {
  type: 'cancel';
  generation: number;
};

type ParentMessage = InitMessage | TranscribeMessage | CancelMessage | { type: 'ping' };

type SherpaOfflineRecognizer = {
  createStream: () => SherpaOfflineStream;
  decode: (stream: SherpaOfflineStream) => void;
  getResult: (stream: SherpaOfflineStream) => {
    text?: string;
    lang?: string;
    tokens?: string[];
  };
  free?: () => void;
};

type SherpaOfflineStream = {
  acceptWaveform: (sampleRate: number, samples: Float32Array) => void;
  setOption?: (key: string, value: string) => void;
  free?: () => void;
};

let recognizer: SherpaOfflineRecognizer | null = null;
let activeGeneration = 0;
let busy = false;
const queue: TranscribeMessage[] = [];

function send(payload: Record<string, unknown>): void {
  if (typeof process.send === 'function') {
    process.send(payload);
  }
}

function loadRecognizer(modelDir: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require('sherpa-onnx') as {
    createOfflineRecognizer: (config: Record<string, unknown>) => SherpaOfflineRecognizer;
  };
  recognizer = sherpa.createOfflineRecognizer({
    modelConfig: {
      qwen3Asr: {
        convFrontend: path.join(modelDir, 'conv_frontend.onnx'),
        encoder: path.join(modelDir, 'encoder.int8.onnx'),
        decoder: path.join(modelDir, 'decoder.int8.onnx'),
        tokenizer: path.join(modelDir, 'tokenizer'),
        hotwords: '',
        maxNewTokens: 96,
      },
      tokens: '',
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  });
}

function inferLanguage(
  result: { text?: string; lang?: string; tokens?: string[] },
  cleaned: string,
): string | null {
  const direct = String(result.lang || '').trim();
  if (direct) {
    return normalizeLang(direct);
  }
  const joined = `${result.text || ''} ${(result.tokens || []).join(' ')}`;
  const scaffold = joined.match(
    /language\s*([A-Za-z\u00C0-\u024F\u0600-\u06FF][A-Za-z\u00C0-\u024F\u0600-\u06FF\s-]*)/i,
  );
  if (scaffold?.[1]) {
    return normalizeLang(scaffold[1].trim());
  }
  return guessLanguageFromScript(cleaned);
}

function normalizeLang(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === 'en' || v.startsWith('eng')) {
    return 'en';
  }
  if (v === 'fr' || v.startsWith('fre') || v.startsWith('fra')) {
    return 'fr';
  }
  if (v === 'ar' || v.startsWith('ara')) {
    return 'ar';
  }
  if (v.includes('english')) {
    return 'en';
  }
  if (v.includes('french') || v.includes('français') || v.includes('francais')) {
    return 'fr';
  }
  if (v.includes('arabic') || v.includes('عربي')) {
    return 'ar';
  }
  return v.slice(0, 16);
}

async function drainQueue(): Promise<void> {
  if (busy) {
    return;
  }
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      if (!job || !recognizer) {
        continue;
      }
      const started = Date.now();
      try {
        const pcm = job.pcm instanceof Float32Array ? job.pcm : Float32Array.from(job.pcm);
        const stream = recognizer.createStream();
        if (job.languageHint && stream.setOption) {
          stream.setOption('language', job.languageHint);
        }
        stream.acceptWaveform(job.sampleRate, pcm);
        recognizer.decode(stream);
        const result = recognizer.getResult(stream);
        stream.free?.();
        const cleaned = cleanupTranscript(String(result?.text || ''));
        const language = cleaned ? inferLanguage(result || {}, cleaned) : null;
        send({
          type: 'result',
          id: job.id,
          text: cleaned,
          language,
          latencyMs: Date.now() - started,
          generation: activeGeneration,
        });
      } catch (err) {
        send({
          type: 'result',
          id: job.id,
          text: '',
          language: null,
          latencyMs: Date.now() - started,
          error: String(err),
          generation: activeGeneration,
        });
      }
    }
  } finally {
    busy = false;
    if (queue.length) {
      void drainQueue();
    }
  }
}

process.on('message', (msg: ParentMessage) => {
  if (!msg || typeof msg !== 'object') {
    return;
  }
  if (msg.type === 'ping') {
    send({ type: 'pong' });
    return;
  }
  if (msg.type === 'cancel') {
    activeGeneration = Number(msg.generation) || activeGeneration + 1;
    queue.length = 0;
    send({ type: 'cancelled', generation: activeGeneration });
    return;
  }
  if (msg.type === 'init') {
    if (recognizer) {
      // Already loaded: never rebuild (a second WASM recognizer aborts).
      send({ type: 'ready', modelDir: msg.modelDir });
      return;
    }
    try {
      loadRecognizer(msg.modelDir);
      send({ type: 'ready', modelDir: msg.modelDir });
    } catch (err) {
      recognizer = null;
      send({ type: 'error', error: String(err) });
    }
    return;
  }
  if (msg.type === 'transcribe') {
    if (!recognizer) {
      send({
        type: 'result',
        id: msg.id,
        text: '',
        language: null,
        latencyMs: 0,
        error: 'Qwen recognizer is not initialized.',
        generation: activeGeneration,
      });
      return;
    }
    queue.push(msg);
    void drainQueue();
  }
});

send({ type: 'boot' });

import { app } from 'electron';
import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import { LANGUAGE_HINTS, type AsrLanguageId } from './constants';
import { ensureQwenModelFiles, getQwenSetupState, qwenModelFilesPresent } from './qwen-models';

export type QwenTranscriptResult = {
  text: string;
  language: string | null;
  latencyMs: number;
  backend: 'qwen';
};

type Pending = {
  resolve: (value: QwenTranscriptResult) => void;
  reject: (err: Error) => void;
  generation: number;
};

let child: ChildProcess | null = null;
let ready = false;
let loading: Promise<void> | null = null;
let lastError: string | null = null;
let nextId = 1;
let listenGeneration = 0;
const pending = new Map<number, Pending>();

export function isQwenReady(): boolean {
  return ready;
}

export function isQwenLoading(): boolean {
  return !!loading;
}

export function getQwenError(): string | null {
  return lastError;
}

export function bumpQwenListenGeneration(): void {
  listenGeneration += 1;
  if (child && child.connected) {
    child.send({ type: 'cancel', generation: listenGeneration });
  }
  for (const [id, job] of pending) {
    pending.delete(id);
    job.resolve({
      text: '',
      language: null,
      latencyMs: 0,
      backend: 'qwen',
    });
  }
}

function workerScriptPath(): string {
  return path.join(__dirname, 'qwen-worker.js');
}

function attachChildHandlers(proc: ChildProcess): void {
  proc.on('message', (msg: Record<string, unknown>) => {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    if (msg['type'] === 'ready') {
      ready = true;
      lastError = null;
      return;
    }
    if (msg['type'] === 'error') {
      ready = false;
      lastError = String(msg['error'] || 'Qwen worker failed');
      return;
    }
    if (msg['type'] === 'result') {
      const id = Number(msg['id']);
      const job = pending.get(id);
      if (!job) {
        return;
      }
      pending.delete(id);
      if (job.generation !== listenGeneration) {
        job.resolve({
          text: '',
          language: null,
          latencyMs: Number(msg['latencyMs']) || 0,
          backend: 'qwen',
        });
        return;
      }
      if (msg['error']) {
        job.reject(new Error(String(msg['error'])));
        return;
      }
      job.resolve({
        text: String(msg['text'] || ''),
        language: msg['language'] ? String(msg['language']) : null,
        latencyMs: Number(msg['latencyMs']) || 0,
        backend: 'qwen',
      });
    }
  });
  proc.on('exit', (code) => {
    ready = false;
    child = null;
    const err = new Error(`Qwen ASR worker exited (code ${code})`);
    lastError = err.message;
    for (const [id, job] of pending) {
      pending.delete(id);
      job.reject(err);
    }
  });
  proc.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString().trim();
    if (line) {
      lastError = lastError || line.slice(0, 240);
    }
  });
}

async function ensureWorker(): Promise<void> {
  if (ready && child && child.connected) {
    return;
  }
  if (loading) {
    await loading;
    return;
  }
  loading = (async () => {
    lastError = null;
    const modelDir = await ensureQwenModelFiles((state) => {
      if (state.status === 'downloading' && state.progress != null) {
        lastError = `Downloading Qwen3-ASR model… ${state.progress}%`;
      } else if (state.status === 'extracting') {
        lastError = 'Extracting Qwen3-ASR model files…';
      } else if (state.status === 'error') {
        lastError = state.error;
      } else if (state.status === 'ready') {
        lastError = null;
      }
    });
    if (!qwenModelFilesPresent(modelDir)) {
      throw new Error(
        `Qwen model files missing. Expected files under ${getQwenSetupState().modelDir}.`,
      );
    }

    if (child) {
      try {
        child.kill();
      } catch {
        // Ignore.
      }
      child = null;
      ready = false;
    }

    const script = workerScriptPath();
    const proc = fork(script, [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      // Structured clone lets us send Float32Array instead of JSON number arrays.
      serialization: 'advanced',
    });
    child = proc;
    attachChildHandlers(proc);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Qwen ASR worker init timed out'));
      }, 180_000);
      // Init must be sent exactly once: a second init makes the worker rebuild the
      // recognizer, which aborts in WASM and discards the working one.
      let initSent = false;
      const sendInit = () => {
        if (initSent || !proc.connected) {
          return;
        }
        initSent = true;
        proc.send({ type: 'init', modelDir });
      };
      const onMsg = (msg: Record<string, unknown>) => {
        if (msg?.['type'] === 'ready') {
          clearTimeout(timer);
          proc.off('message', onMsg);
          resolve();
        } else if (msg?.['type'] === 'error') {
          clearTimeout(timer);
          proc.off('message', onMsg);
          reject(new Error(String(msg['error'])));
        } else if (msg?.['type'] === 'boot') {
          sendInit();
        }
      };
      proc.on('message', onMsg);
      // Fallback in case the boot message was missed; guarded by initSent.
      setTimeout(() => {
        if (!ready) {
          sendInit();
        }
      }, 250);
    });
    ready = true;
    lastError = null;
  })()
    .catch((err: unknown) => {
      ready = false;
      lastError = String(err);
      throw err;
    })
    .finally(() => {
      loading = null;
    });

  await loading;
}

export async function ensureQwenBackend(): Promise<void> {
  if (!app.isReady()) {
    await app.whenReady();
  }
  await ensureWorker();
}

export async function transcribeWithQwen(
  pcm: Float32Array,
  sampleRate: number,
  language: AsrLanguageId,
): Promise<QwenTranscriptResult> {
  await ensureQwenBackend();
  if (!child || !ready || !child.connected) {
    throw new Error(lastError || 'Qwen backend is not ready');
  }
  const id = nextId++;
  const generation = listenGeneration;
  const languageHint =
    language === 'auto' ? null : LANGUAGE_HINTS[language] || null;

  const resultPromise = new Promise<QwenTranscriptResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, generation });
  });

  child.send({
    type: 'transcribe',
    id,
    sampleRate,
    languageHint,
    pcm,
  });

  return withTimeout(resultPromise, 45_000, 'Qwen transcription timed out.');
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

import { app } from 'electron';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  QWEN_MODEL_ARCHIVE,
  QWEN_MODEL_DIR_NAME,
  QWEN_MODEL_URL,
  QWEN_REQUIRED_FILES,
} from './constants';

export type QwenSetupStatus =
  | 'missing'
  | 'downloading'
  | 'extracting'
  | 'ready'
  | 'error';

export type QwenSetupState = {
  status: QwenSetupStatus;
  progress: number | null;
  error: string | null;
  modelDir: string;
};

type ProgressListener = (state: QwenSetupState) => void;

let downloadPromise: Promise<string> | null = null;
let lastState: QwenSetupState = {
  status: 'missing',
  progress: null,
  error: null,
  modelDir: '',
};
const listeners = new Set<ProgressListener>();

export function getQwenModelRoot(): string {
  return path.join(app.getPath('userData'), 'asr-models');
}

export function getQwenModelDir(): string {
  return path.join(getQwenModelRoot(), QWEN_MODEL_DIR_NAME);
}

export function getQwenSetupState(): QwenSetupState {
  const modelDir = getQwenModelDir();
  if (!lastState.modelDir) {
    lastState = { ...lastState, modelDir };
  }
  if (lastState.status === 'downloading' || lastState.status === 'extracting') {
    return lastState;
  }
  if (qwenModelFilesPresent(modelDir)) {
    lastState = {
      status: 'ready',
      progress: 100,
      error: null,
      modelDir,
    };
  } else if (lastState.status !== 'error') {
    lastState = {
      status: 'missing',
      progress: null,
      error: null,
      modelDir,
    };
  }
  return lastState;
}

export function onQwenSetupProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(state: QwenSetupState): void {
  lastState = state;
  for (const listener of listeners) {
    listener(state);
  }
}

export function qwenModelFilesPresent(modelDir = getQwenModelDir()): boolean {
  if (!fs.existsSync(modelDir)) {
    return false;
  }
  for (const name of QWEN_REQUIRED_FILES) {
    if (!fs.existsSync(path.join(modelDir, name))) {
      return false;
    }
  }
  const tokenizer = path.join(modelDir, 'tokenizer');
  return fs.existsSync(tokenizer);
}

export async function ensureQwenModelFiles(
  onProgress?: ProgressListener,
): Promise<string> {
  const modelDir = getQwenModelDir();
  if (qwenModelFilesPresent(modelDir)) {
    const ready: QwenSetupState = {
      status: 'ready',
      progress: 100,
      error: null,
      modelDir,
    };
    emit(ready);
    onProgress?.(ready);
    return modelDir;
  }

  if (!downloadPromise) {
    downloadPromise = downloadAndExtract(modelDir, onProgress).finally(() => {
      downloadPromise = null;
    });
  } else if (onProgress) {
    const unsub = onQwenSetupProgress(onProgress);
    downloadPromise.finally(unsub);
  }
  return downloadPromise;
}

async function downloadAndExtract(
  modelDir: string,
  onProgress?: ProgressListener,
): Promise<string> {
  const root = getQwenModelRoot();
  fs.mkdirSync(root, { recursive: true });
  const archivePath = path.join(root, QWEN_MODEL_ARCHIVE);

  const unsub = onProgress ? onQwenSetupProgress(onProgress) : null;
  try {
    emit({
      status: 'downloading',
      progress: 0,
      error: null,
      modelDir,
    });
    await downloadFile(QWEN_MODEL_URL, archivePath, (pct) => {
      emit({
        status: 'downloading',
        progress: pct,
        error: null,
        modelDir,
      });
    });

    emit({
      status: 'extracting',
      progress: null,
      error: null,
      modelDir,
    });
    await extractArchive(archivePath, root);

    if (!qwenModelFilesPresent(modelDir)) {
      throw new Error(
        `Qwen model extract finished but required files are missing under ${modelDir}`,
      );
    }

    try {
      fs.unlinkSync(archivePath);
    } catch {
      // Keep archive if delete fails; files are usable.
    }

    const ready: QwenSetupState = {
      status: 'ready',
      progress: 100,
      error: null,
      modelDir,
    };
    emit(ready);
    return modelDir;
  } catch (err) {
    const failed: QwenSetupState = {
      status: 'error',
      progress: null,
      error: String(err),
      modelDir,
    };
    emit(failed);
    throw err;
  } finally {
    unsub?.();
  }
}

function downloadFile(
  url: string,
  destPath: string,
  onPct: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = `${destPath}.partial`;
    const file = fs.createWriteStream(tmp);
    const request = https.get(url, { timeout: 120_000 }, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        file.close();
        fs.unlink(tmp, () => undefined);
        downloadFile(res.headers.location, destPath, onPct).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(tmp, () => undefined);
        reject(new Error(`Download failed HTTP ${res.statusCode} for Qwen model`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      let lastPct = -1;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.min(99, Math.floor((received / total) * 100));
          if (pct !== lastPct) {
            lastPct = pct;
            onPct(pct);
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.rename(tmp, destPath, (err) => {
            if (err) {
              reject(err);
              return;
            }
            onPct(100);
            resolve();
          });
        });
      });
    });
    request.on('error', (err) => {
      file.close();
      fs.unlink(tmp, () => undefined);
      reject(err);
    });
    request.on('timeout', () => {
      request.destroy(new Error('Qwen model download timed out'));
    });
  });
}

function extractArchive(archivePath: string, destRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Windows 10+ ships bsdtar which handles .tar.bz2.
    const child = spawn(
      'tar',
      ['-xjf', archivePath, '-C', destRoot],
      { windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.on('error', (err) => {
      reject(
        new Error(
          `Failed to run tar for Qwen extract (${String(err)}). Install tar or extract ${QWEN_MODEL_ARCHIVE} manually into ${destRoot}.`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `tar extract failed (code ${code}): ${stderr.trim() || 'unknown error'}`,
        ),
      );
    });
  });
}

import {
  BACKEND_LABELS,
  DEFAULT_ASR_BACKEND,
  DEFAULT_ASR_LANGUAGE,
  LANGUAGE_LABELS,
  type AsrBackendId,
  type AsrLanguageId,
} from './asr/constants';
import {
  bumpQwenListenGeneration,
  ensureQwenBackend,
  getQwenError,
  isQwenLoading,
  isQwenReady,
  transcribeWithQwen,
} from './asr/qwen-backend';
import {
  getQwenSetupState,
  onQwenSetupProgress,
  type QwenSetupState,
} from './asr/qwen-models';
import {
  bumpWhisperListenGeneration,
  ensureWhisperBackend,
  getWhisperError,
  getWhisperModelId,
  isWhisperLoading,
  isWhisperReady,
  transcribeWithWhisper,
} from './asr/whisper-backend';

export type TranscriptResult = {
  text: string;
  language: string | null;
  latencyMs: number;
  backend: AsrBackendId;
  compare?: TranscriptResult[];
};

export type TranscriberStatus = {
  backend: AsrBackendId;
  language: AsrLanguageId;
  compareMode: boolean;
  ready: boolean;
  loading: boolean;
  error: string | null;
  modelLabel: string;
  languageLabel: string;
  qwenSetup: QwenSetupState;
  acceptanceDefaultUnlocked: boolean;
};

/**
 * Flip to true only after Windows acceptance checks in VERIFICATION.md are Pass.
 * Until then Qwen is preferred when ready, but Whisper remains the safe fallback
 * if Qwen model download/init fails.
 */
const QWEN_ACCEPTANCE_PASSED = false;

let backend: AsrBackendId = DEFAULT_ASR_BACKEND;
let language: AsrLanguageId = DEFAULT_ASR_LANGUAGE;
let compareMode = false;
let setupWarning: string | null = null;
let statusListeners = new Set<(status: TranscriberStatus) => void>();

onQwenSetupProgress(() => {
  emitStatus();
});

export function getAsrBackend(): AsrBackendId {
  return backend;
}

export function getAsrLanguage(): AsrLanguageId {
  return language;
}

export function isCompareMode(): boolean {
  return compareMode;
}

export function getTranscriberStatus(): TranscriberStatus {
  const activeReady = backend === 'qwen' ? isQwenReady() : isWhisperReady();
  const activeLoading = backend === 'qwen' ? isQwenLoading() : isWhisperLoading();
  const activeError =
    backend === 'qwen'
      ? getQwenError() || setupErrorMessage()
      : getWhisperError() || setupWarning;
  return {
    backend,
    language,
    compareMode,
    ready: activeReady,
    loading: activeLoading,
    error: activeError,
    modelLabel:
      backend === 'qwen'
        ? BACKEND_LABELS.qwen
        : `Whisper (${getWhisperModelId().replace('Xenova/', '')})`,
    languageLabel: LANGUAGE_LABELS[language],
    qwenSetup: getQwenSetupState(),
    acceptanceDefaultUnlocked: QWEN_ACCEPTANCE_PASSED,
  };
}

export function onTranscriberStatus(
  listener: (status: TranscriberStatus) => void,
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function emitStatus(): void {
  const status = getTranscriberStatus();
  for (const listener of statusListeners) {
    listener(status);
  }
}

function setupErrorMessage(): string | null {
  const setup = getQwenSetupState();
  if (setup.status === 'missing') {
    return 'Qwen3-ASR model files are not installed yet. Listen will download them once (~1 GB).';
  }
  if (setup.status === 'downloading') {
    return `Downloading Qwen3-ASR model… ${setup.progress ?? 0}%`;
  }
  if (setup.status === 'extracting') {
    return 'Extracting Qwen3-ASR model files…';
  }
  if (setup.status === 'error') {
    return setup.error;
  }
  return null;
}

export function setAsrBackend(next: AsrBackendId): TranscriberStatus {
  if (next === 'qwen' || next === 'whisper') {
    backend = next;
    if (next === 'qwen') {
      setupWarning = null;
    }
  }
  emitStatus();
  return getTranscriberStatus();
}

export function setAsrLanguage(next: AsrLanguageId): TranscriberStatus {
  if (next === 'auto' || next === 'en' || next === 'fr' || next === 'ar') {
    language = next;
  }
  emitStatus();
  return getTranscriberStatus();
}

export function setCompareMode(enabled: boolean): TranscriberStatus {
  compareMode = !!enabled;
  emitStatus();
  return getTranscriberStatus();
}

export function bumpListenGeneration(): void {
  bumpQwenListenGeneration();
  bumpWhisperListenGeneration();
}

export function isTranscriberReady(): boolean {
  return getTranscriberStatus().ready;
}

export function isTranscriberLoading(): boolean {
  return getTranscriberStatus().loading;
}

export function getTranscriberError(): string | null {
  return getTranscriberStatus().error;
}

export function getTranscriberModelId(): string {
  return getTranscriberStatus().modelLabel;
}

export async function ensureTranscriber(): Promise<void> {
  if (backend === 'qwen') {
    try {
      await ensureQwenBackend();
      emitStatus();
      return;
    } catch (err) {
      // Fall back so Listen still works while Qwen setup is incomplete.
      const message = `Qwen setup failed (${String(err)}). Using Whisper until Qwen model files are ready.`;
      setupWarning = message;
      backend = 'whisper';
      emitStatus();
      await ensureWhisperBackend(language);
      emitStatus();
      if (QWEN_ACCEPTANCE_PASSED) {
        throw new Error(message);
      }
      // Soft-fail: Whisper is ready; UI shows the setup warning via status.error.
      return;
    }
  }
  await ensureWhisperBackend(language);
  emitStatus();
}

export async function transcribePcm(
  pcm: Float32Array,
  sampleRate: number,
): Promise<TranscriptResult> {
  if (compareMode) {
    return transcribeCompare(pcm, sampleRate);
  }
  if (backend === 'qwen') {
    try {
      return await transcribeWithQwen(pcm, sampleRate, language);
    } catch (err) {
      // Keep the session usable if Qwen fails mid-listen.
      const whisper = await transcribeWithWhisper(pcm, sampleRate, language);
      return {
        ...whisper,
        text: whisper.text,
        compare: undefined,
      };
    }
  }
  return transcribeWithWhisper(pcm, sampleRate, language);
}

async function transcribeCompare(
  pcm: Float32Array,
  sampleRate: number,
): Promise<TranscriptResult> {
  const copy = Float32Array.from(pcm);
  const [qwenSettled, whisperSettled] = await Promise.allSettled([
    transcribeWithQwen(Float32Array.from(copy), sampleRate, language),
    transcribeWithWhisper(Float32Array.from(copy), sampleRate, language),
  ]);

  const qwen =
    qwenSettled.status === 'fulfilled'
      ? qwenSettled.value
      : {
          text: '',
          language: null,
          latencyMs: 0,
          backend: 'qwen' as const,
        };
  const whisper =
    whisperSettled.status === 'fulfilled'
      ? whisperSettled.value
      : {
          text: '',
          language: null,
          latencyMs: 0,
          backend: 'whisper' as const,
        };

  const primary = backend === 'whisper' ? whisper : qwen;
  return {
    ...primary,
    compare: [qwen, whisper],
  };
}

/** Warm preferred backends without failing app startup. */
export async function warmTranscriber(): Promise<void> {
  if (DEFAULT_ASR_BACKEND === 'qwen' && (QWEN_ACCEPTANCE_PASSED || getQwenSetupState().status === 'ready')) {
    backend = 'qwen';
    try {
      await ensureQwenBackend();
      emitStatus();
      return;
    } catch {
      backend = 'whisper';
    }
  } else if (!QWEN_ACCEPTANCE_PASSED && getQwenSetupState().status !== 'ready') {
    // Keep Whisper warm until the operator finishes Qwen acceptance.
    backend = 'whisper';
  }
  await ensureWhisperBackend(language);
  emitStatus();
}

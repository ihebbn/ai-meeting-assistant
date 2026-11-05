export type AsrBackendId = 'qwen' | 'whisper';

/** Auto leaves the model language hint unset so each segment is detected. */
export type AsrLanguageId = 'auto' | 'en' | 'fr' | 'ar';

export const QWEN_MODEL_DIR_NAME = 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25';
export const QWEN_MODEL_ARCHIVE = `${QWEN_MODEL_DIR_NAME}.tar.bz2`;
export const QWEN_MODEL_URL =
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${QWEN_MODEL_ARCHIVE}`;

export const QWEN_REQUIRED_FILES = [
  'conv_frontend.onnx',
  'encoder.int8.onnx',
  'decoder.int8.onnx',
] as const;

/**
 * Qwen is the intended default. It becomes active once model files initialize
 * successfully; Whisper remains available for side-by-side testing. Windows
 * acceptance checks in VERIFICATION.md must still be marked Pass by an operator.
 */
export const DEFAULT_ASR_BACKEND: AsrBackendId = 'qwen';
export const DEFAULT_ASR_LANGUAGE: AsrLanguageId = 'auto';

export const LANGUAGE_HINTS: Record<Exclude<AsrLanguageId, 'auto'>, string> = {
  en: 'English',
  fr: 'French',
  ar: 'Arabic',
};

export const LANGUAGE_LABELS: Record<AsrLanguageId, string> = {
  auto: 'Auto',
  en: 'English',
  fr: 'French',
  ar: 'Arabic',
};

export const BACKEND_LABELS: Record<AsrBackendId, string> = {
  qwen: 'Qwen3-ASR 0.6B INT8',
  whisper: 'Whisper base',
};

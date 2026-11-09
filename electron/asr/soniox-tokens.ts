/** Soniox token rules: https://docs.soniox.com/stt/rt/real-time-transcription */

export const SONIOX_MODEL = 'stt-rt-v6';
export const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
export const SONIOX_SAMPLE_RATE = 16000;

export type SonioxToken = {
  text?: string;
  is_final?: boolean;
  language?: string;
};

export type SonioxCaption = {
  /** Final tokens received so far in the open phrase. Each final token is appended once. */
  finalText: string;
  /** Non-final tokens from the latest message only. Replaced on every update. */
  provisional: string;
  language: string | null;
};

export function emptyCaption(): SonioxCaption {
  return { finalText: '', provisional: '', language: null };
}

/**
 * Final tokens in a message are new and must be appended.
 * Non-final tokens are the current hypothesis and replace the previous hypothesis.
 */
export function applySonioxTokens(state: SonioxCaption, tokens: SonioxToken[]): SonioxCaption {
  let finalText = state.finalText;
  let provisional = '';
  let language = state.language;
  for (const token of tokens) {
    const text = String(token.text ?? '');
    if (token.is_final) {
      finalText += text;
    } else {
      provisional += text;
    }
    if (token.language) {
      language = token.language;
    }
  }
  return { finalText, provisional, language };
}

export function liveCaptionText(state: SonioxCaption): string {
  return `${state.finalText}${state.provisional}`;
}

/** A phrase is ready to keep when Soniox has finalized it and no provisional tail remains. */
export function takeCommittedPhrase(state: SonioxCaption): { text: string; next: SonioxCaption } | null {
  if (state.provisional || !state.finalText.trim()) {
    return null;
  }
  return {
    text: state.finalText.trim(),
    next: { finalText: '', provisional: '', language: state.language },
  };
}

export function floatToPcm16le(samples: Float32Array): Buffer {
  const bytes = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    const int = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    bytes.writeInt16LE(int, i * 2);
  }
  return bytes;
}

/**
 * Hints bias stt-rt-v6 without locking the session.
 * Tunisian Arabic is not a separate Soniox language code; `ar` is the closest hint.
 */
export function buildSonioxStartMessage(): Record<string, unknown> {
  return {
    model: SONIOX_MODEL,
    audio_format: 'pcm_s16le',
    sample_rate: SONIOX_SAMPLE_RATE,
    num_channels: 1,
    language_hints: ['en', 'fr', 'de', 'ar'],
    enable_language_identification: true,
    enable_endpoint_detection: true,
    max_endpoint_delay_ms: 800,
    context: {
      general: [
        { key: 'domain', value: 'Software engineering meetings and coursework' },
        { key: 'speaker', value: 'Mohamed Iheb Ben Slama' },
        { key: 'organization', value: 'ESPRIT' },
      ],
      terms: ['Mohamed Iheb Ben Slama', 'ESPRIT', 'Spring Boot', 'Angular'],
    },
  };
}

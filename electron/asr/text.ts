/**
 * Shared transcript text helpers used by the Whisper backend and the Qwen worker.
 * Kept free of Electron imports so it can run in the forked worker and in tests.
 */

const NOISE_WORDS =
  /\b(uh|um|erm|inaudible|music|blank_audio|gibberish|clicks?|clicking|sighs?)\b/gi;

/** Strip ASR artefacts (annotations, filler, noise tags) and normalise spacing. */
export function cleanupTranscript(text: string): string {
  return text
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(NOISE_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();
}

/**
 * Cheap script-based language guess (ar / fr / en). Heuristic only: any Latin text
 * without French diacritics is reported as English, so treat it as a hint, never as truth.
 */
export function guessLanguageFromScript(text: string): 'ar' | 'fr' | 'en' | null {
  if (/[؀-ۿ]/.test(text)) {
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

import type { AsrLanguageId } from '../asr/constants';

export type BenchClip = {
  id: string;
  /** Path to a WAV file, relative to the manifest file. */
  audio: string;
  /** Ground-truth transcript, written by you. */
  reference: string;
  /** Language setting passed to the backends (default: auto). */
  language: AsrLanguageId;
  /** Free-form labels used for the per-tag breakdown, e.g. "tunisian-mixed". */
  tags: string[];
};

const LANGUAGES: readonly AsrLanguageId[] = ['auto', 'en', 'fr', 'ar'];

/** Validate a parsed manifest. Throws with a precise message on the first problem. */
export function parseManifest(raw: unknown): BenchClip[] {
  const clips = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { clips?: unknown }).clips)
      ? (raw as { clips: unknown[] }).clips
      : null;
  if (!clips) {
    throw new Error('Manifest must be an array of clips or { "clips": [...] }.');
  }
  if (clips.length === 0) {
    throw new Error('Manifest has no clips.');
  }

  const seen = new Set<string>();
  return clips.map((item, index) => {
    const where = `clip #${index + 1}`;
    if (!item || typeof item !== 'object') {
      throw new Error(`${where}: must be an object.`);
    }
    const c = item as Record<string, unknown>;
    if (typeof c['id'] !== 'string' || !c['id'].trim()) {
      throw new Error(`${where}: "id" must be a non-empty string.`);
    }
    if (seen.has(c['id'])) {
      throw new Error(`${where}: duplicate id "${c['id']}".`);
    }
    seen.add(c['id']);
    if (typeof c['audio'] !== 'string' || !c['audio'].trim()) {
      throw new Error(`${where} (${c['id']}): "audio" must be a non-empty path.`);
    }
    if (typeof c['reference'] !== 'string' || !c['reference'].trim()) {
      throw new Error(`${where} (${c['id']}): "reference" must be a non-empty string.`);
    }
    const language = c['language'] === undefined ? 'auto' : c['language'];
    if (!LANGUAGES.includes(language as AsrLanguageId)) {
      throw new Error(
        `${where} (${c['id']}): "language" must be one of ${LANGUAGES.join(', ')}.`,
      );
    }
    const tags = c['tags'] === undefined ? [] : c['tags'];
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
      throw new Error(`${where} (${c['id']}): "tags" must be an array of strings.`);
    }
    return {
      id: c['id'],
      audio: c['audio'],
      reference: c['reference'],
      language: language as AsrLanguageId,
      tags: tags as string[],
    };
  });
}

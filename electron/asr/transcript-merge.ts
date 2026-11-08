import type { TranscriptLine } from '../session';

/** Interim rows use stable ids. Only the speaker being committed should lose theirs. */
export function interimPrefixForSpeaker(speaker: string): string | null {
  if (
    speaker === 'You' ||
    speaker.startsWith('You ') ||
    speaker.startsWith('You·') ||
    speaker.startsWith('You ·')
  ) {
    return 'you-interim-';
  }
  if (speaker.startsWith('System audio')) {
    return 'system-interim-';
  }
  return null;
}

export function commitTranscriptLine(
  existing: TranscriptLine[],
  line: TranscriptLine,
  max = 200,
): TranscriptLine[] {
  const withTs: TranscriptLine = {
    ...line,
    at: line.at || new Date().toISOString(),
  };
  const prefix = interimPrefixForSpeaker(withTs.speaker);
  const kept = existing.filter((item) => (prefix ? !item.id.startsWith(prefix) : true));
  return [...kept, withTs].slice(-max);
}

/** Keep in sync with cleanupCaption in src/app/audio/listen-pipeline.ts. */

export function cleanupCaption(text: string): string {
  const t = text
    .replace(/\((?:music|applause|laughter|inaudible|blank_audio|silence|noise|background)[^)]*\)/gi, ' ')
    .replace(/\[(?:music|applause|laughter|inaudible|blank_audio|silence|noise|background)[^\]]*\]/gi, ' ')
    .replace(/\*(?:music|applause|laughter|inaudible|blank_audio|silence|noise)\*/gi, ' ')
    .replace(/\b(uh|um|erm|inaudible|blank_audio|gibberish)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();
  if (!t || t.length < 2) {
    return '';
  }
  if (!/\p{L}|\p{N}/u.test(t)) {
    return '';
  }
  if (
    /^(thanks for watching!?|thank you for watching!?|thanks for listening!?|please subscribe)/i.test(
      t,
    )
  ) {
    return '';
  }
  const compact = t.replace(/[\s,.!?…]+/g, '');
  if (compact.length >= 8 && /^(.)\1+$/u.test(compact)) {
    return '';
  }
  const tokens = t.split(/[\s,./!?…]+/).filter(Boolean);
  if (tokens.length >= 6) {
    const first = tokens[0]!.toLowerCase();
    if (tokens.every((tok) => tok.toLowerCase() === first) && first.length <= 6) {
      return '';
    }
  }
  if (isRepeatedLoop(tokens)) {
    return '';
  }
  return t;
}

function isRepeatedLoop(tokens: string[]): boolean {
  const words = tokens.map((tok) => tok.toLowerCase());
  if (words.length < 6) {
    return false;
  }
  for (let size = 1; size <= 3; size += 1) {
    if (words.length < size * 4) {
      continue;
    }
    const unit = words.slice(0, size).join('\0');
    let matched = 0;
    for (let i = 0; i + size <= words.length; i += size) {
      if (words.slice(i, i + size).join('\0') !== unit) {
        break;
      }
      matched += size;
    }
    if (matched >= size * 4 && matched / words.length >= 0.8) {
      return true;
    }
  }
  return false;
}

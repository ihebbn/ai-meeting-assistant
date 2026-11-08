import type { InsightAction, TranscriptLine } from '../session';
import { commitTranscriptLine } from '../asr/transcript-merge';
import type { ScreenFrame } from './screen-capture';

export type ContextNeed = 'transcript' | 'screen' | 'both' | 'none';

export type AskOrigin = 'typed' | 'shortcut' | 'insight';

export type AskRequest = {
  origin: AskOrigin;
  /** Explicit typed text when origin is typed; otherwise resolved intent. */
  prompt: string;
  actionId?: string;
  explicit: boolean;
};

export type PackagedContext = {
  need: ContextNeed;
  transcript: TranscriptLine[];
  screen: ScreenFrame | null;
  screenHistoryNotes: string[];
  usedConversation: boolean;
  usedScreen: boolean;
};

const MAX_TRANSCRIPT_LINES = 200;
const MAX_SCREEN_HISTORY = 5;
const MAX_SUGGESTION_MEMORY = 40;

/** In-memory screen history (full frames). Not broadcast to the renderer. */
const screenHistory: ScreenFrame[] = [];
let latestScreen: ScreenFrame | null = null;
const suggestionFingerprints = new Set<string>();
const suggestionOrder: string[] = [];

export function getLatestScreenFrame(): ScreenFrame | null {
  return latestScreen;
}

export function getScreenHistory(): ScreenFrame[] {
  return [...screenHistory];
}

export function clearScreenContext(): void {
  screenHistory.length = 0;
  latestScreen = null;
}

export function rememberScreenFrame(frame: ScreenFrame, changed: boolean): void {
  latestScreen = frame;
  if (!changed && screenHistory.length) {
    // Refresh latest pointer only.
    screenHistory[screenHistory.length - 1] = frame;
    return;
  }
  screenHistory.push(frame);
  while (screenHistory.length > MAX_SCREEN_HISTORY) {
    screenHistory.shift();
  }
}

export function appendRollingTranscript(
  existing: TranscriptLine[],
  line: TranscriptLine,
): TranscriptLine[] {
  return commitTranscriptLine(existing, line, MAX_TRANSCRIPT_LINES);
}

export function fingerprintSuggestion(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s?/.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export function rememberSuggestion(label: string): boolean {
  const fp = fingerprintSuggestion(label);
  if (!fp || suggestionFingerprints.has(fp)) {
    return false;
  }
  // Near-duplicate: prefix overlap with a recent fingerprint.
  for (const prev of suggestionFingerprints) {
    if (fp.length > 18 && prev.length > 18) {
      if (fp.includes(prev.slice(0, 24)) || prev.includes(fp.slice(0, 24))) {
        return false;
      }
    }
  }
  suggestionFingerprints.add(fp);
  suggestionOrder.push(fp);
  while (suggestionOrder.length > MAX_SUGGESTION_MEMORY) {
    const old = suggestionOrder.shift();
    if (old) {
      suggestionFingerprints.delete(old);
    }
  }
  return true;
}

export function dedupeInsightActions(actions: InsightAction[]): InsightAction[] {
  const out: InsightAction[] = [];
  for (const action of actions) {
    if (!rememberSuggestion(action.label)) {
      continue;
    }
    out.push(action);
  }
  return out;
}

const ANSWER_SCREEN_RE =
  /^\s*(answer|answers?|réponds?|reponds?|réponds[- ]?moi|la réponse|donne la réponse|what'?s the answer|solve(?:\s+it)?|which (?:one|option)|pick(?:\s+one)?|qcm|quiz|mcq)\s*[.!?…]?\s*$/i;

const ANSWER_SCREEN_LOOSE_RE =
  /\b(answer (?:this|the|it)|réponds|on[- ]?screen|qcm|multiple[- ]choice|which option|quelle (?:est )?la réponse)\b/i;

export function findLatestSpokenQuestion(transcript: TranscriptLine[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const line = transcript[i];
    if (!line) {
      continue;
    }
    const text = line.text.trim();
    if (!text || text === '…') {
      continue;
    }
    if (ANSWER_SCREEN_RE.test(text) || ANSWER_SCREEN_LOOSE_RE.test(text)) {
      continue;
    }
    if (text.length < 8) {
      continue;
    }
    if (/[?؟]\s*$/.test(text) || /^(who|what|when|where|why|how|can|could|should|is|are|do|does|did|will|would)\b/i.test(text)) {
      return text;
    }
  }
  return null;
}

/** Short spoken/typed cues that mean “answer whatever is on my screen”. */
export function findScreenAnswerIntent(
  transcript: TranscriptLine[],
  typedPrompt?: string,
): string | null {
  const typed = String(typedPrompt || '').trim();
  if (typed && (ANSWER_SCREEN_RE.test(typed) || ANSWER_SCREEN_LOOSE_RE.test(typed))) {
    return typed;
  }
  for (let i = transcript.length - 1; i >= Math.max(0, transcript.length - 8); i -= 1) {
    const text = transcript[i]?.text?.trim() || '';
    if (!text || text === '…') {
      continue;
    }
    if (ANSWER_SCREEN_RE.test(text) || ANSWER_SCREEN_LOOSE_RE.test(text)) {
      return text;
    }
  }
  return null;
}

export function resolveAskRequest(input: {
  typedPrompt?: string;
  actionId?: string;
  actionLabel?: string;
  origin: AskOrigin;
  transcript: TranscriptLine[];
  insightActions: InsightAction[];
}): AskRequest {
  const typed = String(input.typedPrompt || '').trim();

  // “Answer” / “réponds” / QCM cues → solve the on-screen question.
  const screenAnswer = findScreenAnswerIntent(input.transcript, typed);
  if (screenAnswer && (input.origin === 'shortcut' || input.origin === 'typed')) {
    return {
      origin: input.origin,
      prompt: screenAnswer,
      actionId: 'answer-screen',
      explicit: input.origin === 'typed' && typed.length > 0,
    };
  }

  if (typed && input.origin === 'typed') {
    return {
      origin: 'typed',
      prompt: typed,
      actionId: input.actionId,
      explicit: true,
    };
  }

  if (input.origin === 'insight' && (input.actionLabel || input.actionId)) {
    return {
      origin: 'insight',
      prompt: input.actionLabel || input.actionId || 'Help with this insight',
      actionId: input.actionId,
      explicit: true,
    };
  }

  // Shortcut / empty Ask AI — prefer latest spoken question, else top insight, else screen task.
  const spoken = findLatestSpokenQuestion(input.transcript);
  if (spoken) {
    return {
      origin: 'shortcut',
      prompt: spoken,
      actionId: 'answer-spoken',
      explicit: false,
    };
  }

  const screenish = input.insightActions.find((a) =>
    /screen|slide|visible|on[- ]?screen|error|code|method|quiz|qcm|question/i.test(a.label),
  );
  if (screenish) {
    return {
      origin: 'shortcut',
      prompt: screenish.label,
      actionId: screenish.id || 'screen',
      explicit: false,
    };
  }

  if (input.insightActions[0]) {
    return {
      origin: 'shortcut',
      prompt: input.insightActions[0].label,
      actionId: input.insightActions[0].id,
      explicit: false,
    };
  }

  return {
    origin: 'shortcut',
    prompt: 'Answer the main question or quiz visible on screen right now.',
    actionId: 'answer-screen',
    explicit: false,
  };
}

export function decideContextNeed(request: AskRequest): ContextNeed {
  const text = `${request.prompt} ${request.actionId || ''}`.toLowerCase();

  if (
    request.actionId === 'answer-screen' ||
    request.actionId === 'screen' ||
    /\b(screen|slide|slides|shared screen|whiteboard|diagram|ui|button|pixel|qcm|quiz|mcq|multiple[- ]choice)\b/.test(
      text,
    ) ||
    ANSWER_SCREEN_RE.test(text) ||
    ANSWER_SCREEN_LOOSE_RE.test(text)
  ) {
    return /\b(say|reply|transcript|they said|audio|heard)\b/.test(text) ? 'both' : 'screen';
  }

  if (
    /\b(this method|this function|this class|this error|this code|this stack|line \d+|compiler|typescript|exception)\b/.test(
      text,
    )
  ) {
    return 'both';
  }

  if (
    request.actionId === 'reply' ||
    request.actionId === 'followups' ||
    request.actionId === 'answer-spoken' ||
    /\b(reply|respond|suggest a reply|what (should|do) i say|they asked)\b/.test(text)
  ) {
    return 'both';
  }

  if (
    request.explicit &&
    /\b(what is|explain|define|how does|compare|why|concept|difference between)\b/.test(text) &&
    !/\b(this|these|here|on screen|above|slide|qcm|quiz)\b/.test(text)
  ) {
    // General knowledge / reasoning — transcript optional, no screen required.
    return 'none';
  }

  if (request.actionId === 'helpful' || request.actionId === 'recap') {
    return 'both';
  }

  // Default: conversation evidence; include screen when Watch is likely useful.
  return 'both';
}

export function packageContextForAsk(options: {
  need: ContextNeed;
  transcript: TranscriptLine[];
  screenVisionEnabled: boolean;
  latestScreen: ScreenFrame | null;
  history: ScreenFrame[];
}): PackagedContext {
  const useConversation = options.need === 'transcript' || options.need === 'both';
  const useScreen =
    options.screenVisionEnabled &&
    (options.need === 'screen' || options.need === 'both') &&
    !!options.latestScreen;

  const transcript = useConversation ? options.transcript.slice(-36) : [];
  const screen = useScreen ? options.latestScreen : null;
  const screenHistoryNotes =
    useScreen && options.history.length
      ? options.history.slice(-MAX_SCREEN_HISTORY).map((frame, index, all) => {
          const age = all.length - index;
          return `Frame -${age - 1 || 0}: ${frame.label} @ ${frame.capturedAt} (${frame.width}×${frame.height})${frame.changed ? ' [changed]' : ''}`;
        })
      : [];

  return {
    need: options.need,
    transcript,
    screen,
    screenHistoryNotes,
    usedConversation: transcript.length > 0,
    usedScreen: !!screen,
  };
}

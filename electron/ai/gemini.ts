import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { InsightAction, TranscriptLine } from '../session';
import type { PackagedContext, AskRequest } from './session-context';
import type { ScreenFrame } from './screen-capture';
import { bootstrapGeminiApiKey, getGeminiApiKey } from './secrets';

const PRIMARY_MODEL = 'gemini-3.8-flash';
/** Tried in order when the primary model is overloaded (503) or unavailable. */
const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'] as const;
const ASK_MODELS = [PRIMARY_MODEL, ...FALLBACK_MODELS];

export type MeetingInsights = {
  topic: string;
  recap: string[];
  actions: InsightAction[];
};

export type AskStreamHandlers = {
  onToken: (partial: string) => void;
  shouldCancel?: () => boolean;
};

export type AskResultMeta = {
  usedConversation: boolean;
  usedScreen: boolean;
};

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = getGeminiApiKey() || bootstrapGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      'Gemini API key missing. Set GEMINI_API_KEY in .env or save it under the app userData folder.',
    );
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export function isGeminiConfigured(): boolean {
  return !!(getGeminiApiKey() || bootstrapGeminiApiKey());
}

function formatTranscript(lines: TranscriptLine[], limit = 40): string {
  if (!lines.length) {
    return '(No transcript included for this request.)';
  }
  return lines
    .slice(-limit)
    .map((line) => {
      const lang = line.language ? ` [${line.language}]` : '';
      const at = line.at ? ` @ ${line.at}` : '';
      return `${line.speaker}${lang}${at}: ${line.text}`;
    })
    .join('\n');
}

function actionPrompt(actionId: string | undefined, prompt: string): string {
  switch (actionId) {
    case 'reply':
      return 'Suggest a concise spoken reply the user can say next (1-3 sentences). Prefer natural phrasing.';
    case 'followups':
      return 'Suggest 3-5 sharp follow-up questions the user can ask next. Use a short bullet list.';
    case 'helpful':
      return 'Give helpful talking points / context so the user can respond confidently. Keep it tight.';
    case 'define':
      return 'Define the most important term or concept currently under discussion in plain language.';
    case 'recap':
      return 'Summarize the conversation and any visible screen context in 3-5 short bullets focused on decisions and open questions.';
    case 'screen':
      return 'Explain what is currently visible on screen and how it relates to the spoken conversation. If a question, quiz, or QCM is shown, answer it and pick the correct option.';
    case 'answer-screen':
      return [
        'The user asked you to answer what is on screen (often a quiz / QCM / multiple-choice).',
        'Read the attached screenshot carefully. Answer the visible question directly.',
        'If it is multiple-choice, state the correct option letter/number and a one-line reason.',
        'If the screenshot is blank, unreadable, or you cannot find a clear question, say exactly what is missing (e.g. “I can’t see a quiz on screen — open the QCM or enable Watch Screen”).',
        'Do not invent a different topic.',
      ].join(' ');
    case 'answer-spoken':
      return `Answer this spoken question directly and helpfully: ${prompt}`;
    case 'auto':
      return 'Answer the latest spoken question or the main on-screen task (quiz/QCM if visible). If unclear, say what is missing in one short sentence.';
    default:
      return prompt;
  }
}

function buildSystemPrompt(ctx: PackagedContext, request: AskRequest): string {
  return [
    'You are Meeting Copilot, a real-time meeting assistant.',
    'Use your general knowledge and reasoning freely to explain concepts, interpret code, diagnose errors, compare options, or suggest what to say.',
    'Treat transcript and screen content as evidence when provided — do not invent meeting-specific facts that conflict with them.',
    request.explicit
      ? 'The user typed an explicit request — that request takes priority over automatic suggestions.'
      : 'This request was inferred from recent speech or an on-screen task — answer that intent.',
    request.actionId === 'answer-screen'
      ? 'Priority: solve the on-screen question/quiz. Ignore unrelated chat topics unless needed to pick an answer.'
      : '',
    ctx.usedConversation && ctx.usedScreen
      ? 'Both transcript and a screen frame are attached. Use whichever modality is needed; combine them when the question spans both.'
      : ctx.usedConversation
        ? 'Transcript evidence is attached; no screen frame for this request.'
        : ctx.usedScreen
          ? 'A screen frame is attached; transcript was omitted for this request.'
          : 'No transcript or screen evidence was attached — answer from knowledge/reasoning alone.',
    'If evidence is missing or ambiguous, say what you need instead of guessing a different question.',
    'If a reference like “this method” or “that error” is ambiguous across evidence, state your assumption in one short clause or ask one focused question.',
    'Be concise and ready to speak aloud. Prefer short paragraphs or bullets.',
    'Match the dominant language of the latest transcript when answering, unless the user asks otherwise.',
  ]
    .filter(Boolean)
    .join(' ');
}

function buildTextPrompt(
  request: AskRequest,
  ctx: PackagedContext,
): string {
  const instruction = actionPrompt(request.actionId, request.prompt);
  const screenNote = ctx.screen
    ? `Latest screenshot attached (${ctx.screen.width}×${ctx.screen.height}, ${ctx.screen.label}, ${ctx.screen.capturedAt}${ctx.screen.changed ? ', content changed' : ''}).`
    : 'Screenshot: not attached for this request.';
  const historyNote = ctx.screenHistoryNotes.length
    ? `Recent screen history (oldest→newest):\n${ctx.screenHistoryNotes.join('\n')}`
    : '';
  return [
    `System: ${buildSystemPrompt(ctx, request)}`,
    '',
    `Ask origin: ${request.origin}${request.explicit ? ' (explicit)' : ' (inferred)'}`,
    screenNote,
    historyNote,
    '',
    'Live transcript (You = mic, System audio = remote/call):',
    formatTranscript(ctx.transcript),
    '',
    `User request: ${instruction}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildContents(
  request: AskRequest,
  ctx: PackagedContext,
): Array<string | { inlineData: { mimeType: string; data: string } }> {
  const text = buildTextPrompt(request, ctx);
  if (!ctx.screen) {
    return [text];
  }
  return [
    {
      inlineData: {
        mimeType: ctx.screen.mimeType,
        data: ctx.screen.base64,
      },
    },
    text,
  ];
}

function extractVisibleText(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') {
    return '';
  }
  const asAny = chunk as {
    text?: unknown;
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    }>;
  };
  try {
    if (typeof asAny.text === 'string' && asAny.text) {
      return asAny.text;
    }
  } catch {
    // chunk.text can throw when the SDK sees mixed thought/answer parts.
  }
  const parts = asAny.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts
    .filter((part) => part && !part.thought && typeof part.text === 'string')
    .map((part) => part.text || '')
    .join('');
}

function isRetryableGeminiError(err: unknown): boolean {
  const text = String(err);
  return (
    /\b503\b/.test(text) ||
    /UNAVAILABLE/i.test(text) ||
    /high demand/i.test(text) ||
    /try again later/i.test(text) ||
    /\b429\b/.test(text) ||
    /RESOURCE_EXHAUSTED/i.test(text) ||
    /\b404\b/.test(text) ||
    /NOT_FOUND/i.test(text) ||
    /no longer available/i.test(text)
  );
}

export function formatGeminiUserError(err: unknown): string {
  const text = String(err);
  if (/high demand|UNAVAILABLE|\b503\b/i.test(text)) {
    return 'Gemini is busy right now (high demand). Retrying usually works in a few seconds — press Ask AI again.';
  }
  if (/RESOURCE_EXHAUSTED|\b429\b/i.test(text)) {
    return 'Gemini rate limit hit. Wait a moment, then ask again.';
  }
  if (/no longer available|NOT_FOUND|\b404\b/i.test(text)) {
    return 'Gemini model unavailable. The app will try a fallback model on the next ask.';
  }
  if (/API key|GEMINI_API_KEY|401|403|PERMISSION/i.test(text)) {
    return 'Gemini API key rejected. Check GEMINI_API_KEY in your local .env and restart.';
  }
  if (/timed out/i.test(text)) {
    return 'Gemini timed out. Try a shorter question or ask again.';
  }
  const short = text.replace(/\s+/g, ' ').trim().slice(0, 220);
  return `Gemini error: ${short}`;
}

async function streamWithModel(
  model: string,
  options: {
    request: AskRequest;
    context: PackagedContext;
    handlers: AskStreamHandlers;
  },
): Promise<string> {
  const ai = getClient();
  const stream = await ai.models.generateContentStream({
    model,
    contents: buildContents(options.request, options.context),
    config: {
      // Prefer fast first tokens for live meeting answers.
      thinkingConfig: {
        thinkingLevel:
          model.includes('lite') ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
      },
    },
  });

  let full = '';
  const started = Date.now();
  const timeoutMs = 55_000;
  for await (const chunk of stream) {
    if (options.handlers.shouldCancel?.()) {
      return full;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('Gemini timed out while drafting the answer. Try Ask AI again.');
    }
    const piece = extractVisibleText(chunk);
    if (!piece) {
      continue;
    }
    full += piece;
    options.handlers.onToken(full);
  }
  return full.trim();
}

export async function streamMeetingAnswer(options: {
  request: AskRequest;
  context: PackagedContext;
  handlers: AskStreamHandlers;
}): Promise<string> {
  let lastError: unknown = null;
  for (let i = 0; i < ASK_MODELS.length; i += 1) {
    const model = ASK_MODELS[i]!;
    if (options.handlers.shouldCancel?.()) {
      return '';
    }
    try {
      if (i > 0) {
        options.handlers.onToken(`Gemini busy — trying ${model}…`);
        await new Promise((resolve) => setTimeout(resolve, 700 * i));
      }
      return await streamWithModel(model, options);
    } catch (err) {
      lastError = err;
      if (!isRetryableGeminiError(err) || i === ASK_MODELS.length - 1) {
        throw err;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || 'Gemini request failed'));
}

export async function analyzeMeeting(
  transcript: TranscriptLine[],
  screen?: ScreenFrame | null,
): Promise<MeetingInsights | null> {
  if (transcript.length < 2 && !screen) {
    return null;
  }
  const ai = getClient();
  const textPrompt = [
    'Analyze this live meeting using the transcript and optional screenshot. Return ONLY compact JSON with keys:',
    '{"topic":"string","recap":["string"],"actions":[{"id":"string","label":"string","icon":"book|globe|chat|sparkle|reply"}]}',
    'Rules:',
    '- topic: short meeting theme (max ~8 words)',
    '- recap: 3 short bullets of what matters now (mix audio + visible screen facts)',
    '- actions: exactly 4 clickable suggestions — prefer concrete spoken questions you heard and visible on-screen tasks',
    '- action labels should be phrased as the user intent (e.g. “Answer: why is latency high?”, “Explain the error on screen”)',
    '- action ids must be unique kebab-case; icons must be one of book|globe|chat|sparkle|reply',
    '- Avoid near-duplicate actions that restate the same question',
    '- No markdown fences. JSON only.',
    '',
    screen
      ? `Screenshot attached (${screen.width}×${screen.height}, ${screen.label}).`
      : 'Screenshot: none.',
    '',
    formatTranscript(transcript, 50),
  ].join('\n');

  const contents = screen
    ? [
        {
          inlineData: {
            mimeType: screen.mimeType,
            data: screen.base64,
          },
        },
        textPrompt,
      ]
    : [textPrompt];

  let lastError: unknown = null;
  for (let i = 0; i < ASK_MODELS.length; i += 1) {
    const model = ASK_MODELS[i]!;
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          thinkingConfig: {
            thinkingLevel:
              model.includes('lite') ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
          },
        },
      });
      let text = '';
      try {
        text = String(response.text || '').trim();
      } catch {
        text = extractVisibleText(response).trim();
      }
      return parseInsightsJson(text);
    } catch (err) {
      lastError = err;
      if (!isRetryableGeminiError(err) || i === ASK_MODELS.length - 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return null;
}

function parseInsightsJson(raw: string): MeetingInsights | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      topic?: string;
      recap?: unknown;
      actions?: unknown;
    };
    const topic = String(parsed.topic || '').trim() || 'Live conversation';
    const recap = Array.isArray(parsed.recap)
      ? parsed.recap.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
      : [];
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions
          .map((item, index) => normalizeAction(item, index))
          .filter((item): item is InsightAction => !!item)
          .slice(0, 5)
      : [];
    if (!recap.length && !actions.length) {
      return null;
    }
    return {
      topic,
      recap: recap.length
        ? recap
        : ['Listening — captions and screen context will refresh this recap.'],
      actions: actions.length ? actions : defaultMeetingActions(),
    };
  } catch {
    return null;
  }
}

function normalizeAction(raw: unknown, index: number): InsightAction | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const item = raw as { id?: unknown; label?: unknown; icon?: unknown };
  const label = String(item.label || '').trim();
  if (!label) {
    return null;
  }
  const iconRaw = String(item.icon || 'sparkle');
  const icon =
    iconRaw === 'book' ||
    iconRaw === 'globe' ||
    iconRaw === 'chat' ||
    iconRaw === 'sparkle' ||
    iconRaw === 'reply'
      ? iconRaw
      : 'sparkle';
  const id =
    String(item.id || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || `action-${index + 1}`;
  return { id, label, icon };
}

export function defaultMeetingActions(): InsightAction[] {
  return [
    { id: 'reply', label: 'Suggest a reply', icon: 'reply' },
    { id: 'screen', label: 'Explain what is on screen', icon: 'globe' },
    { id: 'followups', label: 'Suggest follow-up questions', icon: 'chat' },
    { id: 'helpful', label: 'Give me helpful talking points', icon: 'sparkle' },
  ];
}

export type InsightAction = {
  id: string;
  label: string;
  icon: 'book' | 'globe' | 'chat' | 'sparkle' | 'reply';
};

export type AsrBackendId = 'qwen' | 'whisper' | 'soniox';
export type AsrLanguageId = 'auto' | 'en' | 'fr' | 'ar';

export type TranscriptLine = {
  id: string;
  speaker: string;
  text: string;
  /** ISO timestamp when the caption was committed. */
  at?: string;
  language?: string | null;
  backend?: AsrBackendId | null;
  latencyMs?: number | null;
};

export type AiMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  /** Sources that materially informed this assistant reply. */
  usedConversation?: boolean;
  usedScreen?: boolean;
};

export type OverlaySize = {
  width: number;
  height: number;
};

export type AudioActivity = {
  micLevel: number;
  systemLevel: number;
  micActive: boolean;
  systemActive: boolean;
};

export type ListenStatus = 'idle' | 'starting' | 'listening' | 'error';

export type SessionState = {
  listening: boolean;
  elapsedSeconds: number;
  /** When true, panels are concealed but the toolbar stays visible. */
  panelsHidden: boolean;
  /** Extra chrome height while the toolbar ⋮ menu is open (toolbar-only). */
  menuOpen: boolean;
  insightsOpen: boolean;
  responseOpen: boolean;
  showTranscript: boolean;
  /** Remembered expanded panel area size (below toolbar). */
  panelSize: OverlaySize;
  topic: string;
  recap: string[];
  actions: InsightAction[];
  transcript: TranscriptLine[];
  currentQuestion: string;
  messages: AiMessage[];
  followUpDraft: string;
  audio: AudioActivity;
  listenStatus: ListenStatus;
  listenError: string | null;
  modelReady: boolean;
  asrBackend: AsrBackendId;
  asrLanguage: AsrLanguageId;
  asrCompareMode: boolean;
  detectedLanguage: string | null;
  asrModelLabel: string;
  asrSetupMessage: string | null;
  /** Watch Screen — on by default; tracks display changes in the background. */
  screenVisionEnabled: boolean;
  lastScreenCaptureAt: string | null;
  screenVisionError: string | null;
};

export const ASK_ACCELERATOR = 'CommandOrControl+Return';
export const HIDE_ACCELERATOR = 'CommandOrControl+\\';

export const TOOLBAR_HEIGHT = 56;
export const TOOLBAR_WIDTH = 720;
/** Padding around panels only; toolbar-only mode uses zero pad for a clean pill edge. */
export const SHELL_PAD = 8;
export const TOOLBAR_ONLY_PAD = 0;
export const PANEL_GAP = 10;
export const MIN_PANEL_WIDTH = 420;
export const MIN_PANEL_HEIGHT = 260;
export const DEFAULT_PANEL_WIDTH = 760;
export const DEFAULT_PANEL_HEIGHT = 440;

export function createInitialSession(): SessionState {
  return {
    listening: false,
    elapsedSeconds: 0,
    panelsHidden: false,
    menuOpen: false,
    insightsOpen: true,
    responseOpen: false,
    showTranscript: true,
    panelSize: {
      width: DEFAULT_PANEL_WIDTH,
      height: DEFAULT_PANEL_HEIGHT,
    },
    topic: 'Live conversation',
    recap: [
      'Press Listen for a rolling timestamped transcript (You + System audio).',
      'Enable Watch Screen to track meaningful display changes in the background.',
      'Type a question, press Ask AI, or tap an insight — Gemini picks transcript, screen, both, or knowledge.',
    ],
    actions: [
      { id: 'reply', label: 'Suggest a reply', icon: 'reply' },
      { id: 'screen', label: 'Explain what is on screen', icon: 'globe' },
      { id: 'followups', label: 'Suggest follow-up questions', icon: 'chat' },
      { id: 'helpful', label: 'Give me helpful talking points', icon: 'sparkle' },
    ],
    transcript: [],
    currentQuestion: '',
    messages: [],
    followUpDraft: '',
    audio: {
      micLevel: 0,
      systemLevel: 0,
      micActive: false,
      systemActive: false,
    },
    listenStatus: 'idle',
    listenError: null,
    modelReady: false,
    asrBackend: 'whisper',
    asrLanguage: 'auto',
    asrCompareMode: false,
    detectedLanguage: null,
    asrModelLabel: 'Whisper base',
    asrSetupMessage: null,
    screenVisionEnabled: true,
    lastScreenCaptureAt: null,
    screenVisionError: null,
  };
}

export function answerForPrompt(_prompt: string, _actionId?: string): string {
  return 'Gemini is not configured. Add GEMINI_API_KEY to a local .env file and restart.';
}

export function anyPanelOpen(session: SessionState): boolean {
  if (session.panelsHidden) {
    return false;
  }
  return session.insightsOpen || session.responseOpen;
}

export function clampPanelSize(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): OverlaySize {
  return {
    width: Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, Math.round(width))),
    height: Math.max(MIN_PANEL_HEIGHT, Math.min(maxHeight, Math.round(height))),
  };
}

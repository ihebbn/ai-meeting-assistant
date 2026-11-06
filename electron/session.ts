export type InsightAction = {
  id: string;
  label: string;
  icon: 'book' | 'globe' | 'chat' | 'sparkle' | 'reply';
};

import {
  BACKEND_LABELS,
  DEFAULT_ASR_BACKEND,
  DEFAULT_ASR_LANGUAGE,
  type AsrBackendId,
  type AsrLanguageId,
} from './asr/constants';

export type { AsrBackendId, AsrLanguageId };

export type TranscriptLine = {
  id: string;
  speaker: string;
  text: string;
  language?: string | null;
  backend?: AsrBackendId | null;
  latencyMs?: number | null;
};

export type AiMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
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
  /** State of the transcript-based suggestions in Live Insights. */
  suggestionsStatus: 'idle' | 'loading' | 'error';
  suggestionsMessage: string | null;
  /** True when the overlay is excluded from screen capture. */
  contentProtection: boolean;
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
      'Press Listen to capture your microphone (You) and system audio.',
      'Language defaults to Auto — English, French, and Arabic segments are detected per phrase.',
      'Switch Qwen / Whisper in Live Insights for side-by-side testing. Pick an AI provider and add its API key in Settings (⋮ menu) to get real Ask AI answers grounded on the live transcript; without one, Ask AI tells you what to set up. Suggestions are generated from the live transcript when you press Suggest.',
    ],
    actions: [],
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
    asrBackend: DEFAULT_ASR_BACKEND,
    asrLanguage: DEFAULT_ASR_LANGUAGE,
    asrCompareMode: false,
    detectedLanguage: null,
    asrModelLabel: BACKEND_LABELS[DEFAULT_ASR_BACKEND],
    asrSetupMessage: null,
    suggestionsStatus: 'idle',
    suggestionsMessage: null,
    contentProtection: true,
  };
}

/** Shown instead of an answer when no AI provider is usable. */
export const NO_PROVIDER_MESSAGE =
  'No AI provider is configured. Open Settings from the ⋮ menu, pick a provider and add its API key to get answers.';

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

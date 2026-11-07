export type InsightAction = {
  id: string;
  label: string;
  icon: 'book' | 'globe' | 'chat' | 'sparkle' | 'reply';
};

export type AsrBackendId = 'qwen' | 'whisper';
export type AsrLanguageId = 'auto' | 'en' | 'fr' | 'ar';

export type TranscriptLine = {
  id: string;
  speaker: string;
  text: string;
  at?: string;
  language?: string | null;
  backend?: AsrBackendId | null;
  latencyMs?: number | null;
};

export type TranscriptResult = {
  text: string;
  language: string | null;
  latencyMs: number;
  backend: AsrBackendId;
  compare?: TranscriptResult[];
};

export type AiMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
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

export type SessionView = {
  listening: boolean;
  elapsedSeconds: number;
  panelsHidden: boolean;
  menuOpen: boolean;
  insightsOpen: boolean;
  responseOpen: boolean;
  showTranscript: boolean;
  panelSize: OverlaySize;
  bothPanelsOpen: boolean;
  anyPanelOpen: boolean;
  insightsVisible: boolean;
  responseVisible: boolean;
  topic: string;
  recap: string[];
  actions: InsightAction[];
  transcript: TranscriptLine[];
  currentQuestion: string;
  messages: AiMessage[];
  followUpDraft: string;
  askShortcutLabel: string;
  hideShortcutLabel: string;
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
  screenVisionEnabled: boolean;
  lastScreenCaptureAt: string | null;
  screenVisionError: string | null;
};

export type ProtectionState = {
  requested: boolean;
  applied: boolean;
  lastError: string | null;
  appliedAt: string | null;
  windows: Record<string, boolean>;
  enabledForDesignCapture: boolean;
};

export type LogEntry = {
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
};

export type AppSnapshot = {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  windowsBuild: string;
  platform: string;
  arch: string;
  showHideShortcut: string;
  askShortcut: string;
  contentProtection: ProtectionState;
  externalShareVerification: string;
  logFilePath: string;
  logs: LogEntry[];
  session: SessionView;
};

export type MeetingCopilotApi = {
  getSnapshot: () => Promise<AppSnapshot>;
  getSession: () => Promise<SessionView>;
  onSessionUpdated?: (callback: (session: SessionView) => void) => () => void;
  toggleListen?: () => Promise<SessionView>;
  setListening?: (listening: boolean) => Promise<SessionView>;
  hideAll?: () => Promise<SessionView>;
  toggleHidden?: () => Promise<SessionView>;
  toggleMenu?: (anchor: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  }) => Promise<{ open: boolean; placement: 'below' | 'above' }>;
  closeMenu?: () => Promise<SessionView>;
  toggleTranscript?: () => Promise<SessionView>;
  setPanelOpen?: (panel: 'insights' | 'response', open: boolean) => Promise<SessionView>;
  togglePanel?: (panel: 'insights' | 'response') => Promise<SessionView>;
  runAction?: (actionId: string) => Promise<SessionView>;
  ask?: (prompt: string) => Promise<SessionView>;
  setFollowUpDraft?: (draft: string) => Promise<SessionView>;
  closeResponse?: () => Promise<SessionView>;
  resizePanel?: (width: number, height: number) => Promise<SessionView>;
  getPanelSize?: () => Promise<OverlaySize>;
  copyText?: (text: string) => Promise<boolean>;
  quit: () => Promise<void>;
  openDiagnostics?: () => Promise<boolean>;
  openMicSettings?: () => Promise<boolean>;
  openLogFolder?: () => Promise<string>;
  onLog?: (callback: (entry: LogEntry) => void) => () => void;
  enableLoopbackAudio?: () => Promise<void>;
  disableLoopbackAudio?: () => Promise<void>;
  reportAudioActivity?: (activity: AudioActivity) => Promise<SessionView | boolean>;
  reportListenStatus?: (payload: {
    status: ListenStatus;
    error: string | null;
    modelReady: boolean;
  }) => Promise<SessionView>;
  appendTranscript?: (line: {
    speaker: string;
    text: string;
    id?: string;
    language?: string | null;
    backend?: AsrBackendId | null;
    latencyMs?: number | null;
  }) => Promise<SessionView>;
  upsertTranscript?: (line: {
    id: string;
    speaker: string;
    text: string;
    provisional?: boolean;
  }) => Promise<SessionView>;
  ensureTranscriber?: () => Promise<{ ready: boolean; error: string | null }>;
  getAsrStatus?: () => Promise<unknown>;
  setAsrBackend?: (backend: AsrBackendId) => Promise<SessionView>;
  setAsrLanguage?: (language: AsrLanguageId) => Promise<SessionView>;
  setCompareMode?: (enabled: boolean) => Promise<SessionView>;
  setScreenVisionEnabled?: (enabled: boolean) => Promise<SessionView>;
  transcribePcm?: (payload: {
    source: 'you' | 'system';
    sampleRate: number;
    pcm: number[];
  }) => Promise<TranscriptResult | string>;
};

declare global {
  interface Window {
    meetingCopilot?: MeetingCopilotApi;
  }
}

export function getApi(): MeetingCopilotApi | undefined {
  return window.meetingCopilot;
}

export function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const s = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

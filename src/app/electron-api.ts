export type InsightAction = {
  id: string;
  label: string;
  icon: 'book' | 'globe' | 'chat' | 'sparkle' | 'reply';
};

export type TranscriptLine = {
  id: string;
  speaker: string;
  text: string;
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
  openLogFolder?: () => Promise<string>;
  onLog?: (callback: (entry: LogEntry) => void) => () => void;
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

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
};

export const ASK_ACCELERATOR = 'CommandOrControl+Return';
export const HIDE_ACCELERATOR = 'CommandOrControl+\\';

export const TOOLBAR_HEIGHT = 56;
export const TOOLBAR_WIDTH = 640;
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
    listening: true,
    elapsedSeconds: 20,
    panelsHidden: false,
    menuOpen: false,
    insightsOpen: true,
    responseOpen: false,
    showTranscript: false,
    panelSize: {
      width: DEFAULT_PANEL_WIDTH,
      height: DEFAULT_PANEL_HEIGHT,
    },
    topic: 'Discussion about news',
    recap: [
      "You started talking about how there's a lot of big startup acquisitions happening.",
      'Neel asked you about who recently acquired Windsurf.',
    ],
    actions: [
      { id: 'define', label: 'Define startup acquisition', icon: 'book' },
      {
        id: 'search-windsurf',
        label: 'Search the web for information about Windsurf acquisition',
        icon: 'globe',
      },
      { id: 'followups', label: 'Suggest follow-up questions', icon: 'chat' },
      { id: 'helpful', label: 'Give me helpful information', icon: 'sparkle' },
      { id: 'reply', label: 'Suggest a reply', icon: 'reply' },
    ],
    transcript: [
      {
        id: 't1',
        speaker: 'You',
        text: "There's been a wave of big startup acquisitions lately — feels like every week another AI tool gets scooped up.",
      },
      {
        id: 't2',
        speaker: 'Neel',
        text: 'True. Do you know who recently acquired Windsurf?',
      },
      {
        id: 't3',
        speaker: 'You',
        text: "I want to say it was one of the coding-agent companies, but I'm blanking on the details.",
      },
    ],
    currentQuestion: '',
    messages: [],
    followUpDraft: '',
  };
}

const SAMPLE_ANSWERS: Record<string, string> = {
  define:
    'A startup acquisition is when an established company buys a younger company — usually for its product, talent, customers, or intellectual property — instead of building the same capability from scratch.',
  'search-windsurf':
    "On July 14, 2025, Cognition acquired the remainder of Windsurf to integrate into its Devin platform. Includes Windsurf's agentic IDE, IP, brand, $82 M ARR, 350+ enterprise clients, and full team.",
  followups:
    '• What drove Cognition to buy Windsurf instead of competing?\n• How does Windsurf’s IDE fit into Devin’s roadmap?\n• What happens to Windsurf’s enterprise contracts after the deal?\n• Are similar coding-tool acquisitions likely this year?',
  helpful:
    'Useful talking points: Cognition is known for Devin, an autonomous coding agent. Buying Windsurf strengthens the IDE + agent stack, adds recurring revenue, and brings an experienced product team. Frame it as consolidation in the AI developer-tools market.',
  reply:
    'Suggested reply: “Cognition acquired Windsurf in July 2025 to fold its agentic IDE and team into Devin — it looks like a capability + talent deal, not just a brand buy.”',
  default:
    'Based on the recent discussion, focus on the Windsurf acquisition details and ask Neel whether they care more about product integration or market consolidation.',
};

export function answerForPrompt(prompt: string, actionId?: string): string {
  if (actionId && SAMPLE_ANSWERS[actionId]) {
    return SAMPLE_ANSWERS[actionId];
  }
  const lower = prompt.toLowerCase();
  if (lower.includes('windsurf') || lower.includes('acquisition')) {
    return SAMPLE_ANSWERS['search-windsurf'];
  }
  if (lower.includes('follow-up') || lower.includes('follow up')) {
    return SAMPLE_ANSWERS.followups;
  }
  if (lower.includes('reply')) {
    return SAMPLE_ANSWERS.reply;
  }
  if (lower.includes('define')) {
    return SAMPLE_ANSWERS.define;
  }
  return SAMPLE_ANSWERS.default;
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

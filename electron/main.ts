import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  screen,
  session as electronSession,
  shell,
} from 'electron';
import { initMain as initAudioLoopback } from 'electron-audio-loopback';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ASK_ACCELERATOR,
  DEFAULT_PANEL_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  HIDE_ACCELERATOR,
  PANEL_GAP,
  SHELL_PAD,
  TOOLBAR_ONLY_PAD,
  AudioActivity,
  ListenStatus,
  SessionState,
  TOOLBAR_HEIGHT,
  TOOLBAR_WIDTH,
  answerForPrompt,
  anyPanelOpen,
  clampPanelSize,
  createInitialSession,
} from './session';
import {
  bumpListenGeneration,
  ensureTranscriber,
  getAsrBackend,
  getAsrLanguage,
  getTranscriberError,
  getTranscriberStatus,
  isCompareMode,
  isTranscriberReady,
  onTranscriberStatus,
  setAsrBackend,
  setAsrLanguage,
  setCompareMode,
  transcribePcm,
  warmTranscriber,
  type TranscriptResult,
} from './transcriber';
import type { AsrBackendId, AsrLanguageId } from './session';
import { toFloat32Pcm } from './pcm';
import { getSettings, initSettings, updateSettings } from './settings';

const isDev = process.env['ELECTRON_DEV'] === '1';
const OVERLAY_BG = '#00000000';

/** Exclude overlay from screenshots / screen share. Stored in settings.json (default on). */
function isContentProtectionEnabled(): boolean {
  return getSettings().contentProtection;
}

// Windows: keep layered-window transparency working for always-on-top overlays.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

// Must run before ready so Chromium loopback feature flags apply.
initAudioLoopback();

type ProtectionState = {
  requested: boolean;
  applied: boolean;
  lastError: string | null;
  appliedAt: string | null;
  windows: Record<string, boolean>;
  enabledForDesignCapture: boolean;
};

type LogEntry = {
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
};

type SurfaceName = 'overlay' | 'diagnostics' | 'menu';

let overlayWindow: BrowserWindow | null = null;
let diagnosticsWindow: BrowserWindow | null = null;
let menuWindow: BrowserWindow | null = null;

let session: SessionState = createInitialSession();
let contentProtection: ProtectionState = {
  requested: isContentProtectionEnabled(),
  applied: false,
  lastError: null,
  appliedAt: null,
  windows: {},
  enabledForDesignCapture: !isContentProtectionEnabled(),
};
const logEntries: LogEntry[] = [];
let logFilePath = '';
let elapsedTimer: NodeJS.Timeout | null = null;
let streamTimer: NodeJS.Timeout | null = null;
let streamToken = 0;
type MenuAnchor = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

const MENU_POPUP_WIDTH = 176;
const MENU_POPUP_HEIGHT = 96;
const MENU_POPUP_GAP = 8;

function nowIso(): string {
  return new Date().toISOString();
}

function appendLog(level: LogEntry['level'], message: string): void {
  const entry: LogEntry = { ts: nowIso(), level, message };
  logEntries.push(entry);
  if (logEntries.length > 500) {
    logEntries.shift();
  }
  const line = `[${entry.ts}] ${level.toUpperCase()} ${message}\n`;
  try {
    if (logFilePath) {
      fs.appendFileSync(logFilePath, line, 'utf8');
    }
  } catch {
    // Keep in-memory log even if disk write fails.
  }
  if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) {
    diagnosticsWindow.webContents.send('diagnostics:log', entry);
  }
}

function getWindowsBuild(): string {
  try {
    return `${os.type()} ${os.arch()} release=${os.release()}`;
  } catch (err) {
    return `unknown (${String(err)})`;
  }
}

function resolvePreload(name: string): string {
  return path.join(__dirname, name);
}

function resolveAngularIndex(): string {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'meeting-copilot', 'browser', 'index.html'),
    path.join(__dirname, '..', 'dist', 'meeting-copilot', 'index.html'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function loadRoute(win: BrowserWindow, route: string): void {
  if (isDev) {
    void win.loadURL(`http://localhost:4200/#/${route}`);
  } else {
    void win.loadFile(resolveAngularIndex(), { hash: `/${route}` });
  }
}

function applyContentProtection(win: BrowserWindow, name: SurfaceName): void {
  const enabled = isContentProtectionEnabled();
  contentProtection.requested = enabled;
  contentProtection.enabledForDesignCapture = !enabled;
  session.contentProtection = enabled;
  try {
    win.setContentProtection(enabled);
    contentProtection.windows[name] = enabled;
    contentProtection.applied = enabled
      ? Object.values(contentProtection.windows).every(Boolean)
      : false;
    contentProtection.lastError = null;
    contentProtection.appliedAt = nowIso();
    appendLog(
      'info',
      enabled
        ? `setContentProtection(true) on ${name}.`
        : `Content protection OFF on ${name} (overlay is visible in screen capture).`,
    );
  } catch (err) {
    contentProtection.windows[name] = false;
    contentProtection.applied = false;
    contentProtection.lastError = String(err);
    appendLog('error', `setContentProtection failed on ${name}: ${String(err)}`);
  }
}

function getPublicSession() {
  return {
    ...session,
    askShortcutLabel: 'Ctrl+Enter',
    hideShortcutLabel: 'Ctrl+\\',
    bothPanelsOpen:
      !session.panelsHidden && session.insightsOpen && session.responseOpen,
    anyPanelOpen: anyPanelOpen(session),
    insightsVisible: !session.panelsHidden && session.insightsOpen,
    responseVisible: !session.panelsHidden && session.responseOpen,
  };
}

function broadcastSession(): void {
  const payload = getPublicSession();
  for (const win of [overlayWindow, diagnosticsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:updated', payload);
    }
  }
}

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function maxPanelBounds() {
  const area = workArea();
  return {
    maxWidth: Math.max(MIN_SAFE_WIDTH(), area.width - 32),
    maxHeight: Math.max(
      260,
      area.height - TOOLBAR_HEIGHT - PANEL_GAP - SHELL_PAD * 2 - 40,
    ),
  };
}

function MIN_SAFE_WIDTH(): number {
  return 420;
}

function computeWindowSize(): { width: number; height: number } {
  if (!anyPanelOpen(session)) {
    return {
      width: TOOLBAR_WIDTH + TOOLBAR_ONLY_PAD * 2,
      height: TOOLBAR_HEIGHT + TOOLBAR_ONLY_PAD * 2,
    };
  }
  const { width, height } = session.panelSize;
  return {
    width: width + SHELL_PAD * 2,
    height: TOOLBAR_HEIGHT + PANEL_GAP + height + SHELL_PAD * 2,
  };
}

let menuWindowReady: Promise<void> | null = null;
let ignoreMenuBlurUntil = 0;

function menuHtmlPath(): string {
  return path.join(__dirname, '..', 'electron', 'menu.html');
}

function ensureMenuWindow(): BrowserWindow {
  if (menuWindow && !menuWindow.isDestroyed()) {
    return menuWindow;
  }

  const win = new BrowserWindow({
    width: MENU_POPUP_WIDTH,
    height: MENU_POPUP_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: resolvePreload('preload-menu.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  applyContentProtection(win, 'menu');

  // Register load listeners before starting navigation to avoid a hung await.
  menuWindowReady = new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onFail = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
    ) => {
      cleanup();
      reject(new Error(`Menu load failed (${errorCode}): ${errorDescription}`));
    };
    const cleanup = () => {
      win.webContents.removeListener('did-finish-load', onOk);
      win.webContents.removeListener('did-fail-load', onFail);
    };
    win.webContents.once('did-finish-load', onOk);
    win.webContents.once('did-fail-load', onFail);
    void win.loadFile(menuHtmlPath());
  });

  win.on('blur', () => {
    // Defer: opening click / OS focus churn often blurs the popup immediately.
    setTimeout(() => {
      if (Date.now() < ignoreMenuBlurUntil) {
        return;
      }
      if (!win.isDestroyed() && !win.isFocused()) {
        hideMenuPopup();
      }
    }, 200);
  });

  win.on('closed', () => {
    if (menuWindow === win) {
      menuWindow = null;
      menuWindowReady = null;
    }
    session.menuOpen = false;
    broadcastSession();
  });

  menuWindow = win;
  return win;
}

function hideMenuPopup(): void {
  if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
    menuWindow.hide();
  }
  if (session.menuOpen) {
    session.menuOpen = false;
    broadcastSession();
    appendLog('info', 'Menu popup hidden.');
  }
}

async function showMenuPopup(
  anchor: MenuAnchor,
): Promise<{ open: boolean; placement: 'below' | 'above' }> {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    appendLog('error', 'Cannot open menu: overlay window missing.');
    return { open: false, placement: 'below' };
  }

  try {
    const overlayBounds = overlayWindow.getBounds();
    const work = screen.getDisplayMatching(overlayBounds).workArea;
    const win = ensureMenuWindow();
    applyContentProtection(win, 'menu');
    if (menuWindowReady) {
      await menuWindowReady;
    }

    const anchorRight = overlayBounds.x + Math.round(anchor.right);
    const anchorTop = overlayBounds.y + Math.round(anchor.top);
    const anchorBottom = overlayBounds.y + Math.round(anchor.bottom);

    let x = anchorRight - MENU_POPUP_WIDTH;
    let y = anchorBottom + MENU_POPUP_GAP;
    let placement: 'below' | 'above' = 'below';

    if (y + MENU_POPUP_HEIGHT > work.y + work.height) {
      y = anchorTop - MENU_POPUP_GAP - MENU_POPUP_HEIGHT;
      placement = 'above';
    }
    if (y < work.y) {
      y = work.y + 4;
    }
    if (x < work.x) {
      x = work.x + 4;
    }
    if (x + MENU_POPUP_WIDTH > work.x + work.width) {
      x = work.x + work.width - MENU_POPUP_WIDTH - 4;
    }

    win.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: MENU_POPUP_WIDTH,
      height: MENU_POPUP_HEIGHT,
    });

    // Keep the popup alive through the opening click and focus transitions.
    ignoreMenuBlurUntil = Date.now() + 1000;
    session.menuOpen = true;
    win.show();
    win.moveTop();
    setTimeout(() => {
      if (!win.isDestroyed() && session.menuOpen) {
        win.focus();
        ignoreMenuBlurUntil = Date.now() + 300;
      }
    }, 50);
    broadcastSession();
    appendLog('info', `Menu popup shown (${placement}) at ${Math.round(x)},${Math.round(y)}.`);
    return { open: true, placement };
  } catch (err) {
    appendLog('error', `Menu popup failed: ${String(err)}`);
    hideMenuPopup();
    return { open: false, placement: 'below' };
  }
}

function applyOverlayBounds(preserveCenter = false): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const area = workArea();
  const size = computeWindowSize();
  const current = overlayWindow.getBounds();
  let x = current.x;
  let y = current.y;

  if (preserveCenter || current.width === 0) {
    x = Math.round(area.x + (area.width - size.width) / 2);
    y = Math.round(area.y + 24);
  } else {
    // Keep top-center of previous bounds when width changes so panels stay under toolbar.
    const prevCenterX = current.x + Math.round(current.width / 2);
    x = Math.round(prevCenterX - size.width / 2);
    y = current.y;
  }

  x = Math.min(Math.max(area.x, x), area.x + area.width - size.width);
  y = Math.min(Math.max(area.y, y), area.y + area.height - size.height);

  overlayWindow.setBounds({ x, y, width: size.width, height: size.height });
}

function applyVisibility(options?: { center?: boolean }): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  applyContentProtection(overlayWindow, 'overlay');
  applyOverlayBounds(options?.center ?? false);
  if (!overlayWindow.isVisible()) {
    overlayWindow.showInactive();
  }
  broadcastSession();
}

function forceOverlayTransparency(win: BrowserWindow, reason: string): void {
  if (win.isDestroyed()) {
    return;
  }
  try {
    win.setBackgroundColor(OVERLAY_BG);
    // Nudge DWM/Chromium to repaint the layered window after focus changes.
    const current = win.getOpacity();
    win.setOpacity(Math.min(current, 0.99));
    setImmediate(() => {
      if (win.isDestroyed()) {
        return;
      }
      win.setOpacity(1);
      win.setBackgroundColor(OVERLAY_BG);
      if (!win.webContents.isDestroyed()) {
        win.webContents
          .executeJavaScript(
            `(() => {
              const root = document.documentElement;
              const body = document.body;
              if (root) {
                root.style.setProperty('background', 'transparent', 'important');
                root.style.setProperty('background-color', 'transparent', 'important');
              }
              if (body) {
                body.style.setProperty('background', 'transparent', 'important');
                body.style.setProperty('background-color', 'transparent', 'important');
              }
              return true;
            })()`,
          )
          .catch(() => undefined);
      }
    });
    if (!reason.includes('deferred') && !reason.includes('wm-')) {
      appendLog('info', `Overlay transparency reapplied (${reason}).`);
    }
  } catch (err) {
    appendLog('warn', `Failed to reapply overlay transparency: ${String(err)}`);
  }
}

function createOverlayWindow(): BrowserWindow {
  const size = computeWindowSize();
  const area = workArea();
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(area.y + 24),
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Window shadow is rectangular; the toolbar/panels draw their own soft shadows.
    hasShadow: false,
    backgroundColor: OVERLAY_BG,
    roundedCorners: false,
    thickFrame: false,
    // Toolbar-style WS_EX_TOOLWINDOW / layered behavior helps keep transparency when inactive on Windows.
    type: process.platform === 'win32' ? 'toolbar' : 'normal',
    webPreferences: {
      preload: resolvePreload('preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setBackgroundColor(OVERLAY_BG);
  applyContentProtection(win, 'overlay');

  if (process.platform === 'win32') {
    // WM_NCACTIVATE (0x0086): stop Windows from painting the inactive client fill
    // that turns transparent overlays into a solid rectangle when focus is lost.
    win.hookWindowMessage(0x0086, () => {
      setImmediate(() => forceOverlayTransparency(win, 'wm-ncactivate'));
      return true;
    });
    // WM_ACTIVATE (0x0006): same class of inactive-repaint issues on some builds.
    win.hookWindowMessage(0x0006, () => {
      setImmediate(() => forceOverlayTransparency(win, 'wm-activate'));
      return false;
    });
  }

  win.once('ready-to-show', () => {
    applyContentProtection(win, 'overlay');
    forceOverlayTransparency(win, 'ready-to-show');
    applyVisibility({ center: true });
    appendLog('info', 'Unified overlay ready.');
  });

  win.on('show', () => forceOverlayTransparency(win, 'show'));
  win.on('focus', () => forceOverlayTransparency(win, 'focus'));
  win.on('blur', () => {
    // Windows often paints an opaque rect into transparent windows when inactive.
    forceOverlayTransparency(win, 'blur');
    setTimeout(() => forceOverlayTransparency(win, 'blur-deferred'), 50);
    setTimeout(() => forceOverlayTransparency(win, 'blur-deferred-2'), 200);
  });

  win.on('closed', () => {
    if (overlayWindow === win) {
      overlayWindow = null;
    }
    appendLog('info', 'Overlay window closed.');
  });

  loadRoute(win, 'overlay');
  return win;
}

function createDiagnosticsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 600,
    show: false,
    title: 'Meeting Copilot — Settings',
    webPreferences: {
      preload: resolvePreload('preload-diagnostics.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  applyContentProtection(win, 'diagnostics');

  win.once('ready-to-show', () => {
    applyContentProtection(win, 'diagnostics');
    win.show();
    win.focus();
  });

  win.on('closed', () => {
    if (diagnosticsWindow === win) {
      diagnosticsWindow = null;
    }
  });

  loadRoute(win, 'diagnostics');
  return win;
}

function ensureOverlay(): BrowserWindow {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = createOverlayWindow();
  }
  return overlayWindow;
}

function ensureDiagnostics(): BrowserWindow {
  if (!diagnosticsWindow || diagnosticsWindow.isDestroyed()) {
    diagnosticsWindow = createDiagnosticsWindow();
  } else {
    applyContentProtection(diagnosticsWindow, 'diagnostics');
    if (diagnosticsWindow.isMinimized()) {
      diagnosticsWindow.restore();
    }
    diagnosticsWindow.show();
    diagnosticsWindow.focus();
    diagnosticsWindow.moveTop();
  }
  return diagnosticsWindow;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function emptyTranscriptResult(): TranscriptResult {
  return {
    text: '',
    language: null,
    latencyMs: 0,
    backend: getAsrBackend(),
  };
}

function logTranscriptResult(source: string, result: TranscriptResult): void {
  if (!result.text && !result.compare?.length) {
    return;
  }
  if (result.compare?.length) {
    for (const item of result.compare) {
      appendLog(
        'info',
        `Compare ${source}/${item.backend}${item.language ? ` [${item.language}]` : ''} ${item.latencyMs}ms: ${(item.text || '(blank)').slice(0, 80)}`,
      );
    }
    return;
  }
  appendLog(
    'info',
    `Transcribed ${source}/${result.backend}${result.language ? ` [${result.language}]` : ''} ${result.latencyMs}ms: ${result.text.slice(0, 80)}${result.text.length > 80 ? '…' : ''}`,
  );
}

function syncAsrSessionFields(): void {
  const status = getTranscriberStatus();
  session.asrBackend = status.backend;
  session.asrLanguage = status.language;
  session.asrCompareMode = status.compareMode;
  session.asrModelLabel = status.modelLabel;
  session.asrSetupMessage = status.error;
  session.modelReady = status.ready;
}

function setListening(listening: boolean): void {
  const next = !!listening;
  if (session.listening === next) {
    broadcastSession();
    return;
  }
  session.listening = next;
  if (next) {
    session.listenStatus = 'starting';
    session.listenError = null;
    session.audio = {
      micLevel: 0,
      systemLevel: 0,
      micActive: false,
      systemActive: false,
    };
    appendLog(
      'info',
      `Listening started — ${getAsrBackend()}/${getAsrLanguage()} (compare=${isCompareMode()})`,
    );
  } else {
    bumpListenGeneration();
    session.listenStatus = 'idle';
    session.audio = {
      micLevel: 0,
      systemLevel: 0,
      micActive: false,
      systemActive: false,
    };
    appendLog('info', 'Listening stopped — audio streams released; stale ASR discarded.');
  }
  broadcastSession();
}

function startElapsedTimer(): void {
  stopElapsedTimer();
  elapsedTimer = setInterval(() => {
    if (!session.listening) {
      return;
    }
    session.elapsedSeconds += 1;
    broadcastSession();
  }, 1000);
}

function stopElapsedTimer(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function stopStreaming(): void {
  streamToken += 1;
  if (streamTimer) {
    clearInterval(streamTimer);
    streamTimer = null;
  }
}

function streamAnswer(question: string, fullAnswer: string): void {
  stopStreaming();
  const token = ++streamToken;
  const assistantId = `a-${Date.now()}`;
  session.currentQuestion = question;
  session.messages = [
    { id: `u-${Date.now()}`, role: 'user', text: question },
    { id: assistantId, role: 'assistant', text: '', streaming: true },
  ];
  session.responseOpen = true;
  session.panelsHidden = false;
  applyVisibility();

  let index = 0;
  const chars = fullAnswer.split('');
  streamTimer = setInterval(() => {
    if (token !== streamToken) {
      return;
    }
    index = Math.min(chars.length, index + 3);
    const partial = chars.slice(0, index).join('');
    session.messages = session.messages.map((m) =>
      m.id === assistantId
        ? { ...m, text: partial, streaming: index < chars.length }
        : m,
    );
    broadcastSession();
    if (index >= chars.length) {
      stopStreaming();
    }
  }, 18);
}

function askWithPrompt(prompt: string, actionId?: string): void {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return;
  }
  session.followUpDraft = '';
  appendLog('info', `Ask AI: ${trimmed}`);
  streamAnswer(trimmed, answerForPrompt(trimmed, actionId));
}

function setPanelOpen(panel: 'insights' | 'response', open: boolean): void {
  if (panel === 'insights') {
    session.insightsOpen = open;
  } else {
    session.responseOpen = open;
  }
  if (open) {
    session.panelsHidden = false;
  }
  appendLog(
    'info',
    `${panel} ${open ? 'opened' : 'collapsed'}; listening=${session.listening}`,
  );
  applyVisibility();
}

function setPanelsHidden(hidden: boolean): void {
  session.panelsHidden = hidden;
  if (!hidden && !session.insightsOpen && !session.responseOpen) {
    session.insightsOpen = true;
  }
  appendLog(
    'info',
    hidden
      ? 'Panels hidden; toolbar stays visible.'
      : 'Panels shown again from Hide toggle.',
  );
  applyVisibility();
}

function togglePanelsHidden(): void {
  setPanelsHidden(!session.panelsHidden);
}

function resizePanelArea(width: number, height: number): void {
  const { maxWidth, maxHeight } = maxPanelBounds();
  session.panelSize = clampPanelSize(width, height, maxWidth, maxHeight);
  applyVisibility();
}

function getSnapshot() {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    windowsBuild: getWindowsBuild(),
    platform: process.platform,
    arch: process.arch,
    showHideShortcut: HIDE_ACCELERATOR,
    askShortcut: ASK_ACCELERATOR,
    contentProtection: {
      ...contentProtection,
      windows: { ...contentProtection.windows },
    },
    externalShareVerification:
      'Pending — verify unified overlay while dragging, resizing, collapsing, and reopening from a remote Meet/Teams participant',
    logFilePath,
    logs: [...logEntries],
    session: getPublicSession(),
  };
}

function registerIpc(): void {
  ipcMain.handle('app:get-snapshot', () => getSnapshot());
  ipcMain.handle('session:get', () => getPublicSession());

  ipcMain.handle('session:toggle-listen', () => {
    setListening(!session.listening);
    return getPublicSession();
  });

  ipcMain.handle('session:set-listening', (_e, listening: boolean) => {
    setListening(!!listening);
    return getPublicSession();
  });

  ipcMain.handle('session:report-audio-activity', (_e, activity: AudioActivity) => {
    session.audio = {
      micLevel: clamp01(Number(activity?.micLevel) || 0),
      systemLevel: clamp01(Number(activity?.systemLevel) || 0),
      micActive: !!activity?.micActive,
      systemActive: !!activity?.systemActive,
    };
    broadcastSession();
    return getPublicSession();
  });

  ipcMain.handle(
    'session:report-listen-status',
    (
      _e,
      payload: { status: ListenStatus; error: string | null; modelReady: boolean },
    ) => {
      session.listenStatus = payload?.status ?? session.listenStatus;
      session.listenError = payload?.error ? String(payload.error) : null;
      session.modelReady = !!payload?.modelReady || isTranscriberReady();
      if (session.listenError) {
        appendLog('warn', `Listen status: ${session.listenStatus} — ${session.listenError}`);
      }
      broadcastSession();
      return getPublicSession();
    },
  );

  ipcMain.handle(
    'session:append-transcript',
    (
      _e,
      line: {
        speaker: string;
        text: string;
        id?: string;
        language?: string | null;
        backend?: AsrBackendId | null;
        latencyMs?: number | null;
      },
    ) => {
      const text = String(line?.text ?? '').trim();
      if (!text) {
        return getPublicSession();
      }
      const speaker = String(line?.speaker ?? 'You');
      const language = line?.language ? String(line.language) : null;
      // Drop matching provisional line when a final arrives.
      session.transcript = session.transcript.filter((t) => !t.id.startsWith('you-interim-'));
      session.transcript = [
        ...session.transcript,
        {
          id: line?.id || `t-${Date.now()}-${session.transcript.length}`,
          speaker,
          text,
          language,
          backend: line?.backend ?? getAsrBackend(),
          latencyMs: line?.latencyMs ?? null,
        },
      ].slice(-200);
      if (language) {
        session.detectedLanguage = language;
      }
      if (session.topic === 'Live conversation' || session.topic.startsWith('Waiting')) {
        session.topic = 'Live conversation';
      }
      broadcastSession();
      return getPublicSession();
    },
  );

  ipcMain.handle(
    'session:upsert-transcript',
    (
      _e,
      line: { id: string; speaker: string; text: string; provisional?: boolean },
    ) => {
      const text = String(line?.text ?? '').trim();
      const id = String(line?.id ?? '');
      if (!text || !id) {
        return getPublicSession();
      }
      const speaker = String(line?.speaker ?? 'You');
      const existing = session.transcript.findIndex((t) => t.id === id);
      if (existing >= 0) {
        session.transcript = session.transcript.map((t, index) =>
          index === existing ? { ...t, speaker, text } : t,
        );
      } else {
        session.transcript = [...session.transcript, { id, speaker, text }].slice(-200);
      }
      broadcastSession();
      return getPublicSession();
    },
  );

  ipcMain.handle('listen:ensure-transcriber', async () => {
    try {
      await ensureTranscriber();
      syncAsrSessionFields();
      session.listenError = session.asrSetupMessage;
      broadcastSession();
      return {
        ready: isTranscriberReady(),
        error: getTranscriberError(),
        status: getTranscriberStatus(),
      };
    } catch (err) {
      syncAsrSessionFields();
      session.modelReady = isTranscriberReady();
      session.listenError = String(err);
      broadcastSession();
      return {
        ready: session.modelReady,
        error: String(err),
        status: getTranscriberStatus(),
      };
    }
  });

  ipcMain.handle('listen:get-asr-status', () => {
    syncAsrSessionFields();
    return getTranscriberStatus();
  });

  ipcMain.handle('listen:set-asr-backend', (_e, next: AsrBackendId) => {
    setAsrBackend(next);
    syncAsrSessionFields();
    appendLog('info', `ASR backend set to ${session.asrBackend}`);
    broadcastSession();
    return getPublicSession();
  });

  ipcMain.handle('listen:set-asr-language', (_e, next: AsrLanguageId) => {
    setAsrLanguage(next);
    syncAsrSessionFields();
    appendLog('info', `ASR language set to ${session.asrLanguage} (applies to next segments)`);
    broadcastSession();
    return getPublicSession();
  });

  ipcMain.handle('listen:set-compare-mode', (_e, enabled: boolean) => {
    setCompareMode(!!enabled);
    syncAsrSessionFields();
    appendLog('info', `ASR compare mode ${session.asrCompareMode ? 'on' : 'off'}`);
    broadcastSession();
    return getPublicSession();
  });

  ipcMain.handle(
    'listen:transcribe-pcm',
    async (
      _e,
      payload: { source: 'you' | 'system'; sampleRate: number; pcm: Float32Array | number[] },
    ) => {
      const pcm = toFloat32Pcm(payload?.pcm);
      const sampleRate = Number(payload?.sampleRate) || 16000;
      if (!pcm.length) {
        return emptyTranscriptResult();
      }
      try {
        const result = await transcribePcm(pcm, sampleRate);
        logTranscriptResult(payload.source, result);
        if (result.language) {
          session.detectedLanguage = result.language;
        }
        syncAsrSessionFields();
        if (
          session.listenError?.includes('timed out') ||
          session.listenError?.includes('model') ||
          session.listenError?.includes('Downloading')
        ) {
          session.listenError = null;
        }
        broadcastSession();
        return result;
      } catch (err) {
        appendLog('error', `Transcribe failed (${payload.source}): ${String(err)}`);
        session.listenError = getTranscriberError() || String(err);
        syncAsrSessionFields();
        broadcastSession();
        return emptyTranscriptResult();
      }
    },
  );

  ipcMain.handle('session:hide-all', () => {
    togglePanelsHidden();
    return getPublicSession();
  });

  ipcMain.handle('session:toggle-hidden', () => {
    togglePanelsHidden();
    return getPublicSession();
  });

  ipcMain.handle('session:set-panels-hidden', (_e, hidden: boolean) => {
    setPanelsHidden(!!hidden);
    return getPublicSession();
  });

  ipcMain.handle('overlay:toggle-menu', async (_e, anchor: MenuAnchor) => {
    appendLog('info', '⋮ menu toggle requested.');
    if (session.menuOpen) {
      hideMenuPopup();
      return { open: false, placement: 'below' as const };
    }
    return showMenuPopup(anchor ?? { top: 0, right: 160, bottom: 40, left: 130 });
  });

  ipcMain.handle('overlay:close-menu', () => {
    hideMenuPopup();
    return getPublicSession();
  });

  ipcMain.handle('menu:close', () => {
    hideMenuPopup();
    return true;
  });

  ipcMain.handle('menu:open-settings', () => {
    hideMenuPopup();
    ensureDiagnostics();
    return true;
  });

  ipcMain.handle('menu:quit', () => {
    hideMenuPopup();
    appendLog('info', 'Quit requested from menu popup.');
    app.quit();
    return true;
  });

  ipcMain.handle('session:toggle-transcript', () => {
    session.showTranscript = !session.showTranscript;
    broadcastSession();
    return getPublicSession();
  });

  ipcMain.handle('session:set-panel-open', (_e, panel: 'insights' | 'response', open: boolean) => {
    setPanelOpen(panel, !!open);
    return getPublicSession();
  });

  ipcMain.handle('session:toggle-panel', (_e, panel: 'insights' | 'response') => {
    if (panel === 'insights') {
      setPanelOpen('insights', !session.insightsOpen);
    } else {
      setPanelOpen('response', !session.responseOpen);
    }
    return getPublicSession();
  });

  ipcMain.handle('session:run-action', (_e, actionId: string) => {
    const action = session.actions.find((a) => a.id === actionId);
    if (!action) {
      return getPublicSession();
    }
    askWithPrompt(action.label, action.id);
    return getPublicSession();
  });

  ipcMain.handle('session:ask', (_e, prompt: string) => {
    askWithPrompt(String(prompt ?? ''));
    return getPublicSession();
  });

  ipcMain.handle('session:set-follow-up-draft', (_e, draft: string) => {
    session.followUpDraft = String(draft ?? '');
    broadcastSession();
    return getPublicSession();
  });

  ipcMain.handle('session:close-response', () => {
    stopStreaming();
    setPanelOpen('response', false);
    return getPublicSession();
  });

  ipcMain.handle('overlay:resize-panel', (_e, width: number, height: number) => {
    resizePanelArea(Number(width), Number(height));
    return getPublicSession();
  });

  ipcMain.handle('overlay:get-panel-size', () => ({ ...session.panelSize }));

  ipcMain.handle('app:quit', () => {
    appendLog('info', 'Quit requested from UI.');
    app.quit();
  });

  ipcMain.handle('app:open-diagnostics', () => {
    ensureDiagnostics();
    return true;
  });

  ipcMain.handle('app:open-mic-settings', async () => {
    // Windows deep-links for the two places that usually cause silent getUserMedia.
    await shell.openExternal('ms-settings:privacy-microphone');
    await shell.openExternal('ms-settings:sound');
    appendLog('info', 'Opened Windows microphone privacy + sound settings.');
    return true;
  });

  ipcMain.handle('app:open-log-folder', async () => {
    if (logFilePath) {
      await shell.showItemInFolder(logFilePath);
    }
    return logFilePath;
  });

  ipcMain.handle('settings:set-content-protection', (_e, enabled: boolean) => {
    updateSettings({ contentProtection: !!enabled });
    for (const [win, name] of [
      [overlayWindow, 'overlay'],
      [diagnosticsWindow, 'diagnostics'],
      [menuWindow, 'menu'],
    ] as Array<[BrowserWindow | null, SurfaceName]>) {
      if (win && !win.isDestroyed()) {
        applyContentProtection(win, name);
      }
    }
    broadcastSession();
    return getPublicSession();
  });

  ipcMain.handle('app:copy-text', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });
}

function registerShortcuts(): void {
  const regs: Array<[string, () => void]> = [
    [HIDE_ACCELERATOR, () => togglePanelsHidden()],
    [
      ASK_ACCELERATOR,
      () => {
        session.panelsHidden = false;
        if (session.followUpDraft.trim()) {
          askWithPrompt(session.followUpDraft);
        } else {
          askWithPrompt('Suggest a reply');
        }
      },
    ],
  ];

  for (const [accel, handler] of regs) {
    const ok = globalShortcut.register(accel, handler);
    appendLog(
      ok ? 'info' : 'error',
      ok ? `Registered global shortcut ${accel}.` : `Failed to register ${accel}.`,
    );
  }
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  initSettings(userData);
  session.contentProtection = isContentProtectionEnabled();
  logFilePath = path.join(userData, 'meeting-copilot-m1.log');
  appendLog('info', `Meeting Copilot M1 starting. Log file: ${logFilePath}`);
  appendLog('info', `Windows: ${getWindowsBuild()}`);
  appendLog('info', `Electron ${process.versions.electron}`);
  appendLog(
    'info',
    `Default panel size ${DEFAULT_PANEL_WIDTH}x${DEFAULT_PANEL_HEIGHT}`,
  );

  electronSession.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = new Set([
        'media',
        'mediaKeySystem',
        'display-capture',
        'audioCapture',
        'videoCapture',
      ]);
      callback(allowed.has(String(permission)));
    },
  );
  electronSession.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => {
      const name = String(permission);
      return (
        name === 'media' ||
        name === 'display-capture' ||
        name === 'audioCapture' ||
        name === 'videoCapture'
      );
    },
  );

  registerIpc();
  registerShortcuts();
  ensureOverlay();
  startElapsedTimer();
  onTranscriberStatus(() => {
    syncAsrSessionFields();
    broadcastSession();
  });
  syncAsrSessionFields();

  // Warm the preferred local ASR backend after UI is up.
  setTimeout(() => {
    void warmTranscriber()
      .then(() => {
        syncAsrSessionFields();
        appendLog(
          'info',
          `${session.asrModelLabel} ready (language=${session.asrLanguage}).`,
        );
        broadcastSession();
      })
      .catch((err) => {
        syncAsrSessionFields();
        session.listenError = String(err);
        appendLog('warn', `ASR warmup failed: ${String(err)}`);
        broadcastSession();
      });
  }, 1500);

  screen.on('display-metrics-changed', () => {
    const { maxWidth, maxHeight } = maxPanelBounds();
    session.panelSize = clampPanelSize(
      session.panelSize.width,
      session.panelSize.height,
      maxWidth,
      maxHeight,
    );
    applyVisibility();
  });

  app.on('activate', () => {
    ensureOverlay();
    applyVisibility();
  });
});

app.on('will-quit', () => {
  setListening(false);
  stopElapsedTimer();
  stopStreaming();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Keep process alive so global shortcuts can restore the overlay.
});

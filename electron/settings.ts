import * as fs from 'fs';
import * as path from 'path';

/**
 * Persistent app settings (JSON in Electron userData). Free of Electron imports so it
 * can be unit tested; the caller passes the directory.
 */
export type AppSettings = {
  /** Exclude the overlay from screen capture (Windows: WDA_EXCLUDEFROMCAPTURE). */
  contentProtection: boolean;
  /** Set true after the Windows acceptance matrix in VERIFICATION.md is green. */
  qwenAcceptancePassed: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
  contentProtection: true,
  qwenAcceptancePassed: false,
};

const FILE_NAME = 'settings.json';

/** Keep only known keys with the right type; anything else falls back to defaults. */
export function normalizeSettings(raw: unknown): AppSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (key: keyof AppSettings): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : DEFAULT_SETTINGS[key];
  return {
    contentProtection: pick('contentProtection'),
    qwenAcceptancePassed: pick('qwenAcceptancePassed'),
  };
}

let settingsDir = '';
let current: AppSettings = { ...DEFAULT_SETTINGS };

export function initSettings(dir: string): AppSettings {
  settingsDir = dir;
  try {
    const text = fs.readFileSync(path.join(dir, FILE_NAME), 'utf8');
    current = normalizeSettings(JSON.parse(text));
  } catch {
    // Missing or corrupt file: use defaults, the next save rewrites it.
    current = { ...DEFAULT_SETTINGS };
  }
  return getSettings();
}

export function getSettings(): AppSettings {
  return { ...current };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  current = normalizeSettings({ ...current, ...patch });
  if (settingsDir) {
    try {
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, FILE_NAME),
        `${JSON.stringify(current, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // Keep in-memory value if disk write fails.
    }
  }
  return getSettings();
}

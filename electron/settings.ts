import * as fs from 'fs';
import * as path from 'path';
import { normalizeBaseUrl } from './ai/base-url';

/**
 * Persistent app settings (JSON in Electron userData). Free of Electron imports so it
 * can be unit tested; the caller passes the directory.
 */
export type AppSettings = {
  /** Exclude the overlay from screen capture (Windows: WDA_EXCLUDEFROMCAPTURE). */
  contentProtection: boolean;
  /** Set true after the Windows acceptance matrix in VERIFICATION.md is green. */
  qwenAcceptancePassed: boolean;
  /** Ask AI provider id (see ai/registry.ts). */
  aiProvider: string;
  /** Model chosen per provider id. */
  aiModels: Record<string, string>;
  /** Base-URL overrides per provider id (only editable providers use this). */
  aiBaseUrls: Record<string, string>;
  /** Reasoning effort sent to providers/models that support it. */
  aiEffort: 'low' | 'medium' | 'high';
  /** Refresh suggestions automatically while listening (off: sends transcript unprompted). */
  aiAutoSuggest: boolean;
};

const PROVIDER_KEY = /^[a-z0-9-]{1,40}$/;

const AI_EFFORTS: ReadonlyArray<AppSettings['aiEffort']> = ['low', 'medium', 'high'];

export const DEFAULT_SETTINGS: AppSettings = {
  contentProtection: true,
  qwenAcceptancePassed: false,
  aiProvider: 'anthropic',
  aiModels: {},
  aiBaseUrls: {},
  aiEffort: 'medium',
  aiAutoSuggest: false,
};

const FILE_NAME = 'settings.json';

/** Keep only known keys with the right type or value; anything else falls back to defaults. */
export function normalizeSettings(raw: unknown): AppSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (key: 'contentProtection' | 'qwenAcceptancePassed' | 'aiAutoSuggest'): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : DEFAULT_SETTINGS[key];
  const provider =
    typeof source['aiProvider'] === 'string' && PROVIDER_KEY.test(source['aiProvider'].trim())
      ? source['aiProvider'].trim()
      : DEFAULT_SETTINGS.aiProvider;
  const effort = source['aiEffort'];
  return {
    contentProtection: bool('contentProtection'),
    qwenAcceptancePassed: bool('qwenAcceptancePassed'),
    aiAutoSuggest: bool('aiAutoSuggest'),
    aiProvider: provider,
    aiModels: stringRecord(source['aiModels'], (v) => v.trim() || null),
    aiBaseUrls: stringRecord(source['aiBaseUrls'], normalizeBaseUrl),
    aiEffort: AI_EFFORTS.includes(effort as AppSettings['aiEffort'])
      ? (effort as AppSettings['aiEffort'])
      : DEFAULT_SETTINGS.aiEffort,
  };
}

/** Keep entries with a safe key and a value the validator accepts; drop the rest. */
function stringRecord(
  raw: unknown,
  accept: (value: string) => string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (PROVIDER_KEY.test(key) && typeof value === 'string') {
        const accepted = accept(value);
        if (accepted) {
          out[key] = accepted;
        }
      }
    }
  }
  return out;
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

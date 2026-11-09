import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const ENV_NAME = 'SONIOX_API_KEY';

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'soniox-api-key.txt');
}

function readDotEnvKey(projectRoot: string): string | null {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const match = trimmed.match(/^SONIOX_API_KEY\s*=\s*(.*)$/);
      if (!match) {
        continue;
      }
      let value = match[1]!.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value.trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

export function getSonioxApiKey(): string | null {
  const fromEnv = String(process.env[ENV_NAME] || '').trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const filePath = secretsPath();
    if (fs.existsSync(filePath)) {
      const fromFile = fs.readFileSync(filePath, 'utf8').trim();
      if (fromFile) {
        return fromFile;
      }
    }
  } catch {
    // Ignore and try the project .env.
  }
  const projectRoot = app.isPackaged
    ? path.dirname(app.getPath('exe'))
    : path.join(__dirname, '..', '..');
  return readDotEnvKey(projectRoot);
}

export function saveSonioxApiKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) {
    return;
  }
  process.env[ENV_NAME] = trimmed;
  const filePath = secretsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, trimmed, { encoding: 'utf8', mode: 0o600 });
}

export function bootstrapSonioxApiKey(): string | null {
  const key = getSonioxApiKey();
  if (!key) {
    return null;
  }
  try {
    const existing = fs.existsSync(secretsPath())
      ? fs.readFileSync(secretsPath(), 'utf8').trim()
      : '';
    if (existing !== key) {
      saveSonioxApiKey(key);
    }
  } catch {
    // Reading still works from env or .env if persist fails.
  }
  return key;
}

export function hasSonioxApiKey(): boolean {
  return !!getSonioxApiKey();
}

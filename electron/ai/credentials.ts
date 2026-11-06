import * as fs from 'fs';
import * as path from 'path';

/**
 * Encrypted API-key storage. The cipher is injected (Electron safeStorage in the app) so
 * this module has no Electron import and can be tested. The key is never written in
 * plaintext: if encryption is unavailable, saving is refused.
 */
export type KeyCipher = {
  isAvailable: () => boolean;
  encrypt: (plain: string) => Buffer;
  decrypt: (data: Buffer) => string;
};

export type CredentialStore = {
  /** Whether keys can be stored securely on this machine. */
  canStore: () => boolean;
  has: () => boolean;
  load: () => string | null;
  save: (apiKey: string) => void;
  clear: () => void;
};

/** Provider ids appear in file names, so only allow a conservative character set. */
const SAFE_NAME = /^[a-z0-9-]{1,40}$/;

export function createCredentialStore(
  dir: string,
  cipher: KeyCipher,
  name: string,
): CredentialStore {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Invalid credential name "${name}".`);
  }
  const file = path.join(dir, `key-${name}.enc`);

  return {
    canStore: () => cipher.isAvailable(),
    has: () => fs.existsSync(file),
    load: () => {
      try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (!raw || !cipher.isAvailable()) {
          return null;
        }
        const key = cipher.decrypt(Buffer.from(raw, 'base64')).trim();
        return key || null;
      } catch {
        // Missing, corrupt, or encrypted under another user/machine: treat as absent.
        return null;
      }
    },
    save: (apiKey: string) => {
      const key = apiKey.trim();
      if (!key) {
        throw new Error('API key is empty.');
      }
      if (!cipher.isAvailable()) {
        throw new Error(
          'Secure storage is not available on this system, so the key was not saved. Set the ANTHROPIC_API_KEY environment variable instead.',
        );
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, cipher.encrypt(key).toString('base64'), {
        encoding: 'utf8',
        mode: 0o600,
      });
    },
    clear: () => {
      fs.rmSync(file, { force: true });
    },
  };
}

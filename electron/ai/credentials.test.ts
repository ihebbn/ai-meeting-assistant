import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { type KeyCipher, createCredentialStore } from './credentials';

/** Reversible fake cipher so tests can prove the plaintext is not what is stored. */
function fakeCipher(available = true): KeyCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ 0x5a)),
    decrypt: (data) => Buffer.from([...data].map((b) => b ^ 0x5a)).toString('utf8'),
  };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cred-'));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('credential store', () => {
  it('keeps separate keys per provider and rejects unsafe names', () => {
    withTempDir((dir) => {
      const a = createCredentialStore(dir, fakeCipher(), 'openai');
      const b = createCredentialStore(dir, fakeCipher(), 'mistral');
      a.save('key-a');
      assert.equal(b.load(), null);
      b.save('key-b');
      assert.equal(a.load(), 'key-a');
      assert.equal(b.load(), 'key-b');
      assert.throws(() => createCredentialStore(dir, fakeCipher(), '../evil'), /Invalid credential name/);
      assert.throws(() => createCredentialStore(dir, fakeCipher(), 'A B'), /Invalid credential name/);
    });
  });

  it('round-trips a key without writing plaintext to disk', () => {
    withTempDir((dir) => {
      const store = createCredentialStore(dir, fakeCipher(), 'anthropic');
      assert.equal(store.has(), false);
      store.save('  sk-ant-secret-123  ');
      assert.equal(store.has(), true);
      assert.equal(store.load(), 'sk-ant-secret-123');
      const onDisk = fs.readFileSync(path.join(dir, 'key-anthropic.enc'), 'utf8');
      assert.ok(!onDisk.includes('sk-ant-secret-123'));
    });
  });

  it('refuses to save when secure storage is unavailable', () => {
    withTempDir((dir) => {
      const store = createCredentialStore(dir, fakeCipher(false), 'anthropic');
      assert.equal(store.canStore(), false);
      assert.throws(() => store.save('sk-ant-x'), /Secure storage is not available/);
      assert.equal(store.has(), false);
    });
  });

  it('refuses an empty key', () => {
    withTempDir((dir) => {
      assert.throws(() => createCredentialStore(dir, fakeCipher(), 'anthropic').save('   '), /empty/);
    });
  });

  it('clear removes the key and is idempotent', () => {
    withTempDir((dir) => {
      const store = createCredentialStore(dir, fakeCipher(), 'anthropic');
      store.save('sk-ant-x');
      store.clear();
      store.clear();
      assert.equal(store.has(), false);
      assert.equal(store.load(), null);
    });
  });

  it('treats a corrupt file as absent', () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'key-anthropic.enc'), '%%%not-base64-or-valid%%%', 'utf8');
      const cipher = fakeCipher();
      cipher.decrypt = () => {
        throw new Error('cannot decrypt');
      };
      assert.equal(createCredentialStore(dir, cipher, 'anthropic').load(), null);
    });
  });
});

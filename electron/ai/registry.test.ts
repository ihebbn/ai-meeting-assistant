import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { normalizeBaseUrl } from './base-url';
import { DEFAULT_PROVIDER_ID, PROVIDERS, getProvider } from './registry';

describe('provider registry', () => {
  it('has unique, file-name-safe ids and a default that exists', () => {
    const ids = PROVIDERS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(id, /^[a-z0-9-]{1,40}$/);
    }
    assert.ok(ids.includes(DEFAULT_PROVIDER_ID));
  });

  it('only ships https base URLs, and only the custom provider is editable', () => {
    for (const p of PROVIDERS) {
      if (p.baseUrl) {
        assert.equal(normalizeBaseUrl(p.baseUrl), p.baseUrl.replace(/\/+$/, ''), p.id);
        assert.ok(p.baseUrl.startsWith('https://'), p.id);
      }
    }
    assert.deepEqual(
      PROVIDERS.filter((p) => p.baseUrlEditable).map((p) => p.id),
      ['custom'],
    );
  });

  it('gives every HTTP provider a base URL (except custom) and env vars (except custom)', () => {
    for (const p of PROVIDERS.filter((x) => x.kind !== 'anthropic' && x.id !== 'custom')) {
      assert.ok(p.baseUrl, p.id);
      assert.ok(p.envVars.length > 0, p.id);
      for (const name of p.envVars) {
        assert.match(name, /^[A-Z][A-Z0-9_]+$/);
      }
    }
  });

  it('does not hardcode model names for non-Anthropic providers', () => {
    for (const p of PROVIDERS.filter((x) => x.id !== 'anthropic')) {
      assert.equal(p.defaultModel, null, p.id);
    }
    assert.equal(getProvider('anthropic').defaultModel, 'claude-opus-5-5');
  });

  it('flags providers whose wire format is unverified as experimental', () => {
    assert.equal(getProvider('google').experimental, true);
    assert.equal(getProvider('xai').experimental, true);
    assert.equal(getProvider('mistral').experimental, false);
  });

  it('falls back to the first provider for unknown ids', () => {
    assert.equal(getProvider('does-not-exist').id, PROVIDERS[0]!.id);
  });
});

describe('normalizeBaseUrl', () => {
  it('accepts https, trims, drops trailing slashes, query and fragment', () => {
    assert.equal(normalizeBaseUrl('  https://api.example.com/v1/// '), 'https://api.example.com/v1');
    assert.equal(normalizeBaseUrl('https://api.example.com/v1?x=1#frag'), 'https://api.example.com/v1');
    assert.equal(normalizeBaseUrl('https://api.example.com:8443'), 'https://api.example.com:8443');
  });

  it('allows plain http only for loopback hosts', () => {
    assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000');
    assert.equal(normalizeBaseUrl('http://example.com/v1'), null);
  });

  it('rejects other schemes, embedded credentials and garbage', () => {
    assert.equal(normalizeBaseUrl('file:///etc/passwd'), null);
    assert.equal(normalizeBaseUrl('ftp://example.com'), null);
    assert.equal(normalizeBaseUrl('https://user:pw@example.com'), null);
    assert.equal(normalizeBaseUrl('not a url'), null);
    assert.equal(normalizeBaseUrl(''), null);
  });
});

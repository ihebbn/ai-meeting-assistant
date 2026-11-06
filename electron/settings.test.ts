import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_SETTINGS,
  getSettings,
  initSettings,
  normalizeSettings,
  updateSettings,
} from './settings';

describe('normalizeSettings', () => {
  it('returns defaults for garbage input', () => {
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings('x'), DEFAULT_SETTINGS);
  });

  it('ignores unknown keys and wrong types', () => {
    const out = normalizeSettings({ contentProtection: 'yes', qwenAcceptancePassed: true, extra: 1 });
    assert.deepEqual(out, { ...DEFAULT_SETTINGS, contentProtection: true, qwenAcceptancePassed: true });
  });

  it('validates AI provider, models, base URLs and effort', () => {
    const out = normalizeSettings({
      aiProvider: 'openai',
      aiModels: { openai: '  gpt-x ', mistral: '', 'bad key!': 'm', anthropic: 42 },
      aiBaseUrls: {
        custom: 'https://example.com/v1/',
        evil: 'http://example.com/v1',
        creds: 'https://user:pw@example.com',
        local: 'http://localhost:8080/v1',
      },
      aiEffort: 'high',
    });
    assert.equal(out.aiProvider, 'openai');
    assert.deepEqual(out.aiModels, { openai: 'gpt-x' });
    assert.deepEqual(out.aiBaseUrls, {
      custom: 'https://example.com/v1',
      local: 'http://localhost:8080/v1',
    });
    assert.equal(out.aiEffort, 'high');
  });

  it('falls back to defaults for invalid AI fields', () => {
    const out = normalizeSettings({ aiProvider: 'Bad Provider!', aiModels: 'x', aiBaseUrls: [], aiEffort: 'max' });
    assert.equal(out.aiProvider, DEFAULT_SETTINGS.aiProvider);
    assert.deepEqual(out.aiModels, {});
    assert.deepEqual(out.aiBaseUrls, {});
    assert.equal(out.aiEffort, DEFAULT_SETTINGS.aiEffort);
  });
});

describe('settings persistence', () => {
  it('persists updates and reloads them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-settings-'));
    try {
      assert.deepEqual(initSettings(dir), DEFAULT_SETTINGS);
      updateSettings({ contentProtection: false });
      assert.equal(getSettings().contentProtection, false);
      assert.equal(initSettings(dir).contentProtection, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults on a corrupt file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-settings-'));
    try {
      fs.writeFileSync(path.join(dir, 'settings.json'), '{not json', 'utf8');
      assert.deepEqual(initSettings(dir), DEFAULT_SETTINGS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

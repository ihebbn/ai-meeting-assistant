import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { platformCaps } from './platform';

describe('platformCaps', () => {
  it('supports capture protection and mic settings links on Windows', () => {
    const caps = platformCaps('win32');
    assert.equal(caps.contentProtection, true);
    assert.deepEqual(caps.micSettingsLinks, ['ms-settings:privacy-microphone', 'ms-settings:sound']);
  });

  it('does not claim capture protection or Windows links on Linux', () => {
    const caps = platformCaps('linux');
    assert.equal(caps.label, 'Linux');
    assert.equal(caps.contentProtection, false);
    assert.deepEqual(caps.micSettingsLinks, []);
  });

  it('supports capture protection on macOS but offers no unverified deep link', () => {
    const caps = platformCaps('darwin');
    assert.equal(caps.contentProtection, true);
    assert.deepEqual(caps.micSettingsLinks, []);
  });

  it('is conservative for unknown platforms', () => {
    const caps = platformCaps('freebsd');
    assert.equal(caps.contentProtection, false);
    assert.deepEqual(caps.micSettingsLinks, []);
  });

  it('never offers an ms-settings link off Windows', () => {
    for (const p of ['linux', 'darwin', 'freebsd', 'aix'] as const) {
      assert.ok(!platformCaps(p).micSettingsLinks.some((l) => l.startsWith('ms-settings:')), p);
    }
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  anyPanelOpen,
  clampPanelSize,
  NO_PROVIDER_MESSAGE,
  createInitialSession,
} from './session';

describe('clampPanelSize', () => {
  it('enforces the minimum size', () => {
    assert.deepEqual(clampPanelSize(10, 10, 2000, 2000), {
      width: MIN_PANEL_WIDTH,
      height: MIN_PANEL_HEIGHT,
    });
  });

  it('enforces the maximum size and rounds', () => {
    assert.deepEqual(clampPanelSize(5000.4, 4000.6, 900, 700), { width: 900, height: 700 });
  });
});

describe('anyPanelOpen', () => {
  it('is false when panels are hidden even if flagged open', () => {
    const s = createInitialSession();
    s.panelsHidden = true;
    assert.equal(anyPanelOpen(s), false);
  });

  it('is true when one panel is open and not hidden', () => {
    const s = createInitialSession();
    s.insightsOpen = true;
    s.responseOpen = false;
    assert.equal(anyPanelOpen(s), true);
  });

  it('is false when both panels are collapsed', () => {
    const s = createInitialSession();
    s.insightsOpen = false;
    s.responseOpen = false;
    assert.equal(anyPanelOpen(s), false);
  });
});

describe('createInitialSession', () => {
  it('starts idle with an empty transcript and no canned suggestions', () => {
    const s = createInitialSession();
    assert.equal(s.listening, false);
    assert.equal(s.transcript.length, 0);
    assert.deepEqual(s.actions, []);
    assert.equal(s.suggestionsStatus, 'idle');
    assert.equal(s.suggestionsMessage, null);
  });

  it('has no demo content about real companies or events', () => {
    const s = createInitialSession();
    assert.ok(!JSON.stringify(s).match(/windsurf|cognition|acquisition/i));
  });
});

describe('NO_PROVIDER_MESSAGE', () => {
  it('tells the user how to get answers', () => {
    assert.match(NO_PROVIDER_MESSAGE, /Settings/);
    assert.match(NO_PROVIDER_MESSAGE, /API key/);
  });
});

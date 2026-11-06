import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  anyPanelOpen,
  answerForPrompt,
  clampPanelSize,
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

describe('answerForPrompt', () => {
  it('prefers the action id when known', () => {
    assert.match(answerForPrompt('anything', 'define'), /startup acquisition/i);
  });

  it('falls back to the default sample answer', () => {
    assert.match(answerForPrompt('unrelated question'), /sample answers/i);
  });
});

describe('createInitialSession', () => {
  it('starts idle with an empty transcript', () => {
    const s = createInitialSession();
    assert.equal(s.listening, false);
    assert.equal(s.transcript.length, 0);
  });
});

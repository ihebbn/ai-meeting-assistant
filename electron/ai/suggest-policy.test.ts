import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  AUTO_SUGGEST_MIN_INTERVAL_MS,
  AUTO_SUGGEST_MIN_NEW_LINES,
  type AutoSuggestInput,
  shouldAutoSuggest,
} from './suggest-policy';

const ready: AutoSuggestInput = {
  enabled: true,
  configured: true,
  loading: false,
  nowMs: 1_000_000,
  lastStartedMs: null,
  linesNow: 10,
  linesAtLastRefresh: 0,
};

describe('shouldAutoSuggest', () => {
  it('fires when enabled, configured, idle and there is new content', () => {
    assert.equal(shouldAutoSuggest(ready), true);
  });

  it('never fires when disabled, unconfigured or already loading', () => {
    assert.equal(shouldAutoSuggest({ ...ready, enabled: false }), false);
    assert.equal(shouldAutoSuggest({ ...ready, configured: false }), false);
    assert.equal(shouldAutoSuggest({ ...ready, loading: true }), false);
  });

  it('needs at least a couple of transcript lines', () => {
    assert.equal(shouldAutoSuggest({ ...ready, linesNow: 1 }), false);
  });

  it('respects the minimum interval since the last refresh', () => {
    const last = ready.nowMs - (AUTO_SUGGEST_MIN_INTERVAL_MS - 1);
    assert.equal(shouldAutoSuggest({ ...ready, lastStartedMs: last, linesAtLastRefresh: 0 }), false);
    const older = ready.nowMs - AUTO_SUGGEST_MIN_INTERVAL_MS;
    assert.equal(shouldAutoSuggest({ ...ready, lastStartedMs: older, linesAtLastRefresh: 0 }), true);
  });

  it('needs enough new lines since the last refresh', () => {
    const base = { ...ready, lastStartedMs: 0, linesAtLastRefresh: 20 };
    assert.equal(shouldAutoSuggest({ ...base, linesNow: 20 + AUTO_SUGGEST_MIN_NEW_LINES - 1 }), false);
    assert.equal(shouldAutoSuggest({ ...base, linesNow: 20 + AUTO_SUGGEST_MIN_NEW_LINES }), true);
  });
});

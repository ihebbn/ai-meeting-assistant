/**
 * Decides whether suggestions may refresh on their own. Auto-refresh sends the recent
 * transcript to the provider, so it is opt-in and throttled by both time and new content.
 */
export const AUTO_SUGGEST_MIN_INTERVAL_MS = 45_000;
export const AUTO_SUGGEST_MIN_NEW_LINES = 3;
/** Fewer transcript lines than this give nothing worth suggesting from. */
export const MIN_LINES_FOR_SUGGESTIONS = 2;

export type AutoSuggestInput = {
  enabled: boolean;
  configured: boolean;
  loading: boolean;
  nowMs: number;
  /** When the last refresh started; null if none has run yet. */
  lastStartedMs: number | null;
  linesNow: number;
  linesAtLastRefresh: number;
};

export function shouldAutoSuggest(input: AutoSuggestInput): boolean {
  if (!input.enabled || !input.configured || input.loading) {
    return false;
  }
  if (input.linesNow < MIN_LINES_FOR_SUGGESTIONS) {
    return false;
  }
  if (input.lastStartedMs !== null && input.nowMs - input.lastStartedMs < AUTO_SUGGEST_MIN_INTERVAL_MS) {
    return false;
  }
  return input.linesNow - input.linesAtLastRefresh >= AUTO_SUGGEST_MIN_NEW_LINES;
}

import { type ErrorCount, percentile, rate, sumErrors } from './metrics';

export type ClipResult = {
  clipId: string;
  backend: 'qwen' | 'whisper';
  language: string;
  tags: string[];
  durationSec: number;
  /** Wall-clock decode time around the backend call. */
  wallMs: number;
  hypothesis: string;
  wer: ErrorCount;
  cer: ErrorCount;
  /** Set when the backend threw; such clips are excluded from the aggregates. */
  error?: string;
};

export type GroupSummary = {
  group: string;
  backend: 'qwen' | 'whisper';
  clips: number;
  failures: number;
  /** Micro-averaged (pooled) rates; null when no reference words were scored. */
  wer: number | null;
  cer: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Total decode time divided by total audio time; below 1 is faster than real time. */
  realTimeFactor: number | null;
};

export function summarize(
  results: readonly ClipResult[],
  groupsOf: (r: ClipResult) => string[],
): GroupSummary[] {
  const buckets = new Map<string, ClipResult[]>();
  for (const r of results) {
    for (const group of groupsOf(r)) {
      const key = `${group}\u0000${r.backend}`;
      const list = buckets.get(key);
      if (list) {
        list.push(r);
      } else {
        buckets.set(key, [r]);
      }
    }
  }

  return [...buckets.entries()]
    .map(([key, list]) => {
      const [group, backend] = key.split('\u0000') as [string, 'qwen' | 'whisper'];
      const ok = list.filter((r) => !r.error);
      const audioSec = ok.reduce((acc, r) => acc + r.durationSec, 0);
      const wallMs = ok.reduce((acc, r) => acc + r.wallMs, 0);
      const latencies = ok.map((r) => r.wallMs);
      return {
        group,
        backend,
        clips: ok.length,
        failures: list.length - ok.length,
        wer: rate(sumErrors(ok.map((r) => r.wer))),
        cer: rate(sumErrors(ok.map((r) => r.cer))),
        latencyP50Ms: percentile(latencies, 50),
        latencyP95Ms: percentile(latencies, 95),
        realTimeFactor: audioSec > 0 ? wallMs / 1000 / audioSec : null,
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.backend.localeCompare(b.backend));
}

const pct = (v: number | null): string => (v === null ? '-' : `${(v * 100).toFixed(1)}%`);
const ms = (v: number | null): string => (v === null ? '-' : `${Math.round(v)}`);
const num = (v: number | null): string => (v === null ? '-' : v.toFixed(2));

export function formatTable(rows: readonly GroupSummary[]): string {
  const header = ['group', 'backend', 'clips', 'fail', 'WER', 'CER', 'p50 ms', 'p95 ms', 'RTF'];
  const body = rows.map((r) => [
    r.group,
    r.backend,
    String(r.clips),
    String(r.failures),
    pct(r.wer),
    pct(r.cer),
    ms(r.latencyP50Ms),
    ms(r.latencyP95Ms),
    num(r.realTimeFactor),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

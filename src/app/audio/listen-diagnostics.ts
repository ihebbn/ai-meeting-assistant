import { Injectable } from '@angular/core';
import { getApi } from '../electron-api';

type SourceName = 'you' | 'system';

type FinalMark = {
  source: SourceName;
  speechEndedAt: number;
  sentAt: number;
  recvAt: number;
  asrMs: number;
  endpointMs: number;
  durMs: number;
  queueDepth: number;
  appendedAt: number;
  painted: boolean;
};

/**
 * Development timings only. Never includes transcript text, audio samples, or secrets.
 * Enabled for `npm run dev` (ELECTRON_DEV=1) and for the local Angular server.
 */
@Injectable({ providedIn: 'root' })
export class ListenDiagnostics {
  private readonly partials = new Map<string, { onsetAt: number; painted: boolean }>();
  private readonly finals = new Map<string, FinalMark>();

  enabled(): boolean {
    const flag = getApi()?.isDev;
    if (flag === true) {
      return true;
    }
    if (flag === false) {
      return false;
    }
    const host = typeof location !== 'undefined' ? location.hostname : '';
    return host === 'localhost' || host === '127.0.0.1';
  }

  noteCapture(
    source: SourceName,
    stats: {
      callbacks: number;
      maxGapMs: number;
      overruns: number;
      rawPeak: number;
      speaking: boolean;
      queue: number;
      dropped: number;
      sampleRate: number;
      channels: number;
    },
  ): void {
    if (!this.enabled()) {
      return;
    }
    console.info(
      `[listen-diag] capture source=${source} callbacks=${stats.callbacks} maxGapMs=${stats.maxGapMs} overruns=${stats.overruns} rawPeak=${stats.rawPeak.toFixed(4)} vad=${stats.speaking ? 1 : 0} queue=${stats.queue} dropped=${stats.dropped} rate=${stats.sampleRate} ch=${stats.channels}`,
    );
  }

  noteLifecycle(source: SourceName, event: string): void {
    console.warn(`[listen-diag] lifecycle source=${source} event=${event}`);
  }

  noteOnset(interimId: string): void {
    this.partials.set(interimId, { onsetAt: performance.now(), painted: false });
  }

  noteInterimPaint(interimId: string): void {
    const row = this.partials.get(interimId);
    if (!row || row.painted) {
      return;
    }
    row.painted = true;
    if (!this.enabled()) {
      return;
    }
    console.info(
      `[listen-diag] partial id=${interimId} paintMs=${Math.round(performance.now() - row.onsetAt)}`,
    );
  }

  noteChunk(mark: {
    id: string;
    source: SourceName;
    speechEndedAt: number;
    sentAt: number;
    recvAt: number;
    asrMs: number;
    endpointMs: number;
    durMs: number;
    queueDepth: number;
    empty: boolean;
  }): void {
    this.finals.set(mark.id, {
      source: mark.source,
      speechEndedAt: mark.speechEndedAt,
      sentAt: mark.sentAt,
      recvAt: mark.recvAt,
      asrMs: mark.asrMs,
      endpointMs: mark.endpointMs,
      durMs: mark.durMs,
      queueDepth: mark.queueDepth,
      appendedAt: performance.now(),
      painted: false,
    });
    if (!this.enabled()) {
      return;
    }
    console.info(
      `[listen-diag] chunk source=${mark.source} durMs=${mark.durMs} endpointMs=${mark.endpointMs} queue=${mark.queueDepth} ipcMs=${Math.round(mark.recvAt - mark.sentAt)} asrMs=${mark.asrMs} empty=${mark.empty ? 1 : 0}`,
    );
  }

  notePainted(lineId: string): void {
    const row = this.finals.get(lineId);
    if (!row || row.painted) {
      return;
    }
    row.painted = true;
    if (!this.enabled()) {
      return;
    }
    const now = performance.now();
    console.info(
      `[listen-diag] ui source=${row.source} paintMs=${Math.round(now - row.appendedAt)} e2eMs=${Math.round(now - row.speechEndedAt)}`,
    );
  }

  noteDrop(source: SourceName, chunks: number): void {
    console.warn(`[listen-diag] drop source=${source} chunks=${chunks}`);
  }

  noteSendFailure(source: SourceName, reason: string): void {
    console.warn(`[listen-diag] send-failed source=${source} reason=${reason}`);
  }

  noteDev(message: string): void {
    if (!this.enabled()) {
      return;
    }
    console.info(`[listen-diag] ${message}`);
  }
}

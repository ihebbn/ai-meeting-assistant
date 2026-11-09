import WebSocket from 'ws';
import {
  SONIOX_SAMPLE_RATE,
  SONIOX_WS_URL,
  applySonioxTokens,
  buildSonioxStartMessage,
  emptyCaption,
  floatToPcm16le,
  liveCaptionText,
  takeCommittedPhrase,
  type SonioxCaption,
  type SonioxToken,
} from './soniox-tokens';

export type SonioxSource = 'you' | 'system';

export type SonioxHooks = {
  onLive: (source: SonioxSource, text: string, language: string | null) => void;
  onCommit: (source: SonioxSource, text: string, language: string | null) => void;
  onError: (source: SonioxSource, message: string) => void;
  onDiag: (line: string) => void;
};

const MAX_QUEUED_SAMPLES = SONIOX_SAMPLE_RATE * 5;
const RECONNECT_LIMIT = 3;

class SourceSocket {
  private ws: WebSocket | null = null;
  private caption: SonioxCaption = emptyCaption();
  private queue: Float32Array[] = [];
  private queuedSamples = 0;
  private acceptAudio = false;
  private stopping = false;
  private reconnects = 0;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private firstAudioAt = 0;
  private reportedPartial = false;
  private overflowReported = false;
  private finished: (() => void) | null = null;

  constructor(
    readonly source: SonioxSource,
    private readonly key: string,
    private readonly hooks: SonioxHooks,
  ) {}

  start(): Promise<void> {
    this.stopping = false;
    return this.open();
  }

  sendFloat(samples: Float32Array): void {
    if (!samples.length || this.stopping) {
      return;
    }
    if (!this.firstAudioAt) {
      this.firstAudioAt = Date.now();
    }
    this.queue.push(Float32Array.from(samples));
    this.queuedSamples += samples.length;
    while (this.queuedSamples > MAX_QUEUED_SAMPLES && this.queue.length) {
      const dropped = this.queue.shift();
      this.queuedSamples -= dropped?.length ?? 0;
      if (!this.overflowReported) {
        this.overflowReported = true;
        this.hooks.onError(
          this.source,
          'Soniox is behind live audio. Some speech was kept in a 5s buffer and older audio was dropped.',
        );
      }
    }
    this.flushQueue();
  }

  cancel(): void {
    this.stopping = true;
    this.closeSocket();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearKeepalive();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.closeSocket();
      this.commitRemainder();
      return;
    }
    const done = new Promise<void>((resolve) => {
      this.finished = resolve;
      setTimeout(resolve, 2000);
    });
    try {
      ws.send(JSON.stringify({ type: 'finalize' }));
      ws.send('');
    } catch {
      this.commitRemainder();
      this.closeSocket();
      return;
    }
    await done;
    this.commitRemainder();
    this.closeSocket();
  }

  private open(): Promise<void> {
    this.closeSocket();
    this.acceptAudio = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(SONIOX_WS_URL, {
        headers: { Authorization: `Bearer ${this.key}` },
      });
      this.ws = ws;
      const fail = (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        this.stopping = true;
        reject(new Error(message));
      };
      ws.on('open', () => {
        try {
          ws.send(JSON.stringify(buildSonioxStartMessage()));
        } catch (err) {
          fail(String(err));
          return;
        }
        this.acceptAudio = true;
        this.reconnects = 0;
        this.armKeepalive();
        this.flushQueue();
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          return;
        }
        this.onMessage(data.toString());
      });
      ws.on('error', (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!settled) {
          fail(message);
          return;
        }
        this.hooks.onError(this.source, `Soniox connection error: ${message}`);
      });
      ws.on('close', (code) => {
        this.acceptAudio = false;
        this.clearKeepalive();
        this.finished?.();
        this.finished = null;
        if (!settled) {
          fail(`Soniox connection closed (${code}) before it was ready.`);
          return;
        }
        if (!this.stopping) {
          void this.reconnect();
        }
      });
    });
  }

  private async reconnect(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.reconnects += 1;
    if (this.reconnects > RECONNECT_LIMIT) {
      this.hooks.onError(
        this.source,
        'Soniox disconnected and did not recover. Stop and press Listen to try again.',
      );
      return;
    }
    this.commitRemainder();
    this.hooks.onError(this.source, `Soniox reconnecting (${this.reconnects}/${RECONNECT_LIMIT}).`);
    await delay(400 * this.reconnects);
    if (this.stopping) {
      return;
    }
    try {
      await this.open();
      this.hooks.onDiag(`soniox source=${this.source} event=reconnected`);
    } catch (err) {
      this.hooks.onError(this.source, `Soniox reconnect failed: ${String(err)}`);
      void this.reconnect();
    }
  }

  private onMessage(raw: string): void {
    let message: {
      tokens?: SonioxToken[];
      finished?: boolean;
      error_code?: number;
      error_type?: string;
      error_message?: string;
    };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      this.hooks.onError(this.source, 'Soniox sent a response that was not JSON.');
      return;
    }
    if (message.error_code) {
      const kind = message.error_type || 'error';
      this.hooks.onError(
        this.source,
        `Soniox ${kind} (${message.error_code}): ${message.error_message || 'request failed'}`,
      );
      if (message.error_code === 401 || message.error_code === 402 || message.error_code === 403) {
        this.stopping = true;
        this.closeSocket();
      }
      return;
    }
    const tokens = Array.isArray(message.tokens) ? message.tokens : [];
    this.caption = applySonioxTokens(this.caption, tokens);
    const hadProvisional = tokens.some((token) => token.is_final === false && token.text);
    if (hadProvisional && !this.reportedPartial && this.firstAudioAt) {
      this.reportedPartial = true;
      this.hooks.onDiag(
        `soniox source=${this.source} firstPartialMs=${Date.now() - this.firstAudioAt}`,
      );
    }
    const committed = takeCommittedPhrase(this.caption);
    if (committed) {
      this.caption = committed.next;
      this.hooks.onCommit(this.source, committed.text, this.caption.language);
      this.hooks.onLive(this.source, '', this.caption.language);
    } else {
      this.hooks.onLive(this.source, liveCaptionText(this.caption).trim(), this.caption.language);
    }
    if (message.finished) {
      this.finished?.();
      this.finished = null;
    }
  }

  private flushQueue(): void {
    if (!this.acceptAudio || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    while (this.queue.length) {
      const next = this.queue.shift();
      if (!next) {
        continue;
      }
      this.queuedSamples -= next.length;
      this.ws.send(floatToPcm16le(next));
    }
  }

  private commitRemainder(): void {
    const text = `${this.caption.finalText}${this.caption.provisional}`.trim();
    const language = this.caption.language;
    this.caption = emptyCaption();
    if (text) {
      this.hooks.onCommit(this.source, text, language);
    }
    this.hooks.onLive(this.source, '', null);
  }

  private armKeepalive(): void {
    this.clearKeepalive();
    this.keepalive = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'keepalive' }));
      }
    }, 15_000);
  }

  private clearKeepalive(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  private closeSocket(): void {
    this.acceptAudio = false;
    this.clearKeepalive();
    const ws = this.ws;
    this.ws = null;
    if (!ws) {
      return;
    }
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    }
  }
}

const sockets = new Map<SonioxSource, SourceSocket>();

export async function startSoniox(
  key: string,
  sources: SonioxSource[],
  hooks: SonioxHooks,
): Promise<{ error: string | null }> {
  await stopSoniox();
  const opening = sources.map(async (source) => {
    const socket = new SourceSocket(source, key, hooks);
    sockets.set(source, socket);
    try {
      await socket.start();
    } catch (err) {
      sockets.delete(source);
      socket.cancel();
      throw err;
    }
  });
  const results = await Promise.allSettled(opening);
  const failures = results
    .map((result, index) =>
      result.status === 'rejected' ? `${sources[index]}: ${String(result.reason)}` : '',
    )
    .filter(Boolean);
  if (failures.length === sources.length) {
    await stopSoniox();
    throw new Error(failures.join(' '));
  }
  if (failures.length) {
    const message = failures.join(' ');
    hooks.onError(failures[0]!.startsWith('you') ? 'you' : 'system', message);
    return { error: message };
  }
  return { error: null };
}

export function sendSonioxPcm(source: SonioxSource, samples: Float32Array): void {
  sockets.get(source)?.sendFloat(samples);
}

export async function stopSoniox(): Promise<void> {
  const active = [...sockets.values()];
  sockets.clear();
  await Promise.all(active.map((socket) => socket.stop()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

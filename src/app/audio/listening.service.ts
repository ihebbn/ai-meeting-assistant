import { Injectable, OnDestroy, effect, inject } from '@angular/core';
import { getApi } from '../electron-api';
import { SessionService } from '../session.service';

type SourceName = 'you' | 'system';

const TARGET_RATE = 16000;
/** Short phrase windows keep captions closer to live speech. */
const MAX_UTTERANCE_SEC = 3.2;
const OVERLAP_SEC = 0.35;
const PAD_UTTERANCE_SEC = 0.25;
const MIN_UTTERANCE_SEC = 0.28;
const SILENCE_FLUSH_MS = 260;
/** Meter sampling; IPC reports are further throttled when values barely change. */
const LEVEL_PUSH_MS = 160;
const LEVEL_REPORT_MIN_MS = 180;
const SPEECH_RMS = 0.004;
const SILENCE_RMS = 0.002;
const MIC_LIVE_RMS = 0.006;
const MIN_SPEECH_RATIO = 0.1;
const MAX_QUEUED_UTTERANCES = 10;

class SourceCapture {
  stream: MediaStream | null = null;
  context: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  sourceNode: MediaStreamAudioSourceNode | null = null;
  processor: ScriptProcessorNode | null = null;
  monitor: HTMLAudioElement | null = null;
  readonly samples: number[] = [];
  readonly queue: Float32Array[] = [];
  speaking = false;
  silentSince = 0;
  level = 0;
  active = false;
  draining = false;
  generation = 0;
  peakRms = 0;

  constructor(readonly name: SourceName) {}
}

@Injectable({ providedIn: 'root' })
export class ListeningService implements OnDestroy {
  private readonly sessions = inject(SessionService);
  private readonly mic = new SourceCapture('you');
  private readonly system = new SourceCapture('system');
  private running = false;
  private starting = false;
  /** Bumped on every stop/start so abandoned startups cannot steal the session. */
  private listenGeneration = 0;
  private levelTimer: number | null = null;
  private destroyed = false;
  private lastMicDiag = 0;
  private lastLevelReportAt = 0;
  private lastReportedMic = -1;
  private lastReportedSys = -1;
  private lastReportedMicActive = false;
  private lastReportedSysActive = false;
  private micLabel = '';
  private silentMicWarned = false;

  constructor() {
    effect(() => {
      const listening = this.sessions.session()?.listening ?? false;
      if (this.destroyed) {
        return;
      }
      if (listening) {
        void this.start();
      } else {
        void this.stop('session-paused');
      }
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    void this.stop('destroy');
  }

  private async start(): Promise<void> {
    if (this.running || this.starting) {
      return;
    }
    const generation = ++this.listenGeneration;
    this.starting = true;
    this.silentMicWarned = false;
    const api = getApi();
    try {
      await api?.reportListenStatus?.({
        status: 'starting',
        error: 'Loading speech model…',
        modelReady: false,
      });
      if (generation !== this.listenGeneration) {
        return;
      }

      const model = await api?.ensureTranscriber?.();
      if (generation !== this.listenGeneration) {
        return;
      }
      if (!model?.ready) {
        throw new Error(
          model?.error ||
            'Speech model failed to load. Check network on first run, then retry Listen.',
        );
      }

      // System loopback first — opening it after the mic can leave WASAPI mic
      // sessions delivering silence on some Windows machines.
      if (!api?.enableLoopbackAudio || !api?.disableLoopbackAudio) {
        throw new Error('System audio loopback bridge is unavailable.');
      }
      await api.enableLoopbackAudio();
      if (generation !== this.listenGeneration) {
        try {
          await api.disableLoopbackAudio();
        } catch {
          // Already disabled.
        }
        return;
      }
      let systemStream: MediaStream;
      try {
        systemStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
      } finally {
        await api.disableLoopbackAudio();
      }
      if (generation !== this.listenGeneration) {
        for (const track of systemStream.getTracks()) {
          track.stop();
        }
        return;
      }
      for (const track of systemStream.getVideoTracks()) {
        track.stop();
        systemStream.removeTrack(track);
      }
      if (systemStream.getAudioTracks().length === 0) {
        throw new Error('System audio track missing — loopback did not start.');
      }
      await this.attachStream(this.system, systemStream, 1);
      if (generation !== this.listenGeneration) {
        this.teardownSource(this.system);
        return;
      }

      const mic = await this.openLiveMicrophone();
      if (generation !== this.listenGeneration) {
        mic.stream.getTracks().forEach((t) => t.stop());
        this.teardownSource(this.system);
        return;
      }
      this.micLabel = mic.label;
      await this.attachStream(this.mic, mic.stream, 1);
      if (generation !== this.listenGeneration) {
        this.teardownSource(this.mic);
        this.teardownSource(this.system);
        return;
      }

      this.running = true;
      this.startLevelPump();
      void api?.ensureTranscriber?.().then((ok) => {
        if (generation !== this.listenGeneration) {
          return;
        }
        void api.reportListenStatus?.({
          status: 'listening',
          error: ok?.error ?? null,
          modelReady: !!ok?.ready,
        });
      });

      // Never open Windows Settings automatically — just start listening.
      await api?.reportListenStatus?.({
        status: 'listening',
        error: null,
        modelReady: !!model?.ready,
      });
      if (!mic.live) {
        console.info(
          `[listen] mic “${mic.label}” was quiet during quick probe — continuing anyway`,
        );
      }
    } catch (err) {
      if (generation !== this.listenGeneration) {
        return;
      }
      await this.stop('start-failed');
      await api?.reportListenStatus?.({
        status: 'error',
        error: formatListenError(err),
        modelReady: false,
      });
      await api?.setListening?.(false);
    } finally {
      if (generation === this.listenGeneration) {
        this.starting = false;
      }
    }
  }

  private async openLiveMicrophone(): Promise<{
    stream: MediaStream;
    label: string;
    live: boolean;
  }> {
    // Fast path: open the default mic immediately so Listen feels instant.
    // Only fall back to other devices if the default stays near-silent.
    const permission = await navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((p) => p.state)
      .catch(() => 'unknown');
    console.info('[listen] mic permission', permission);

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
    const ranked = [...inputs].sort((a, b) => scoreMicLabel(b.label) - scoreMicLabel(a.label));
    const attempts: Array<MediaDeviceInfo | null> = [null, ...ranked.slice(0, 3)];

    let best: { stream: MediaStream; label: string; peak: number } | null = null;

    for (const device of attempts) {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: device ? { exact: device.deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });
      } catch (err) {
        console.warn('[listen] mic open failed', device?.label || 'default', err);
        continue;
      }

      const track = stream.getAudioTracks()[0];
      const label = device?.label || track?.label || 'Default microphone';
      const peak = await measureStreamPeak(stream, 220);
      console.info(
        `[listen] mic probe “${label}” peak=${peak.toFixed(4)} muted=${track?.muted}`,
      );

      if (!best || peak > best.peak) {
        if (best) {
          best.stream.getTracks().forEach((t) => t.stop());
        }
        best = { stream, label, peak };
      } else {
        stream.getTracks().forEach((t) => t.stop());
      }

      // Default/first usable device is enough — don't stall probing every input.
      if (peak >= MIC_LIVE_RMS || device === null) {
        break;
      }
    }

    if (!best) {
      throw new Error('Could not open any microphone device.');
    }

    const live = best.peak >= MIC_LIVE_RMS;
    console.info(
      `[listen] using mic “${best.label}” peak=${best.peak.toFixed(4)} live=${live}`,
    );
    return { stream: best.stream, label: best.label, live };
  }

  private async stop(reason: string): Promise<void> {
    this.listenGeneration += 1;
    this.running = false;
    this.starting = false;
    if (this.levelTimer != null) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    this.teardownSource(this.mic);
    this.teardownSource(this.system);
    const api = getApi();
    try {
      await api?.disableLoopbackAudio?.();
    } catch {
      // Already disabled.
    }
    await api?.reportAudioActivity?.({
      micLevel: 0,
      systemLevel: 0,
      micActive: false,
      systemActive: false,
    });
    if (reason !== 'start-failed') {
      await api?.reportListenStatus?.({
        status: 'idle',
        error: null,
        modelReady: false,
      });
    }
  }

  private async attachStream(
    capture: SourceCapture,
    stream: MediaStream,
    gain: number,
  ): Promise<void> {
    capture.stream = stream;
    for (const track of stream.getAudioTracks()) {
      track.enabled = true;
      track.onended = () => {
        if (this.running) {
          void getApi()?.reportListenStatus?.({
            status: 'error',
            error: `${capture.name === 'you' ? 'Microphone' : 'System audio'} track ended.`,
            modelReady: false,
          });
        }
      };
      track.onmute = () => {
        // Chromium often reports muted=true briefly on open even when audio flows.
        // Only warn if the mic stays silent after a short grace period.
        if (capture.name !== 'you' || !this.running) {
          return;
        }
        window.setTimeout(() => {
          if (!this.running || this.mic.peakRms >= MIC_LIVE_RMS || this.mic.active) {
            return;
          }
          void getApi()?.reportListenStatus?.({
            status: 'listening',
            error: `Microphone muted by Windows (“${this.micLabel || track.label}”).`,
            modelReady: false,
          });
        }, 1500);
      };
      track.onunmute = () => {
        if (capture.name === 'you' && this.running) {
          void getApi()?.reportListenStatus?.({
            status: 'listening',
            error: null,
            modelReady: !!this.sessions.session()?.modelReady,
          });
        }
      };
    }

    // Keep the capture graph alive — some Windows builds only deliver samples
    // when the MediaStream is attached to an element that is actually playing.
    const monitor = new Audio();
    monitor.srcObject = stream;
    monitor.muted = true;
    monitor.volume = 0;
    monitor.autoplay = true;
    capture.monitor = monitor;
    try {
      await monitor.play();
    } catch (err) {
      console.warn('[listen] monitor play failed', capture.name, err);
    }

    const trackRate = stream.getAudioTracks()[0]?.getSettings?.().sampleRate;
    // Chromium throws NotSupportedError when the track's sampleRate cannot be
    // forced on AudioContext (common with WASAPI loopback). Fall back to default.
    const context = createAudioContext(
      typeof trackRate === 'number' && trackRate > 0 ? trackRate : undefined,
    );
    capture.context = context;
    if (context.state === 'suspended') {
      await context.resume();
    }
    const sourceNode = context.createMediaStreamSource(stream);
    capture.sourceNode = sourceNode;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.25;
    capture.analyser = analyser;

    const gainNode = context.createGain();
    gainNode.gain.value = capture.name === 'you' ? Math.max(gain, 1.25) : gain;
    sourceNode.connect(gainNode);
    gainNode.connect(analyser);

    const processor = context.createScriptProcessor(2048, 1, 1);
    capture.processor = processor;
    gainNode.connect(processor);
    const mute = context.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(context.destination);
    // Also pull analyser so meters move even if processor is delayed.
    analyser.connect(mute);

    processor.onaudioprocess = (event) => {
      if (!this.running) {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      event.outputBuffer.getChannelData(0).fill(0);
      this.ingestPcm(capture, input, event.inputBuffer.sampleRate);
    };
  }

  private teardownSource(capture: SourceCapture): void {
    capture.processor?.disconnect();
    capture.analyser?.disconnect();
    capture.sourceNode?.disconnect();
    if (capture.processor) {
      capture.processor.onaudioprocess = null;
    }
    capture.processor = null;
    capture.analyser = null;
    capture.sourceNode = null;
    if (capture.monitor) {
      try {
        capture.monitor.pause();
        capture.monitor.srcObject = null;
      } catch {
        // Ignore.
      }
      capture.monitor = null;
    }
    if (capture.context) {
      void capture.context.close();
      capture.context = null;
    }
    if (capture.stream) {
      for (const track of capture.stream.getTracks()) {
        track.stop();
      }
      capture.stream = null;
    }
    capture.samples.length = 0;
    capture.queue.length = 0;
    capture.speaking = false;
    capture.level = 0;
    capture.active = false;
    capture.draining = false;
    capture.peakRms = 0;
    capture.generation += 1;
  }

  private startLevelPump(): void {
    if (this.levelTimer != null) {
      return;
    }
    this.levelTimer = window.setInterval(() => {
      this.sampleLevel(this.mic);
      this.sampleLevel(this.system);
      const now = performance.now();
      const levelChanged =
        Math.abs(this.mic.level - this.lastReportedMic) > 0.04 ||
        Math.abs(this.system.level - this.lastReportedSys) > 0.04 ||
        this.mic.active !== this.lastReportedMicActive ||
        this.system.active !== this.lastReportedSysActive;
      if (levelChanged && now - this.lastLevelReportAt >= LEVEL_REPORT_MIN_MS) {
        this.lastLevelReportAt = now;
        this.lastReportedMic = this.mic.level;
        this.lastReportedSys = this.system.level;
        this.lastReportedMicActive = this.mic.active;
        this.lastReportedSysActive = this.system.active;
        void getApi()?.reportAudioActivity?.({
          micLevel: this.mic.level,
          systemLevel: this.system.level,
          micActive: this.mic.active,
          systemActive: this.system.active,
        });
      }
      if (now - this.lastMicDiag > 2000) {
        this.lastMicDiag = now;
        console.info(
          `[listen] mic “${this.micLabel}” peak=${this.mic.peakRms.toFixed(4)} level=${this.mic.level.toFixed(2)} speaking=${this.mic.speaking} samples=${this.mic.samples.length}`,
        );
        if (this.mic.peakRms >= MIC_LIVE_RMS || this.mic.active) {
          if (this.sessions.session()?.listenError) {
            void getApi()?.reportListenStatus?.({
              status: 'listening',
              error: null,
              modelReady: !!this.sessions.session()?.modelReady,
            });
          }
        } else if (
          !this.silentMicWarned &&
          this.mic.peakRms > 0 &&
          this.mic.peakRms < 0.002
        ) {
          this.silentMicWarned = true;
          // Soft status only — never steal focus into Windows Settings.
          console.warn(
            `[listen] mic “${this.micLabel}” still very quiet — check Windows mic privacy if captions stay empty`,
          );
        }
        this.mic.peakRms = 0;
      }

      void this.drainQueue(this.mic);
      void this.drainQueue(this.system);
    }, LEVEL_PUSH_MS);
  }

  private sampleLevel(capture: SourceCapture): void {
    const analyser = capture.analyser;
    if (!analyser) {
      capture.level = 0;
      capture.active = false;
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i]! - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    capture.level = Math.max(0, Math.min(1, rms * 10));
    capture.active = rms >= SPEECH_RMS;
  }

  private ingestPcm(
    capture: SourceCapture,
    input: Float32Array,
    sampleRate: number,
  ): void {
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < input.length; i += 1) {
      const s = input[i]!;
      sum += s * s;
      peak = Math.max(peak, Math.abs(s));
    }
    const rms = Math.sqrt(sum / input.length);
    capture.peakRms = Math.max(capture.peakRms, rms);

    const boost =
      capture.name === 'you' && peak > 0.002 && peak < 0.07
        ? Math.min(1.5, 0.18 / peak)
        : 1;
    const down = downsampleTo16k(input, sampleRate, boost);
    const now = performance.now();
    const gate = capture.name === 'you' ? SPEECH_RMS * 0.75 : SPEECH_RMS;

    // Cap live buffer so we never pile up 20s of noise behind a slow ASR call.
    const hardCap = Math.floor(TARGET_RATE * (MAX_UTTERANCE_SEC + OVERLAP_SEC + 1));
    if (capture.samples.length > hardCap) {
      capture.samples.splice(0, capture.samples.length - hardCap);
    }

    if (rms >= gate) {
      capture.speaking = true;
      capture.silentSince = 0;
      appendSamples(capture.samples, down);
    } else if (capture.speaking) {
      appendSamples(capture.samples, down);
      if (!capture.silentSince) {
        capture.silentSince = now;
      }
      if (now - capture.silentSince >= SILENCE_FLUSH_MS) {
        this.enqueueUtterance(capture, false);
      }
    }

    const maxSamples = Math.floor(TARGET_RATE * MAX_UTTERANCE_SEC);
    if (capture.samples.length >= maxSamples) {
      this.enqueueUtterance(capture, true);
    }
  }

  private enqueueUtterance(capture: SourceCapture, hitMaxLength: boolean): void {
    const minSamples = Math.floor(TARGET_RATE * MIN_UTTERANCE_SEC);
    if (capture.samples.length < minSamples) {
      capture.samples.length = 0;
      capture.speaking = false;
      capture.silentSince = 0;
      return;
    }

    const overlap = Math.floor(TARGET_RATE * OVERLAP_SEC);
    const chunk = Float32Array.from(capture.samples);
    if (hitMaxLength && chunk.length > overlap * 2) {
      capture.samples.splice(0, capture.samples.length - overlap);
      capture.speaking = true;
      capture.silentSince = 0;
    } else {
      capture.samples.length = 0;
      capture.speaking = false;
      capture.silentSince = 0;
    }

    const ratio = speechRatio(chunk);
    if (ratio < MIN_SPEECH_RATIO) {
      console.info(
        `[listen] skip ${capture.name} — low speech ratio (${ratio.toFixed(2)})`,
      );
      return;
    }
    let peak = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      peak = Math.max(peak, Math.abs(chunk[i]!));
    }
    if (peak < SPEECH_RMS) {
      console.info(`[listen] skip ${capture.name} — peak too low (${peak.toFixed(4)})`);
      return;
    }

    capture.queue.push(chunk);
    while (capture.queue.length > MAX_QUEUED_UTTERANCES) {
      capture.queue.shift();
    }
    // Show a live placeholder immediately so Insights doesn't wait for ASR.
    void getApi()?.upsertTranscript?.({
      id: interimId(capture.name),
      speaker: capture.name === 'you' ? 'You' : 'System audio',
      text: '…',
      provisional: true,
    });
    void this.drainQueue(capture);
  }

  private async drainQueue(capture: SourceCapture): Promise<void> {
    if (capture.draining) {
      return;
    }
    // Prefer finishing mic captions before system-audio backlog.
    if (capture.name === 'system' && (this.mic.draining || this.mic.queue.length)) {
      return;
    }
    capture.draining = true;
    const generation = capture.generation;
    const speaker = capture.name === 'you' ? 'You' : 'System audio';
    const api = getApi();
    const interim = interimId(capture.name);
    try {
      while (capture.queue.length && generation === capture.generation) {
        const chunk = capture.queue.shift();
        if (!chunk) {
          continue;
        }
        const pcm = padPcm(chunk, TARGET_RATE, PAD_UTTERANCE_SEC);
        console.info(
          `[listen] flush ${capture.name} samples=${chunk.length} (~${(chunk.length / TARGET_RATE).toFixed(2)}s)`,
        );
        try {
          const raw = await api?.transcribePcm?.({
            source: capture.name,
            sampleRate: TARGET_RATE,
            pcm: Array.from(pcm),
          });
          if (generation !== capture.generation) {
            return;
          }
          const results = normalizeTranscriptResults(raw);
          if (!results.length) {
            console.info(`[listen] ${capture.name} empty/non-speech`);
            continue;
          }
          for (const item of results) {
            const cleaned = cleanupCaption(item.text);
            if (!cleaned) {
              console.info(
                `[listen] ${capture.name}/${item.backend} empty/non-speech: ${item.text || '(blank)'}`,
              );
              continue;
            }
            const label =
              results.length > 1
                ? `${speaker} · ${item.backend}${item.language ? ` · ${item.language}` : ''}`
                : speaker;
            await api?.appendTranscript?.({
              speaker: label,
              text: cleaned,
              language: item.language,
              backend: item.backend,
              latencyMs: item.latencyMs,
            });
          }
          if (capture.name === 'you') {
            this.silentMicWarned = true;
            await api?.reportListenStatus?.({
              status: 'listening',
              error: null,
              modelReady: !!this.sessions.session()?.modelReady,
            });
          }
        } catch (err) {
          await api?.reportListenStatus?.({
            status: 'listening',
            error: `Transcription error: ${String(err)}`,
            modelReady: false,
          });
        }
      }
    } finally {
      // Clear the live placeholder once the queue is drained.
      if (!capture.queue.length) {
        void api?.upsertTranscript?.({
          id: interim,
          speaker,
          text: '',
          provisional: true,
        });
      }
      if (generation === capture.generation) {
        capture.draining = false;
      }
    }
  }
}

function interimId(source: SourceName): string {
  return source === 'you' ? 'you-interim-live' : 'system-interim-live';
}

function scoreMicLabel(label: string): number {
  const l = label.toLowerCase();
  if (!l) {
    return 0;
  }
  let score = 0;
  if (/headset|headphone|earbud|airpods|bluetooth/.test(l)) {
    score += 50;
  }
  if (/usb|external|webcam/.test(l)) {
    score += 30;
  }
  if (/default/.test(l)) {
    score += 20;
  }
  if (/communications/.test(l)) {
    score -= 5;
  }
  if (/array|realtek|stereo mix/.test(l)) {
    score -= 15;
  }
  return score;
}

async function measureStreamPeak(stream: MediaStream, ms: number): Promise<number> {
  const context = createAudioContext();
  const mute = context.createGain();
  mute.gain.value = 0;
  try {
    if (context.state === 'suspended') {
      await context.resume();
    }
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    // Must reach destination or Chromium may not pull mic buffers.
    analyser.connect(mute);
    mute.connect(context.destination);

    const monitor = new Audio();
    monitor.srcObject = stream;
    monitor.muted = true;
    monitor.volume = 0;
    try {
      await monitor.play();
    } catch {
      // Ignore autoplay failures; graph pull may still work.
    }

    const data = new Float32Array(analyser.fftSize);
    let peak = 0;
    const started = performance.now();
    while (performance.now() - started < ms) {
      analyser.getFloatTimeDomainData(data);
      for (let i = 0; i < data.length; i += 1) {
        peak = Math.max(peak, Math.abs(data[i]!));
      }
      await sleep(40);
    }
    source.disconnect();
    analyser.disconnect();
    mute.disconnect();
    monitor.pause();
    monitor.srcObject = null;
    return peak;
  } finally {
    await context.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function appendSamples(target: number[], next: Float32Array): void {
  for (let i = 0; i < next.length; i += 1) {
    target.push(next[i]!);
  }
}

function padPcm(pcm: Float32Array, sampleRate: number, minSec: number): Float32Array {
  const minSamples = Math.floor(sampleRate * minSec);
  if (pcm.length >= minSamples) {
    return pcm;
  }
  const out = new Float32Array(minSamples);
  out.set(pcm, 0);
  return out;
}

function speechRatio(pcm: Float32Array): number {
  const frame = 512;
  if (pcm.length < frame) {
    return 0;
  }
  let speech = 0;
  let total = 0;
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let sum = 0;
    for (let j = 0; j < frame; j += 1) {
      const s = pcm[i + j]!;
      sum += s * s;
    }
    total += 1;
    if (Math.sqrt(sum / frame) >= SPEECH_RMS) {
      speech += 1;
    }
  }
  return total ? speech / total : 0;
}

function normalizeTranscriptResults(
  raw: unknown,
): Array<{
  text: string;
  language: string | null;
  latencyMs: number;
  backend: 'qwen' | 'whisper';
}> {
  if (!raw) {
    return [];
  }
  if (typeof raw === 'string') {
    return raw.trim()
      ? [{ text: raw, language: null, latencyMs: 0, backend: 'whisper' }]
      : [];
  }
  if (typeof raw !== 'object') {
    return [];
  }
  const result = raw as {
    text?: string;
    language?: string | null;
    latencyMs?: number;
    backend?: 'qwen' | 'whisper';
    compare?: Array<{
      text?: string;
      language?: string | null;
      latencyMs?: number;
      backend?: 'qwen' | 'whisper';
    }>;
  };
  if (Array.isArray(result.compare) && result.compare.length) {
    return result.compare.map((item) => ({
      text: String(item.text || ''),
      language: item.language ? String(item.language) : null,
      latencyMs: Number(item.latencyMs) || 0,
      backend: item.backend === 'qwen' ? 'qwen' : 'whisper',
    }));
  }
  return [
    {
      text: String(result.text || ''),
      language: result.language ? String(result.language) : null,
      latencyMs: Number(result.latencyMs) || 0,
      backend: result.backend === 'qwen' ? 'qwen' : 'whisper',
    },
  ];
}

function createAudioContext(sampleRate?: number): AudioContext {
  if (typeof sampleRate === 'number' && sampleRate > 0) {
    try {
      return new AudioContext({ sampleRate });
    } catch (err) {
      console.warn(
        `[listen] AudioContext sampleRate=${sampleRate} unsupported, using default`,
        err,
      );
    }
  }
  return new AudioContext();
}

function formatListenError(err: unknown): string {
  const raw = String(err ?? 'Listen failed');
  if (/NotSupportedError/i.test(raw) || /Not supported/i.test(raw)) {
    return 'Audio capture not supported with the current device rate. Stop/Listen again — the app will retry with the default rate.';
  }
  return raw;
}

function cleanupCaption(text: string): string {
  let t = text
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(uh|um|erm|inaudible|music|blank_audio|gibberish)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();
  if (!t || t.length < 2) {
    return '';
  }
  // Keep Arabic/French/etc. — only reject strings with no letters or digits at all.
  if (!/\p{L}|\p{N}/u.test(t)) {
    return '';
  }
  if (isWhisperHallucination(t)) {
    return '';
  }
  return t;
}

/** Classic Whisper garbage on silence / noise. */
function isWhisperHallucination(text: string): boolean {
  const t = text.trim();
  if (
    /^(thanks for watching!?|thank you for watching!?|thanks for listening!?|please subscribe|subtitles by.*|amara\.org|www\.|http)/i.test(
      t,
    )
  ) {
    return true;
  }
  // Long runs of the same short token: "Ah, ah, ah…" / "CCCCCCCC"
  const compact = t.replace(/[\s,.!?…]+/g, '');
  if (compact.length >= 8 && /^(.)\1+$/u.test(compact)) {
    return true;
  }
  const tokens = t.split(/[\s,./!?…]+/).filter(Boolean);
  if (tokens.length >= 6) {
    const first = tokens[0]!.toLowerCase();
    if (tokens.every((tok) => tok.toLowerCase() === first) && first.length <= 6) {
      return true;
    }
  }
  return false;
}

function downsampleTo16k(
  input: Float32Array,
  sampleRate: number,
  gain = 1,
): Float32Array {
  const ratio = sampleRate / TARGET_RATE;
  const outLength =
    Math.abs(sampleRate - TARGET_RATE) < 1
      ? input.length
      : Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  if (Math.abs(sampleRate - TARGET_RATE) < 1) {
    for (let i = 0; i < outLength; i += 1) {
      out[i] = clampSample(input[i]! * gain);
    }
    return out;
  }
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    const count = Math.max(1, end - start);
    for (let j = start; j < end; j += 1) {
      sum += input[j]!;
    }
    out[i] = clampSample((sum / count) * gain);
  }
  return out;
}

function clampSample(value: number): number {
  if (value > 1) {
    return 1;
  }
  if (value < -1) {
    return -1;
  }
  return value;
}

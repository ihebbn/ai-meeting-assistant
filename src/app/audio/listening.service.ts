import { Injectable, OnDestroy, effect, inject } from '@angular/core';
import { getApi } from '../electron-api';
import { SessionService } from '../session.service';
import { ListenDiagnostics } from './listen-diagnostics';
import {
  FairQueue,
  MIC_LIVE_PEAK,
  MIN_SPEECH_SEC,
  SILENCE_RMS,
  TARGET_RATE,
  MAX_MERGED_SEC,
  MAX_QUEUED_UTTERANCES,
  UtteranceAssembler,
  applyMakeup,
  cleanupCaption,
  downsampleTo16k,
  dropRepeatedPrefix,
  keepSearchingMics,
  mixChannels,
  padPcm,
  pushQueued,
  speechDurationSec,
  type AssembledUtterance,
  type SourceName,
} from './listen-pipeline';

const LEVEL_PUSH_MS = 160;
const LEVEL_REPORT_MIN_MS = 180;
const SPEECH_RMS = 0.004;
const PROCESSOR_BUFFER = 2048;

type QueuedUtterance = {
  id: string;
  pcm: Float32Array;
  startedAt: number;
  endedAt: number;
};

class SourceCapture {
  stream: MediaStream | null = null;
  context: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  sourceNode: MediaStreamAudioSourceNode | null = null;
  processor: ScriptProcessorNode | null = null;
  monitor: HTMLAudioElement | null = null;
  readonly assembler = new UtteranceAssembler();
  readonly queue: QueuedUtterance[] = [];
  level = 0;
  active = false;
  generation = 0;
  rawPeak = 0;
  callbacks = 0;
  maxGapMs = 0;
  overruns = 0;
  droppedChunks = 0;
  callbackErrors = 0;
  lastCallbackAt = 0;
  observedRate = 0;
  observedChannels = 0;
  attachedAt = 0;
  interimShown = false;
  lastModelText = '';

  constructor(readonly name: SourceName) {}
}

@Injectable({ providedIn: 'root' })
export class ListeningService implements OnDestroy {
  private readonly sessions = inject(SessionService);
  private readonly diag = inject(ListenDiagnostics);
  private readonly mic = new SourceCapture('you');
  private readonly system = new SourceCapture('system');
  private readonly fair = new FairQueue<QueuedUtterance>();
  private running = false;
  private starting = false;
  private pumping = false;
  /** Bumped on every stop/start so abandoned startups cannot steal the session. */
  private listenGeneration = 0;
  private segmentSeq = 0;
  private levelTimer: number | null = null;
  private destroyed = false;
  private lastListening: boolean | null = null;
  private pumpEpoch = 0;
  private lastMicDiag = 0;
  private lastLevelReportAt = 0;
  private lastReportedMic = -1;
  private lastReportedSys = -1;
  private lastReportedMicActive = false;
  private lastReportedSysActive = false;
  private micLabel = '';
  private silentMicWarned = false;
  private dropWarned = false;
  private bridgeWarned = false;
  private useSoniox = false;
  private readonly sonioxCarry: Record<SourceName, Float32Array> = {
    you: new Float32Array(0),
    system: new Float32Array(0),
  };
  private readonly recovering: Record<SourceName, boolean> = { you: false, system: false };

  constructor() {
    effect(() => {
      const listening = this.sessions.session()?.listening ?? false;
      if (this.destroyed || listening === this.lastListening) {
        return;
      }
      this.lastListening = listening;
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
    this.dropWarned = false;
    this.bridgeWarned = false;
    const api = getApi();
    this.useSoniox = this.sessions.session()?.asrBackend === 'soniox';
    try {
      await api?.reportListenStatus?.({
        status: 'starting',
        error: this.useSoniox ? 'Connecting to Soniox…' : 'Loading speech model…',
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
      let systemStream: MediaStream | null = null;
      let captureWarning: string | null = null;
      try {
        systemStream = await this.openSystemLoopback();
      } catch (err) {
        if (!this.useSoniox) {
          throw err;
        }
        captureWarning = formatListenError(err);
      }
      if (systemStream) {
        if (generation !== this.listenGeneration) {
          stopTracks(systemStream);
          return;
        }
        await this.attachStream(this.system, systemStream);
        if (generation !== this.listenGeneration) {
          this.teardownSource(this.system);
          return;
        }
      }

      const mic = await this.openLiveMicrophone();
      if (generation !== this.listenGeneration) {
        stopTracks(mic.stream);
        this.teardownSource(this.system);
        return;
      }
      this.micLabel = mic.label;
      await this.attachStream(this.mic, mic.stream);
      if (generation !== this.listenGeneration) {
        this.teardownSource(this.mic);
        this.teardownSource(this.system);
        return;
      }

      let sonioxWarning: string | null = null;
      if (this.useSoniox) {
        if (!api?.sonioxStart) {
          throw new Error('Soniox bridge is unavailable. Restart Meeting Copilot and try again.');
        }
        const sources: Array<'you' | 'system'> = ['you'];
        if (this.system.stream) {
          sources.push('system');
        }
        const started = await api.sonioxStart(sources);
        if (generation !== this.listenGeneration) {
          await api.sonioxStop?.();
          this.teardownSource(this.mic);
          this.teardownSource(this.system);
          return;
        }
        if (!started?.ok) {
          throw new Error(started?.error || 'Soniox did not connect.');
        }
        sonioxWarning = [captureWarning, started.error].filter(Boolean).join(' ') || null;
      }

      this.running = true;
      this.startLevelPump();
      void api?.ensureTranscriber?.().then((ok) => {
        if (generation !== this.listenGeneration) {
          return;
        }
        void api.reportListenStatus?.({
          status: 'listening',
          error: this.useSoniox ? sonioxWarning : (ok?.error ?? null),
          modelReady: !!ok?.ready,
        });
      });

      await api?.reportListenStatus?.({
        status: 'listening',
        error: sonioxWarning,
        modelReady: !!model?.ready,
      });
      if (!mic.live) {
        this.diag.noteDev('mic-probe quiet; continuing with the loudest opened device');
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

  private async openSystemLoopback(): Promise<MediaStream> {
    const api = getApi();
    if (!api?.enableLoopbackAudio || !api?.disableLoopbackAudio) {
      throw new Error('System audio loopback bridge is unavailable.');
    }
    await api.enableLoopbackAudio();
    let systemStream: MediaStream;
    try {
      systemStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } finally {
      await api.disableLoopbackAudio();
    }
    for (const track of systemStream.getVideoTracks()) {
      track.stop();
      systemStream.removeTrack(track);
    }
    const audioTracks = systemStream.getAudioTracks();
    if (audioTracks.length === 0) {
      stopTracks(systemStream);
      throw new Error('System audio track missing — loopback did not start.');
    }
    const settings = audioTracks[0]?.getSettings?.() ?? {};
    console.info(
      `[listen] system audio tracks=${audioTracks.length} muted=${audioTracks[0]?.muted ? 1 : 0} rate=${settings.sampleRate ?? '?'} ch=${settings.channelCount ?? '?'}`,
    );
    return systemStream;
  }

  private async openLiveMicrophone(): Promise<{
    stream: MediaStream;
    label: string;
    live: boolean;
  }> {
    const permission = await navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((status) => status.state)
      .catch(() => 'unknown');
    this.diag.noteDev(`mic-permission state=${permission}`);
    if (permission === 'denied') {
      throw new Error(
        'Microphone permission is blocked. Allow mic access for this app, then press Listen again.',
      );
    }

    // Open the default device before enumerating so labels exist after the prompt.
    const first = await this.probeMic(null, 220);
    if (!first) {
      throw new Error('Could not open any microphone device.');
    }
    let best = first;
    if (!keepSearchingMics(best.peak)) {
      this.logMicChoice(best.label, best.peak, false);
      return { stream: best.stream, label: best.label, live: true };
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
    const ranked = [...inputs].sort((a, b) => scoreMicLabel(b.label) - scoreMicLabel(a.label));
    const currentId = best.stream.getAudioTracks()[0]?.getSettings?.().deviceId;
    for (const device of ranked.slice(0, 3)) {
      if (currentId && device.deviceId === currentId) {
        continue;
      }
      const attempt = await this.probeMic(device, 360);
      if (!attempt) {
        continue;
      }
      if (attempt.peak > best.peak) {
        stopTracks(best.stream);
        best = attempt;
      } else {
        stopTracks(attempt.stream);
      }
      if (!keepSearchingMics(best.peak)) {
        break;
      }
    }

    const live = best.peak >= MIC_LIVE_PEAK;
    this.logMicChoice(best.label, best.peak, !live);
    return { stream: best.stream, label: best.label, live };
  }

  private logMicChoice(label: string, peak: number, fallback: boolean): void {
    console.info(
      `[listen] using mic “${label}” peak=${peak.toFixed(4)} fallback=${fallback ? 1 : 0}`,
    );
  }

  private async probeMic(
    device: MediaDeviceInfo | null,
    ms: number,
  ): Promise<{ stream: MediaStream; label: string; peak: number } | null> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: device ? { exact: device.deviceId } : undefined,
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: false },
          channelCount: { ideal: 1 },
        },
        video: false,
      });
    } catch (err) {
      console.warn('[listen] mic open failed', device?.label || 'default', err);
      return null;
    }
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') {
      stopTracks(stream);
      return null;
    }
    track.enabled = true;
    const label = device?.label || track.label || 'Default microphone';
    const peak = await measureStreamPeak(stream, ms);
    const settings = track.getSettings?.() ?? {};
    console.info(
      `[listen] mic probe “${label}” peak=${peak.toFixed(4)} muted=${track.muted ? 1 : 0} agc=${String(settings.autoGainControl)} ns=${String(settings.noiseSuppression)} ec=${String(settings.echoCancellation)} rate=${settings.sampleRate ?? '?'} ch=${settings.channelCount ?? '?'}`,
    );
    return { stream, label, peak };
  }

  private async stop(reason: string): Promise<void> {
    this.listenGeneration += 1;
    this.pumpEpoch += 1;
    this.running = false;
    this.starting = false;
    this.pumping = false;
    this.fair.reset();
    if (this.useSoniox) {
      this.flushSonioxTail('you');
      this.flushSonioxTail('system');
      await getApi()?.sonioxStop?.();
      this.useSoniox = false;
    }
    if (this.levelTimer != null) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    this.teardownSource(this.mic);
    this.teardownSource(this.system);
    this.clearInterim(this.mic, true);
    this.clearInterim(this.system, true);
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

  private async attachStream(capture: SourceCapture, stream: MediaStream): Promise<void> {
    capture.stream = stream;
    capture.attachedAt = performance.now();
    for (const track of stream.getAudioTracks()) {
      track.enabled = true;
      track.onended = () => {
        if (!this.running) {
          return;
        }
        void this.recoverSource(capture);
      };
      track.onmute = () => {
        window.setTimeout(() => {
          if (!this.running || capture.assembler.isSpeaking || capture.level > 0.05) {
            return;
          }
          const who =
            capture.name === 'you'
              ? `Microphone muted (“${this.micLabel || track.label}”).`
              : 'System audio track is muted.';
          void getApi()?.reportListenStatus?.({
            status: 'listening',
            error: who,
            modelReady: !!this.sessions.session()?.modelReady,
          });
        }, 1500);
      };
      track.onunmute = () => {
        const err = this.sessions.session()?.listenError || '';
        if (this.running && /muted/i.test(err)) {
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
    const context = createAudioContext(
      typeof trackRate === 'number' && trackRate > 0 ? trackRate : undefined,
    );
    capture.context = context;
    context.onstatechange = () => {
      if (!this.running || context.state !== 'suspended') {
        return;
      }
      this.diag.noteDev(`context-suspended source=${capture.name}`);
      void context.resume().catch(() => undefined);
    };
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
    gainNode.gain.value = 1;
    sourceNode.connect(gainNode);
    gainNode.connect(analyser);

    const processor = context.createScriptProcessor(PROCESSOR_BUFFER, 2, 1);
    capture.processor = processor;
    gainNode.connect(processor);
    const mute = context.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(context.destination);
    analyser.connect(mute);

    processor.onaudioprocess = (event) => {
      if (!this.running || capture.processor !== processor) {
        return;
      }
      try {
        this.consumeBuffer(capture, event);
      } catch {
        capture.callbackErrors += 1;
        if (capture.callbackErrors === 1) {
          this.diag.noteLifecycle(capture.name, 'callback-error');
        }
      }
    };
  }

  private pushSoniox(source: SourceName, samples: Float32Array): void {
    if (!samples.length || !getApi()?.sonioxAudio) {
      return;
    }
    const prev = this.sonioxCarry[source];
    const merged = new Float32Array(prev.length + samples.length);
    merged.set(prev, 0);
    merged.set(samples, prev.length);
    const frame = 1280;
    let offset = 0;
    while (merged.length - offset >= frame) {
      getApi()?.sonioxAudio?.({
        source,
        pcm: Float32Array.from(merged.subarray(offset, offset + frame)),
      });
      offset += frame;
    }
    this.sonioxCarry[source] =
      offset === 0 ? merged : Float32Array.from(merged.subarray(offset));
  }

  private flushSonioxTail(source: SourceName): void {
    const tail = this.sonioxCarry[source];
    this.sonioxCarry[source] = new Float32Array(0);
    if (tail.length >= 160) {
      getApi()?.sonioxAudio?.({ source, pcm: tail });
    }
  }

  private consumeBuffer(capture: SourceCapture, event: AudioProcessingEvent): void {
    const now = performance.now();
    const rate = event.inputBuffer.sampleRate;
    if (capture.lastCallbackAt > 0 && rate > 0) {
      const gap = now - capture.lastCallbackAt;
      capture.maxGapMs = Math.max(capture.maxGapMs, gap);
      const expected = (event.inputBuffer.length / rate) * 1000;
      if (gap > expected * 2.5) {
        capture.overruns += 1;
      }
    }
    capture.lastCallbackAt = now;
    capture.callbacks += 1;
    capture.observedRate = rate;
    capture.observedChannels = event.inputBuffer.numberOfChannels;
    event.outputBuffer.getChannelData(0).fill(0);

    const channels: Float32Array[] = [];
    for (let index = 0; index < event.inputBuffer.numberOfChannels; index += 1) {
      channels.push(event.inputBuffer.getChannelData(index));
    }
    const mixed = mixChannels(channels);
    let peak = 0;
    for (let i = 0; i < mixed.length; i += 1) {
      peak = Math.max(peak, Math.abs(mixed[i]!));
    }
    capture.rawPeak = Math.max(capture.rawPeak, peak);
    if (!rate || rate < 1000) {
      return;
    }
    const gained = applyMakeup(mixed, capture.name);
    const down = downsampleTo16k(gained, rate);
    if (this.useSoniox) {
      this.pushSoniox(capture.name, down);
      return;
    }
    const wasSpeaking = capture.assembler.isSpeaking;
    const uttered = capture.assembler.push(down, now);
    if (!wasSpeaking && capture.assembler.isSpeaking) {
      this.showInterim(capture, true);
    }
    if (uttered) {
      this.enqueueUtterance(capture, uttered);
    }
  }

  private async recoverSource(capture: SourceCapture): Promise<void> {
    if (!this.running || this.recovering[capture.name]) {
      return;
    }
    const age = performance.now() - capture.attachedAt;
    if (age < 800) {
      this.diag.noteLifecycle(capture.name, 'track-ended-immediate');
      await getApi()?.reportListenStatus?.({
        status: 'error',
        error: `${capture.name === 'you' ? 'Microphone' : 'System audio'} stopped as soon as it started. Press Listen again.`,
        modelReady: !!this.sessions.session()?.modelReady,
      });
      return;
    }
    this.recovering[capture.name] = true;
    this.diag.noteLifecycle(capture.name, 'track-ended-reopen');
    const generation = this.listenGeneration;
    try {
      this.teardownSource(capture);
      if (!this.running || generation !== this.listenGeneration) {
        return;
      }
      if (capture.name === 'you') {
        const mic = await this.openLiveMicrophone();
        if (!this.running || generation !== this.listenGeneration) {
          stopTracks(mic.stream);
          return;
        }
        this.micLabel = mic.label;
        await this.attachStream(this.mic, mic.stream);
      } else {
        const stream = await this.openSystemLoopback();
        if (!this.running || generation !== this.listenGeneration) {
          stopTracks(stream);
          return;
        }
        await this.attachStream(this.system, stream);
      }
    } catch (err) {
      this.diag.noteLifecycle(capture.name, 'reopen-failed');
      await getApi()?.reportListenStatus?.({
        status: 'error',
        error: formatListenError(err),
        modelReady: false,
      });
    } finally {
      this.recovering[capture.name] = false;
    }
  }

  private teardownSource(capture: SourceCapture): void {
    capture.generation += 1;
    capture.processor?.disconnect();
    capture.analyser?.disconnect();
    capture.sourceNode?.disconnect();
    if (capture.processor) {
      capture.processor.onaudioprocess = null;
    }
    capture.processor = null;
    capture.analyser = null;
    capture.sourceNode = null;
    if (capture.context) {
      capture.context.onstatechange = null;
    }
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
        track.onended = null;
        track.stop();
      }
      capture.stream = null;
    }
    capture.queue.length = 0;
    capture.assembler.reset();
    capture.level = 0;
    capture.active = false;
    capture.rawPeak = 0;
    capture.lastModelText = '';
    capture.interimShown = false;
    capture.lastCallbackAt = 0;
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
        this.flushCaptureDiag(this.mic);
        this.flushCaptureDiag(this.system);
        const listenError = this.sessions.session()?.listenError || '';
        if (
          (this.mic.rawPeak >= MIC_LIVE_PEAK || this.mic.active) &&
          /muted|quiet|silent/i.test(listenError)
        ) {
          void getApi()?.reportListenStatus?.({
            status: 'listening',
            error: null,
            modelReady: !!this.sessions.session()?.modelReady,
          });
        } else if (!this.silentMicWarned && this.mic.rawPeak > 0 && this.mic.rawPeak < 0.002) {
          this.silentMicWarned = true;
          console.warn(
            `[listen] mic “${this.micLabel}” still very quiet — check Windows mic privacy if captions stay empty`,
          );
        }
        this.mic.rawPeak = 0;
        this.system.rawPeak = 0;
        this.mic.callbacks = 0;
        this.system.callbacks = 0;
        this.mic.maxGapMs = 0;
        this.system.maxGapMs = 0;
        this.mic.overruns = 0;
        this.system.overruns = 0;
      }
      void this.pumpQueues();
    }, LEVEL_PUSH_MS);
  }

  private flushCaptureDiag(capture: SourceCapture): void {
    this.diag.noteCapture(capture.name, {
      callbacks: capture.callbacks,
      maxGapMs: Math.round(capture.maxGapMs),
      overruns: capture.overruns,
      rawPeak: capture.rawPeak,
      speaking: capture.assembler.isSpeaking,
      queue: capture.queue.length,
      dropped: capture.droppedChunks,
      sampleRate: Math.round(capture.observedRate),
      channels: capture.observedChannels,
    });
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
    capture.active = capture.assembler.isSpeaking || rms >= SPEECH_RMS;
  }

  private enqueueUtterance(capture: SourceCapture, uttered: AssembledUtterance): void {
    const voiced = speechDurationSec(uttered.pcm);
    if (voiced < MIN_SPEECH_SEC) {
      this.diag.noteDev(`skip source=${capture.name} reason=short-speech voicedMs=${Math.round(voiced * 1000)}`);
      return;
    }
    let peak = 0;
    for (let i = 0; i < uttered.pcm.length; i += 1) {
      peak = Math.max(peak, Math.abs(uttered.pcm[i]!));
    }
    if (peak < SILENCE_RMS) {
      this.diag.noteDev(`skip source=${capture.name} reason=low-peak`);
      return;
    }
    const item: QueuedUtterance = {
      id: `${capture.name}-${this.listenGeneration}-${++this.segmentSeq}`,
      pcm: uttered.pcm,
      startedAt: uttered.startedAt,
      endedAt: uttered.endedAt,
    };
    const dropped = pushQueued(
      capture.queue,
      item,
      MAX_QUEUED_UTTERANCES,
      Math.floor(TARGET_RATE * MAX_MERGED_SEC),
      mergeUtterances,
    );
    if (dropped > 0) {
      capture.droppedChunks += dropped;
      this.diag.noteDrop(capture.name, dropped);
      if (!this.dropWarned) {
        this.dropWarned = true;
        void getApi()?.reportListenStatus?.({
          status: 'listening',
          error: 'Live transcription fell behind and skipped some audio. Captions will continue.',
          modelReady: !!this.sessions.session()?.modelReady,
        });
      }
    }
    void this.pumpQueues();
  }

  private async pumpQueues(): Promise<void> {
    if (this.pumping || !this.running) {
      return;
    }
    this.pumping = true;
    const epoch = ++this.pumpEpoch;
    try {
      while (this.running && epoch === this.pumpEpoch) {
        const next = this.fair.pull(this.mic.queue, this.system.queue);
        if (!next) {
          return;
        }
        const capture = next.source === 'you' ? this.mic : this.system;
        await this.transcribeOne(capture, next.item);
      }
    } finally {
      if (epoch !== this.pumpEpoch) {
        return;
      }
      this.pumping = false;
      this.clearInterim(this.mic, false);
      this.clearInterim(this.system, false);
      if (this.running && (this.mic.queue.length || this.system.queue.length)) {
        void this.pumpQueues();
      }
    }
  }

  private async transcribeOne(capture: SourceCapture, item: QueuedUtterance): Promise<void> {
    const generation = this.listenGeneration;
    const captureGeneration = capture.generation;
    const api = getApi();
    const speaker = capture.name === 'you' ? 'You' : 'System audio';
    if (!api?.transcribePcm) {
      this.diag.noteSendFailure(capture.name, 'bridge-missing');
      if (!this.bridgeWarned) {
        this.bridgeWarned = true;
        await api?.reportListenStatus?.({
          status: 'error',
          error: 'Transcription bridge is unavailable.',
          modelReady: false,
        });
      }
      return;
    }

    const pcm = padPcm(item.pcm, TARGET_RATE, 0.25);
    const sentAt = performance.now();
    const queueDepth = capture.queue.length;
    let raw: unknown;
    try {
      raw = await api.transcribePcm({
        source: capture.name,
        sampleRate: TARGET_RATE,
        pcm,
      });
    } catch (err) {
      this.diag.noteSendFailure(capture.name, 'ipc-error');
      await api.reportListenStatus?.({
        status: 'listening',
        error: `Transcription error: ${String(err)}`,
        modelReady: false,
      });
      return;
    }
    const recvAt = performance.now();
    if (generation !== this.listenGeneration || captureGeneration !== capture.generation) {
      return;
    }

    const results = normalizeTranscriptResults(raw);
    const endpointMs = Math.max(0, Math.round(sentAt - item.endedAt));
    const durMs = Math.round((item.pcm.length / TARGET_RATE) * 1000);
    if (!results.length) {
      this.diag.noteChunk({
        id: item.id,
        source: capture.name,
        speechEndedAt: item.endedAt,
        sentAt,
        recvAt,
        asrMs: 0,
        endpointMs,
        durMs,
        queueDepth,
        empty: true,
      });
      return;
    }

    const previousText = capture.lastModelText;
    let appended = false;
    for (const result of results) {
      const cleaned = cleanupCaption(result.text);
      const novel = dropRepeatedPrefix(previousText, cleaned);
      if (cleaned) {
        capture.lastModelText = cleaned;
      }
      const lineId = results.length > 1 ? `${item.id}-${result.backend}` : item.id;
      this.diag.noteChunk({
        id: lineId,
        source: capture.name,
        speechEndedAt: item.endedAt,
        sentAt,
        recvAt,
        asrMs: result.latencyMs,
        endpointMs,
        durMs,
        queueDepth,
        empty: !novel,
      });
      if (!novel) {
        continue;
      }
      const label =
        results.length > 1
          ? `${speaker} · ${result.backend}${result.language ? ` · ${result.language}` : ''}`
          : speaker;
      await api.appendTranscript?.({
        id: lineId,
        speaker: label,
        text: novel,
        language: result.language,
        backend: result.backend,
        latencyMs: result.latencyMs,
      });
      appended = true;
    }

    if (generation !== this.listenGeneration || captureGeneration !== capture.generation) {
      return;
    }
    if (appended && (capture.assembler.isSpeaking || capture.queue.length)) {
      this.showInterim(capture, false);
    }
    if (appended && capture.name === 'you') {
      this.silentMicWarned = true;
      await api.reportListenStatus?.({
        status: 'listening',
        error: null,
        modelReady: !!this.sessions.session()?.modelReady,
      });
    }
  }

  private showInterim(capture: SourceCapture, fromOnset: boolean): void {
    if (capture.interimShown && fromOnset) {
      return;
    }
    capture.interimShown = true;
    const id = interimId(capture.name);
    if (fromOnset) {
      this.diag.noteOnset(id);
    }
    void getApi()?.upsertTranscript?.({
      id,
      speaker: capture.name === 'you' ? 'You' : 'System audio',
      text: '…',
      provisional: true,
    });
  }

  private clearInterim(capture: SourceCapture, force: boolean): void {
    if (!force && (capture.assembler.isSpeaking || capture.queue.length)) {
      return;
    }
    if (!capture.interimShown && !force) {
      return;
    }
    capture.interimShown = false;
    void getApi()?.upsertTranscript?.({
      id: interimId(capture.name),
      speaker: capture.name === 'you' ? 'You' : 'System audio',
      text: '',
      provisional: true,
    });
  }
}

function interimId(source: SourceName): string {
  return source === 'you' ? 'you-interim-live' : 'system-interim-live';
}

function mergeUtterances(a: QueuedUtterance, b: QueuedUtterance): QueuedUtterance {
  const pcm = new Float32Array(a.pcm.length + b.pcm.length);
  pcm.set(a.pcm, 0);
  pcm.set(b.pcm, a.pcm.length);
  return {
    id: a.id,
    pcm,
    startedAt: a.startedAt,
    endedAt: b.endedAt,
  };
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

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function normalizeTranscriptResults(raw: unknown): Array<{
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

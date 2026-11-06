/**
 * ASR benchmark entry point. Runs inside Electron (headless, no windows) so it uses the
 * exact backends and model cache of the app.
 *
 *   npm run bench -- <manifest.json> [--backend qwen|whisper|both] [--out report.json]
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ensureQwenBackend, transcribeWithQwen } from '../asr/qwen-backend';
import { onQwenSetupProgress } from '../asr/qwen-models';
import { ensureWhisperBackend, transcribeWithWhisper } from '../asr/whisper-backend';
import type { AsrLanguageId } from '../asr/constants';
import { type BenchClip, parseManifest } from './manifest';
import { charErrors, wordErrors } from './metrics';
import { type ClipResult, formatTable, summarize } from './summary';
import { loadAudio16kMono } from './wav';

type BackendId = 'qwen' | 'whisper';

/** The app flushes utterances at 5.5 s; longer clips don't reflect real usage. */
const RECOMMENDED_MAX_CLIP_SEC = 6;

type Options = { manifestPath: string; backends: BackendId[]; outPath: string | null };

function parseArgs(argv: string[]): Options {
  let manifestPath = '';
  let backends: BackendId[] = ['qwen', 'whisper'];
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--backend') {
      const value = argv[(i += 1)];
      if (value === 'qwen' || value === 'whisper') {
        backends = [value];
      } else if (value !== 'both') {
        throw new Error('--backend must be qwen, whisper or both.');
      }
    } else if (arg === '--out') {
      outPath = argv[(i += 1)] ?? null;
      if (!outPath) {
        throw new Error('--out needs a file path.');
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}.`);
    } else if (!manifestPath) {
      manifestPath = arg;
    } else {
      throw new Error(`Unexpected argument ${arg}.`);
    }
  }
  if (!manifestPath) {
    throw new Error('Usage: npm run bench -- <manifest.json> [--backend qwen|whisper|both] [--out report.json]');
  }
  return { manifestPath: path.resolve(manifestPath), backends, outPath };
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function transcribe(
  backend: BackendId,
  pcm: Float32Array,
  language: AsrLanguageId,
): Promise<string> {
  const copy = Float32Array.from(pcm);
  const out =
    backend === 'qwen'
      ? await transcribeWithQwen(copy, 16000, language)
      : await transcribeWithWhisper(copy, 16000, language);
  return out.text;
}

async function run(options: Options): Promise<number> {
  const manifestDir = path.dirname(options.manifestPath);
  const clips: BenchClip[] = parseManifest(
    JSON.parse(fs.readFileSync(options.manifestPath, 'utf8')),
  );

  const audio = new Map<string, ReturnType<typeof loadAudio16kMono>>();
  for (const clip of clips) {
    const decoded = loadAudio16kMono(fs.readFileSync(path.resolve(manifestDir, clip.audio)));
    audio.set(clip.id, decoded);
    if (decoded.durationSec > RECOMMENDED_MAX_CLIP_SEC) {
      log(
        `warning: ${clip.id} is ${decoded.durationSec.toFixed(1)}s; the app decodes utterances of at most ~5.5s, so results may not reflect real use.`,
      );
    }
  }
  log(`Loaded ${clips.length} clip(s); backends: ${options.backends.join(', ')}`);

  let lastPct = -1;
  onQwenSetupProgress((state) => {
    if (state.status === 'downloading' && state.progress != null && state.progress !== lastPct) {
      lastPct = state.progress;
      if (state.progress % 10 === 0) {
        log(`Downloading Qwen3-ASR model… ${state.progress}%`);
      }
    }
  });

  const results: ClipResult[] = [];
  for (const backend of options.backends) {
    log(`\n[${backend}] loading model…`);
    if (backend === 'qwen') {
      await ensureQwenBackend();
    } else {
      await ensureWhisperBackend('auto');
    }
    // Discard one decode so model/JIT warm-up does not skew the first latency.
    const first = clips[0]!;
    await transcribe(backend, audio.get(first.id)!.samples, first.language).catch((err: unknown) => {
      log(`warning: [${backend}] warm-up decode failed: ${String(err)}`);
      return '';
    });

    for (const clip of clips) {
      const decoded = audio.get(clip.id)!;
      const started = performance.now();
      let hypothesis = '';
      let error: string | undefined;
      try {
        hypothesis = await transcribe(backend, decoded.samples, clip.language);
      } catch (err) {
        error = String(err);
      }
      const wallMs = performance.now() - started;
      const result: ClipResult = {
        clipId: clip.id,
        backend,
        language: clip.language,
        tags: clip.tags,
        durationSec: decoded.durationSec,
        wallMs,
        hypothesis,
        wer: wordErrors(clip.reference, hypothesis),
        cer: charErrors(clip.reference, hypothesis),
        ...(error ? { error } : {}),
      };
      results.push(result);
      log(
        `[${backend}] ${clip.id} ${Math.round(wallMs)}ms ${error ? `ERROR ${error}` : `"${hypothesis}"`}`,
      );
    }
  }

  const overall = summarize(results, () => ['all']);
  const byLanguage = summarize(results, (r) => [`lang:${r.language}`]);
  const byTag = summarize(results, (r) => r.tags.map((t) => `tag:${t}`));
  log('\n' + formatTable([...overall, ...byLanguage, ...byTag]));
  log('\nWER/CER are pooled over all reference words/characters. Latency is decode time only (excludes the 420 ms end-of-speech wait). RTF < 1 is faster than real time.');

  const failures = results.filter((r) => r.error).length;
  if (failures > 0) {
    log(`\n${failures} decode(s) failed and are excluded from the rates above.`);
  }

  if (options.outPath) {
    const report = {
      generatedAt: new Date().toISOString(),
      environment: {
        electron: process.versions.electron,
        platform: process.platform,
        arch: process.arch,
      },
      manifest: options.manifestPath,
      summary: { overall, byLanguage, byTag },
      results,
    };
    fs.writeFileSync(path.resolve(options.outPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(`Report written to ${path.resolve(options.outPath)}`);
  }
  return failures > 0 ? 2 : 0;
}

// Same userData folder as the app, so downloaded models are reused.
app.setPath('userData', path.join(app.getPath('appData'), 'meeting-copilot'));

app
  .whenReady()
  .then(() => run(parseArgs(process.argv.slice(2))))
  .then((code) => app.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`bench failed: ${String(err)}\n`);
    app.exit(1);
  });

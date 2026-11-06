# Meeting Copilot — Milestone 1

One movable, resizable frosted-glass overlay for Google Meet and Microsoft Teams, hidden from screen share on Windows (not possible on Linux, see [Platforms](#platforms)). Live dual-source transcription (microphone + system audio) with local ASR. Ask AI answers with the cloud provider and model you choose in Settings, grounded on the live transcript (without a configured provider it tells you how to set one up).

## Unified overlay

- **Toolbar** — dedicated drag grip moves the whole overlay; Listen/Stop, waveform, **You / Sys activity**, timer, Ask AI, **Insights** / **AI** reopen chips, Hide
- **Live Insights** — own collapse control; transcript toggle; live **You** / **System audio** lines; ASR backend + language controls; setup tips + **Suggestions** generated from the live transcript
- **AI Response** — own collapse control; streaming model answer; Copy; follow-up input

### Listen

| Control | Behavior |
| --- | --- |
| Listen | Starts microphone + Windows system-audio loopback; streams speech into the transcript |
| Stop | Releases both audio streams, clears activity meters, and discards in-flight ASR results |
| Hide / collapse | Does **not** stop listening — capture keeps running while the toolbar stays up |

Transcript speakers are labeled **You** (mic) and **System audio** (loopback). Wear headphones so meeting audio is not echoed into the mic.

### Local transcription backends

| Backend | Engine | Notes |
| --- | --- | --- |
| **Qwen3-ASR 0.6B INT8** | `sherpa-onnx` (WASM) in a forked Node worker | Multilingual; intended default after Windows acceptance |
| **Whisper base** | `@xenova/transformers` | Kept for side-by-side testing (`base.en` when language=English, multilingual `base` otherwise) |

**Language** defaults to **Auto**. In Auto mode the language hint is left unset and each speech segment is detected independently. Change language mid-session from Live Insights — no restart. Detected language is shown when the backend exposes it.

**Compare** runs Qwen and Whisper on the same utterance and appends both lines with latency (ms).

Recognition runs off the overlay UI thread (Qwen worker process; Whisper promise queue on the main process). Voice-activity detection flushes finished phrases into Show Transcript.

#### Qwen model setup (one-time, ~1 GB)

On first Listen with the Qwen backend selected, the app downloads:

`sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25`

into `%APPDATA%/meeting-copilot/asr-models/` (Electron `userData`). Progress and errors appear in Live Insights. Manual fallback (on Linux the folder is `~/.config/meeting-copilot/asr-models/`; use the same `curl` and `tar -xjf` commands from a shell):

```powershell
cd $env:APPDATA\meeting-copilot\asr-models
curl.exe -L -o sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2
tar -xjf sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2
```

Required files: `conv_frontend.onnx`, `encoder.int8.onnx`, `decoder.int8.onnx`, `tokenizer/`.

If Qwen init fails before acceptance is marked Pass, Listen falls back to Whisper automatically.

#### Switching backends

In **Live Insights → Show transcript**:

1. **Backend** — Qwen3-ASR or Whisper (takes effect on the next flushed phrase; Listen can stay running)
2. **Language** — Auto / English / French / Arabic
3. **Compare** — checkbox for dual-backend output on each phrase

Whisper first-run may download model weights into `%APPDATA%/meeting-copilot/model-cache/`.

**Default policy:** Qwen is the intended default once the Windows acceptance matrix in [`VERIFICATION.md`](VERIFICATION.md) is marked Pass. Until then, Whisper stays warm if Qwen model files are not ready; select Qwen in Live Insights to download and test.

### Collapse / expand

| State | Layout |
| --- | --- |
| Both open | Equal-width split under the toolbar |
| One open | That panel fills the panel area |
| Both collapsed | Toolbar only (panel size remembered) |

Toolbar **Insights** / **AI** chips reopen either panel. Transcript, AI answer, and listening state are preserved.

### Resize

Bottom-right handle resizes the panel area as a group (min ~420×260). Long content scrolls inside each panel.

### Hide

`Ctrl+\` hides panels and restores them with session state intact. The toolbar stays visible. Listening continues until you press Stop.

Capture exclusion: `setContentProtection(true)` on the overlay and diagnostics windows (can be disabled for design screenshots).

## Run

```powershell
npm install
npm start
```

Dev: `npm run dev` · Package: `npm run package:win`

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Hide / restore panels | `Ctrl+\` |
| Ask AI | `Ctrl+Enter` |
| Follow-up submit | `Enter` |

## Remote verification

From a second participant in Meet/Teams, confirm the overlay stays invisible while you **drag**, **resize**, **collapse**, and **reopen** panels. Record dual-audio + multilingual ASR results in [`VERIFICATION.md`](VERIFICATION.md) before wiring Ask AI to the live transcript.

## Benchmarking ASR (Qwen vs Whisper)

`npm run bench` decodes your own short clips with the same backends and model cache as the app, then reports pooled **WER** and **CER**, decode latency (p50 / p95) and real-time factor, per backend, language and tag.

```bash
npm run bench -- bench/manifest.example.json --backend both --out bench-report.json
```

- **Clips:** record 16-bit PCM or float32 WAV files yourself (any sample rate or channel count; they are mixed to mono and resampled to 16 kHz). Keep them utterance-sized, about 2–6 s, because the app decodes at most ~5.5 s at a time. Use only your own voice or content you may use. Put them in `bench-data/` (git-ignored).
- **Manifest:** `{ "clips": [{ "id", "audio", "reference", "language"?, "tags"? }] }`. `audio` is relative to the manifest file; `language` is `auto`, `en`, `fr` or `ar`. See [`bench/manifest.example.json`](bench/manifest.example.json).
- **Scoring:** reference and output are normalised the same way (case, punctuation, Arabic diacritics and alef variants) before comparison. WER can exceed 100% when the model inserts many words. Failed decodes are excluded from the rates and counted in the `fail` column; the process exits with code 2 if any failed.
- **Latency:** decode time only. It excludes the 420 ms end-of-speech wait and the IPC hop, so on-screen latency in the app is higher.
- **Models:** the first Qwen run downloads about 1 GB into the app's `asr-models` folder, the same one the app uses.

## Ask AI

Ask AI streams an answer from a cloud model you choose into the AI Response panel, using the recent transcript (about 12,000 characters, newest kept) as context. No local models.

### Providers

| Provider | Protocol | Status |
| --- | --- | --- |
| Anthropic (Claude) | Official Anthropic SDK | Checked against the real SDK with a mock server; no live key tested |
| OpenAI | Chat Completions over HTTP | Request sent is `model`, `messages`, `stream` only. Whether the newest OpenAI models accept it is **unverified** |
| Mistral, Groq, OpenRouter, DeepSeek, Together AI | OpenAI-compatible Chat Completions | Endpoints and SSE format taken from each provider's docs; no live key tested. Together documents no `[DONE]` marker, so the stream closing ends the answer |
| Google (Gemini) | Native `streamGenerateContent` | **Experimental**: stream chunk shape, error body and header auth could not be confirmed without a key |
| xAI (Grok) | OpenAI-compatible | **Experimental**: the docs read only describe the Responses API |
| Custom | OpenAI-compatible | You supply the base URL (https only; plain http is allowed for localhost) |

Provider facts were read from official docs on 2026-11-06. Recheck them before relying on a provider; the catalogue is `electron/ai/registry.ts`.

### Setup

- Open **⋮ → Settings → Ask AI**, pick a provider, paste its API key and press *Save key*. The key is encrypted with the OS secure store (Electron `safeStorage`, DPAPI on Windows), kept **per provider**, and never shown again or sent to the UI. If secure storage is unavailable the key is not saved; set the provider's environment variable instead (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `TOGETHER_API_KEY`, `XAI_API_KEY`, `GOOGLE_API_KEY` or `GEMINI_API_KEY`). A stored key wins over the environment.
- **Model:** the field accepts any model id; the suggestions come from the provider's own models endpoint, so they never go stale. Anthropic defaults to `claude-opus-5-5`; other providers have no default and you must pick one. The choice is remembered per provider in `settings.json` (`aiModels`).
- **Reasoning effort** (`aiEffort`) is shown only for Anthropic, and only sent to models that report effort support. Other providers use their defaults, and no token limit is sent to them.

### Suggestions

With **Hide transcript** on, Live Insights shows a **Suggestions** list. Press **Suggest** and the selected provider proposes up to four short things worth asking right now (define a term just mentioned, summarise the last minutes, draft a reply, a follow-up question), grounded on the last ~4,000 characters of transcript, at low effort. Pressing a suggestion asks it like any question.

- Suggestions are **only generated when you press Suggest**, unless you turn on **Auto suggestions** in Settings. Auto mode is off by default because it sends the transcript to your provider on its own; when on, it refreshes at most every 45 seconds and only after 3 new transcript lines.
- With no provider configured, or fewer than two transcript lines, nothing is sent and the panel says what is missing.
- Suggestions are model output: they can be wrong or miss things. The model is told to ground each one in what was said and to output nothing when there is too little content, but that is not enforced.

### Safety, privacy and cost

- **Your data goes to the selected provider:** each question, each Suggest press, and (if enabled) each automatic refresh sends the recent transcript to that provider and is billed to your key. A lower-cost model reduces cost and latency.
- **Prompt injection:** the transcript is passed as untrusted data inside `<transcript>` tags and the system prompt tells the model never to follow instructions found in it, because anyone on the call can speak them. Tag-like text is neutralised. This reduces, but does not eliminate, the risk.
- **Refusals and limits:** a declined request or an answer cut at the output limit is shown with a note. Anthropic server-side refusal fallbacks are **not** enabled.
- **Cancel:** a new question, closing the AI panel, or quitting cancels the request in flight.

## Platforms

Windows and Linux are both supported targets for development and use. macOS is untested.

| Capability | Windows | Linux |
| --- | --- | --- |
| Run (`npm run dev` / `npm start`) | Yes | Yes (checked on GNOME, Wayland, Electron 35) |
| Hide overlay from screen share | Yes (`setContentProtection`) | **No.** Electron does nothing here; the toolbar shows a non-clickable **Visible** marker and Settings says so |
| Global shortcuts (`Ctrl+\`, `Ctrl+Enter`) | Yes | Registered on GNOME/Wayland; other compositors unchecked |
| Microphone + system-audio capture | Verified locally on Windows | System-audio track is obtained via the PulseAudio/PipeWire loopback and carries the default sink's monitor signal (checked with a test tone; see the note below about monitor volume). The library supports "most Linux distros with PulseAudio as a sound server" |
| Local ASR (Qwen, Whisper) | Yes | Yes (CPU) |
| Encrypted API-key storage | DPAPI | OS keyring via `safeStorage` (libsecret checked); refuses the weak plain-text fallback, so set the provider's environment variable if no keyring is available |
| "Open mic settings" button | Opens Windows settings | Hidden: there is no reliable deep link across desktops |
| Packaging | `npm run package:win` | Not set up yet |

Linux notes:

- On Wayland, always-on-top, window positioning and transparency are controlled by the compositor and can differ from Windows; this has not been checked visually.
- To check system audio yourself: play any audio, press **Listen**, and confirm the **Sys** meter on the toolbar moves and **System audio** lines appear. Use headphones so the microphone does not pick up the speakers.
- The loopback carries what the default output's **monitor** carries, so it follows the monitor volume. If the Sys meter stays flat while audio plays, check it with `pw-dump | python3 -c "import json,sys; [print(o['id'], o['info']['props'].get('node.name'), o['info'].get('params',{}).get('Props',[{}])[0].get('monitorVolumes')) for o in json.load(sys.stdin) if o.get('type')=='PipeWire:Interface:Node' and o['info']['props'].get('media.class')=='Audio/Sink']"`. A value far below 1.0 (for example 0.0005) mutes the capture; reset it with your audio settings or `pw-cli set-param <sink id> Props '{ monitorVolumes: [1.0, 1.0] }'` (syntax not verified).
- If `getDisplayMedia` stalls, check that `xdg-desktop-portal` and PipeWire (`pipewire-pulse`) are running.

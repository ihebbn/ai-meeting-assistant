# Windows Meeting Copilot — Milestone 1

One protected, movable, resizable frosted-glass overlay for Google Meet and Microsoft Teams. Live dual-source transcription (microphone + Windows system audio) with local ASR, plus Gemini answers grounded in the live transcript.

## Unified overlay

- **Toolbar** — dedicated drag grip moves the whole overlay; Listen/Stop, waveform, **You / Sys activity**, timer, Ask AI, **Insights** / **AI** reopen chips, Hide
- **Live Insights** — own collapse control; transcript toggle; live **You** / **System audio** lines; ASR backend + language controls; sample recap + actions
- **AI Response** — own collapse control; streaming sample answer; Copy; follow-up input

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

into `%APPDATA%/meeting-copilot/asr-models/` (Electron `userData`). Progress and errors appear in Live Insights. Manual fallback:

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

## Gemini Ask AI

Ask AI uses a rolling timestamped transcript plus optional **Watch Screen** history.

- **Typed chat** is an explicit request (highest priority).
- **Ask AI / Ctrl+Enter** with an empty draft answers the latest spoken question or on-screen task.
- **Live Insights** chips are deduped spoken questions / visible tasks.
- Gemini chooses transcript, screen, both, or knowledge-only for each reply. AI Response shows **Conversation** / **Screen** badges when those sources were sent.
- Watch Screen keeps a short in-memory frame history on meaningful changes and keeps running even if the overlay is hidden. Only the context needed for the current request is sent to Gemini; a newer ask cancels the previous stream.

Setup:

1. Copy `.env.example` → `.env`
2. Set `GEMINI_API_KEY=...` (never commit `.env`)
3. `npm start` — the key is also mirrored into Electron userData for later launches

Rotate any key that was pasted into chat history.

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

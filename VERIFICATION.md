# Screen-sharing verification matrix

**Scope:** Milestone 1 unified overlay (toolbar + Live Insights + AI Response).  
**Electron protection:** Diagnostics per-window status ≠ Meet/Teams Pass.

## Environment

| Field | Value |
| --- | --- |
| Date | 2026-11-05 (Qwen3-ASR + Whisper dual backend) |
| Presenter OS / build | (see Diagnostics) |
| Electron version | (see Diagnostics) |
| App version | 0.1.0 |
| Observer (remote) | — |
| Notes | Repeat remote checks while dragging, resizing, collapsing, reopening |

## Dual-audio transcription (headphones required)

Do this in a real Meet/Teams call **before** connecting Ask AI to the live transcript.

| Check | Result |
| --- | --- |
| Headphones on (speakers off) to avoid mic echo | Pending (operator) |
| Listen starts mic + system audio without stopping on Hide/collapse | Pass (local 2026-11-05 — hide while listening kept capture; Stop released streams) |
| Speak → **You** activity meter moves and transcript line labeled You | Pending (operator — speak with headphones in a call) |
| Remote participant / call audio → **Sys** meter moves and line labeled System audio | Pass (local 2026-11-05 — loopback transcribed system playback) |
| Stop releases both streams and discards stale in-flight ASR | Pass (local code path 2026-11-05; re-confirm in call) |
| Ask AI answers from the live transcript with the selected provider when a key is configured; a setup message otherwise | Pending (operator: needs a real key per provider and a call) |
| Suggestions are generated from the live transcript on demand (Suggest) and only automatically when the setting is on | Pending (operator) |

## Qwen3-ASR Windows acceptance (required before making Qwen the production default)

Mark Pass only after a headphones Meet/Teams run. Flip `QWEN_ACCEPTANCE_PASSED` in `electron/transcriber.ts` to `true` after this table is green.

| Check | Backend | Result | Notes / actual text |
| --- | --- | --- | --- |
| Meet or Teams call with headphones; **You** + **System audio** both appear | Qwen | Pending (operator) | |
| English segment (Auto language) | Qwen | Pending | |
| French segment immediately after (no setting change) | Qwen | Pending | |
| Arabic segment immediately after (no setting change) | Qwen | Pending | |
| Tunisian Arabic mixed with French in one sentence | Qwen | Pending | Record exact transcript output here |
| Same utterance Compare mode: missed/incorrect words | Qwen vs Whisper | Pending | |
| Same utterance Compare mode: end-of-phrase → on-screen latency | Qwen vs Whisper | Pending | Use ms tags on compare lines |
| Mid-session language change Auto → French without restart | Either | Pending | |
| Detected language shown when backend exposes it | Qwen | Pending | |
| Model missing / init failure shows clear setup error | Qwen | Pending | |
| Collapse / Hide while listening keeps captions flowing | Qwen | Pending | |

**Default gate:** Until the rows above are Pass, keep Whisper available and do not treat Qwen as the sole production backend. Qwen remains selectable for testing; Listen falls back to Whisper if model download/init fails.

## Local interaction checks

| Check | Result |
| --- | --- |
| Drag grip moves toolbar + panels together | Pending |
| Panels stay aligned under toolbar while dragging | Pending |
| Toolbar buttons still clickable (not captured by drag) | Pending |
| Each panel has its own collapse control | Pending |
| Both open → equal split; one open → fills width | Pending |
| Both collapsed → toolbar only; size remembered | Pending |
| Toolbar Insights / AI chips reopen panels; state preserved | Pending |
| Bottom-right resize handle resizes panel group | Pending |
| Min size enforced; long content scrolls | Pending |
| Content protection applied on overlay (+ diagnostics) | Pending |

## Meet / Teams results

For each mode, verify remote view during drag, resize, collapse, and reopen.

| App | Mode | Result | Browser / client version | Observer notes |
| --- | --- | --- | --- | --- |
| Google Meet in Chrome | Tab | Pending | | |
| Google Meet in Chrome | Window | Pending | | |
| Google Meet in Chrome | Entire display | Pending | | |
| Google Meet in Edge | Tab | Pending | | |
| Google Meet in Edge | Window | Pending | | |
| Google Meet in Edge | Entire display | Pending | | |
| Teams desktop | Window | Pending | | |
| Teams desktop | Entire display | Pending | | |
| Teams web in Chrome | Tab (if offered) | Pending | | |
| Teams web in Chrome | Window | Pending | | |
| Teams web in Chrome | Entire display | Pending | | |
| Teams web in Edge | Tab (if offered) | Pending | | |
| Teams web in Edge | Window | Pending | | |
| Teams web in Edge | Entire display | Pending | | |

## Brief results summary

Live Meet/Teams overlay invisibility and Qwen multilingual acceptance remain **Pending** until an operator completes the tables above with headphones.

## Linux (GNOME, Wayland, PipeWire + pipewire-pulse, Electron 35) — 2026-11-06

| Check | Result |
| --- | --- |
| App starts and the overlay opens | Pass (dev run) |
| Global shortcuts register | Pass (log: both registered) |
| API key stored in OS keyring via `safeStorage` (libsecret), nothing in plain text | Pass (round-trip probe) |
| Local ASR decode (Whisper and Qwen) | Pass (benchmark harness on a tone; no real speech) |
| `getDisplayMedia` loopback returns a "System audio" track | Pass (48 kHz track; setup took about 7 s; no portal prompt appeared) |
| Loopback delivers the audio that is playing | **Not verified**: my test tone was silent even when recorded directly from the default sink's monitor with `pw-record`, so the test setup was invalid, not the app. Operator: play audio, press Listen, check the Sys meter |
| Microphone capture | Not tested (not opened, for privacy) |
| Overlay transparency, always-on-top and drag on Wayland | Not verified visually |
| Capture protection | Not available on Linux (reported as such in the toolbar and Settings) |

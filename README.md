# Windows Meeting Copilot — Milestone 1

One protected, movable, resizable frosted-glass overlay for Google Meet and Microsoft Teams. Live dual-source transcription (microphone + Windows system audio). Ask AI still uses sample answers until dual-source capture is verified with headphones in a real call.

## Unified overlay

- **Toolbar** — dedicated drag grip moves the whole overlay; Listen/Stop, waveform, **You / Sys activity**, timer, Ask AI, **Insights** / **AI** reopen chips, Hide
- **Live Insights** — own collapse control; transcript toggle; live **You** / **System audio** lines; sample recap + actions
- **AI Response** — own collapse control; streaming sample answer; Copy; follow-up input

### Listen

| Control | Behavior |
| --- | --- |
| Listen | Starts microphone + Windows system-audio loopback; streams speech into the transcript |
| Stop | Releases both audio streams and clears activity meters |
| Hide / collapse | Does **not** stop listening — capture keeps running while the toolbar stays up |

Transcript speakers are labeled **You** (mic) and **System audio** (loopback). Wear headphones so meeting audio is not echoed into the mic.

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

First Listen may download the local Whisper `base.en` model into the app userData cache.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Hide / restore panels | `Ctrl+\` |
| Ask AI | `Ctrl+Enter` |
| Follow-up submit | `Enter` |

## Remote verification

From a second participant in Meet/Teams, confirm the overlay stays invisible while you **drag**, **resize**, **collapse**, and **reopen** panels. Record results in [`VERIFICATION.md`](VERIFICATION.md), including the dual-audio headphones checklist before wiring Ask AI to the live transcript.

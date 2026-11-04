# Windows Meeting Copilot — Milestone 1

One protected, movable, resizable frosted-glass overlay for Google Meet and Microsoft Teams. Sample transcript and answers only — layout/interaction first.

## Unified overlay

- **Toolbar** — dedicated drag grip moves the whole overlay; Listen/Pause, waveform, timer, Ask AI, **Insights** / **AI** reopen chips, Hide
- **Live Insights** — own collapse control; transcript toggle; sample recap + actions
- **AI Response** — own collapse control; streaming sample answer; Copy; follow-up input

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

`Ctrl+\` hides panels and restores them with session state intact. The toolbar stays visible.

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

From a second participant in Meet/Teams, confirm the overlay stays invisible while you **drag**, **resize**, **collapse**, and **reopen** panels. Record results in [`VERIFICATION.md`](VERIFICATION.md).

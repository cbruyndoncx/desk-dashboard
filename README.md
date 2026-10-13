# Desk Dashboard

A personal-dashboard screensaver for Windows (dev work in WSL2). When you step away it shows what needs your attention; when you sit back down the logon screen appears.

- **Agent sessions**: Claude Code (terminal, Obsidian Agent Client, desktop) and Codex (CLI, desktop) via hooks and by scanning Codex's local SQLite/rollout files. Each card shows state, last message, turn duration, tool count, whether a question is outstanding, and a "since you left" timeline.
- **Windows Terminal tabs** (via UI Automation) to see which tabs are still spinning.
- **Windows notifications**, grouped per app, read from the notification database.
- **Today's todos** from an Obsidian daily note.

## Layout

| Path | What |
|---|---|
| `server.js` | Collector (Node 22+, no dependencies, uses `node:sqlite`). HTTP + SSE on `127.0.0.1:7777`. |
| `hook.js` | Hook script for Claude Code / Codex: forwards hook JSON to the collector. |
| `public/index.html` | The dashboard UI. |
| `scr/DeskDashboard.cs` | The `.scr` host: fullscreen WebView2, exits on input, locks the workstation on exit. |
| `scr/build.sh` | Compiles the `.scr` with the .NET Framework `csc.exe` already on Windows. |
| `scr/start-collector.vbs` | Hidden autostart for the collector (put a shortcut in `shell:startup`). |
| `config.example.json` | Copy to `config.json` and adjust the paths. |

## Setup

1. `cp config.example.json config.json` and fix the paths (daily-note folder, Codex homes, your Windows user).
2. Download the `Microsoft.Web.WebView2` NuGet package (1.0.2792.45 was used), extract it, then `scr/build.sh <extracted-dir>`. It builds into `C:\Users\<you>\DeskDashboard`.
3. Create `C:\Users\<you>\DeskDashboard\DeskDashboard.cfg`:
   ```
   distro=Ubuntu
   script=/home/<you>/path/to/screensaver/run-server.sh
   ```
4. Edit the path in `scr/start-collector.vbs`, copy it to the same folder and add a shortcut to it in `shell:startup`.
5. Register the screensaver (`HKCU\Control Panel\Desktop`: `SCRNSAVE.EXE`, `ScreenSaveActive=1`, `ScreenSaveTimeOut`, `ScreenSaverIsSecure=1`). Make a Start Menu shortcut to `DeskDashboard.scr /s` with a hotkey (e.g. Ctrl+Alt+D) to launch it on demand.
6. Add hooks (`hook.js`) for the events SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, SessionEnd to your Claude Code `settings.json` (and Codex `hooks.json`; Codex asks you to approve them).

`DeskDashboard.scr /s /hold` ignores input for 12 s and does not lock; it is meant for screenshots and testing.

## Notes

- The collector only listens on localhost and stores nothing outside `state.json` (sessions) in this folder, which is git-ignored.
- Windows' own "on resume, display logon screen" is not reliable for third-party screensavers, so the `.scr` calls `LockWorkStation()` itself when it closes.

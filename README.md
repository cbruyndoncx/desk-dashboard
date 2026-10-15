# Desk Dashboard

> **What is covered**
>
> | Covered (one card per session) | How |
> |---|---|
> | Claude Code in a WSL terminal | hooks |
> | Claude Code via the Obsidian Agent Client | hooks |
> | Claude Desktop, Code tab | hooks (Windows `settings.json`) |
> | Codex CLI and Codex / ChatGPT desktop app, incl. Work chats | Codex's local databases (no hooks needed) |
> | Antigravity CLI (`agy`), also when started from Obsidian | agy's local databases |
>
> **Not covered:** plain chats in the Claude Desktop and ChatGPT desktop apps (no hooks, no readable local state). They only show up indirectly if the app sends a Windows notification. Other agents (e.g. Goose) are not wired up.

A personal-dashboard screensaver for Windows, built for people who run coding agents in WSL2. When you step away it shows what needs your attention; when you sit back down the Windows logon screen appears.

- **Agent sessions**: Claude Code (terminal, Obsidian Agent Client, desktop app), Codex (CLI, desktop app) and the Antigravity CLI (`agy`). Each card shows state, last message, turn duration, tool count, whether a question is outstanding, and a timeline of what changed since you left.
- **Windows Terminal tabs**, read via UI Automation, to see which tabs are still spinning.
- **Windows notifications**, grouped per app, read from the notification database.
- **Today's todos** from an Obsidian daily note (optional).

## How it works

```
Claude Code / Codex ──hook.js──▶ ┌──────────────┐ ──SSE──▶ public/index.html
Windows notifications, tabs ───▶ │  server.js   │            shown fullscreen by
Codex SQLite, daily note ──────▶ │ 127.0.0.1:7777│            DeskDashboard.scr (WebView2)
                                 └──────────────┘
```

The collector runs in WSL. The `.scr` is a small C# program that opens the page fullscreen, closes on any input, and then locks the workstation. If the collector is not running when the screensaver starts, the `.scr` starts it through `wsl.exe`.

## Requirements

- Windows 10/11 with the WebView2 runtime (preinstalled on Windows 11 and current Windows 10).
- WSL2 with a distro that has **Node.js 22.5 or newer** (the collector uses the built-in `node:sqlite`; there are no npm dependencies) plus `curl` and `unzip`.
- The .NET Framework 4 `csc.exe` that ships with Windows (nothing to install).

Everything below runs in the WSL shell unless it says PowerShell. Replace `YOU` with your Windows user name and `<repo>` with the folder you cloned into.

## 1. Clone and configure

```bash
git clone https://github.com/cbruyndoncx/desk-dashboard.git
cd desk-dashboard
cp config.example.json config.json
```

Edit `config.json`. The values that matter:

| Key | Meaning |
|---|---|
| `dailyNoteDir` | Folder with your daily notes (the todo panel stays empty without it). `dailyNotePattern` is the file name, `YYYY-MM-DD.md` by default. |
| `notificationDir` | `/mnt/c/Users/YOU/AppData/Local/Microsoft/Windows/Notifications` |
| `notificationExcludeApps` | App names to hide from the notification panel. |
| `codexSessionIndexes`, `codexSessionDirs`, `codexHomes` | Codex data folders, for WSL (`/home/YOU/.codex`) and Windows (`/mnt/c/Users/YOU/.codex`). Delete the entries for a Codex install you don't have. |
| `agyHomes` | Antigravity CLI data folder(s), default `~/.gemini/antigravity-cli`. Delete the entry if you don't use `agy`. |
| `sessionStaleMinutes` | Sessions idle longer than this disappear (default 240). |
| `notificationMaxAgeHours` | Hide notifications older than this many hours (`0` = keep all until Windows expires them). |
| `secondScreen` | `true` spreads the screensaver over two screens: agent sessions on the primary, terminal tabs, today's todos and notifications on the second. `false` (default): everything on the primary, other screens black. |
| `dateLocale` | Locale for the clock and date, e.g. `en-GB` or `nl-BE`. Empty = Windows locale. |

The collector reads `config.json` at start: restart it after a change. The `.scr` asks the collector for `secondScreen` each time it starts, so no rebuild is needed.

Check that the collector runs:

```bash
./run-server.sh &
curl -s 127.0.0.1:7777/state | head -c 200   # JSON with sessions, notifications, tabs
```

Open <http://localhost:7777> in a browser to see the dashboard before you build the screensaver. Stop the collector with `kill %1`.

## 2. Build the screensaver

Download the WebView2 package and build into `C:\Users\YOU\DeskDashboard`:

```bash
mkdir ~/wv2 && cd ~/wv2
curl -L -o wv2.nupkg https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2792.45
unzip -q wv2.nupkg -d pkg
cd <repo>
scr/build.sh ~/wv2/pkg
```

`build.sh` copies the three WebView2 DLLs and the source there and compiles `DeskDashboard.scr`. It finds your Windows user name itself; set `WINUSER=YOU` if that fails. If it stops with "Permission denied", a previous instance still holds the DLLs: end `DeskDashboard.exe`/`msedgewebview2` in Task Manager and run it again.

Tell the `.scr` where the collector lives. Create `C:\Users\YOU\DeskDashboard\DeskDashboard.cfg` (Notepad is fine):

```
distro=Ubuntu
script=/home/YOU/<repo>/run-server.sh
```

`distro` is the name from `wsl -l`. Without this file the screensaver still displays the dashboard, but cannot start the collector by itself.

## 3. Try it

In PowerShell:

```powershell
& "C:\Users\YOU\DeskDashboard\DeskDashboard.scr" /s /hold
```

You should see the dashboard fullscreen. `/hold` ignores input for 12 seconds and does **not** lock, so it is safe for testing. Without `/hold`, any mouse move or key closes it and locks Windows. If nothing appears, read `%TEMP%\deskdashboard-error.txt`.

## 4. Register as the Windows screensaver

PowerShell, after editing the user name:

```powershell
$k = 'HKCU:\Control Panel\Desktop'
Set-ItemProperty $k SCRNSAVE.EXE 'C:\Users\YOU\DeskDashboard\DeskDashboard.scr'
Set-ItemProperty $k ScreenSaveActive 1
Set-ItemProperty $k ScreenSaveTimeOut 300        # seconds idle before it starts
Set-ItemProperty $k ScreenSaverIsSecure 1        # ask for logon on resume
```

The screensaver only starts while Windows is not turned off by the power plan, so set the display-off and sleep timeouts to longer than the screensaver timeout (Settings → System → Power, or `powercfg /change monitor-timeout-ac 0`). On a laptop that includes the battery timeouts.

Windows' own "on resume, display logon screen" is not reliable for third-party screensavers, so the `.scr` also calls `LockWorkStation()` when it closes. You get the logon screen either way.

## 5. Hotkey and autostart

Start-menu shortcut with a hotkey (Ctrl+Alt+D) that starts the screensaver on demand, and a Startup shortcut that launches the collector at logon. First edit the path in `scr/start-collector.vbs` to your `run-server.sh` and copy it to the DeskDashboard folder:

```bash
cp scr/start-collector.vbs /mnt/c/Users/YOU/DeskDashboard/
```

Then, in PowerShell:

```powershell
$sh = New-Object -ComObject WScript.Shell
$d = 'C:\Users\YOU\DeskDashboard'

$l = $sh.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Desk Dashboard.lnk")
$l.TargetPath = "$d\DeskDashboard.scr"; $l.Arguments = '/s'; $l.Hotkey = 'CTRL+ALT+D'; $l.Save()

$l = $sh.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Desk Dashboard Collector.lnk")
$l.TargetPath = 'wscript.exe'; $l.Arguments = "`"$d\start-collector.vbs`""; $l.WindowStyle = 7; $l.Save()
```

Windows hotkeys on shortcuts work from the Start-menu folder; it can take a moment (or a sign-out) before Ctrl+Alt+D is active.

## 6. Connect your agents

The dashboard works without this (terminal tabs, notifications and Codex via its database still show up), but live state, "needs permission" and "asking you" need hooks.

**Claude Code in WSL**: add to `~/.claude/settings.json` (merge with an existing `hooks` block):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "node /home/YOU/<repo>/hook.js" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /home/YOU/<repo>/hook.js" }] }],
    "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "node /home/YOU/<repo>/hook.js" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "node /home/YOU/<repo>/hook.js" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "node /home/YOU/<repo>/hook.js" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "node /home/YOU/<repo>/hook.js" }] }]
  }
}
```

The hook script forwards the event and always exits 0 with a 500 ms timeout, so it can't stall a session when the collector is down. Sessions started before you add the hooks only appear after their next event.

**Claude Code on Windows** (desktop app, or `claude` in a Windows terminal): same events in `C:\Users\YOU\.claude\settings.json`, with this command instead (Windows has no `node hook.js` path into WSL):

```
curl.exe -s -m 1 -X POST -H "Content-Type: application/json" --data-binary @- "http://127.0.0.1:7777/event?agent=claude-desktop"
```

**Codex**: put the same hook block in `~/.codex/hooks.json` (and `C:\Users\YOU\.codex\hooks.json` for Windows) with `hook.js --agent codex`, or the `curl.exe` command with `?agent=codex`. Codex asks you to review and trust new hooks the first time; approve them yourself in Codex. Without trust, Codex sessions still appear through the SQLite scan, only without "waiting for permission".

**Antigravity CLI (`agy`)**: nothing to configure. The collector reads agy's own per-conversation SQLite files (`~/.gemini/antigravity-cli/conversations`), so working / waiting for permission / done, the last answer and the tool count show up without hooks. This relies on agy's internal, undocumented format (tested with agy 1.3.3) and may break after an update.

Check with a test event:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"UserPromptSubmit","session_id":"test","cwd":"/tmp/demo","prompt":"hello"}' \
  "127.0.0.1:7777/event?agent=claude"
```

A "demo" card appears; remove it with the same call using `"hook_event_name":"SessionEnd"`.

## Files

| Path | What |
|---|---|
| `server.js` | Collector: HTTP + SSE on `127.0.0.1:7777`; `GET /state`, `POST /event`, `GET /events`, `GET /config` (display settings for the `.scr`). Env overrides: `DASH_PORT`, `DASH_NOTE_DIR`. |
| `hook.js` | Hook script: forwards hook JSON from stdin to the collector. |
| `public/index.html` | The dashboard UI. Double-click toggles browser fullscreen. `?view=main` / `?view=side` show the two halves of the two-screen layout. |
| `run-server.sh` | Starts the collector; finds nvm's node when `node` is not on PATH (set `NODE_BIN` to override). |
| `scr/DeskDashboard.cs` | The `.scr` host. Flags: `/s` run, `/c` info box, `/p` no-op, `/hold` test mode. |
| `scr/build.sh` | Compiles the `.scr`. |
| `scr/start-collector.vbs` | Hidden collector start for the Startup shortcut. |
| `config.example.json` | Template for `config.json` (git-ignored). |

## Limits

- "Still running" for a session relies on its Windows Terminal tab spinner, so it only works for sessions that have a tab.
- "Asking you" is a heuristic: a last message ending in `?`, the `AskUserQuestion` tool, or Codex's `questions` field.
- A screensaver cannot draw over the Windows lock screen, so nothing is shown after the machine has locked.
- `agy` sessions are only seen while the conversation database changes; a question the model asks in plain text is flagged by the same `?` heuristic as for the other agents.
- Developed on one machine (Windows 11, Ubuntu on WSL2); other setups may need path tweaks.

## Privacy

The collector listens on `127.0.0.1` only. It reads local files (transcripts, Codex databases, the notification database, your daily note) and keeps session state in `state.json` in this folder, which is git-ignored. Nothing leaves your machine.

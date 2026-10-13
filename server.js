const http = require('http');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
if (!cfg.agyHomes) cfg.agyHomes = [path.join(os.homedir(), '.gemini', 'antigravity-cli')];
if (process.env.DASH_PORT) cfg.port = +process.env.DASH_PORT;
if (process.env.DASH_NOTE_DIR) cfg.dailyNoteDir = process.env.DASH_NOTE_DIR;
const PUBLIC = path.join(__dirname, 'public');

// ---- sessions -------------------------------------------------------------
const STATE_FILE = path.join(__dirname, 'state.json');
const sessions = new Map(); // session_id -> { id, project, cwd, status, detail, prompt, updated, attention }


// ---- session titles (from the transcript the hook payload points to) -------
// Claude Code appends {"type":"ai-title","aiTitle":...} entries; a user rename is expected as
// {"type":"custom-title","customTitle":...}. A custom name wins over the generated one.
function toLinuxPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
}

function readTitle(transcript) {
  let fd;
  try {
    const file = toLinuxPath(transcript);
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 1 << 20); // titles are re-appended regularly, so the tail is enough
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let custom = null, ai = null;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('-title"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'custom-title') custom = o.customTitle || o.title || custom;
        else if (o.type === 'ai-title') ai = o.aiTitle || o.title || ai;
      } catch {}
    }
    return custom || ai || null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Codex keeps thread names in session_index.jsonl (one per line, newest rename last), WSL and Windows each have one.
function readCodexTitle(id) {
  let title = null;
  for (const f of cfg.codexSessionIndexes) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes(id)) continue;
        try { const o = JSON.parse(line); if (o.id === id && o.thread_name) title = o.thread_name; } catch {}
      }
    } catch {}
  }
  return title;
}


// ---- turn bookkeeping: what happened in the latest turn ---------------------
function logEvent(s, txt) {
  s.log = s.log || [];
  const last = s.log[s.log.length - 1];
  if (last && last.txt === txt) return;
  s.log.push({ t: Date.now(), txt });
  if (s.log.length > 10) s.log.shift();
}
const fmtDur = ms => (ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + 's' : Math.round(ms / 60000) + 'm');
// A turn that ends on a question leaves something outstanding for the user.
function looksLikeQuestion(text) {
  const tail = (text || '').trim().split(/\n+/).pop().replace(/[*_`"')\]\s]+$/, '');
  return tail.endsWith('?');
}
function readLastAssistantText(transcript) {
  let fd;
  try {
    fd = fs.openSync(toLinuxPath(transcript), 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"assistant"')) continue;
      try {
        const o = JSON.parse(lines[i]);
        const text = (o.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if (text) return text;
      } catch {}
    }
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

function applyEvent(ev) {
  const id = ev.session_id || ev.thread_id || ev.conversation_id;
  if (!id) return;
  const name = ev.hook_event_name;
  if (name === 'SessionEnd') { sessions.delete(id); saveSessions(); return; }

  const s = sessions.get(id) || { id, status: 'idle', detail: '', prompt: '', attention: false };
  s.agent = ev.agent || s.agent || 'claude';
  if (ev.cwd) { s.cwd = ev.cwd; s.project = ev.cwd.split(/[\\/]/).filter(Boolean).pop(); }
  s.updated = Date.now();
  if (ev.transcript_path) s.transcript = ev.transcript_path;
  if (s.agent === 'codex' && (!s.title || ['UserPromptSubmit', 'Stop'].includes(name))) s.title = readCodexTitle(id) || s.title;
  // Re-read the title when it can have changed (not on every tool call).
  if (s.transcript && (!s.title || ['SessionStart', 'UserPromptSubmit', 'Stop'].includes(name))) s.title = readTitle(s.transcript) || s.title;

  switch (name) {
    case 'SessionStart':
      s.status = 'idle'; s.detail = ev.source || 'started'; logEvent(s, 'session started'); break;
    case 'UserPromptSubmit':
      s.status = 'working'; s.prompt = (ev.prompt || '').slice(0, 200);
      s.detail = ''; s.attention = false; s.asking = false;
      s.turn = { start: Date.now(), tools: 0 };
      logEvent(s, 'prompt: "' + s.prompt.slice(0, 60) + '"'); break;
    case 'PreToolUse':
    case 'PostToolUse':
      s.status = 'working'; s.detail = ev.tool_name || ''; s.attention = false;
      if (name === 'PreToolUse') {
        s.turn = s.turn || { start: Date.now(), tools: 0 };
        if (++s.turn.tools === 1) logEvent(s, 'working');
        if (ev.tool_name === 'AskUserQuestion') {
          s.status = 'waiting'; s.asking = true; s.attention = true; s.detail = 'asking you a question';
          logEvent(s, 'asked you a question');
        }
      }
      break;
    case 'PermissionRequest':
      s.status = 'waiting'; s.detail = 'permission: ' + (ev.tool_name || 'tool'); s.attention = true;
      logEvent(s, 'needs permission: ' + (ev.tool_name || 'tool')); break;
    case 'Notification':
      s.status = 'waiting'; s.detail = ev.message || 'needs input'; s.attention = true;
      logEvent(s, 'needs input: ' + (ev.message || '').slice(0, 60)); break;
    case 'Stop':
      s.status = 'done'; s.detail = 'finished'; s.attention = true;
      {
        const text = ev.last_assistant_message || (s.transcript && readLastAssistantText(s.transcript)) || s.lastMessage || '';
        s.lastMessage = text.slice(-600);
        s.asking = looksLikeQuestion(text);
        const ms = s.turn ? Date.now() - s.turn.start : 0, tools = s.turn ? s.turn.tools : 0;
        s.lastTurn = { ms, tools, end: Date.now() };
        logEvent(s, `done in ${fmtDur(ms)} (${tools} tool${tools === 1 ? '' : 's'})` + (s.asking ? ', asks you a question' : ''));
      }
      break;
  }
  sessions.set(id, s);
  saveSessions();
}

// Persist sessions so a collector restart doesn't hide sessions that are idle or waiting.
try {
  for (const s of JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))) sessions.set(s.id, s);
} catch {}
let saveTimer = null;
function saveSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify([...sessions.values()])); } catch {}
  }, 500);
}

function liveSessions() {
  const cutoff = Date.now() - cfg.sessionStaleMinutes * 60000;
  for (const [id, s] of sessions) if (s.updated < cutoff) sessions.delete(id);
  return [...sessions.values()].sort((a, b) => b.updated - a.updated);
}

// ---- daily note todos -----------------------------------------------------
let todos = { file: null, exists: false, items: [] };
let todoMtime = 0;

function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadTodos() {
  const file = path.join(cfg.dailyNoteDir, cfg.dailyNotePattern.replace('YYYY-MM-DD', ymd(new Date())));
  let st;
  try { st = fs.statSync(file); } catch {
    if (todos.file !== file || todos.exists) { todos = { file, exists: false, items: [] }; return true; }
    return false;
  }
  if (todos.file === file && st.mtimeMs === todoMtime) return false;
  todoMtime = st.mtimeMs;
  const items = [];
  let heading = '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) { heading = h[1].trim(); continue; }
    const t = line.match(/^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)/);
    if (t) items.push({ text: t[3].trim(), done: t[2] !== ' ', heading, indent: t[1].length });
  }
  todos = { file, exists: true, items };
  return true;
}


// ---- Windows notifications (read from the Action Center database) ---------
// wpndatabase.db is locked/WAL on Windows, so query a private copy. Read-only, never writes back.
let notifications = [];
let notifStamp = '';
const notifTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpn-'));

function prettyApp(primaryId) {
  const base = primaryId.split('!')[0].split('_')[0];
  const last = base.split('.').pop() || base;
  return last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\.exe$/i, '');
}
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function loadNotifications() {
  const src = path.join(cfg.notificationDir, 'wpndatabase.db');
  let stamp;
  try {
    stamp = ['', '-wal'].map(x => fs.statSync(src + x).mtimeMs).join('/');
  } catch { return false; }
  if (stamp === notifStamp) return false;
  notifStamp = stamp;
  try {
    for (const x of ['', '-wal', '-shm']) {
      try { fs.copyFileSync(src + x, path.join(notifTmp, 'wpndatabase.db' + x)); } catch {}
    }
    const db = new DatabaseSync(path.join(notifTmp, 'wpndatabase.db'));
    const stmt = db.prepare(`SELECT n.ArrivalTime AS t, n.ExpiryTime AS e, n.Payload AS p, h.PrimaryId AS app
      FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId
      WHERE n.Type = 'toast' ORDER BY n.ArrivalTime DESC LIMIT 200`);
    stmt.setReadBigInts(true); // FILETIMEs exceed 2^53
    const rows = stmt.all();
    db.close();
    const FT_TO_MS = ft => Number(ft) / 1e4 - 11644473600000;
    const now = Date.now();
    const out = [];
    for (const r of rows) {
      if (FT_TO_MS(r.e) < now) continue;
      const xml = Buffer.from(r.p).toString('utf8');
      const texts = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => unxml(m[1]).trim()).filter(Boolean);
      if (!texts.length) continue;
      const app = prettyApp(r.app);
      if (cfg.notificationExcludeApps.includes(app)) continue;
      const n = { app, title: texts[0], body: texts.slice(1).join(' · '), time: FT_TO_MS(r.t), count: 1 };
      const dup = out.find(o => o.app === n.app && o.title === n.title && o.body === n.body);
      if (dup) { dup.count++; continue; } // rows are newest-first, so dup keeps the latest time
      out.push(n);
      if (out.length >= cfg.maxNotifications) break;
    }
    const changed = JSON.stringify(out) !== JSON.stringify(notifications);
    notifications = out;
    return changed;
  } catch (e) {
    console.error('notifications:', e.message);
    return false;
  }
}


// ---- Windows Terminal tabs (UI Automation via powershell.exe) -------------
// Claude Code prefixes the tab title with a status glyph: ✳ idle, ◐◑◒◓ / braille spinner = working.
const TABS_PS = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]
$root=$A::RootElement
$wins=$root.FindAll('Children',(New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty,'CASCADIA_HOSTING_WINDOW_CLASS')))
$out=@()
foreach($w in $wins){
  $tabs=$w.FindAll('Descendants',(New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)))
  foreach($t in $tabs){
    $sel=$t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected
    $out+=[pscustomobject]@{window=$w.Current.NativeWindowHandle;title=$t.Current.Name;selected=$sel}
  }
}
ConvertTo-Json -InputObject @($out) -Compress
`;
const TABS_B64 = Buffer.from(TABS_PS, 'utf16le').toString('base64'); // -EncodedCommand avoids stdin/quoting pitfalls
let tabs = [];
let tabsBusy = false;

function classifyTab(title) {
  const g = [...title][0] || '';
  const rest = title.slice(g.length).trim();
  if (g === '✳') return { kind: 'claude', status: 'idle', name: rest };
  if ('◐◑◒◓'.includes(g) || /[⠀-⣿]/.test(g)) return { kind: 'claude', status: 'working', name: rest };
  return { kind: 'shell', status: 'shell', name: title };
}

function pollTabs() {
  if (tabsBusy) return;
  tabsBusy = true;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', TABS_B64],
    { timeout: 15000, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout) => {
      tabsBusy = false;
      if (err) return;
      try {
        const rows = JSON.parse(stdout.replace(/^﻿/, '').trim() || '[]');
        const next = rows.map(r => ({ ...classifyTab(r.title), selected: r.selected, win: r.window }));
        if (JSON.stringify(next) !== JSON.stringify(tabs)) { tabs = next; broadcast(); }
      } catch {}
    });
}


// ---- Codex sessions from rollout files (no hooks / trust approval needed) ---
// Each Codex thread appends to sessions/YYYY/MM/DD/rollout-*.jsonl: session_meta first, then
// task_started / task_complete events. Hook events (when trusted) are fresher and win.
const codexSeen = new Map(); // file -> mtimeMs already processed

function scanCodex() {
  let changed = false;
  const now = new Date(), day = d => path.join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const days = [day(now), day(new Date(now - 86400000))];
  const cutoff = Date.now() - cfg.sessionStaleMinutes * 60000;
  for (const base of cfg.codexSessionDirs) for (const d of days) {
    let names;
    try { names = fs.readdirSync(path.join(base, d)); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue;
      const file = path.join(base, d, n);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < cutoff || codexSeen.get(file) === st.mtimeMs) continue;
      codexSeen.set(file, st.mtimeMs);
      try {
        const fd = fs.openSync(file, 'r');
        const len = Math.min(st.size, 256 * 1024), buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        const head = Buffer.alloc(Math.min(st.size, 64 * 1024));
        fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        const meta = JSON.parse(head.toString('utf8').split('\n')[0]).payload || {};
        if (!meta.id) continue;
        let last = null;
        for (const line of buf.toString('utf8').split('\n')) {
          if (!line.includes('"event_msg"')) continue;
          try { const t = JSON.parse(line).payload?.type; if (['task_started', 'task_complete', 'turn_aborted'].includes(t)) last = t; } catch {}
        }
        if (!last) continue;
        const ex = sessions.get(meta.id);
        if (ex && ex.updated >= st.mtimeMs) continue; // a hook event is newer
        const stale = Date.now() - st.mtimeMs > 10 * 60000;
        const status = last === 'task_started' && !stale ? 'working' : last === 'task_started' ? 'idle' : 'done';
        const cwd = meta.cwd || '';
        sessions.set(meta.id, {
          ...(ex || {}), id: meta.id, agent: 'codex', cwd, project: cwd.split(/[\\/]/).filter(Boolean).pop() || '',
          status, detail: status === 'done' ? 'finished' : meta.originator || '', prompt: ex?.prompt || '',
          updated: st.mtimeMs, attention: status === 'done', title: readCodexTitle(meta.id) || ex?.title,
        });
        changed = true;
      } catch {}
    }
  }
  if (changed) saveSessions();
  return changed;
}


// ---- Codex sessions from its SQLite stores (precise turn status) -----------
// state_5.sqlite `threads` = title/cwd/updated_at; thread_history_1.sqlite `thread_turns` = per-turn
// status ('inProgress' until completed_at is set). Newer Codex builds write here before (or instead of) rollout files.
const codexDbStamp = new Map(); // home -> mtime stamp
const codexTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdb-'));

function scanCodexDb() {
  let changed = false;
  cfg.codexHomes.forEach((home, i) => {
    const files = ['state_5.sqlite', 'thread_history_1.sqlite'];
    let stamp;
    try { stamp = files.flatMap(f => ['', '-wal'].map(x => { try { return fs.statSync(path.join(home, f + x)).mtimeMs; } catch { return 0; } })).join('/'); } catch { return; }
    if (codexDbStamp.get(home) === stamp) return;
    codexDbStamp.set(home, stamp);
    try {
      const dir = path.join(codexTmp, String(i));
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) for (const x of ['', '-wal', '-shm']) {
        try { fs.copyFileSync(path.join(home, f + x), path.join(dir, f + x)); } catch {}
      }
      const state = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
      const cutoff = Math.floor(Date.now() / 1000) - cfg.sessionStaleMinutes * 60;
      const threads = state.prepare(`SELECT id, COALESCE(NULLIF(name,''), title) AS title, cwd, updated_at
        FROM threads WHERE archived = 0 AND updated_at >= ? ORDER BY updated_at DESC`).all(cutoff);
      state.close();
      const turns = new Map(); // thread_id -> latest turn
      let hist = null;
      try {
        hist = new DatabaseSync(path.join(dir, 'thread_history_1.sqlite'));
        for (const t of hist.prepare('SELECT thread_id, turn_id, status, started_at, completed_at, duration_ms FROM thread_turns ORDER BY started_at ASC').all()) turns.set(t.thread_id, t);
      } catch {}
      // What the latest turn did: tool count, final agent message, and any outstanding question.
      const turnInfo = turn => {
        if (!hist || !turn) return {};
        try {
          const tools = hist.prepare("SELECT count(*) AS n FROM thread_items WHERE turn_id = ? AND item_type NOT IN ('userMessage','agentMessage','reasoning')").get(turn.turn_id).n;
          const row = hist.prepare("SELECT item_json FROM thread_items WHERE turn_id = ? AND item_type = 'agentMessage' ORDER BY rollout_ordinal DESC LIMIT 1").get(turn.turn_id);
          const m = row ? JSON.parse(row.item_json) : {};
          const text = m.text || '';
          const asking = (Array.isArray(m.questions) && m.questions.length > 0) || looksLikeQuestion(text);
          return { tools: Number(tools), text, asking };
        } catch { return {}; }
      };
      for (const t of threads) {
        const turn = turns.get(t.id);
        const ms = Math.max(t.updated_at, turn ? (turn.completed_at || turn.started_at) : 0) * 1000;
        const ex = sessions.get(t.id);
        if (ex && ex.updated >= ms && ex.agent === 'codex' && ex.status !== 'done' && !turn) continue;
        const stale = Date.now() - ms > 10 * 60000;
        const status = !turn ? 'done' : turn.status === 'inProgress' ? (stale ? 'idle' : 'working') : 'done';
        const cwd = t.cwd || '';
        const info = turnInfo(turn);
        const next = {
          ...(ex || {}), id: t.id, agent: 'codex', cwd, project: cwd.split(/[\\/]/).filter(Boolean).pop() || '',
          status, detail: status === 'working' ? 'turn in progress' : status === 'done' ? 'finished' : '',
          prompt: ex?.prompt || '', updated: Math.max(ms, ex?.updated || 0), attention: status === 'done', title: t.title || ex?.title,
        };
        if (turn && info.text !== undefined) {
          next.lastMessage = info.text.slice(-600); next.asking = info.asking;
          if (turn.status === 'inProgress') next.turn = { start: turn.started_at * 1000, tools: info.tools };
          else next.lastTurn = { ms: turn.duration_ms || (turn.completed_at - turn.started_at) * 1000, tools: info.tools, end: (turn.completed_at || turn.started_at) * 1000 };
        }
        if (!ex || ex.status !== status) {
          if (status === 'working') logEvent(next, 'working');
          else if (status === 'done' && next.lastTurn) logEvent(next, `done in ${fmtDur(next.lastTurn.ms)} (${next.lastTurn.tools} tool${next.lastTurn.tools === 1 ? '' : 's'})` + (next.asking ? ', asks you a question' : ''));
        }
        if (!ex || ex.status !== next.status || ex.title !== next.title || ex.updated !== next.updated || ex.lastMessage !== next.lastMessage) { sessions.set(t.id, next); changed = true; }
      }
      if (hist) hist.close();
    } catch (e) { console.error('codex db:', e.message); }
  });
  if (changed) saveSessions();
  return changed;
}


// ---- Antigravity CLI (agy): per-conversation SQLite files, no hooks needed -------------------
// steps.step_type 14 = user prompt (protobuf field 19.2), 15 = model turn (visible text in 20.1, reasoning in 20.3),
// 132 = tool call (name 5.4.2). steps.status 2 = running, 3 = done, 9 = waiting for permission.
const agyStamp = new Map(); // db path -> mtime stamp
const agyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agydb-'));
function pbVarint(b, o) { let v = 0n, sh = 0n; for (;;) { const c = b[o++]; v |= BigInt(c & 127) << sh; if (!(c & 128)) break; sh += 7n; } return [v, o]; }
// Collect printable string fields, keyed by dotted field path ("20.1").
function pbStrings(b, prefix, out, depth) {
  let o = 0;
  while (o < b.length) {
    let t; [t, o] = pbVarint(b, o);
    const f = Number(t >> 3n), w = Number(t & 7n);
    if (w === 0) { [, o] = pbVarint(b, o); }
    else if (w === 1) o += 8;
    else if (w === 5) o += 4;
    else if (w === 2) {
      let l; [l, o] = pbVarint(b, o); l = Number(l);
      if (o + l > b.length) return;
      const sub = b.subarray(o, o + l); o += l;
      const str = sub.toString('utf8');
      const key = prefix ? prefix + '.' + f : String(f);
      if (str.length && !str.includes('�') && /^[\t\n\r\x20-\x7e -￿]+$/.test(str)) { if (!out[key]) out[key] = str; }
      else if (depth < 4) pbStrings(sub, key, out, depth + 1);
    } else return;
  }
}
// metadata starts with a Timestamp message (field 1): seconds in its field 1.
function stepTime(meta) {
  try { const b = Buffer.from(meta); if (b[0] !== 0x0a) return 0; const [, o] = pbVarint(b, 1); if (b[o] !== 0x08) return 0; return Number(pbVarint(b, o + 1)[0]) * 1000; } catch { return 0; }
}
function scanAgy() {
  let changed = false;
  for (const home of cfg.agyHomes || []) {
    const convDir = path.join(home, 'conversations');
    let names;
    try { names = fs.readdirSync(convDir).filter(f => f.endsWith('.db')); } catch { continue; }
    const cutoff = Date.now() - cfg.sessionStaleMinutes * 60000;
    let summaries = null;
    const titleOf = id => {
      if (summaries === null) {
        summaries = new Map();
        try {
          const dir = path.join(agyTmp, 'sum'); fs.mkdirSync(dir, { recursive: true });
          for (const x of ['', '-wal', '-shm']) { try { fs.copyFileSync(path.join(home, 'conversation_summaries.db' + x), path.join(dir, 'conversation_summaries.db' + x)); } catch {} }
          const d = new DatabaseSync(path.join(dir, 'conversation_summaries.db'));
          for (const r of d.prepare('SELECT conversation_id, title, parent_conversation_id FROM conversation_summaries').all()) summaries.set(r.conversation_id, r);
          d.close();
        } catch {}
      }
      return summaries.get(id) || {};
    };
    for (const name of names) {
      const id = name.slice(0, -3), file = path.join(convDir, name);
      let stamp = '';
      try { stamp = ['', '-wal'].map(x => { try { return fs.statSync(file + x).mtimeMs; } catch { return 0; } }).join('/'); } catch { continue; }
      const mt = Math.max(...stamp.split('/').map(Number));
      if (mt < cutoff && !sessions.has(id)) continue;
      const key = home + '|' + id;
      const quiet = Date.now() - mt > 15000; // a "running" step with no writes for a while is re-evaluated each pass
      if (agyStamp.get(key) === stamp && quiet) continue;
      agyStamp.set(key, stamp);
      try {
        const dir = path.join(agyTmp, 'c'); fs.mkdirSync(dir, { recursive: true });
        for (const x of ['', '-wal', '-shm']) { try { fs.copyFileSync(file + x, path.join(dir, 'c.db' + x)); } catch {} }
        const db = new DatabaseSync(path.join(dir, 'c.db'));
        const steps = db.prepare('SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx').all();
        db.close();
        let lastUser = -1;
        steps.forEach((r, i) => { if (r.step_type === 14) lastUser = i; });
        if (lastUser < 0) continue;
        const sum = titleOf(id);
        if (sum.parent_conversation_id) continue; // sub-agent conversation
        const f = {}; pbStrings(Buffer.from(steps[lastUser].step_payload), '', f, 0);
        const prompt = (f['19.2'] || '').slice(0, 200);
        const cwd = (f['19.12.12'] || '').replace(/^file:\/\//, '').replace(/%20/g, ' ');
        const turnSteps = steps.slice(lastUser + 1);
        const tools = turnSteps.filter(r => r.step_type === 132).length;
        const last = steps[steps.length - 1];
        let text = '', tool = '';
        for (const r of turnSteps) {
          const g = {}; pbStrings(Buffer.from(r.step_payload), '', g, 0);
          if (r.step_type === 15 && g['20.1']) text = g['20.1'];
          if (r.step_type === 132 && g['5.4.2']) tool = g['5.4.2'];
        }
        const startMs = stepTime(steps[lastUser].metadata) || mt;
        const endMs = Math.max(stepTime(last.metadata), 0) || mt;
        const lastIsAnswer = last.step_type === 15 && last.status === 3 && !!text;
        const waiting = turnSteps.some(r => r.status === 9);
        const running = turnSteps.some(r => r.status === 2) || (!lastIsAnswer && !waiting && Date.now() - mt < 20000);
        const status = waiting ? 'waiting' : running ? 'working' : lastIsAnswer ? 'done' : 'idle';
        const ex = sessions.get(id);
        const next = {
          ...(ex || {}), id, agent: 'agy', cwd, project: cwd.split(/[\\/]/).filter(Boolean).pop() || '',
          status, detail: waiting ? 'permission: ' + (tool || 'tool') : running ? tool : status === 'done' ? 'finished' : '',
          prompt, updated: endMs || mt, attention: status === 'done' || waiting,
          title: sum.title || ex?.title || prompt.slice(0, 60),
        };
        next.asking = status === 'done' && looksLikeQuestion(text);
        if (text) next.lastMessage = text.slice(-600);
        if (status === 'working') next.turn = { start: startMs, tools };
        else if (status === 'done') next.lastTurn = { ms: Math.max(0, endMs - startMs), tools, end: endMs };
        if (!ex || ex.status !== status || ex.prompt !== prompt) {
          if (!ex || ex.prompt !== prompt) logEvent(next, 'prompt: "' + prompt.slice(0, 60) + '"');
          if (status === 'working') logEvent(next, 'working');
          else if (status === 'waiting') logEvent(next, 'needs permission: ' + (tool || 'tool'));
          else if (status === 'done') logEvent(next, `done in ${fmtDur(next.lastTurn.ms)} (${tools} tool${tools === 1 ? '' : 's'})` + (next.asking ? ', asks you a question' : ''));
        }
        if (!ex || ex.status !== next.status || ex.title !== next.title || ex.updated !== next.updated || ex.lastMessage !== next.lastMessage || ex.detail !== next.detail) { sessions.set(id, next); changed = true; }
      } catch (e) { console.error('agy db:', e.message); }
    }
  }
  if (changed) saveSessions();
  return changed;
}

// ---- state + SSE ----------------------------------------------------------
const clients = new Set();
const snapshot = () => ({ now: Date.now(), sessions: liveSessions(), todos, notifications, tabs, clients: clients.size });
function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) c.write(data);
}

setInterval(() => { const a = loadTodos(), b = loadNotifications(), c = scanCodex(), e = scanCodexDb(), g = scanAgy(); if (a || b || c || e || g) broadcast(); }, 5000); // drvfs has no reliable inotify
setInterval(pollTabs, 6000);
pollTabs();
setInterval(broadcast, 30000); // refresh relative ages / stale pruning
loadTodos();
loadNotifications();
scanCodex();
scanCodexDb();
scanAgy();

// ---- http -----------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && url === '/event') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        const q = new URL(req.url, 'http://x').searchParams.get('agent');
        if (q && !ev.agent) ev.agent = q; // Windows hooks tag via ?agent= (curl.exe can't edit the body)
        applyEvent(ev); broadcast();
      } catch {}
      res.writeHead(204).end();
    });
  } else if (url === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(snapshot()));
  } else if (url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else {
    const file = path.join(PUBLIC, url === '/' ? 'index.html' : path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }).end(data);
    });
  }
}).listen(cfg.port, '127.0.0.1', () => console.log(`dashboard on http://localhost:${cfg.port}`));

#!/usr/bin/env node
// Claude Code hook: forwards the hook JSON (stdin) to the dashboard collector.
// Never blocks or fails the session: short timeout, always exits 0.
const http = require('http');
const port = process.env.DASH_PORT || 7777;
const ai = process.argv.indexOf('--agent');
const agent = ai > 0 ? process.argv[ai + 1] : '';
let buf = '';
process.stdin.on('data', d => (buf += d));
process.stdin.on('end', () => {
  const req = http.request(
    { host: '127.0.0.1', port, path: '/event', method: 'POST', timeout: 500,
      headers: { 'content-type': 'application/json' } },
    res => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  let body = buf || '{}';
  if (agent) { try { body = JSON.stringify({ ...JSON.parse(body), agent }); } catch {} }
  req.end(body);
});

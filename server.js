/* Blockstead — authoritative server (Node, no dependencies).
 * Serves the static distribution and the hosted API used by the game:
 *   GET  /api/v1/time                  platform time (round-trip adjusted client-side)
 *   GET  /api/v1/daily                 today's immutable daily ruleset
 *   GET  /api/v1/leaderboard?board=ID  validated scores (global/daily boards)
 *   POST /api/v1/score                 submit a replay envelope for validation
 *   POST /api/v1/achievement           durable, idempotent achievement delivery
 * Competitive claims are never trusted: scores are accepted only after the
 * server replays the ordered input log against trusted versioned content.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const Rules = require('./js/rules.js');
const Content = require('./js/content.js');
const Session = require('./js/session.js');

const ROOT = __dirname;
const PORT = process.env.PORT ? +process.env.PORT : 8080;
const DATA_DIR = path.join(ROOT, 'data');
const BOARD_FILE = path.join(DATA_DIR, 'leaderboards.json');
const ACH_FILE = path.join(DATA_DIR, 'achievements.json');
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.opus': 'audio/ogg'
};

// ---------- tiny JSON stores ----------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function saveJson(file, obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch (e) { /* read-only fs: keep serving, boards become session-local */ }
}

// ---------- rate limiting (per-IP token bucket, recoverable 429s) ----------
const buckets = new Map();
function rateOk(ip, cost) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: 30, at: now }; buckets.set(ip, b); }
  b.tokens = Math.min(30, b.tokens + (now - b.at) / 2000); // +1 token / 2s
  b.at = now;
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}
setInterval(() => { // GC buckets
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [ip, b] of buckets) if (b.at < cutoff) buckets.delete(ip);
}, 5 * 60 * 1000).unref();

// ---------- trusted content lookup (client may only name known ids) ----------
function trustedConfig(contentId, kind) {
  if (!contentId || typeof contentId !== 'string' || contentId.length > 64) return null;
  const j = Content.JOURNEY.find(l => l.id === contentId);
  if (j) return j;
  const c = Content.CHALLENGES.find(l => l.id === contentId);
  if (c) return c;
  const p = Content.PRACTICE.find(l => l.id === contentId);
  if (p) return p;
  if (Content.SCORE_CHASE.id === contentId) return Content.SCORE_CHASE;
  const m = /^daily-(\d{4}-\d{2}-\d{2})$/.exec(contentId);
  if (m && !Number.isNaN(Date.parse(m[1] + 'T00:00:00Z'))) return Content.dailyConfig(m[1]);
  const t = Content.tutorialLessons().find(l => l.cfg.id === contentId);
  if (t) return t.cfg;
  return null;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- API ----------
async function handleApi(req, res, url, ip) {
  if (!rateOk(ip, 1)) return json(res, 429, { error: 'rate-limited' });

  if (req.method === 'GET' && url.pathname === '/api/v1/time') {
    return json(res, 200, { now: Date.now() });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/daily') {
    const date = Content.utcDateString(Date.now());
    const cfg = Content.dailyConfig(date);
    return json(res, 200, { config: cfg });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/leaderboard') {
    const boards = loadJson(BOARD_FILE, { entries: [] });
    const board = url.searchParams.get('board') || 'global';
    const entries = boards.entries.filter(e => e.board === board).slice(0, 200);
    // tie order: score, fewer invalid, lower elapsed, stable session id
    entries.sort((a, b) =>
      b.score - a.score ||
      (a.invalid || 0) - (b.invalid || 0) ||
      (a.durationMs || 0) - (b.durationMs || 0) ||
      String(a.sessionId).localeCompare(String(b.sessionId)));
    return json(res, 200, { board, entries: entries.slice(0, 50) });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/score') {
    if (!rateOk(ip, 4)) return json(res, 429, { error: 'rate-limited' });
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { return json(res, 400, { error: 'bad-json' }); }
    const env = body && body.envelope;
    const board = String((body && body.board) || 'global').slice(0, 80);
    const name = String((body && body.name) || 'Guest').slice(0, 24);
    if (!env) return json(res, 400, { error: 'missing-envelope' });
    const cfg = trustedConfig(env.contentId, env.kind);
    if (!cfg) return json(res, 400, { error: 'unknown-content' });
    const verdict = Session.verify(cfg, env);
    if (!verdict.ok) return json(res, 422, { error: 'validation-failed', reason: verdict.reason });
    const boards = loadJson(BOARD_FILE, { entries: [] });
    const sessionId = String(env.commands.length ? env.commands[0].id : 's') + '-' + (env.seed >>> 0).toString(36);
    // Idempotent by envelope identity: same initial hash + same final hash.
    const dup = boards.entries.find(e =>
      e.board === board && e.initialHash === env.initialHash &&
      e.finalHash === verdict.finalHash && e.sessionId === String(body.sessionId || sessionId));
    if (!dup) {
      boards.entries.push({
        board, name, score: verdict.score,
        ruleset: env.contentId, contentVersion: env.contentVersion, seed: env.seed >>> 0,
        assists: body.assists || {}, durationMs: env.elapsedMs | 0,
        invalid: env.invalid | 0,
        sessionId: String(body.sessionId || sessionId).slice(0, 64),
        initialHash: env.initialHash, finalHash: verdict.finalHash,
        won: !!(env.terminal && env.terminal.won),
        at: Date.now()
      });
      if (boards.entries.length > 5000) boards.entries = boards.entries.slice(-5000);
      saveJson(BOARD_FILE, boards);
    }
    return json(res, 200, { ok: true, score: verdict.score, accepted: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/achievement') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { return json(res, 400, { error: 'bad-json' }); }
    const key = String((body && body.key) || '');
    const player = String((body && body.player) || 'guest').slice(0, 64);
    const known = Content.ACHIEVEMENTS.some(a => a.key === key);
    if (!known) return json(res, 400, { error: 'unknown-achievement' });
    const ach = loadJson(ACH_FILE, {});
    ach[player] = ach[player] || {};
    const fresh = !ach[player][key];
    ach[player][key] = ach[player][key] || Date.now(); // idempotent
    saveJson(ACH_FILE, ach);
    return json(res, 200, { ok: true, key, fresh });
  }

  return json(res, 404, { error: 'not-found' });
}

// ---------- static ----------
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || file.includes('..') ||
      file.startsWith(DATA_DIR) || path.basename(file).startsWith('.')) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = (req.socket && req.socket.remoteAddress) || 'local';
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url, ip).catch(() => json(res, 500, { error: 'server-error' }));
  } else {
    serveStatic(req, res, url);
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Blockstead server listening on http://localhost:' + PORT);
  });
}

module.exports = { server, trustedConfig };

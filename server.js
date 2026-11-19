// Retro Shot game server: lobbies, ready-up, shared options, and lockstep match relay.
// Every client runs the same deterministic simulation; the server owns the match timeline:
// it starts matches with a shared random seed, relays each wizard's inputs and choices to
// everyone in a fixed order, picks the input delay from measured pings, and checks fingerprints.
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const PROTO = 1;
const PORT = +process.env.PORT || 7777;
const TEAM_COLS = ['#ff9a2e', '#36e0ff', '#7dff5a', '#ff5ca8', '#ffd23d', '#b28bff'];
const OPT_ALLOWED = { game: ['classic', 'arsenal'], points: [3, 5, 7], rounds: [1, 2], picks: ['loser', 'both'], bot: ['easy', 'normal', 'hard'] };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const clients = new Map(); // id -> client
const lobbies = new Map(); // code -> lobby
let nextId = 1;

const LAG = +process.env.LAG || 0; // testing only: pretend every connection is this many ms away (each way)
const send = (c, m) => { const j = JSON.stringify(m); if (!LAG) { if (c.ws.readyState === 1) c.ws.send(j); return; } setTimeout(() => { if (c.ws.readyState === 1) c.ws.send(j); }, LAG); };
const cleanName = n => String(n || '').replace(/[<>]/g, '').trim().slice(0, 12) || 'Wizard';
const cleanLook = l => { if (!l || typeof l !== 'object') return {}; const o = {}; for (const k of ['shape', 'hat', 'eyes', 'gun', 'col']) if (typeof l[k] === 'string' && l[k].length < 24) o[k] = l[k]; return o; };
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c; do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (lobbies.has(c)); return c; }

function lobbyView(L) {
  return { code: L.code, state: L.state, opts: L.opts, countdown: L.countdown ? Math.max(0, Math.ceil((L.countdown - Date.now()) / 1000)) : 0,
    slots: L.slots.map(s => s.kind === 'human' ? { kind: 'human', cid: s.cid, name: clients.get(s.cid).name, look: clients.get(s.cid).look, col: s.col, ready: !!s.ready, ping: clients.get(s.cid).rtt | 0 }
      : s.kind === 'bot' ? { kind: 'bot', col: s.col, name: s.name } : { kind: 'empty' }) };
}
function broadcastLobby(L) { const v = lobbyView(L); for (const s of L.slots) if (s.kind === 'human') send(clients.get(s.cid), { t: 'lobby', lobby: v }); }
function lobbyList() { return [...lobbies.values()].filter(L => L.state === 'lobby').map(L => ({ code: L.code, n: L.slots.filter(s => s.kind === 'human').length, bots: L.slots.filter(s => s.kind === 'bot').length, game: L.opts.game, ver: (clients.get((L.slots.find(s => s.kind === 'human') || {}).cid) || {}).ver, host: (clients.get((L.slots.find(s => s.kind === 'human') || {}).cid) || {}).name || '?' })); }
function freeCol(L) { const used = L.slots.filter(s => s.kind !== 'empty').map(s => s.col); return TEAM_COLS.find(c => !used.includes(c)) || TEAM_COLS[0]; }
function humans(L) { return L.slots.filter(s => s.kind === 'human'); }

function checkStart(L) {
  if (L.state !== 'lobby') return;
  const on = L.slots.filter(s => s.kind !== 'empty'), hs = humans(L);
  const ok = on.length >= 2 && new Set(on.map(s => s.col)).size >= 2 && hs.length >= 1 && hs.every(s => s.ready);
  if (ok && !L.countdown) { L.countdown = Date.now() + 3000; L.cdTimer = setTimeout(() => startMatch(L), 3000); broadcastLobby(L); }
  else if (!ok && L.countdown) { clearTimeout(L.cdTimer); L.countdown = 0; broadcastLobby(L); }
}
function startMatch(L) {
  L.countdown = 0;
  const on = L.slots.map((s, i) => ({ s, i })).filter(o => o.s.kind !== 'empty');
  // input delay: long enough for the slowest pair of wizards' inputs to reach each other through the server
  const rtts = humans(L).map(s => clients.get(s.cid).rtt || 150).sort((a, b) => b - a);
  const worst = rtts.length > 1 ? (rtts[0] + rtts[1]) / 2 : rtts[0] / 2;
  const delay = Math.max(3, Math.min(14, Math.ceil(worst / 16.67) + 2));
  const players = on.map((o, pid) => ({ pid, slot: o.i, human: o.s.kind === 'human', cid: o.s.cid || 0, name: o.s.kind === 'human' ? clients.get(o.s.cid).name : o.s.name, look: o.s.kind === 'human' ? clients.get(o.s.cid).look : null, col: o.s.col }));
  L.state = 'match'; L.match = { seed: (Math.random() * 2 ** 31) | 0, players, delay, last: {}, hashes: {}, ended: new Set(), started: Date.now() };
  for (const p of players) if (p.human) L.match.last[p.pid] = delay - 1;
  for (const p of players) if (p.human) send(clients.get(p.cid), { t: 'start', seed: L.match.seed, players, opts: L.opts, delay, you: p.pid });
  log('match', L.code, players.map(p => p.name + (p.human ? '' : '*')).join(','), L.opts.game, 'delay', delay);
}
function endMatch(L) {
  L.state = 'lobby'; L.match = null;
  for (const s of L.slots) if (s.kind === 'human') s.ready = false;
  broadcastLobby(L);
}
function relay(L, m) { for (const p of L.match.players) if (p.human) { const c = clients.get(p.cid); if (c && c.lobby === L.code) send(c, m); } }

function leaveLobby(c) {
  const L = lobbies.get(c.lobby); c.lobby = null; if (!L) return;
  const idx = L.slots.findIndex(s => s.kind === 'human' && s.cid === c.id);
  if (idx >= 0) L.slots[idx] = { kind: 'empty' };
  if (L.match) { // the leaver's wizard becomes a bot right after their last relayed input, on every machine
    const p = L.match.players.find(q => q.cid === c.id && q.human);
    if (p) { p.human = false; p.left = true; relay(L, { t: 'left', p: p.pid, f: (L.match.last[p.pid] || 0) + 1 }); }
    if (!L.match.players.some(q => q.human)) endMatch(L);
  }
  if (!humans(L).length) { clearTimeout(L.cdTimer); lobbies.delete(L.code); log('lobby closed', L.code); return; }
  checkStart(L); broadcastLobby(L);
}

function handle(c, m) {
  switch (m.t) {
    case 'hello':
      if (m.v !== PROTO) return send(c, { t: 'err', msg: 'This game version is too old or new for the server - update the game.' });
      c.name = cleanName(m.name); c.look = cleanLook(m.look); c.ver = String(m.ver || '?').slice(0, 12); c.ok = true;
      return send(c, { t: 'welcome', id: c.id, lobbies: lobbyList().filter(L => L.ver === c.ver) });
    case 'ping': return send(c, { t: 'pong', ts: m.ts });
    case 'rtt': c.rtt = Math.max(1, Math.min(2000, +m.ms || 0)); return;
  }
  if (!c.ok) return;
  const L = c.lobby ? lobbies.get(c.lobby) : null;
  switch (m.t) {
    case 'list': return send(c, { t: 'lobbies', list: lobbyList().filter(L => L.ver === c.ver) });
    case 'look': c.name = cleanName(m.name); c.look = cleanLook(m.look); if (L) broadcastLobby(L); return;
    case 'create': {
      if (c.lobby) leaveLobby(c);
      const code = newCode(), N = { code, state: 'lobby', slots: [{ kind: 'human', cid: c.id, col: TEAM_COLS[0], ready: false }, { kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }], opts: { game: 'classic', points: 5, rounds: 1, picks: 'loser', bot: 'normal' }, countdown: 0 };
      lobbies.set(code, N); c.lobby = code; log('lobby', code, 'by', c.name); return broadcastLobby(N);
    }
    case 'join': {
      const T = lobbies.get(String(m.code || '').toUpperCase().trim());
      if (!T) return send(c, { t: 'err', msg: 'No lobby with that code.' });
      if (T.state !== 'lobby') return send(c, { t: 'err', msg: 'That lobby is in a match - try again when it ends.' });
      const host = humans(T).map(s => clients.get(s.cid))[0];
      if (host && host.ver !== c.ver) return send(c, { t: 'err', msg: `That lobby is on version ${host.ver} and you have ${c.ver}. Restart the game to update, then try again.` });
      const i = T.slots.findIndex(s => s.kind === 'empty');
      if (i < 0) return send(c, { t: 'err', msg: 'That lobby is full.' });
      if (c.lobby) leaveLobby(c);
      T.slots[i] = { kind: 'human', cid: c.id, col: freeCol(T), ready: false }; c.lobby = T.code;
      checkStart(T); return broadcastLobby(T);
    }
    case 'leave': return leaveLobby(c);
  }
  if (!L) return;
  if (L.state === 'lobby') {
    const me = L.slots.find(s => s.kind === 'human' && s.cid === c.id);
    switch (m.t) {
      case 'team': if (TEAM_COLS.includes(m.col)) { const s = Number.isInteger(m.slot) ? L.slots[m.slot] : me; if (s && (s === me || s.kind === 'bot')) { s.col = m.col; unready(L); } } break;
      case 'opt': if (OPT_ALLOWED[m.k] && OPT_ALLOWED[m.k].includes(m.v)) { L.opts[m.k] = m.v; unready(L); } break;
      case 'addbot': { const i = L.slots.findIndex(s => s.kind === 'empty'); if (i >= 0) { const n = L.slots.filter(s => s.kind === 'bot').length; L.slots[i] = { kind: 'bot', col: freeCol(L), name: 'Bot' + (n ? ' ' + (n + 1) : '') }; unready(L); } break; }
      case 'delbot': if (L.slots[m.slot] && L.slots[m.slot].kind === 'bot') { L.slots[m.slot] = { kind: 'empty' }; unready(L); } break;
      case 'ready': if (me) me.ready = !!m.v; break;
      default: return;
    }
    checkStart(L); return broadcastLobby(L);
  }
  // ---- in a match ----
  const P = L.match.players.find(q => q.cid === c.id && q.human);
  if (!P) return;
  switch (m.t) {
    case 'in': { // inputs arrive in order, one per frame; relay them to everyone
      const f = m.f | 0; if (f <= L.match.last[P.pid]) return; L.match.last[P.pid] = f;
      return relay(L, { t: 'in', p: P.pid, f, d: m.d });
    }
    case 'cmd': return relay(L, { t: 'cmd', p: P.pid, c: m.c });
    case 'hash': {
      const H = L.match.hashes[m.f] = L.match.hashes[m.f] || {}; H[P.pid] = m.h;
      const hs = Object.values(H), need = L.match.players.filter(q => q.human).length;
      if (hs.length >= need) { if (new Set(hs).size > 1) { log('DESYNC', L.code, 'frame', m.f, JSON.stringify(H)); relay(L, { t: 'desync', f: m.f }); } delete L.match.hashes[m.f]; }
      return;
    }
    case 'endmatch': L.match.ended.add(P.pid); if (L.match.players.filter(q => q.human).every(q => L.match.ended.has(q.pid))) endMatch(L); else send(c, { t: 'waitend' }); return;
  }
}
function unready(L) { for (const s of L.slots) if (s.kind === 'human') s.ready = false; }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`Retro Shot server OK - ${clients.size} connected, ${lobbies.size} lobbies\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
wss.on('connection', (ws, req) => {
  const c = { id: nextId++, ws, name: 'Wizard', look: {}, lobby: null, ok: false, rtt: 0, ip: req.socket.remoteAddress };
  clients.set(c.id, c);
  ws.on('message', raw => { const go = () => { let m; try { m = JSON.parse(raw); } catch (e) { return; } try { handle(c, m); } catch (e) { log('error', e && e.stack); } }; if (LAG) setTimeout(go, LAG); else go(); });
  ws.on('close', () => { if (c.lobby) leaveLobby(c); clients.delete(c.id); });
  ws.on('error', () => {});
});
// keep lobby browsers fresh and connections alive
setInterval(() => { for (const c of clients.values()) if (c.ok && !c.lobby) send(c, { t: 'lobbies', list: lobbyList().filter(L => L.ver === c.ver) }); }, 3000);
server.listen(PORT, () => log('Retro Shot server listening on', PORT));

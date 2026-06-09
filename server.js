/* =========================================================================
   NightIn — backend
   - Serves the single-page app (index.html)
   - Holds the TMDB API key server-side (never shipped to the browser)
   - Merges two players' quiz answers and fetches ONE shared deck from TMDB
   - Syncs two phones in a room over WebSocket (room codes, swipes, matches)

   Run:  TMDB_API_KEY=xxxx node server.js
   ========================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';

if (!API_KEY) {
  console.warn('[NightIn] WARNING: TMDB_API_KEY is not set — TMDB requests will fail.');
}

/* ---------------- TMDB genre maps (movie vs tv differ) ---------------- */
const MOVIE_GENRES = {
  Comedy: 35, Horror: 27, Romance: 10749, 'Sci-Fi': 878,
  Crime: 80, Fantasy: 14, Documentary: 99,
  Drama: 18, Thriller: 53, Mystery: 9648, Action: 28, Family: 10751
};
const TV_GENRES = {
  Comedy: 35, 'Sci-Fi': 10765, Crime: 80, Fantasy: 10765,
  Documentary: 99, Drama: 18, Mystery: 9648, Action: 10759, Family: 10751
};
const VIBE_MAP = {
  Chill:   { add: ['Comedy', 'Romance', 'Family'],     sort: 'vote_average.desc', minVotes: 400 },
  Laugh:   { add: ['Comedy'],                          sort: 'popularity.desc',   minVotes: 100 },
  Cry:     { add: ['Drama', 'Romance'],                sort: 'popularity.desc',   minVotes: 150 },
  Thrills: { add: ['Thriller', 'Horror', 'Action'],    sort: 'popularity.desc',   minVotes: 150 },
  Think:   { add: ['Drama', 'Mystery', 'Documentary'], sort: 'vote_average.desc', minVotes: 350 }
};
const PROVIDERS = { Netflix: 8, 'Prime': 9 };
const EXCLUDE_GENRES = '16'; // 16 = Animation (cartoons & anime) — always excluded

/* =========================================================================
   Answer merge → TMDB query spec
   Works for 1 player (solo / pass-and-play) or 2 players (two-phone room).
   ========================================================================= */
function computeSpec(list) {
  const genres = new Set(), added = new Set(), formats = new Set();
  const eras = new Set(), services = new Set();
  let runtimeLte = null;

  list.forEach(function (a) {
    (a.genres || []).forEach(function (g) { genres.add(g); });
    const v = VIBE_MAP[a.vibe] || VIBE_MAP.Chill;
    v.add.forEach(function (g) { added.add(g); });
    if (a.length === 'series') formats.add('tv'); else formats.add('movie');
    if (a.length === 'short') runtimeLte = 90;
    else if (a.energy === 'zombie' && runtimeLte == null) runtimeLte = 115;
    eras.add(a.era || 'any');
    (a.services || []).forEach(function (s) { services.add(s); });
  });

  // sort/vote-floor: use the shared vibe when both agree (or solo); else neutral
  let sort = 'popularity.desc', minVotes = 150;
  if (list.length === 1 || list[0].vibe === list[1].vibe) {
    const v = VIBE_MAP[list[0].vibe] || VIBE_MAP.Chill;
    sort = v.sort; minVotes = v.minVotes;
  }

  // era: only constrain when both pick the same (non-"any") era
  const era = eras.size === 1 ? Array.from(eras)[0] : 'any';

  // "any" (Jordan's Server) → no provider restriction
  const wantsAny = services.has('any');
  const providerIds = wantsAny ? [] :
    Array.from(services).map(function (s) { return PROVIDERS[s]; }).filter(Boolean);

  return {
    genres: Array.from(genres),
    added: Array.from(added),
    formats: Array.from(formats),
    runtimeLte: runtimeLte,
    sort: sort, minVotes: minVotes, era: era, providerIds: providerIds
  };
}

function buildParams(spec, type, relax) {
  const genreMap = type === 'movie' ? MOVIE_GENRES : TV_GENRES;
  const wanted = relax >= 2 ? [] : Array.from(new Set([].concat(spec.genres, spec.added)));
  // OR genres ('|') — broaden the mood pool rather than demand all at once
  const ids = Array.from(new Set(wanted.map(function (g) { return genreMap[g]; }).filter(Boolean)));

  let dateGte = null, dateLte = null;
  if (relax < 2) {
    if (spec.era === 'classic')      { dateLte = '1999-12-31'; }
    else if (spec.era === 'modern')  { dateGte = '2000-01-01'; dateLte = '2019-12-31'; }
    else if (spec.era === 'latest')  { dateGte = '2022-01-01'; }
  }
  const minVotes = relax >= 1 ? 50 : spec.minVotes;

  const p = new URLSearchParams();
  p.set('api_key', API_KEY);
  p.set('language', 'en-US');
  p.set('include_adult', 'false');
  p.set('without_genres', EXCLUDE_GENRES);
  p.set('sort_by', spec.sort);
  p.set('vote_count.gte', String(minVotes));
  if (ids.length) p.set('with_genres', ids.join('|'));
  if (spec.runtimeLte && type === 'movie' && relax === 0) p.set('with_runtime.lte', String(spec.runtimeLte));
  if (dateGte) p.set(type === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte', dateGte);
  if (dateLte) p.set(type === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte', dateLte);
  if (spec.providerIds.length && relax < 2) {
    p.set('with_watch_providers', spec.providerIds.join('|'));
    p.set('watch_region', 'US');
  }
  return p;
}

function normalize(raw, type) {
  return {
    id: type + '-' + raw.id,
    tmdbId: raw.id,
    type: type,
    title: raw.title || raw.name || 'Untitled',
    overview: raw.overview || '',
    poster_path: raw.poster_path || null,
    vote: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null,
    release_date: raw.release_date,
    first_air_date: raw.first_air_date
  };
}

async function discover(type, params) {
  const out = [];
  for (let page = 1; page <= 2; page++) {
    params.set('page', String(page));
    const res = await fetch(TMDB_BASE + '/discover/' + type + '?' + params.toString());
    if (!res.ok) throw new Error('TMDB ' + res.status);
    const data = await res.json();
    (data.results || []).forEach(function (r) { out.push(normalize(r, type)); });
    if (!data.results || data.results.length < 20) break;
  }
  return out;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/* Fetch a shared deck for 1 or 2 answer sets, relaxing filters if too sparse */
async function fetchDeck(answerList) {
  const spec = computeSpec(answerList);
  for (let relax = 0; relax <= 2; relax++) {
    const results = [];
    for (const type of spec.formats) {
      const found = await discover(type, buildParams(spec, type, relax));
      found.forEach(function (r) { results.push(r); });
    }
    const seen = new Set(), unique = [];
    results.forEach(function (r) { if (!seen.has(r.id)) { seen.add(r.id); unique.push(r); } });
    if (unique.length >= (relax === 0 ? 6 : 1)) {
      unique.sort(function (x, y) { return (y.poster_path ? 1 : 0) - (x.poster_path ? 1 : 0); });
      const top = unique.slice(0, 28);
      shuffle(top);
      return top.slice(0, 18);
    }
  }
  return [];
}

async function fetchTrailer(type, tmdbId) {
  try {
    const res = await fetch(TMDB_BASE + '/' + type + '/' + tmdbId + '/videos?api_key=' + API_KEY + '&language=en-US');
    if (!res.ok) return null;
    const data = await res.json();
    const vids = (data.results || []).filter(function (v) { return v.site === 'YouTube'; });
    const tr = vids.find(function (v) { return v.type === 'Trailer'; }) ||
               vids.find(function (v) { return v.type === 'Teaser'; }) || vids[0];
    return tr ? 'https://www.youtube.com/watch?v=' + tr.key : null;
  } catch (e) { return null; }
}

/* =========================================================================
   HTTP server — static app + JSON API (used by solo / pass-and-play mode)
   ========================================================================= */
const INDEX = path.join(__dirname, 'index.html');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve) {
    let data = '';
    req.on('data', function (c) { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', function () { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://localhost');

  // --- API: build a deck from one or more answer sets ---
  if (url.pathname === '/api/deck' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const list = Array.isArray(body.answers) ? body.answers : [body.answers].filter(Boolean);
      if (!list.length) return sendJson(res, 400, { error: 'no answers' });
      const titles = await fetchDeck(list);
      return sendJson(res, 200, { titles: titles });
    } catch (e) {
      return sendJson(res, 502, { error: 'TMDB request failed: ' + e.message });
    }
  }

  // --- API: trailer lookup ---
  if (url.pathname === '/api/trailer' && req.method === 'GET') {
    const type = url.searchParams.get('type'), id = url.searchParams.get('id');
    const trailerUrl = await fetchTrailer(type, id);
    return sendJson(res, 200, { url: trailerUrl });
  }

  // --- static: only ever serve the SPA ---
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(INDEX, function (err, buf) {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

/* =========================================================================
   WebSocket rooms — two-phone live sync
   ========================================================================= */
const wss = new WebSocketServer({ server: server, path: '/ws' });
const rooms = new Map();   // code -> room

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
function makeCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(c));
  return c;
}

function newRoom(code) {
  return {
    code: code,
    sockets: { 1: null, 2: null },
    answers: { 1: null, 2: null },
    likes: { 1: new Set(), 2: new Set() },
    done: { 1: false, 2: false },
    deck: [],
    deckById: {},
    round: 0,
    busy: false   // guards concurrent deck/result builds
  };
}

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) { send(room.sockets[1], obj); send(room.sockets[2], obj); }
function peerOf(room, n) { return room.sockets[n === 1 ? 2 : 1]; }

async function maybeBuildDeck(room) {
  if (room.busy) return;
  if (!room.answers[1] || !room.answers[2]) return;
  room.busy = true;
  try {
    broadcast(room, { t: 'status', msg: 'Finding films you’ll both love…' });
    const titles = await fetchDeck([room.answers[1], room.answers[2]]);
    setDeck(room, titles);
    if (!titles.length) {
      broadcast(room, { t: 'error', msg: 'No titles matched your combined moods. Try again.' });
    } else {
      room.round++;
      broadcast(room, { t: 'deck', titles: titles, round: room.round });
    }
  } catch (e) {
    broadcast(room, { t: 'error', msg: 'Could not reach TMDB: ' + e.message });
  } finally {
    room.busy = false;
  }
}

function setDeck(room, titles) {
  room.deck = titles;
  room.deckById = {};
  titles.forEach(function (t) { room.deckById[t.id] = t; });
  room.likes = { 1: new Set(), 2: new Set() };
  room.done = { 1: false, 2: false };
}

function maybeResult(room) {
  if (!room.done[1] || !room.done[2]) return;
  const a = room.likes[1], b = room.likes[2];
  const matchIds = Array.from(a).filter(function (id) { return b.has(id); });
  const matches = matchIds.map(function (id) { return room.deckById[id]; }).filter(Boolean);

  if (matches.length) {
    broadcast(room, { t: 'result', kind: matches.length === 1 ? 'single' : 'multi', matches: matches });
  } else {
    const either = room.deck.filter(function (t) { return a.has(t.id) || b.has(t.id); });
    either.sort(function (x, y) { return (y.vote || 0) - (x.vote || 0); });
    broadcast(room, { t: 'result', kind: 'none', miss: either[0] || null });
  }
}

function startReswipe(room) {
  if (room.busy) return;
  const a = room.likes[1], b = room.likes[2];
  const nearMiss = room.deck.filter(function (t) {
    const la = a.has(t.id), lb = b.has(t.id);
    return (la || lb) && !(la && lb);
  });
  let deck = nearMiss.length >= 2 ? nearMiss.slice() : room.deck.slice();
  shuffle(deck);
  setDeck(room, deck);
  room.round++;
  broadcast(room, { t: 'deck', titles: deck, round: room.round });
}

wss.on('connection', function (ws) {
  ws.roomCode = null; ws.player = null;

  ws.on('message', function (raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'create') {
      const code = makeCode();
      const room = newRoom(code);
      room.sockets[1] = ws;
      rooms.set(code, room);
      ws.roomCode = code; ws.player = 1;
      send(ws, { t: 'created', room: code, player: 1 });
      return;
    }

    if (m.t === 'join') {
      const room = rooms.get(String(m.room || '').toUpperCase());
      if (!room) return send(ws, { t: 'join-error', msg: 'Room not found' });
      if (room.sockets[2]) return send(ws, { t: 'join-error', msg: 'Room is full' });
      room.sockets[2] = ws;
      ws.roomCode = room.code; ws.player = 2;
      send(ws, { t: 'joined', room: room.code, player: 2 });
      broadcast(room, { t: 'both-here' });   // both phones → start quizzes
      return;
    }

    const room = ws.roomCode && rooms.get(ws.roomCode);
    if (!room) return;

    if (m.t === 'answers') {
      room.answers[ws.player] = m.answers || {};
      send(peerOf(room, ws.player), { t: 'peer-ready' });
      maybeBuildDeck(room);
      return;
    }

    if (m.t === 'done') {
      (m.likes || []).forEach(function (id) { room.likes[ws.player].add(id); });
      room.done[ws.player] = true;
      send(peerOf(room, ws.player), { t: 'peer-done' });
      maybeResult(room);
      return;
    }

    if (m.t === 'reswipe') { startReswipe(room); return; }

    if (m.t === 'pick') { broadcast(room, { t: 'picked', titleId: m.titleId }); return; }

    if (m.t === 'restart') {
      room.answers = { 1: null, 2: null };
      setDeck(room, []);
      room.round = 0;
      broadcast(room, { t: 'both-here' });
      return;
    }
  });

  ws.on('close', function () {
    const room = ws.roomCode && rooms.get(ws.roomCode);
    if (!room) return;
    if (ws.player) room.sockets[ws.player] = null;
    const peer = peerOf(room, ws.player);
    if (peer) send(peer, { t: 'peer-left' });
    if (!room.sockets[1] && !room.sockets[2]) rooms.delete(room.code);
  });
});

server.listen(PORT, function () {
  console.log('[NightIn] listening on http://0.0.0.0:' + PORT + (API_KEY ? '' : '  (no TMDB key!)'));
});

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
  Think:   { add: ['Drama', 'Mystery', 'Documentary'], sort: 'vote_average.desc', minVotes: 350 },
  Any:     { add: [],                                  sort: 'popularity.desc',   minVotes: 150 }
};
const PROVIDERS = { Netflix: 8, 'Prime': 9 };
const REGION = process.env.TMDB_REGION || 'US';
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
    if (a.length === 'series') formats.add('tv');
    else if (a.length === 'any') { formats.add('movie'); formats.add('tv'); }
    else formats.add('movie');
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

  // services: 'any' (or nothing picked) → no filter at all;
  // 'server' (Jordan's Server) → include/limit to what's downloaded on the NAS;
  // named providers (Netflix/Prime) → TMDB watch-provider filter.
  const anything = services.has('any') || services.size === 0;
  const wantsServer = services.has('server');
  const providerIds = anything ? [] :
    Array.from(services).map(function (s) { return PROVIDERS[s]; }).filter(Boolean);
  const serverOnly = !anything && wantsServer && providerIds.length === 0;

  return {
    genres: Array.from(genres),
    added: Array.from(added),
    formats: Array.from(formats),
    runtimeLte: runtimeLte,
    sort: sort, minVotes: minVotes, era: era,
    providerIds: providerIds, anything: anything,
    wantsServer: wantsServer, serverOnly: serverOnly
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
    p.set('watch_region', REGION);
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

/* =========================================================================
   Radarr / Sonarr — what's on Jordan's server + sending downloads
   All optional: if the URL/key env vars aren't set, these no-op and the deck
   falls back to plain TMDB discovery.
   ========================================================================= */
const RADARR = { url: (process.env.RADARR_URL || '').replace(/\/+$/, ''), key: process.env.RADARR_API_KEY || '' };
const SONARR = { url: (process.env.SONARR_URL || '').replace(/\/+$/, ''), key: process.env.SONARR_API_KEY || '' };
const radarrOn = function () { return !!(RADARR.url && RADARR.key); };
const sonarrOn = function () { return !!(SONARR.url && SONARR.key); };

// our quiz genre labels -> the genre name strings Radarr/Sonarr store
const GENRE_NAMES = {
  Comedy: 'Comedy', Horror: 'Horror', Romance: 'Romance', 'Sci-Fi': 'Science Fiction',
  Crime: 'Crime', Fantasy: 'Fantasy', Documentary: 'Documentary', Drama: 'Drama',
  Thriller: 'Thriller', Mystery: 'Mystery', Action: 'Action', Family: 'Family'
};

async function arrFetch(base, key, apiPath, opts) {
  const ctrl = new AbortController();
  const to = setTimeout(function () { ctrl.abort(); }, 7000);
  try {
    const res = await fetch(base + apiPath, Object.assign({
      signal: ctrl.signal,
      headers: Object.assign({ 'X-Api-Key': key, 'Content-Type': 'application/json' }, (opts && opts.headers) || {})
    }, opts || {}));
    if (!res.ok) throw new Error(apiPath + ' -> HTTP ' + res.status);
    return res.status === 204 ? null : await res.json();
  } finally { clearTimeout(to); }
}

// extract a TMDB-style poster_path (/abc.jpg) from a Radarr/Sonarr image URL
function posterPathFromImages(images) {
  if (!Array.isArray(images)) return null;
  const p = images.find(function (i) { return i.coverType === 'poster'; });
  const url = p ? (p.remoteUrl || p.url || '') : '';
  const m = url.match(/\/t\/p\/[^/]+(\/[^?]+)/);
  return m ? m[1] : null;
}

// cached library snapshots (refreshed lazily every few minutes)
const lib = { radarr: null, sonarr: null, ts: 0 };
const LIB_TTL = 5 * 60 * 1000;

async function refreshLibrary() {
  if (lib.ts && Date.now() - lib.ts < LIB_TTL) return;
  let failed = false;
  if (radarrOn()) {
    try {
      const movies = await arrFetch(RADARR.url, RADARR.key, '/api/v3/movie');
      const byTmdb = new Map(), list = [];
      (movies || []).forEach(function (m) {
        const e = {
          id: m.id, tmdbId: m.tmdbId, title: m.title, year: m.year, hasFile: !!m.hasFile,
          monitored: !!m.monitored, genres: m.genres || [], runtime: m.runtime || 0,
          overview: m.overview || '', poster_path: posterPathFromImages(m.images),
          vote: m.ratings && m.ratings.value ? Math.round(m.ratings.value * 10) / 10 : null
        };
        if (m.tmdbId) byTmdb.set(m.tmdbId, e);
        list.push(e);
      });
      lib.radarr = { byTmdb: byTmdb, list: list };
    } catch (e) { failed = true; console.warn('[Radarr] refresh failed:', e.message); }
  }
  if (sonarrOn()) {
    try {
      const series = await arrFetch(SONARR.url, SONARR.key, '/api/v3/series');
      const byTmdb = new Map(), byTitle = new Map(), list = [];
      (series || []).forEach(function (s) {
        const epFiles = s.statistics ? (s.statistics.episodeFileCount || 0) : 0;
        const e = {
          id: s.id, tmdbId: s.tmdbId || null, tvdbId: s.tvdbId || null, title: s.title, year: s.year,
          hasFile: epFiles > 0, monitored: !!s.monitored, genres: s.genres || [],
          overview: s.overview || '', poster_path: posterPathFromImages(s.images),
          vote: s.ratings && s.ratings.value ? Math.round(s.ratings.value * 10) / 10 : null
        };
        if (s.tmdbId) byTmdb.set(s.tmdbId, e);
        byTitle.set((s.title || '').toLowerCase() + '|' + (s.year || ''), e);
        list.push(e);
      });
      lib.sonarr = { byTmdb: byTmdb, byTitle: byTitle, list: list };
    } catch (e) { failed = true; console.warn('[Sonarr] refresh failed:', e.message); }
  }
  // a failed refresh (e.g. transient Radarr 500) retries after 30s
  // instead of leaving the deck badge-less for the whole TTL
  lib.ts = failed ? Date.now() - (LIB_TTL - 30 * 1000) : Date.now();
}

function yearNum(t) {
  const d = t.release_date || t.first_air_date || '';
  return d ? parseInt(d.slice(0, 4), 10) : null;
}

// 'downloaded' | 'library' | 'available' | null (media not configured)
function availabilityFor(t) {
  if (t.type === 'movie') {
    if (!radarrOn() || !lib.radarr) return null;
    const e = lib.radarr.byTmdb.get(t.tmdbId);
    if (!e) return 'available';
    return e.hasFile ? 'downloaded' : 'library';
  }
  if (!sonarrOn() || !lib.sonarr) return null;
  let e = lib.sonarr.byTmdb.get(t.tmdbId);
  if (!e) e = lib.sonarr.byTitle.get((t.title || '').toLowerCase() + '|' + (yearNum(t) || ''));
  if (!e) return 'available';
  return e.hasFile ? 'downloaded' : 'library';
}

function wantedGenreNames(spec) {
  const names = new Set();
  [].concat(spec.genres, spec.added).forEach(function (g) {
    if (GENRE_NAMES[g]) names.add(GENRE_NAMES[g].toLowerCase());
  });
  return names;
}
function eraOk(year, era) {
  if (!year) return true;
  if (era === 'classic') return year <= 1999;
  if (era === 'modern') return year >= 2000 && year <= 2019;
  if (era === 'latest') return year >= 2022;
  return true;
}

// downloaded library items matching tonight's mood, as deck-shaped titles
function libraryMatches(spec, ignoreGenres) {
  const out = [];
  const names = wantedGenreNames(spec);
  const needGenre = !ignoreGenres && names.size > 0;
  const matchGenre = function (genres) { return genres.some(function (g) { return names.has((g || '').toLowerCase()); }); };

  if (spec.formats.includes('movie') && radarrOn() && lib.radarr) {
    lib.radarr.list.forEach(function (m) {
      if (!m.hasFile || !m.tmdbId) return;
      if (!eraOk(m.year, spec.era)) return;
      if (spec.runtimeLte && m.runtime && m.runtime > spec.runtimeLte) return;
      if (needGenre && !matchGenre(m.genres)) return;
      out.push({
        id: 'movie-' + m.tmdbId, tmdbId: m.tmdbId, type: 'movie', title: m.title,
        overview: m.overview, poster_path: m.poster_path, vote: m.vote,
        release_date: m.year ? m.year + '-01-01' : undefined, availability: 'downloaded'
      });
    });
  }
  if (spec.formats.includes('tv') && sonarrOn() && lib.sonarr) {
    lib.sonarr.list.forEach(function (s) {
      if (!s.hasFile) return;
      if (!eraOk(s.year, spec.era)) return;
      if (needGenre && !matchGenre(s.genres)) return;
      out.push({
        id: 'tv-' + (s.tmdbId || ('tvdb' + s.tvdbId)), tmdbId: s.tmdbId, tvdbId: s.tvdbId,
        type: 'tv', title: s.title, overview: s.overview, poster_path: s.poster_path, vote: s.vote,
        first_air_date: s.year ? s.year + '-01-01' : undefined, availability: 'downloaded'
      });
    });
  }
  return out;
}

/* Fetch a shared deck for 1 or 2 answer sets.
   Server library (downloaded) is prioritised first, then downloadable TMDB
   picks fill out the deck. Filters relax if TMDB returns too little. */
async function fetchDeck(answerList) {
  const spec = computeSpec(answerList);
  await refreshLibrary().catch(function () {});

  // "Jordan's Server" only → deck comes purely from what's downloaded;
  // drop the genre filter if the mood-matched slice is too thin
  if (spec.serverOnly) {
    let mine = libraryMatches(spec, false);
    if (mine.length < 4) mine = libraryMatches(spec, true);
    return shuffle(mine).slice(0, 18);
  }

  // 1) TMDB discovery pool (with relaxation), annotated with server availability
  let tmdbPool = [];
  for (let relax = 0; relax <= 2; relax++) {
    const results = [];
    for (const type of spec.formats) {
      const found = await discover(type, buildParams(spec, type, relax));
      found.forEach(function (r) { results.push(r); });
    }
    const seen = new Set(), unique = [];
    results.forEach(function (r) { if (!seen.has(r.id)) { seen.add(r.id); unique.push(r); } });
    if (unique.length >= (relax === 0 ? 6 : 1)) { tmdbPool = unique; break; }
  }
  tmdbPool.forEach(function (t) { t.availability = availabilityFor(t); });

  // 2) downloaded library matches (server-first), merged + de-duped —
  //    only when the server is in play (Jordan's Server / Anything / no pick)
  const byId = new Map();
  if (spec.wantsServer || spec.anything) {
    libraryMatches(spec, false).forEach(function (t) { if (!byId.has(t.id)) byId.set(t.id, t); });
  }
  tmdbPool.forEach(function (t) { if (!byId.has(t.id)) byId.set(t.id, t); });
  const all = Array.from(byId.values());

  // 3) downloaded first (in swipe order), then downloadable; prefer posters in the tail
  const downloaded = shuffle(all.filter(function (t) { return t.availability === 'downloaded'; }));
  const rest = shuffle(all.filter(function (t) { return t.availability !== 'downloaded'; }));
  rest.sort(function (a, b) { return (b.poster_path ? 1 : 0) - (a.poster_path ? 1 : 0); });

  const deck = [];
  downloaded.slice(0, 14).forEach(function (t) { deck.push(t); });          // leave room for discovery
  for (const t of rest) { if (deck.length >= 18) break; deck.push(t); }
  for (const t of downloaded.slice(14)) { if (deck.length >= 18) break; deck.push(t); }
  return deck.slice(0, 18);
}

/* =========================================================================
   Send a title to Radarr / Sonarr to download
   ========================================================================= */
async function arrDefaults(base, key) {
  const profiles = await arrFetch(base, key, '/api/v3/qualityprofile');
  const roots = await arrFetch(base, key, '/api/v3/rootfolder');
  if (!profiles || !profiles.length) throw new Error('No quality profile configured');
  if (!roots || !roots.length) throw new Error('No root folder configured');
  return { qualityProfileId: profiles[0].id, rootFolderPath: roots[0].path };
}

async function addMovie(tmdbId) {
  if (!radarrOn()) throw new Error('Radarr is not configured');
  const lookup = await arrFetch(RADARR.url, RADARR.key, '/api/v3/movie/lookup?term=tmdb:' + tmdbId);
  const movie = Array.isArray(lookup) ? lookup[0] : lookup;
  if (!movie) throw new Error('Not found in Radarr');
  if (movie.id) return { ok: true, already: true, title: movie.title };
  const def = await arrDefaults(RADARR.url, RADARR.key);
  const body = Object.assign({}, movie, {
    qualityProfileId: def.qualityProfileId, rootFolderPath: def.rootFolderPath,
    monitored: true, minimumAvailability: 'released', addOptions: { searchForMovie: true }
  });
  const added = await arrFetch(RADARR.url, RADARR.key, '/api/v3/movie', { method: 'POST', body: JSON.stringify(body) });
  return { ok: true, title: added.title };
}

async function addSeries(tmdbId, title) {
  if (!sonarrOn()) throw new Error('Sonarr is not configured');
  // Sonarr keys on TVDB ids — resolve it from TMDB first
  let tvdbId = null;
  try {
    const ext = await (await fetch(TMDB_BASE + '/tv/' + tmdbId + '/external_ids?api_key=' + API_KEY)).json();
    tvdbId = ext && ext.tvdb_id;
  } catch (e) {}
  let lookup = null;
  if (tvdbId) lookup = await arrFetch(SONARR.url, SONARR.key, '/api/v3/series/lookup?term=tvdb:' + tvdbId);
  if (!lookup || !lookup.length) lookup = await arrFetch(SONARR.url, SONARR.key, '/api/v3/series/lookup?term=' + encodeURIComponent(title || ''));
  const series = (lookup || []).find(function (s) { return tvdbId && s.tvdbId === tvdbId; }) || (lookup || [])[0];
  if (!series) throw new Error('Not found in Sonarr');
  if (series.id) return { ok: true, already: true, title: series.title };
  const def = await arrDefaults(SONARR.url, SONARR.key);
  const body = Object.assign({}, series, {
    qualityProfileId: def.qualityProfileId, rootFolderPath: def.rootFolderPath,
    monitored: true, addOptions: { monitor: 'all', searchForMissingEpisodes: true }
  });
  // Sonarr v3 requires a languageProfileId; v4 ignores it
  try {
    const langs = await arrFetch(SONARR.url, SONARR.key, '/api/v3/languageprofile');
    if (langs && langs.length) body.languageProfileId = langs[0].id;
  } catch (e) {}
  const added = await arrFetch(SONARR.url, SONARR.key, '/api/v3/series', { method: 'POST', body: JSON.stringify(body) });
  return { ok: true, title: added.title };
}

/* =========================================================================
   Rotten Tomatoes (via OMDb) — optional, needs OMDB_API_KEY
   TMDB id → imdb id → OMDb ratings. Cached forever (scores barely move).
   ========================================================================= */
const OMDB_KEY = process.env.OMDB_API_KEY || '';
const ratingsCache = new Map();   // 'movie-123' -> { rt, imdb }

async function fetchRatings(type, tmdbId) {
  const ck = type + '-' + tmdbId;
  if (ratingsCache.has(ck)) return ratingsCache.get(ck);
  const out = { rt: null, imdb: null };
  if (!OMDB_KEY || !tmdbId) return out;
  try {
    const ext = await (await fetch(TMDB_BASE + '/' + type + '/' + tmdbId + '/external_ids?api_key=' + API_KEY)).json();
    const imdbId = ext && ext.imdb_id;
    if (imdbId) {
      const data = await (await fetch('https://www.omdbapi.com/?apikey=' + OMDB_KEY + '&i=' + imdbId)).json();
      const rt = (data.Ratings || []).find(function (r) { return r.Source === 'Rotten Tomatoes'; });
      out.rt = rt ? rt.Value : null;
      out.imdb = data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : null;
    }
    ratingsCache.set(ck, out);
  } catch (e) {}
  return out;
}

/* =========================================================================
   Trending — films in cinemas right now, badged with server availability
   ========================================================================= */
async function fetchTrending() {
  await refreshLibrary().catch(function () {});
  const out = [], seen = new Set();
  for (let page = 1; page <= 2; page++) {
    const res = await fetch(TMDB_BASE + '/movie/now_playing?api_key=' + API_KEY +
      '&language=en-US&region=' + REGION + '&page=' + page);
    if (!res.ok) throw new Error('TMDB ' + res.status);
    const data = await res.json();
    (data.results || []).forEach(function (r) {
      if ((r.genre_ids || []).indexOf(16) !== -1) return;   // no cartoons/anime
      if ((r.vote_average || 0) < 5.5) return;              // skip poorly-rated films
      if (seen.has(r.id)) return;
      seen.add(r.id);
      const t = normalize(r, 'movie');
      t.popularity = r.popularity || 0;
      out.push(t);
    });
  }
  out.sort(function (a, b) { return b.popularity - a.popularity; });
  out.forEach(function (t) { t.availability = availabilityFor(t); });
  return out.slice(0, 30);
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

  // --- API: Rotten Tomatoes / IMDb ratings (needs OMDB_API_KEY) ---
  if (url.pathname === '/api/ratings' && req.method === 'GET') {
    const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
    const id = Number(url.searchParams.get('id'));
    const r = await fetchRatings(type, id);
    return sendJson(res, 200, r);
  }

  // --- API: trending in cinemas ---
  if (url.pathname === '/api/trending' && req.method === 'GET') {
    try {
      const titles = await fetchTrending();
      return sendJson(res, 200, { titles: titles });
    } catch (e) {
      return sendJson(res, 502, { error: 'TMDB request failed: ' + e.message });
    }
  }

  // --- API: send a title to Radarr/Sonarr to download ---
  if (url.pathname === '/api/download' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const r = b.type === 'tv'
        ? await addSeries(Number(b.tmdbId), b.title || '')
        : await addMovie(Number(b.tmdbId));
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
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

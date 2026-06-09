# NightIn 🎬🍿

A couples' movie & TV picker. Two of you each take a quick quiz on your **own
phone**, the app merges your moods, pulls one shared deck from TMDB, you both
swipe, and the **matches pop up on both screens** — no more "what do you want to
watch?"

- **Two-phone mode** — room code, each does their own quiz, live-synced deck & matches.
- **Same-phone mode** — pass-and-play on one device (shared quiz, take turns swiping).
- No accounts, no database. The TMDB key lives only on the server.
- Cartoons & anime are filtered out. Streaming filter: **Netflix**, **Prime**, or
  **Anything (Jordan's Server)** = no filter.

## How it works

```
Phone A ──┐
          ├──► NightIn server (room code) ──► TMDB ──► one shared deck
Phone B ──┘        merges both quizzes, collects both players' swipes,
                   reveals matches to both phones at once
```

The browser talks to the server over WebSocket; the server holds the TMDB key
and does all the TMDB calls.

## Run locally

```bash
npm install
TMDB_API_KEY=your_tmdb_v3_key node server.js
# open http://localhost:8080
```

Get a free TMDB v3 key at https://www.themoviedb.org/settings/api.

## Deploy on Synology / Portainer

1. Copy this folder to the NAS (e.g. `/volume1/docker/nightin`).
2. Portainer → **Stacks → Add stack**.
3. **Web editor**: paste `docker-compose.yml` (or use **Upload** / **Repository**).
4. Set `TMDB_API_KEY` in the stack's environment (it's pre-filled in the compose
   file — change it there or override it as a stack env var).
5. Deploy. Browse to `http://<NAS-IP>:8024`.

To reach it from phones on the same Wi-Fi, just use the NAS IP. For use away from
home, put it behind your existing reverse proxy / HTTPS — the client auto-uses
`wss://` when served over HTTPS.

### Files

| File | Purpose |
|------|---------|
| `index.html` | The entire front-end (UI, swipe deck, screens) |
| `server.js` | Node server: static host + `/api/deck` + `/api/trailer` + `/ws` room sync |
| `Dockerfile` | `node:20-alpine` image |
| `docker-compose.yml` | Portainer stack (set `TMDB_API_KEY`, host port) |

### Notes

- The app is served by the Node server (it needs the backend for the TMDB key and
  two-phone sync) — opening `index.html` directly from disk won't work.
- Rooms live in memory; restarting the container clears any in-progress rooms.

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

### Optional: connect Radarr & Sonarr

Set these (env vars or Portainer) to make the deck prioritise what's already
**downloaded** on your server, badge each card (▶ on server / ＋ can download),
and let a match be sent to Radarr/Sonarr with one tap:

```
RADARR_URL=http://<NAS-IP>:7878
RADARR_API_KEY=...        # Radarr → Settings → General → API Key
SONARR_URL=http://<NAS-IP>:8989
SONARR_API_KEY=...        # Sonarr → Settings → General → API Key
```

Use the NAS **LAN IP**, not `localhost`, so the container can reach them. Leave
unset and the app behaves exactly as before (plain TMDB picks, no badges). New
downloads use each app's **first** quality profile and root folder.

## Deploy on Synology / Portainer (prebuilt image — no NAS-side build)

A GitHub Action (`.github/workflows/docker-publish.yml`) builds the image on
every push to `main` and publishes it to **GHCR** at
`ghcr.io/jordanperkins98/nightin:latest`. The NAS only *pulls* it.

**One-time setup**

1. Push to `main` (or run the workflow from the **Actions** tab). Wait for the
   "Build & publish image" run to go green.
2. Make the package pullable by the NAS. On GitHub → your profile →
   **Packages → nightin → Package settings**: either set **visibility = Public**
   (simplest for a home NAS), or keep it private and add a GHCR pull token in
   Portainer (Personal Access Token with `read:packages`).

**Deploy the stack**

3. Portainer → **Stacks → Add stack**, build method **Repository**:
   - **Repository URL:** `https://github.com/jordanperkins98/Nightin`
   - **Compose path:** `docker-compose.yml`
4. **Environment variables** → add `TMDB_API_KEY` = your TMDB v3 key.
5. Deploy. Browse to `http://<NAS-IP>:8024`.

**Updating later:** push to `main` → wait for the Action → in Portainer open the
stack and hit **Pull and redeploy** (the image uses `pull_policy: always`).

To reach it from phones on the same Wi-Fi, use the NAS IP. For use away from
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

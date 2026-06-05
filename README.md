# Chess Open World

A colorful, open-world multiplayer chess **MMO** — built around an
authoritative, zoned world server (the hard part of any MMO) with a
data-driven rules engine and an isometric web client.

This repo is the **step-4 architecture vertical slice**: it runs, it's tested,
and every load-bearing seam an MMO needs is present. It is a foundation to
*harden into scale*, not a finished product.

> 📖 **New here? Read [CONCEPTS.md](./CONCEPTS.md)** — a guided tour of every
> idea in the game: the world, zones, interest management, the chess engine,
> data-driven pieces and effects, seats, the camera, persistence, and how to
> extend it. The rest of this file is about running and deploying.

## What's here

```
packages/
  engine/     Deterministic, data-driven chess rules. Pure & unit-tested.
  protocol/   Shared client/server wire types + world constants.
  server/     Authoritative zoned world: interest management, tick sim, persistence.
  client/     Isometric (2.5D) PixiJS web client.
```

### The four MMO seams (why this is "step 4", not a toy)

1. **Authoritative server** — clients send *intents*; the server validates
   everything with the engine and owns all state. Nothing is trusted.
   (`server/src/world.ts`, `tryBoardMove`)
2. **Spatial partitioning** — every entity is indexed by **zone**, so "what's
   near this player" is a ~9-zone lookup, not a world scan. This is where zones
   later move to separate processes/machines. (`protocol` `zoneOf` / `interestZones`)
3. **Interest management** — each tick, every player gets only the *changes* to
   their interest set (`enter` / `leave` / `move`). This is what lets an MMO
   show many entities without broadcasting the whole world. (`server/src/server.ts` `step`)
4. **Persistence** — the world snapshots to disk and reloads on boot. Swap the
   JSON file for Postgres (Nakama's model) to scale. (`server/src/persistence.ts`)

### Data-driven rules (your differentiator)

Pieces are **data**, not hardcoded logic — `rides` (sliders) + `hops` (leapers).
A custom "amazon" (queen + knight) is a few lines in a `PieceRegistry`, no engine
changes. Skins are cosmetic-only and never touch rules, so the world can be as
colorful and custom as you like (pieces, buildings, artifacts).

## Run it on your machine

### 1. Prerequisites

- **Node.js 20 or newer** (22 LTS recommended) and **npm 10+**.
  Check with `node -v` && `npm -v`. If you don't have it, install from
  <https://nodejs.org> (the LTS installer) or via `nvm install --lts`.
- A modern browser (Chrome, Edge, Firefox, or Safari).
- That's it — no database, Docker, or accounts needed to run locally.

### 2. Get the code & install

```bash
git clone https://github.com/bondarchukb/chess-openworld.git
cd chess-openworld
npm install            # installs all four packages (npm workspaces)
```

### 3. Start everything with one command

```bash
npm run dev
```

This builds the shared `protocol` package, then launches **both** halves together
(color-tagged in your terminal):

- `server` — the world server on `ws://localhost:8080`
- `client` — the web client on `http://localhost:5173`

Open **<http://localhost:5173>** in your browser. You should see a colorful
isometric world with a chess board in the middle. The HUD (top-left) shows your
connection status and the board state.

> Prefer two terminals? Run the halves separately:
> ```bash
> npm run start -w @chess-openworld/server   # world server  (:8080)
> npm run dev   -w @chess-openworld/client   # web client    (:5173)
> ```

### 4. Play with a friend (or yourself)

Open a **second browser tab** at <http://localhost:5173>. You're now two players
in the same world — walk apart and watch each other appear/disappear (interest
management), or both press **Enter** at the board to play a real game of chess.

### 5. Stop it

Press **Ctrl-C** in the terminal. The server saves the world to
`packages/server/world.save.json` on exit and reloads it next time — so your
buildings, artifacts, and the board state persist across restarts. Delete that
file to start fresh.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| HUD says `disconnected` | The server isn't running or `:8080` is blocked. Make sure `npm run dev` shows the `server` line; restart it. |
| `EADDRINUSE :8080` or `:5173` | Another process owns the port. Stop it, or run the server on another port: `PORT=8090 npm run start -w @chess-openworld/server` (the client dev proxy expects 8080, so also update `packages/client/vite.config.ts` if you change it). |
| Blank page / nothing renders | Hard-refresh (Ctrl-Shift-R). Check the browser console for errors. |
| `npm install` fails | Confirm Node 20+ (`node -v`); delete `node_modules` and retry. |
| Want a clean world | Delete `packages/server/world.save.json` and restart. |

### Controls & how to play

Controls: **WASD / arrows** to walk · **drag** to roam the camera anywhere on
the map · **scroll** to zoom · **C** to recenter · **B** place a building ·
**F** place an artifact · **Enter** to take a seat at the board · **click** a
piece then a square to move it · **N** for a new game once one ends.

The shared chess board sits at the center of the world. The first two players to
press **Enter** become White and Black; only the seated player may move on their
turn. Drop a **building** on a board square to wall it off, or an **artifact**
next to the board to grant nearby pieces extra knight-like moves — terrain and
artifacts genuinely change the rules. Open two browser tabs to see real-time
sync, interest culling, and a two-player game.

**Lightning skin shop (mock).** The panel in the bottom-right sells cosmetic
avatar skins for sats. Click **Buy**, then **Simulate payment (mock)** — the
server only grants the skin once the (mock) Lightning invoice settles, then
**Equip** it to change how your avatar looks to everyone. Purchases are tied to a
per-browser `accountId` and persist across restarts. It's a real, end-to-end
purchase→entitlement→equip flow with a **mock** payment provider; swap
`packages/server/src/payments.ts` for BTCPay/LNbits/a hosted API to go live. See
[CONCEPTS.md §Monetization](./CONCEPTS.md) for the design and the legal caveats.

## Test

```bash
npm test            # engine unit tests + server integration test
```

The server integration test proves the architecture end-to-end: two players
see each other when near, get culled when far apart, and the shared board
rejects illegal moves while applying & broadcasting legal ones.

## Deploy

The app is two pieces with two different hosting needs:

| Piece | Nature | Where it can run |
| --- | --- | --- |
| **client** | static files | Vercel, Netlify, any static host ✅ |
| **server** | long-lived stateful WS process + tick loop | Render / Fly / Railway / VM ✅ — **not** Vercel ❌ |

> **Why not all on Vercel?** Vercel is serverless: functions are short-lived
> and stateless. The game server holds the whole world in memory, runs a 10 Hz
> tick loop, and keeps sockets open — none of which survives in a serverless
> function. So the client goes on Vercel; the server goes on a persistent host.

**1. Server → Render** (free tier, WebSocket-friendly). Push to GitHub, then in
Render: *New → Blueprint*, pick this repo. `render.yaml` + `Dockerfile` do the
rest; health checks hit `/health`. You'll get a URL like
`https://chess-openworld-server.onrender.com`.

You can also run the server image anywhere Docker runs:

```bash
docker build -t chess-openworld-server .
docker run -p 8080:8080 chess-openworld-server   # health: http://localhost:8080/health
```

**2. Client → Vercel.** Import the repo (root); `vercel.json` sets the build.
Add an env var **`VITE_WS_URL`** = your server's `wss://…` URL (the Render URL
above, with `wss://`). Redeploy and the client connects to your live server.

> Note: the free server uses ephemeral disk, so the JSON world save resets on
> redeploy/restart. Swap `persistence.ts` for Postgres for durable state.

## Implemented vs. remaining

**Done:** full standard chess (castling, en passant, under-promotion, checkmate /
stalemate / 50-move draw); data-driven board effects (walls + auras) wired from
world entities; seats + turn ownership; structure collision; UUID ids;
tick-gated authoritative movement; full-state persistence; new-game flow.

**Remaining:**

- Threefold-repetition draw (needs position history) and a chess clock.
- Multiple boards / match instances (only one shared board today).
- More effect types and real piece skins (the `skin` field is plumbed but the
  client still draws one glyph per piece type).
- Client-side interpolation + prediction for smooth movement.
- Sharded zones (**Nakama** or custom Node + Redis/Postgres) with player handoff
  at zone borders; accounts, matchmaking, chat, and durable Postgres storage.

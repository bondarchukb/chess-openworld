# Chess Open World

A colorful, open-world multiplayer chess **MMO** — built around an
authoritative, zoned world server (the hard part of any MMO) with a
data-driven rules engine and an isometric web client.

This repo is the **step-4 architecture vertical slice**: it runs, it's tested,
and every load-bearing seam an MMO needs is present. It is a foundation to
*harden into scale*, not a finished product.

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

## Run it

```bash
npm install

# Terminal 1 — the world server (ws://localhost:8080)
npm run start -w @chess-openworld/server

# Terminal 2 — the isometric client (http://localhost:5173)
npm run dev -w @chess-openworld/client
```

Controls: **WASD / arrows** to walk the world · **B** place a building ·
**F** place an artifact. Open two browser tabs to see real-time multiplayer
sync and interest culling as you walk apart. The shared chess board sits at
the center of the world — moves are validated server-side by the engine.

## Test

```bash
npm test            # engine unit tests + server integration test
```

The server integration test proves the architecture end-to-end: two players
see each other when near, get culled when far apart, and the shared board
rejects illegal moves while applying & broadcasting legal ones.

## Roadmap to real scale

This slice is single-process. To grow it (in order):

- Move zones onto a sharded backend (**Nakama** or custom Node + Redis/Postgres)
  with player handoff at zone borders.
- Client-side interpolation + prediction/reconciliation for smooth movement.
- Accounts, matchmaking, chat, anti-cheat (the engine already gives you
  server-side validation, the backbone of anti-cheat).
- Richer variant rules, artifacts, and buildings via the `PieceRegistry` seam.
```

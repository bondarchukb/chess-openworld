# Chess Open World — Concepts

A guided tour of every idea in the game, from the big picture down to "how would
I add a new piece." No prior game-dev knowledge assumed. Code references point at
the file where each idea lives.

---

## 1. The big picture: two programs that never trust each other

The game is **two programs** plus a **shared dictionary**:

```
   browser tab                         one Node.js process
 ┌──────────────┐   WebSocket (JSON)  ┌──────────────────────┐
 │   client     │  ─── intents ────▶  │       server         │
 │ (PixiJS UI)  │  ◀── updates ─────  │  (the whole world)   │
 └──────────────┘                     └──────────────────────┘
        │                                       │
        └──────────── protocol ─────────────────┘
              (shared TypeScript types)
```

- **Client** (`packages/client`) draws the world and reads your keyboard/mouse.
  It is deliberately "dumb": it never decides what is true. It sends **intents**
  ("I want to step left", "I want to move this piece") and draws whatever the
  server reports back.
- **Server** (`packages/server`) owns the single source of truth — the entire
  world lives in its memory. It **validates** every intent and tells each client
  only what they need to know.
- **Protocol** (`packages/protocol`) is the shared set of message shapes both
  sides import, so they can never disagree about the wire format.
- **Engine** (`packages/engine`) is the pure chess-rules library the server uses
  to decide whether a move is legal.

This "client proposes, server decides" model is called **server-authoritative**,
and it's the foundation of any multiplayer game that cares about cheating. (More
in §8.)

---

## 2. The world: a big grid of tiles

The world is a 2-D grid of **tiles** — currently `192 × 192` (`protocol` `WORLD`).
Every position is a tile coordinate `(x, y)`:

- `x` = column (west→east), `y` = row (north→south).
- The shared chess board sits at the **center** of the world.

The client draws this grid **isometrically** — tiles are drawn as diamonds (2:1
width:height) instead of squares, and taller things (pieces, buildings) are drawn
as upright sprites on top. That "2.5D" look gives depth and a colorful, non-chess-
board feel without any real 3-D engine. The math that turns a tile `(x, y)` into a
screen pixel lives in `client/src/iso.ts` (`isoToScreen`), and the inverse —
turning a mouse click back into a tile — is `screenToIso`.

---

## 3. Entities: everything that lives on a tile

Anything in the world is an **Entity** (`protocol` `Entity`) with an `id`, a
`kind`, and a position. There are four kinds:

| Kind | What it is | Notes |
| --- | --- | --- |
| `player` | a connected person's avatar | one per browser tab |
| `piece` | a chess piece | (the board pieces are sent separately, see §7) |
| `building` | a colorful structure | **solid** — blocks movement, walls off board squares |
| `artifact` | a magical object | projects an **aura** that changes nearby rules |

Entities get **UUID ids** (`world.ts` `makeId`) so two of them can never collide,
even after a restart or across multiple servers later.

---

## 4. Zones: chopping the world into chunks

A 192×192 world has ~37,000 tiles. If every player had to hear about every entity
everywhere, the server would melt. So the world is divided into **zones** (square
chunks, `24 × 24` tiles each). Every entity is filed under the zone it sits in
(`world.ts` `zoneIndex`). Helpers `zoneOf(x, y)` and `interestZones(x, y)` live in
`protocol`.

Why it matters: answering "what's near this player?" becomes a lookup over ~9
zones instead of a scan of the whole world. This is also the **seam** where, to
scale to thousands of players, you'd move different zones onto different server
machines.

This technique is called **spatial partitioning**.

---

## 5. Interest management: only tell you what's nearby

Each player is "interested" in the **3×3 block of zones** around them (their zone
plus the 8 neighbors) — the `interestZones` set. The server only ever sends you
entities inside *your* interest set.

But it goes one step further: instead of resending everything every frame, it
sends only the **changes** since last time (`server.ts` `step`):

- `enter` — entities that just came into view,
- `move` — entities that changed position,
- `leave` — entities that left your view.

This delta stream is **interest management**, and it's the single most important
trick that lets an MMO show a busy world to many players cheaply. When you walk
away from another player and they "disappear," that's a `leave` delta.

---

## 6. The tick: the world's heartbeat

The server advances the world on a fixed clock — **10 times per second** (10 Hz,
`WORLD.tickHz`). Each "tick" (`server.ts` `step`) does the same thing for every
connected player:

1. apply that player's **one** buffered movement step (see §8),
2. compute their interest set,
3. diff it against what they last knew, and
4. send the `enter`/`leave`/`move` delta.

A fixed tick keeps the simulation deterministic and fair — everyone advances on
the same schedule, regardless of how fast their network or computer is.

---

## 7. The chess board & engine

The center of the world holds one shared, persistent **chess board**. The server
keeps its true state as an engine `GameState` and streams a `BoardSnapshot` to
nearby players (`world.ts` `boardSnapshot`). It's sent *separately* from the
entity stream because it's a structured 8×8 thing, not a free-floating entity.

### Data-driven pieces (the differentiator)

Most chess programs hard-code each piece. This engine describes movement as
**data** (`engine/src/pieces.ts`):

- **`rides`** — sliding moves along directions until blocked. A rook *rides*
  orthogonally with unlimited range; a bishop *rides* diagonally.
- **`hops`** — fixed jumps that ignore blockers. A knight *hops*; a king *hops*
  one square in any direction.

A queen is just "rides in all 8 directions." A custom **"amazon"** (queen +
knight) is a few lines — `rides` for the queen part, `hops` for the knight part —
with **zero changes** to the move generator. Pieces are registered in a
`PieceRegistry`, so a future variant can ship its own piece set. This is what
makes "colorful custom pieces" possible.

### Full standard rules

The engine (`engine/src/moves.ts`) implements real chess: pawns (single/double
step, **en passant**, **under-promotion** to any piece), **castling** (with all
the "can't castle through check" safety checks), and terminal detection —
**checkmate**, **stalemate**, and the **50-move draw** — via `status()`.

Crucially, all of this is **pure and deterministic**: same input → same output,
no randomness, no side effects. That's why it can run authoritatively on the
server and be unit-tested without any UI (`engine/test/moves.test.ts`).

---

## 8. Authority & anti-cheat

The client cannot make anything true; it can only *ask*. Two examples:

- **Board moves.** You click a piece and a square; the client sends
  `{ boardMove, from, to }`. The server runs the engine
  (`world.ts` `tryBoardMove`) and only updates the board if the move is legal,
  it's your turn, and you're in the right seat. A hacked client gains nothing.
- **Movement.** A cheating client could spam "move" messages to teleport. The
  server defends against this by **buffering** your latest direction and applying
  at most **one step per tick** (`server.ts`, the `pendingMove` field) — an
  authoritative speed limit. No matter how many messages you send, you move one
  tile per tick.

Server-side validation like this *is* the backbone of anti-cheat.

---

## 9. Board effects: terrain & artifacts that change the rules

This is what turns "chess on a map" into an open-world game. The engine's move
generator reads an optional **`BoardEffects`** (`engine/src/effects.ts`)
alongside the pieces. Today there are two effect types:

- **`blocked`** — squares that are impassable. Drop a **building** on a board
  square and that square becomes a wall: rooks and queens can't slide through it,
  nothing can land on it.
- **`grantHops`** — extra moves granted by an **aura**. Place an **artifact**
  next to the board and pieces near it gain extra knight-like jumps.

The world builds this effects object every turn from the entities sitting on or
near the board (`world.ts` `boardEffects`). The key design choice: **new effect
types are added as data**, consumed in one place in the generator — you never
special-case individual artifacts. This is the seam a future scripting/plugin
system (community-made rules) would plug into.

---

## 10. Seats & turns: who may move

The shared board is a real 2-player game, so it has two **seats**: White and
Black. The first two players to press **Enter** (`{ sit }`) claim them
(`world.ts` `claimSeat`); everyone else spectates. On a given turn, **only the
player in the seat whose turn it is** may move — anyone else's move is rejected
with "not your turn." When a game ends (checkmate/stalemate/draw), pressing **N**
(`{ newGame }`) resets the board.

---

## 11. The camera: walk, roam, and spectate

The client camera (`client/src/main.ts`) has three modes that blend together:

- **Follow** — by default the camera smoothly tracks your avatar as you walk.
- **Free-roam** — **drag** to pan and **scroll** to zoom; press **C** (or just
  walk) to snap back to your avatar.
- **Spectator focus** — here's the subtle part. The server only streams entities
  near *your avatar*. So when you drag the camera far away, the client tells the
  server "I'm looking over **here**" (`{ focus, x, y }`). The server then streams
  interest around **both** your avatar and your camera, so distant areas populate
  as you look at them. That's how you can survey the whole map, not just your own
  corner.

Rendering is kept cheap with two tricks: the ground tiles are only redrawn when
the visible window changes, and display objects are **pooled** (reused by id
instead of recreated every frame).

---

## 12. Persistence: the world remembers

When the server shuts down it writes the world to
`packages/server/world.save.json` and reloads it on the next boot
(`server/src/persistence.ts`). It saves the placed buildings/artifacts and the
**full** engine `GameState` — so castling rights, en passant, and the move clocks
survive a restart, not just piece positions. (Players and seats aren't persisted;
those belong to live connections.)

For a real deployment you'd swap the JSON file for a database (Postgres is what
the Nakama backend uses) — the `persistence.ts` module is the single seam where
that change happens.

---

## 13. The protocol: the shared language

Everything on the wire is JSON matching the types in `protocol/src/index.ts`.

**Client → Server (intents):** `join`, `move`, `place` (building/artifact),
`boardMove` (+ optional promotion), `sit`, `newGame`, `focus`, `chat`, `ping`.

**Server → Client (truth):** `welcome` (your id + world constants + board),
`snapshot` (full interest set on join), `delta` (per-tick enter/leave/move),
`board` (a fresh board snapshot), `chat`, `error`, `pong`.

Because both programs import these exact types, a typo in a message is a
*compile error*, not a mysterious runtime bug. That's the payoff of TypeScript on
both ends.

---

## 13b. Monetization: Lightning skin shop (mock)

The game sells **cosmetic avatar skins** for Bitcoin over the **Lightning
Network** (instant, sub-cent payments — on-chain BTC is too slow/expensive for
this). It's built so you can develop the whole flow with **no real money**:

**The flow** (all server-authoritative):

1. Client clicks *Buy* → `{ buySkin }`.
2. Server asks the **payment provider** for an invoice (`payments.ts`) and sends
   it back as `{ invoice, bolt11, … }`.
3. The player pays it with a Lightning wallet. (In mock mode, the *Simulate
   payment* button sends `{ devPay }`.)
4. The server confirms settlement **with the provider** — never trusting the
   client — then grants the skin and sends `{ purchased }` + an updated
   `{ wallet }`.
5. *Equip* (`{ equipSkin }`) sets the skin on the player's avatar entity, which
   re-streams to everyone nearby.

**Why it's safe & low-risk:**

- **Cosmetic only.** Skins never touch the rules (no pay-to-win), which keeps
  this clear of gambling / real-money-gaming regulation. (Wagering real BTC on
  matches would be a different, heavily-regulated beast — see the README chat.)
- **No custody.** The game never holds player balances; it charges per item.
- **Provider-agnostic.** `payments.ts` defines a `LightningProvider` interface
  with a `MockLightningProvider` for dev/tests. Swap in **BTCPay** (self-hosted,
  non-custodial), **LNbits**, or a hosted API to go live — no game-code changes.
- **Entitlements persist.** Purchases are keyed to a per-browser `accountId` and
  saved with the world, so they survive restarts.

**Going live checklist:** verify settlement via signed webhook (not the client),
make granting idempotent per invoice, start on testnet/regtest, and price in
sats. See the security notes at the top of `payments.ts`.

## 14. Why the client and server deploy differently

- The **client** is just static files (HTML/JS) — it can live on any static host
  (Vercel, Netlify, …).
- The **server** is a long-lived process that holds the world in memory, runs the
  tick loop, and keeps sockets open. It **cannot** run on a serverless platform
  (like Vercel functions), which are short-lived and stateless. It needs a
  persistent host (Render, Fly, Railway, a VM). See the README "Deploy" section.

---

## 15. How to extend it (worked examples)

**Add a custom piece** — register it; the generator already understands it:

```ts
registry.register({
  id: "archbishop",
  rides: [{ dirs: DIAGONAL, range: Infinity }], // bishop
  hops: KNIGHT_HOPS,                             // + knight
});
```

**Add a new board effect** — extend `BoardEffects` (`engine/src/effects.ts`),
consume it in `moves.ts`, and have `world.ts boardEffects()` produce it from some
entity. Example ideas: a "swamp" that halts a piece's ride early, a "portal" pair
that teleports a piece, a "shield" that makes a square un-capturable.

**Add a new entity kind / message** — add it to `protocol`, handle the intent in
`server.ts handleMessage`, render it in `client/src/main.ts`. The compiler will
walk you through every place that needs updating.

---

## 16. Glossary

- **Authoritative server** — the server is the only source of truth; clients send
  requests, never facts.
- **Tick** — one step of the fixed-rate simulation loop (10/sec here).
- **Zone / chunk** — a fixed square block of tiles used to index entities by
  location.
- **Spatial partitioning** — organizing entities by location so nearby-queries
  are cheap.
- **Interest management** — sending each player only the entities (and changes)
  near them.
- **Delta** — the per-tick set of changes (enter/leave/move) sent to a client.
- **Intent** — a client's *request* to do something, which the server may accept
  or reject.
- **Pseudo-legal vs. legal move** — a move that follows a piece's pattern vs. one
  that also doesn't leave your own king in check.
- **BoardEffects** — data describing how terrain/artifacts modify the rules.
- **Isometric / 2.5D** — drawing a top-down grid as diamonds with upright sprites
  to fake depth.
- **Interpolation / prediction** (not yet built) — smoothing movement between
  ticks on the client; a future polish step.

# Chess Open World ⚡

A colorful, open-world multiplayer chess **MMO** with a real **Bitcoin Lightning**
economy. Every piece is denominated in sats: capture pieces to earn, buy pieces
off your opponents, deposit real Lightning to top up, and cash your winnings out
to any Lightning address.

Built on an authoritative, zoned world server (the hard part of any MMO) with a
data-driven rules engine and an isometric web client.

## What makes it interesting

- **Sat economy** — every piece is worth real sats (`PIECE_SATS`). Capturing a
  piece transfers its value from victim to attacker; capturing a king is the
  jackpot. Spawning an army costs sats.
- **Lightning money layer** — deposit real sats (Lightning invoice / QR),
  withdraw winnings to a Lightning address, all over [coinos](https://coinos.io).
  A custodial pool wallet + an internal ledger with idempotency and a solvency
  invariant (the house never pays out more than it took in).
- **Buy your opponent's pieces** — make a sat **offer** on any enemy piece; the
  owner accepts or declines. On accept the piece *defects* to you and the sats
  move buyer → seller. (Kings can't be bought.)
- **Domination mode** — a bounded arena battle royale: last army standing in the
  ring wins the whole sat pot. Coexists with open casual roaming in one world.
- **Data-driven pieces** — pieces are data (`rides` + `hops`), not hardcoded
  logic. A custom "amazon" (queen + knight) is a few lines, no engine changes.

## Layout

```
packages/
  engine/     Deterministic, data-driven chess rules. Pure & unit-tested.
  protocol/   Shared client/server wire types + world constants + PIECE_SATS.
  server/     Authoritative zoned world: interest mgmt, tick sim, payments, ledger.
  client/     Isometric (2.5D) PixiJS web client + wallet UI.
  bots/       Autonomous players for load + play-testing.
paywall-shop/ Standalone Next.js Lightning checkout (coinos LNURL-pay reference).
```

The four MMO seams: authoritative server (clients send intents, server owns all
state), zone spatial partitioning, per-tick interest management (enter/leave/move
deltas), and persistence (world + stats + ledger to disk).

## Run it

Prereqs: **Node 20+** and **npm 10+**. No accounts or DB needed for local play.

```bash
npm install
npm run dev        # server on ws://localhost:8080, client on http://localhost:5173
```

Open **http://localhost:5173**. Open a second tab to play yourself.

Variants:
```bash
npm run watch      # server + client + a few bots
npm run share      # server + client + a public cloudflared tunnel
npm test           # engine unit tests + integration
```

### Controls

**WASD / arrows** walk · **drag** pan · **scroll** zoom · **C** recenter ·
**Enter** take a seat at the board · **click** your piece then a square to move ·
**click an enemy piece** to make a buy offer · wallet panel (bottom-right) to
**Top Up** / **Cash Out**.

## Money: mock vs. real

By default the server runs a **mock Lightning provider** — deposits auto-settle
after a couple seconds so you can demo the whole loop with no real money.

To use real Lightning, set the coinos pool wallet token (server-side only):

```bash
COINOS_TOKEN=<your-coinos-api-token> npm run dev
# optional: COINOS_URL=https://coinos.io/api
```

With the token set, `CoinosProvider` mints real invoices (`POST /invoice`),
confirms settlement, and pays withdrawals to Lightning addresses
(`POST /send/:addr/:amount`).

> ⚠️ **Run on testnet.** The token has full spend authority over the pooled
> wallet — never ship it to the client or commit it. Holding user funds and
> paying out is custodial and may be regulated; start on testnet/regtest.

## Deploy

- **client** → static host (Vercel/Netlify). Set `VITE_WS_URL` to your server's
  `wss://…` URL.
- **server** → a persistent host (Render/Fly/Railway/VM) — it's a long-lived
  stateful WS process with a tick loop, not serverless. `Dockerfile` +
  `render.yaml` included; health check at `/health`.

## Known limitations / not done

- **Custodial**: coinos holds the float; a compromise of `COINOS_TOKEN` drains
  the pool. No non-custodial path.
- **Identity** is a per-browser `accountId` (localStorage) — enough to keep your
  balance across sessions, but not authenticated. No login / signatures yet.
- **Real Lightning path is implemented but exercised only via the mock provider**
  in testing; a real testnet deposit/withdraw still needs a live token run.
- Invoices show a QR + bolt11; no WebLN one-click pay.
- `paywall-shop` is a separate app, not wired into the game.

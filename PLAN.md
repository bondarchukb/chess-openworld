# Tomorrow's plan

Goal: make the game **actually playable** and **self-testing** so a human can
watch bots fight while feeling confident no regression broke the build.

Order = ship-to-fun ratio. Each item lists scope + risk.

## A. Make it playable (8 items, ~8 h)

| # | Task | Why | Est |
|---|---|---|---|
| 1 | **Smoke test current build** — fresh refresh, verify pawn double-step, reorient, mate trigger, ELO flow, blob spawn end-to-end | Catch lingering bugs before adding more | 30m |
| 2 | **Audio v1** — Web Audio API: synth tones for move-click, capture, check-warning pulse (loops while in check), death sting. Mute toggle in HUD. No external assets. | Game stops feeling dead | 1.5h |
| 3 | **Killer feedback** — floating "+8 ELO · killed PawnLord" center text on kill, kill-feed top-right (last 5 events), brief screen flash | Reward the moment | 1.5h |
| 4 | **Pawn promotion** — server tracks `tilesAdvanced` per pawn; at 8, auto-promote to queen. HUD ping "pawn promoted!" Promote-choice modal is later (P1). | Pawns become real threats; long pushes have payoff | 1.5h |
| 5 | **Stalemate handling** — if army not in check + 0 legal moves → forced respawn, **no** ELO change | Avoid frozen players | 45m |
| 6 | **First-time tutorial bar** — 60s banner on first join only (localStorage flag): "click your piece → click highlighted square. Kill enemy king. Press G to find enemies." | New players play instead of staring | 30m |
| 7 | **Own-piece distinguisher** — thicker white ring + outer glow on your pieces. Enemy pieces dimmer ring. | Identify your army at a glance | 30m |
| 8 | **AFK kick** — 90s no input → warning toast, 120s → disconnect + army removed | No more zombie armies / ELO farming | 1h |

**Stretch** (only if all P0 done):
- Mobile tap-to-move (single tap = select, second tap = move).
- Zone chat (`/say` to 3x3 zones, max 100 chars).

## B. Self-testing (3 items, ~4 h)

The point: human watches bots brawl. Bugs surface without manual play.

### B1. Engine unit tests (vitest, packages/engine)

`packages/engine/test/plane.test.ts` — exhaustive cases:
- Pawn double-step only from `hasMoved=false`.
- Pawn diagonal capture vs blocked diagonal.
- Knight L-shape against blockers + own pieces.
- Bishop/rook/queen rides stop at first piece, capture enemy at endpoint.
- King single step in all 8 directions.
- `squareAttackedBy` returns true for every standard mating shape (back-rank
  rook mate, smothered mate, ladder mate).
- `leavesOwnKingInCheck` correctly bans pinned-piece moves.
- `legalMovesPlaneFiltered` filters check-leaving moves.

Run: `npm test -w @chess-openworld/engine`.

### B2. Server integration test (one process, no network needed)

`packages/server/test/integration.ts` — boots `GameServer` on a free port,
opens N `ws` clients in-process, asserts:
- 2 clients can join, each sees the other in roster within 1 tick.
- A king-capture wipes the victim, ELO delta applied, victim gets `dead`
  message, respawn fires after delay (shortened in test via mock timer).
- Check restriction: a pinned pawn cannot move sideways (server returns
  "would leave king in check").
- Pawn double-step accepted on first move only.

Run: `npm test -w @chess-openworld/server`.

### B3. Autonomous bots (the centerpiece — watch instead of play)

`packages/bots/` — new workspace.

Each bot:
1. Opens a WebSocket to `ws://localhost:8080` (or env URL).
2. Sends `join` with a random name + spawn mode.
3. On every snapshot/delta, computes its own legal moves using the engine
   (same `legalMovesPlaneFiltered`).
4. Picks a move using a tiny policy:
   - Greedy: prefer a move that captures, prefer captures of higher-value
     piece, otherwise a move toward the nearest enemy king. If none, random
     legal move.
   - Occasionally (5% chance) cast Reorient on own pawn toward the nearest
     enemy.
5. Sends `pieceMove` (or `reorient`), respecting cooldown.
6. On `dead`, just waits — server will respawn it in 30s.

Run: `npm run bots -- 4` spawns 4 bots. `npm run bots -- 8` spawns 8.

Optional: `npm run watch` = start dev + tunnel + spawn 4 bots, open the
browser. Human watches.

Risks:
- Bots must respect cooldown to avoid spamming.
- Engine must be importable in Node (already true — pure TS).
- Use `ws` package on Node side (same as server).

## C. Risks / open questions

- **Audio**: no external assets — synth via Web Audio oscillators. Cheap
  blip/zap sounds, not music. Mute by default to avoid surprise.
- **Promotion + check**: pawn promoting can create new check-blocking
  possibilities or new threats. Engine recomputes check after every move, so
  this should "just work" but needs a unit test.
- **Stalemate vs mate distinction**: only force respawn on stalemate, not
  ELO loss. Mate = full death + ELO loss.
- **Bot greedy = boring**: maybe v0 is fine; iterate after watching.

## D. Defer

- Skill system v1 (2+ days)
- Shop + gold (2-3 days)
- Custom piece builder (week+)
- HP/mana coupling

## E. Branch / commit hygiene

Work on `claude/playable-day` branch off `dev`. Small commits per item.
Open PR to `dev` at end of day with the full diff + a screenshot/clip of
bots fighting.

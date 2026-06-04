/**
 * Integration test (no framework, just assertions) proving the step-4 core:
 *   1. Two players in the same area see each other (interest = visible).
 *   2. When one walks far away, the other gets a `leave` (interest culling).
 *   3. The shared board rejects illegal moves and applies legal ones,
 *      broadcasting the new state to nearby players (engine authority + sync).
 *
 * Run: npm test -w @chess-openworld/server
 */

import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { Entity, EntityId, ServerMessage } from "@chess-openworld/protocol";
import { GameServer } from "../src/server.js";

const PORT = 8099;
const URL = `ws://localhost:${PORT}`;

class TestClient {
  socket: WebSocket;
  selfId = "";
  selfPos = { x: 0, y: 0 };
  known = new Map<EntityId, Entity>();
  boards: ServerMessage[] = [];
  errors: string[] = [];
  private ready: Promise<void>;

  constructor(name: string) {
    this.socket = new WebSocket(URL);
    this.ready = new Promise((res, rej) => {
      this.socket.on("open", () => {
        this.socket.send(JSON.stringify({ t: "join", name }));
      });
      this.socket.on("error", rej);
      this.socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        this.handle(msg, res);
      });
    });
  }

  private handle(msg: ServerMessage, ready: () => void): void {
    switch (msg.t) {
      case "welcome":
        this.selfId = msg.you.id;
        this.selfPos = { x: msg.you.x, y: msg.you.y };
        ready();
        break;
      case "snapshot":
        for (const e of msg.entities) this.known.set(e.id, e);
        break;
      case "delta":
        for (const e of msg.enter) this.known.set(e.id, e);
        for (const m of msg.move) {
          const e = this.known.get(m.id);
          if (e) {
            e.x = m.x;
            e.y = m.y;
          }
          if (m.id === this.selfId) this.selfPos = { x: m.x, y: m.y };
        }
        for (const id of msg.leave) this.known.delete(id);
        break;
      case "board":
        this.boards.push(msg);
        break;
      case "error":
        this.errors.push(msg.message);
        break;
    }
  }

  whenReady(): Promise<void> {
    return this.ready;
  }
  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }
  /** Walk `n` tiles in a direction, one intent per message. */
  walk(dx: number, dy: number, n: number): void {
    for (let i = 0; i < n; i++) this.send({ t: "move", dx, dy });
  }
  sees(id: EntityId): boolean {
    return this.known.has(id);
  }
  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = new GameServer({ port: PORT });
  server.start();
  let passed = 0;

  try {
    const alice = new TestClient("Alice");
    const bob = new TestClient("Bob");
    await Promise.all([alice.whenReady(), bob.whenReady()]);
    await sleep(250); // a few ticks

    // 1. Interest: both spawned near the board, so they should see each other.
    assert.ok(alice.sees(bob.selfId), "Alice should see Bob nearby");
    assert.ok(bob.sees(alice.selfId), "Bob should see Alice nearby");
    console.log("✓ nearby players are mutually visible (interest = visible)");
    passed++;

    // 2. Movement is rate-limited: a burst of 8 step messages must advance the
    //    avatar by at most ~1 tile per tick, not 8 tiles instantly.
    const start = { ...bob.selfPos };
    bob.walk(1, 0, 8); // spam 8 east steps in one burst
    await sleep(120); // ~1 tick
    const moved = Math.abs(bob.selfPos.x - start.x);
    assert.ok(moved >= 1 && moved <= 2, `burst should move ~1 tile/tick, got ${moved}`);
    console.log("✓ movement is tick-gated (no speed cheat)");
    passed++;

    // 3. Interest culling: relocate Alice far away (directly, in-process) and
    //    confirm Bob loses sight of her on the next tick diff.
    server.world.moveEntity(alice.selfId, alice.selfPos.x + 80, alice.selfPos.y);
    await sleep(300);
    assert.ok(!bob.sees(alice.selfId), "Bob should no longer see far-away Alice");
    console.log("✓ distant players are culled from interest (delta leave)");
    passed++;

    // 4. Seats + engine authority. Bob must sit before he can move; then an
    //    illegal move is rejected and a legal one is applied and broadcast.
    bob.errors.length = 0;
    bob.send({ t: "sit" }); // claims White (first to sit)
    await sleep(150);
    bob.send({ t: "boardMove", from: 12, to: 36 }); // e2 -> e5, illegal
    await sleep(150);
    assert.ok(bob.errors.some((e) => /illegal/.test(e)), "illegal move should error");

    bob.boards.length = 0;
    bob.send({ t: "boardMove", from: 12, to: 28 }); // e2 -> e4, legal
    await sleep(250);
    const last = bob.boards.at(-1);
    assert.ok(last && last.t === "board" && last.board.sideToMove === "black",
      "legal move should advance turn and broadcast");
    assert.equal(last && last.t === "board" ? last.board.seatWhite : null, bob.selfId,
      "Bob should be seated as White");
    console.log("✓ seats enforced + legal/illegal moves validated and synced");
    passed++;

    // 5. A non-seated player cannot move the board.
    bob.errors.length = 0; // Alice isn't seated; it's Black's turn now anyway.
    alice.send({ t: "boardMove", from: 52, to: 36 }); // e7 -> e5 as un-seated
    await sleep(150);
    assert.ok(alice.errors.some((e) => /not your turn/.test(e)), "unseated move rejected");
    console.log("✓ turn/seat ownership enforced");
    passed++;

    // 6. Spectator focus: Bob (near the board) can't see far Alice until he
    //    points his camera at her — then she streams into his interest.
    assert.ok(!bob.sees(alice.selfId), "precondition: Bob can't see far Alice");
    bob.send({ t: "focus", x: alice.selfPos.x, y: alice.selfPos.y });
    await sleep(300);
    assert.ok(bob.sees(alice.selfId), "Bob should see Alice after focusing her area");
    console.log("✓ spectator focus streams distant entities into interest");
    passed++;

    alice.close();
    bob.close();
  } finally {
    await server.stop();
  }

  const TOTAL = 6;
  console.log(`\n${passed}/${TOTAL} integration checks passed`);
  if (passed !== TOTAL) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

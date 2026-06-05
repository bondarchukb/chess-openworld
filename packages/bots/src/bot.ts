/**
 * A single autonomous bot client.
 *
 * Connects via WebSocket, keeps a local replica of nearby pieces, and on each
 * tick picks a move using a simple greedy policy:
 *   - prefer captures (weighted by victim value)
 *   - otherwise step a piece toward the nearest enemy king
 *   - small chance to reorient a pawn toward the nearest enemy
 *
 * Cooldowns are respected. Bot waits politely while every piece is recharging.
 */

import { WebSocket } from "ws";
import {
  PieceRegistry,
  STANDARD_PIECES,
  legalMovesPlaneFiltered,
  type Occupant,
} from "@chess-openworld/engine";
import {
  WORLD,
  type ArmyId,
  type ClientMessage,
  type Piece,
  type PieceId,
  type ServerMessage,
  type SpawnMode,
} from "@chess-openworld/protocol";

const PIECE_VALUE: Record<string, number> = {
  pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100,
};

export interface BotOptions {
  url: string;
  name: string;
  spawnMode?: SpawnMode;
  /** ms between policy ticks. Default 800. */
  tickIntervalMs?: number;
  /** Log lines? Default true. */
  verbose?: boolean;
}

export class Bot {
  private socket: WebSocket;
  private armyId: ArmyId | null = null;
  private pieces = new Map<PieceId, Piece>();
  private registry = new PieceRegistry(STANDARD_PIECES);
  private serverOffset = 0;
  private timer?: ReturnType<typeof setInterval>;
  private dead = false;
  private inCheck = false;

  constructor(private opts: BotOptions) {
    const ws = new WebSocket(opts.url);
    this.socket = ws;
    ws.on("open", () => {
      this.log(`connected`);
      this.send({ t: "join", name: opts.name, spawnMode: opts.spawnMode ?? "classical" });
    });
    ws.on("message", (raw) => this.handle(JSON.parse(raw.toString()) as ServerMessage));
    ws.on("close", () => {
      this.log(`disconnected`);
      if (this.timer) clearInterval(this.timer);
    });
    ws.on("error", (err) => this.log(`ws error: ${err.message}`));

    this.timer = setInterval(() => this.act(), opts.tickIntervalMs ?? 800);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    try { this.socket.close(); } catch { /* ignore */ }
  }

  // ---- net ------------------------------------------------------------------

  private send(msg: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private now(): number {
    return Date.now() + this.serverOffset;
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.armyId = msg.you.armyId;
        this.serverOffset = msg.serverNow - Date.now();
        this.log(`joined as ${msg.you.name} (ELO ${msg.you.stats.elo})`);
        break;
      case "snapshot":
        this.serverOffset = msg.serverNow - Date.now();
        this.pieces.clear();
        for (const p of msg.pieces) this.pieces.set(p.id, p);
        break;
      case "delta":
        this.serverOffset = msg.serverNow - Date.now();
        for (const p of msg.enter) this.pieces.set(p.id, p);
        for (const m of msg.move) {
          const p = this.pieces.get(m.id);
          if (p) {
            p.x = m.x; p.y = m.y; p.readyAt = m.readyAt;
          }
        }
        for (const c of msg.cooldown) {
          const p = this.pieces.get(c.id);
          if (p) {
            p.readyAt = c.readyAt;
            if (c.forward !== undefined) p.forward = c.forward;
          }
        }
        for (const id of msg.leave) this.pieces.delete(id);
        break;
      case "dead":
        this.dead = true;
        this.log(`died (${msg.reason} by ${msg.killerName}, ELO ${msg.eloDelta >= 0 ? "+" : ""}${msg.eloDelta})`);
        break;
      case "respawned":
        this.dead = false;
        break;
      case "roster": {
        const me = msg.armies.find((a) => a.id === this.armyId);
        this.inCheck = me?.inCheck ?? false;
        break;
      }
    }
  }

  // ---- policy ---------------------------------------------------------------

  private act(): void {
    if (!this.armyId || this.dead) return;

    // Every ready piece picks its own best move this tick. The whole army
    // marches together; the server still enforces cooldowns.
    const myPieces: Piece[] = [];
    for (const p of this.pieces.values()) {
      if (p.owner === this.armyId && p.readyAt <= this.now()) myPieces.push(p);
    }
    if (myPieces.length === 0) return;

    const enemyKing = this.findNearestEnemyKing(myPieces[0]!);
    const aimTarget = enemyKing ?? this.findNearestEnemy(myPieces[0]!);
    const occupant = (x: number, y: number): Occupant => {
      for (const p of this.pieces.values()) {
        if (p.x === x && p.y === y) {
          return { owner: p.owner, type: p.type, forward: p.forward ?? undefined, hasMoved: p.hasMoved, x, y };
        }
      }
      return null;
    };
    const allPieces = () => this.allPiecesIter();
    const findKing = (owner: string) => this.findKing(owner);

    // Score every (piece, move) pair across the army, send only ONE move per
    // tick so the action stays observable. Per-piece cooldown still ensures
    // different pieces get their turn over time.
    let best: { piece: Piece; toX: number; toY: number; score: number } | null = null;
    for (const piece of myPieces) {
      const plane = {
        owner: piece.owner, type: piece.type, forward: piece.forward ?? undefined, hasMoved: piece.hasMoved,
        x: piece.x, y: piece.y,
      };
      const moves = legalMovesPlaneFiltered(plane, this.registry, occupant, allPieces, findKing, WORLD.maxRideRange);
      for (const m of moves) {
        let score = 0;
        const target = this.pieceAt(m.x, m.y);
        if (target && target.owner !== piece.owner) {
          score += 100 + (PIECE_VALUE[target.type] ?? 0) * 10;
        }
        if (aimTarget) {
          const distBefore = chebyshev(piece.x, piece.y, aimTarget.x, aimTarget.y);
          const distAfter = chebyshev(m.x, m.y, aimTarget.x, aimTarget.y);
          score += (distBefore - distAfter) * 2;
        }
        if (piece.type === "king" && !target) score -= 5;
        // Encourage variety: prefer pieces that haven't moved recently.
        score += Math.max(0, this.now() - piece.readyAt) / 1000;
        score += Math.random() * 0.5;
        if (!best || score > best.score) best = { piece, toX: m.x, toY: m.y, score };
      }
    }

    if (!best) {
      this.maybeReorientPawn(myPieces, aimTarget);
      return;
    }
    this.send({ t: "pieceMove", pieceId: best.piece.id, toX: best.toX, toY: best.toY });
  }

  private maybeReorientPawn(myPieces: Piece[], aimTarget: { x: number; y: number } | null): void {
    if (!aimTarget || Math.random() > 0.05) return;
    const pawn = myPieces.find((p) => p.type === "pawn");
    if (!pawn || !pawn.forward) return;
    // Pick the cardinal pointing toward the aim target.
    const dx = Math.sign(aimTarget.x - pawn.x);
    const dy = Math.sign(aimTarget.y - pawn.y);
    let dir: [number, number] = pawn.forward;
    if (Math.abs(aimTarget.x - pawn.x) > Math.abs(aimTarget.y - pawn.y)) dir = [dx as number, 0];
    else dir = [0, dy as number];
    if (dir[0] === 0 && dir[1] === 0) return;
    if (dir[0] === pawn.forward[0] && dir[1] === pawn.forward[1]) return;
    this.send({ t: "reorient", pieceId: pawn.id, dir });
  }

  // ---- helpers --------------------------------------------------------------

  private pieceAt(x: number, y: number): Piece | null {
    for (const p of this.pieces.values()) if (p.x === x && p.y === y) return p;
    return null;
  }

  private *allPiecesIter() {
    for (const p of this.pieces.values()) {
      yield { owner: p.owner, type: p.type, forward: p.forward ?? undefined, hasMoved: p.hasMoved, x: p.x, y: p.y };
    }
  }

  private findKing(owner: string): { x: number; y: number } | null {
    for (const p of this.pieces.values()) {
      if (p.owner === owner && p.type === "king") return { x: p.x, y: p.y };
    }
    return null;
  }

  private findNearestEnemyKing(from: Piece): { x: number; y: number } | null {
    let best: { x: number; y: number; d: number } | null = null;
    for (const p of this.pieces.values()) {
      if (p.owner === this.armyId || p.type !== "king") continue;
      const d = chebyshev(from.x, from.y, p.x, p.y);
      if (!best || d < best.d) best = { x: p.x, y: p.y, d };
    }
    return best;
  }

  private findNearestEnemy(from: Piece): { x: number; y: number } | null {
    let best: { x: number; y: number; d: number } | null = null;
    for (const p of this.pieces.values()) {
      if (p.owner === this.armyId) continue;
      const d = chebyshev(from.x, from.y, p.x, p.y);
      if (!best || d < best.d) best = { x: p.x, y: p.y, d };
    }
    return best;
  }

  private log(msg: string): void {
    if (this.opts.verbose !== false) console.log(`[${this.opts.name}] ${msg}`);
  }
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

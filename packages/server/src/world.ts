/**
 * Authoritative open-plane chess world.
 *
 * - The plane is logically infinite; coordinates can be negative.
 * - Each player owns an Army (16 pieces). Pieces are indexed by position
 *   (`pieceAt`) for O(1) collision/occupancy lookups, and by zone for interest
 *   streaming. Removing/moving updates both indices.
 * - Movement is real-time: each piece has a `readyAt` timestamp; the server
 *   rejects moves until the cooldown expires.
 * - King capture wipes the owning army and respawns it elsewhere.
 *
 * The chess rules (which squares a piece may reach) live in the engine —
 * see `legalMovesPlane`. This file owns world state, not move math.
 */

import {
  PieceRegistry,
  STANDARD_PIECES,
  legalMovesPlane,
  leavesOwnKingInCheck,
  squareAttackedBy,
  type Occupant,
  type PlanePiece,
} from "@chess-openworld/engine";
import {
  WORLD,
  zoneOf,
  type ArmyId,
  type Piece,
  type PieceId,
  type SpawnMode,
} from "@chess-openworld/protocol";

export interface Army {
  id: ArmyId;
  name: string;
  color: string;
  /** Pawn advance direction. */
  forward: [number, number];
  /** Last spawn center (camera default; updated on respawn). */
  spawnX: number;
  spawnY: number;
  pieces: Set<PieceId>;
  /** True while the army's king is currently attacked by any enemy piece. */
  inCheck: boolean;
  /** True between death and respawn. Pieces are gone; army shell remains. */
  dead: boolean;
  /** Layout chosen at join time; used on every respawn for this player. */
  spawnMode: SpawnMode;
}

export interface PersistedWorld {
  nextPieceId: number;
  nextArmyId: number;
}

const PALETTE = [
  "#ff5577", "#55ddff", "#ffcc44", "#88ee66", "#cc77ff",
  "#ff8833", "#33ccaa", "#ee66cc", "#aabb33", "#5577ff",
];

export class World {
  private registry = new PieceRegistry(STANDARD_PIECES);
  private pieces = new Map<PieceId, Piece>();
  private pieceAt = new Map<string, PieceId>();
  private zoneIndex = new Map<string, Set<PieceId>>();
  armies = new Map<ArmyId, Army>();

  private nextPieceId = 1;
  private nextArmyId = 1;

  // ---- queries --------------------------------------------------------------

  getPiece(id: PieceId): Piece | undefined {
    return this.pieces.get(id);
  }

  pieceAtXY(x: number, y: number): Piece | null {
    const id = this.pieceAt.get(`${x},${y}`);
    return id ? this.pieces.get(id) ?? null : null;
  }

  piecesInZones(zones: Set<string>): Piece[] {
    const out: Piece[] = [];
    for (const z of zones) {
      const ids = this.zoneIndex.get(z);
      if (!ids) continue;
      for (const id of ids) {
        const p = this.pieces.get(id);
        if (p) out.push(p);
      }
    }
    return out;
  }

  getArmy(id: ArmyId): Army | undefined {
    return this.armies.get(id);
  }

  // ---- army lifecycle -------------------------------------------------------

  spawnArmy(name: string, spawnMode: SpawnMode = "classical"): Army {
    const armyId = `a${this.nextArmyId++}`;
    const color = PALETTE[(this.nextArmyId - 2) % PALETTE.length] ?? "#ffffff";
    const { cx, cy, forward } = this.findClearSpawn();
    const army: Army = {
      id: armyId,
      name,
      color,
      forward,
      spawnX: cx,
      spawnY: cy,
      pieces: new Set(),
      inCheck: false,
      dead: false,
      spawnMode,
    };
    this.armies.set(armyId, army);
    this.placeArmy(army);
    return army;
  }

  removeArmy(armyId: ArmyId): void {
    const army = this.armies.get(armyId);
    if (!army) return;
    for (const pid of [...army.pieces]) this.removePiece(pid);
    this.armies.delete(armyId);
  }

  /** Remove all pieces of an army but keep the army shell so respawn can land
   * later with the same id (preserves session linkage + roster entry). */
  wipeArmy(armyId: ArmyId): void {
    const army = this.armies.get(armyId);
    if (!army) return;
    for (const pid of [...army.pieces]) this.removePiece(pid);
    army.inCheck = false;
    army.dead = true;
  }

  respawnArmy(army: Army): void {
    for (const pid of [...army.pieces]) this.removePiece(pid);
    const { cx, cy, forward } = this.findClearSpawn();
    army.spawnX = cx;
    army.spawnY = cy;
    army.forward = forward;
    army.inCheck = false;
    army.dead = false;
    this.placeArmy(army);
  }

  // ---- moves ----------------------------------------------------------------

  /**
   * Attempt to move a piece. Enforces chess rules:
   *   - legal piece movement (rides/hops/pawn)
   *   - move must not leave the mover's own king in check
   *   - cooldown
   * Returns:
   *   - `capturedKingOf` — non-null only if a king was directly taken (shouldn't
   *     happen under normal check rules, but kept as a safety net)
   *   - `matedArmies` — armies that were in check AND have no legal move after
   *     this move resolves (game-over for them this round)
   *   - `checkSet` — armies whose `inCheck` flag flipped as a result; caller
   *     should re-broadcast the roster.
   */
  tryMove(
    pieceId: PieceId,
    toX: number,
    toY: number,
    nowMs: number
  ):
    | { ok: true; capturedKingOf: ArmyId | null; matedArmies: ArmyId[]; checkChanged: boolean }
    | { ok: false; reason: string } {
    const piece = this.pieces.get(pieceId);
    if (!piece) return { ok: false, reason: "no such piece" };
    if (nowMs < piece.readyAt) return { ok: false, reason: "on cooldown" };

    const planePiece = this.planePieceOf(piece);
    const occupant = this.occupantLookup();
    const allPieces = () => this.allPiecesIter();
    const findKing = (owner: string) => this.kingPosOf(owner);

    // 1) Basic move legality (movement pattern + capture rules).
    const moves = legalMovesPlane(planePiece, piece.x, piece.y, this.registry, occupant, WORLD.maxRideRange);
    if (!moves.some((m) => m.x === toX && m.y === toY)) {
      console.log(
        `[tryMove reject] ${piece.type} ${piece.id} owner=${piece.owner} from=(${piece.x},${piece.y}) ` +
          `to=(${toX},${toY}) hasMoved=${piece.hasMoved} forward=${JSON.stringify(piece.forward)} ` +
          `legal=${JSON.stringify(moves)}`
      );
      return { ok: false, reason: "illegal move" };
    }

    // 2) Block moves that leave own king in check.
    const planePieceXY = { ...planePiece, x: piece.x, y: piece.y };
    if (leavesOwnKingInCheck(planePieceXY, toX, toY, this.registry, occupant, allPieces, findKing, WORLD.maxRideRange)) {
      return { ok: false, reason: "would leave king in check" };
    }

    // 3) Apply move.
    const target = this.pieceAtXY(toX, toY);
    let capturedKingOf: ArmyId | null = null;
    if (target) {
      if (target.owner === piece.owner) return { ok: false, reason: "blocked by own piece" };
      if (target.type === "king") capturedKingOf = target.owner;
      this.removePiece(target.id);
    }
    this.movePieceTo(piece, toX, toY);
    piece.hasMoved = true;
    // Travel cooldown if no enemy nearby after the move; combat cooldown otherwise.
    const inCombat = this.enemyWithin(piece.owner, toX, toY, WORLD.combatRadius);
    piece.readyAt = nowMs + (inCombat ? WORLD.pieceCooldownMs : WORLD.travelCooldownMs);

    // 4) Recompute check + mate for every other army. (Cheap: one square-attack
    //    check per army for `inCheck`; mate check only when in check.)
    const matedArmies: ArmyId[] = [];
    let checkChanged = false;
    for (const army of this.armies.values()) {
      const wasInCheck = army.inCheck;
      const nowInCheck = this.isArmyInCheck(army.id);
      if (wasInCheck !== nowInCheck) checkChanged = true;
      army.inCheck = nowInCheck;
      if (nowInCheck && !this.armyHasAnyLegalMove(army.id)) {
        matedArmies.push(army.id);
      }
    }

    return { ok: true, capturedKingOf, matedArmies, checkChanged };
  }

  /** Public: does `armyId`'s king currently sit on an attacked square? */
  isArmyInCheck(armyId: ArmyId): boolean {
    const king = this.kingPosOf(armyId);
    if (!king) return false;
    const occupant = this.occupantLookup();
    return squareAttackedBy(king.x, king.y, armyId, this.allPiecesIter(), this.registry, occupant, WORLD.maxRideRange);
  }

  /** True if any piece of `armyId` has at least one legal (check-respecting) move. */
  armyHasAnyLegalMove(armyId: ArmyId): boolean {
    const occupant = this.occupantLookup();
    const allPieces = () => this.allPiecesIter();
    const findKing = (owner: string) => this.kingPosOf(owner);
    const army = this.armies.get(armyId);
    if (!army) return false;
    for (const pid of army.pieces) {
      const piece = this.pieces.get(pid);
      if (!piece) continue;
      const plane = { ...this.planePieceOf(piece), x: piece.x, y: piece.y };
      const moves = legalMovesPlane(plane, piece.x, piece.y, this.registry, occupant, WORLD.maxRideRange);
      for (const m of moves) {
        if (!leavesOwnKingInCheck(plane, m.x, m.y, this.registry, occupant, allPieces, findKing, WORLD.maxRideRange)) {
          return true;
        }
      }
    }
    return false;
  }

  private planePieceOf(p: Piece): PlanePiece {
    return {
      owner: p.owner,
      type: p.type,
      forward: p.forward ?? undefined,
      hasMoved: p.hasMoved,
    };
  }

  private occupantLookup(): (x: number, y: number) => Occupant {
    return (x: number, y: number) => {
      const p = this.pieceAtXY(x, y);
      if (!p) return null;
      return { ...this.planePieceOf(p), x: p.x, y: p.y };
    };
  }

  private *allPiecesIter(): IterableIterator<PlanePiece & { x: number; y: number }> {
    for (const p of this.pieces.values()) {
      yield { ...this.planePieceOf(p), x: p.x, y: p.y };
    }
  }

  /** True if any enemy piece sits within `r` Chebyshev tiles of (x, y). */
  private enemyWithin(ownerId: ArmyId, x: number, y: number, r: number): boolean {
    for (const p of this.pieces.values()) {
      if (p.owner === ownerId) continue;
      if (Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) <= r) return true;
    }
    return false;
  }

  private kingPosOf(armyId: ArmyId): { x: number; y: number } | null {
    const army = this.armies.get(armyId);
    if (!army) return null;
    for (const pid of army.pieces) {
      const p = this.pieces.get(pid);
      if (p && p.type === "king") return { x: p.x, y: p.y };
    }
    return null;
  }

  /**
   * Rotate a pawn's forward vector. Costs the long reorient cooldown (shared
   * with normal move readyAt — reorient is itself a "real action").
   * `dir` must be one of the four cardinal unit vectors.
   */
  tryReorient(
    pieceId: PieceId,
    dir: [number, number],
    nowMs: number
  ): { ok: true } | { ok: false; reason: string } {
    const piece = this.pieces.get(pieceId);
    if (!piece) return { ok: false, reason: "no such piece" };
    if (piece.type !== "pawn") return { ok: false, reason: "only pawns reorient" };
    if (nowMs < piece.readyAt) return { ok: false, reason: "on cooldown" };
    const [dx, dy] = dir;
    const isCardinalUnit = (dx === 0) !== (dy === 0) && Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
    if (!isCardinalUnit) return { ok: false, reason: "bad direction" };
    if (piece.forward && piece.forward[0] === dx && piece.forward[1] === dy) {
      return { ok: false, reason: "already facing that way" };
    }
    piece.forward = [dx, dy];
    piece.readyAt = nowMs + WORLD.reorientCooldownMs;
    return { ok: true };
  }

  // ---- persistence ----------------------------------------------------------

  serialize(): PersistedWorld {
    return {
      nextPieceId: this.nextPieceId,
      nextArmyId: this.nextArmyId,
    };
  }

  load(data: PersistedWorld): void {
    this.pieces.clear();
    this.pieceAt.clear();
    this.zoneIndex.clear();
    this.armies.clear();
    this.nextPieceId = data.nextPieceId ?? 1;
    this.nextArmyId = data.nextArmyId ?? 1;
  }

  // ---- internals ------------------------------------------------------------

  private placeArmy(army: Army): void {
    if (army.spawnMode === "blob") this.placeBlobSetup(army);
    else this.placeClassicalSetup(army);
  }

  private placeClassicalSetup(army: Army): void {
    const { spawnX: cx, spawnY: cy, forward } = army;
    const backRow: string[] = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];
    const fileAxis: [number, number] = [-forward[1], forward[0]];
    const backOffset: [number, number] = [-forward[0], -forward[1]];
    const frontOffset: [number, number] = [0, 0];

    for (let i = 0; i < 8; i++) {
      const shift = i - 3;
      const bx = Math.round(cx + fileAxis[0] * shift + backOffset[0]);
      const by = Math.round(cy + fileAxis[1] * shift + backOffset[1]);
      const fx = Math.round(cx + fileAxis[0] * shift + frontOffset[0]);
      const fy = Math.round(cy + fileAxis[1] * shift + frontOffset[1]);
      this.spawnPiece(army, backRow[i]!, bx, by);
      this.spawnPiece(army, "pawn", fx, fy);
    }
  }

  /** Blob: 16 pieces randomly scattered in a 5x5 area around spawn center.
   * Same piece count as classical (1 king, 1 queen, 2 rooks, 2 bishops, 2 knights, 8 pawns). */
  private placeBlobSetup(army: Army): void {
    const types: string[] = [
      "king", "queen", "rook", "rook", "bishop", "bishop", "knight", "knight",
      "pawn", "pawn", "pawn", "pawn", "pawn", "pawn", "pawn", "pawn",
    ];
    const occupied = new Set<string>();
    const tryPlace = (type: string): boolean => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const dx = Math.floor(Math.random() * 5) - 2;
        const dy = Math.floor(Math.random() * 5) - 2;
        const x = army.spawnX + dx;
        const y = army.spawnY + dy;
        const key = `${x},${y}`;
        if (occupied.has(key)) continue;
        if (this.pieceAtXY(x, y)) continue;
        occupied.add(key);
        this.spawnPiece(army, type, x, y);
        return true;
      }
      return false;
    };
    for (const t of types) {
      if (!tryPlace(t)) {
        // Fallback: walk outward until a free cell.
        outer: for (let r = 3; r < 30; r++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              const x = army.spawnX + dx;
              const y = army.spawnY + dy;
              const key = `${x},${y}`;
              if (occupied.has(key) || this.pieceAtXY(x, y)) continue;
              occupied.add(key);
              this.spawnPiece(army, t, x, y);
              break outer;
            }
          }
        }
      }
    }
  }

  private spawnPiece(army: Army, type: string, x: number, y: number): Piece {
    const id = `p${this.nextPieceId++}`;
    const piece: Piece = {
      id,
      owner: army.id,
      color: army.color,
      type,
      x,
      y,
      forward: type === "pawn" ? army.forward : null,
      readyAt: 0,
      hasMoved: false,
    };
    this.pieces.set(id, piece);
    this.pieceAt.set(`${x},${y}`, id);
    this.indexZoneAdd(zoneOf(x, y), id);
    army.pieces.add(id);
    return piece;
  }

  private removePiece(id: PieceId): void {
    const p = this.pieces.get(id);
    if (!p) return;
    this.pieces.delete(id);
    this.pieceAt.delete(`${p.x},${p.y}`);
    this.indexZoneRemove(zoneOf(p.x, p.y), id);
    const army = this.armies.get(p.owner);
    if (army) army.pieces.delete(id);
  }

  private movePieceTo(p: Piece, toX: number, toY: number): void {
    this.pieceAt.delete(`${p.x},${p.y}`);
    const oldZone = zoneOf(p.x, p.y);
    p.x = toX;
    p.y = toY;
    this.pieceAt.set(`${toX},${toY}`, p.id);
    const newZone = zoneOf(toX, toY);
    if (oldZone !== newZone) {
      this.indexZoneRemove(oldZone, p.id);
      this.indexZoneAdd(newZone, p.id);
    }
  }

  private indexZoneAdd(zone: string, id: PieceId): void {
    let set = this.zoneIndex.get(zone);
    if (!set) {
      set = new Set();
      this.zoneIndex.set(zone, set);
    }
    set.add(id);
  }

  private indexZoneRemove(zone: string, id: PieceId): void {
    const set = this.zoneIndex.get(zone);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.zoneIndex.delete(zone);
  }

  /**
   * Pick a spawn near an existing army so new arrivals see action immediately.
   * - First army: spawns at origin (0, 0) facing north.
   * - Later armies: pick a random existing army, face it, place ~20 tiles away
   *   in the direction toward it. If that area is occupied, walk outward.
   */
  private findClearSpawn(): { cx: number; cy: number; forward: [number, number] } {
    const dirs: [number, number][] = [[0, -1], [0, 1], [1, 0], [-1, 0]];

    if (this.armies.size === 0) {
      return { cx: 0, cy: 0, forward: [0, -1] };
    }

    const others = [...this.armies.values()];
    const target = others[Math.floor(Math.random() * others.length)]!;
    // Pick a side of the target army to spawn on (random cardinal).
    const sideIdx = Math.floor(Math.random() * 4);
    const side = dirs[sideIdx]!;
    // Face the target.
    const fwd: [number, number] = [-side[0], -side[1]];
    const fileAxis: [number, number] = [-fwd[1], fwd[0]];
    const isClear = (cx: number, cy: number) => {
      for (let i = -4; i <= 4; i++) {
        for (let r = -2; r <= 2; r++) {
          const x = Math.round(cx + fileAxis[0] * i + fwd[0] * r);
          const y = Math.round(cy + fileAxis[1] * i + fwd[1] * r);
          if (this.pieceAtXY(x, y)) return false;
        }
      }
      return true;
    };
    // Start ~8 tiles out — close enough to start fighting within a couple
    // of moves, far enough that you aren't spawn-camped on tick 1.
    for (let d = 8; d < 200; d += 6) {
      const cx = target.spawnX + side[0] * d;
      const cy = target.spawnY + side[1] * d;
      if (isClear(cx, cy)) return { cx, cy, forward: fwd };
    }
    return { cx: target.spawnX + side[0] * 200, cy: target.spawnY + side[1] * 200, forward: fwd };
  }
}

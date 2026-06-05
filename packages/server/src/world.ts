/**
 * The authoritative world model.
 *
 * Two ideas make this scale-shaped even though it runs in one process today:
 *
 *  1. Spatial partitioning — every entity is indexed by the zone it sits in, so
 *     "what's near this player" is a cheap lookup over ~9 zones instead of a
 *     scan of the whole world. This is the seam where zones later move to
 *     separate server processes/machines.
 *
 *  2. Authoritative state — the world owns the engine GameState for the shared
 *     board. Clients ask to move; the world decides. Nothing is trusted.
 */

import { randomUUID } from "node:crypto";
import {
  PieceRegistry,
  applyMove,
  initialState,
  resolveLegalMove,
  status as boardStatus,
  type BoardEffects,
  type GameState,
} from "@chess-openworld/engine";
import {
  WORLD,
  skinById,
  zoneOf,
  type BoardSnapshot,
  type Color,
  type Entity,
  type EntityId,
  type EntityKind,
  type SkinSlot,
  type Wallet,
} from "@chess-openworld/protocol";

/** Globally-unique ids — safe across restarts and (later) multiple servers,
 * unlike a per-process counter, which collided with persisted ids on reload. */
function makeId(prefix: string): EntityId {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

const KNIGHT_HOPS: [number, number][] = [
  [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1],
];
/** Artifacts within this Chebyshev radius (world tiles) of a board square
 * grant the piece there extra knight-like hops — a demonstrable rule modifier. */
const AURA_RADIUS = 2;

interface Account {
  owned: Set<string>;
  equipped: { avatar?: string };
}

export interface PersistedWorld {
  entities: Entity[];
  /** Full engine state so castling rights / en passant / clocks survive. */
  board: GameState;
  /** Cosmetic entitlements per account id (purchases persist). */
  accounts?: { id: string; owned: string[]; equipped: { avatar?: string } }[];
}

export class World {
  private entities = new Map<EntityId, Entity>();
  /** zone id -> set of entity ids currently in that zone. */
  private zoneIndex = new Map<number, Set<EntityId>>();
  /** tile index -> count of solid (blocking) entities, for collision. */
  private solid = new Map<number, number>();
  /** account id -> owned/equipped cosmetics (the entitlement ledger). */
  private accounts = new Map<string, Account>();

  readonly registry = new PieceRegistry();
  board: GameState = initialState();
  /** Bumped on every accepted board move / reset so clients can sync lazily. */
  boardVersion = 0;
  /** Player ids seated at the board; only the seated player may move that color. */
  seats: { white: EntityId | null; black: EntityId | null } = { white: null, black: null };
  /** Where the shared board's a1 sits in world tiles. */
  readonly boardOrigin = { x: Math.floor(WORLD.width / 2), y: Math.floor(WORLD.height / 2) };

  // ---- entity lifecycle -----------------------------------------------------

  addEntity(kind: EntityKind, x: number, y: number, label: string, extra: Partial<Entity> = {}): Entity {
    const e: Entity = { id: makeId(kind[0]!), kind, x, y, label, ...extra };
    this.entities.set(e.id, e);
    this.indexAdd(e);
    if (isSolid(e)) this.bumpSolid(tileIndex(e.x, e.y), 1);
    return e;
  }

  removeEntity(id: EntityId): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.indexRemove(e);
    if (isSolid(e)) this.bumpSolid(tileIndex(e.x, e.y), -1);
    this.entities.delete(id);
    // Free any seat this player held.
    if (this.seats.white === id) this.seats.white = null;
    if (this.seats.black === id) this.seats.black = null;
  }

  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  /** Is the world tile blocked by a solid entity (building)? */
  isSolidTile(x: number, y: number): boolean {
    return (this.solid.get(tileIndex(x, y)) ?? 0) > 0;
  }

  /** Move an entity to (x,y), clamped to the world and re-indexed by zone.
   * Players cannot walk into solid tiles. Returns true if it actually moved. */
  moveEntity(id: EntityId, x: number, y: number): boolean {
    const e = this.entities.get(id);
    if (!e) return false;
    const nx = clamp(x, 0, WORLD.width - 1);
    const ny = clamp(y, 0, WORLD.height - 1);
    if (nx === e.x && ny === e.y) return false;
    if (e.kind === "player" && this.isSolidTile(nx, ny)) return false; // collision
    const oldZone = zoneOf(e.x, e.y);
    const newZone = zoneOf(nx, ny);
    e.x = nx;
    e.y = ny;
    if (oldZone !== newZone) {
      this.zoneIndex.get(oldZone)?.delete(id);
      this.indexAddZone(newZone, id);
    }
    return true;
  }

  // ---- interest queries -----------------------------------------------------

  /** All entities whose zone is in `zones`. */
  entitiesInZones(zones: Set<number>): Entity[] {
    const out: Entity[] = [];
    for (const z of zones) {
      const ids = this.zoneIndex.get(z);
      if (!ids) continue;
      for (const id of ids) {
        const e = this.entities.get(id);
        if (e) out.push(e);
      }
    }
    return out;
  }

  // ---- the shared chess board ----------------------------------------------

  /** Translate world entities sitting on / near the board into rule effects. */
  boardEffects(): BoardEffects {
    const blocked = new Set<number>();
    const auraSquares = new Set<number>();
    for (const e of this.entities.values()) {
      if (e.kind !== "building" && e.kind !== "artifact") continue;
      const bx = e.x - this.boardOrigin.x;
      const by = e.y - this.boardOrigin.y;
      if (e.kind === "building" && onBoard8(bx, by)) {
        blocked.add(by * 8 + bx); // a building on a square walls it off
      }
      if (e.kind === "artifact") {
        // Any board square within AURA_RADIUS of the artifact gets the aura.
        for (let sq = 0; sq < 64; sq++) {
          const sx = sq % 8;
          const sy = Math.floor(sq / 8);
          if (Math.abs(this.boardOrigin.x + sx - e.x) <= AURA_RADIUS &&
              Math.abs(this.boardOrigin.y + sy - e.y) <= AURA_RADIUS) {
            auraSquares.add(sq);
          }
        }
      }
    }
    return {
      blocked,
      grantHops: (sq) => (auraSquares.has(sq) ? KNIGHT_HOPS : []),
    };
  }

  boardSnapshot(): BoardSnapshot {
    const effects = this.boardEffects();
    return {
      originX: this.boardOrigin.x,
      originY: this.boardOrigin.y,
      cells: this.board.board.map((p) => (p ? `${p.color}:${p.type}` : null)),
      sideToMove: this.board.sideToMove,
      status: boardStatus(this.board, this.registry, effects),
      seatWhite: this.seats.white,
      seatBlack: this.seats.black,
      blocked: [...(effects.blocked ?? [])],
    };
  }

  /** Seat a player at the first open color. Returns the color or null (full). */
  claimSeat(playerId: EntityId): Color | null {
    if (this.seats.white === playerId) return "white";
    if (this.seats.black === playerId) return "black";
    if (!this.seats.white) return (this.seats.white = playerId), "white";
    if (!this.seats.black) return (this.seats.black = playerId), "black";
    return null;
  }

  /** Attempt an engine-validated move, enforcing seat + turn ownership. */
  tryBoardMove(playerId: EntityId, from: number, to: number, promotion?: string): { ok: boolean; reason?: string } {
    const effects = this.boardEffects();
    if (boardStatus(this.board, this.registry, effects) !== "playing" &&
        boardStatus(this.board, this.registry, effects) !== "check") {
      return { ok: false, reason: "game over — start a new game" };
    }
    const seat = this.board.sideToMove;
    if (this.seats[seat] !== playerId) {
      return { ok: false, reason: `not your turn (${seat} to move)` };
    }
    const move = resolveLegalMove(this.board, from, to, this.registry, effects, promotion);
    if (!move) return { ok: false, reason: "illegal move" };
    this.board = applyMove(this.board, move, this.registry);
    this.boardVersion++;
    return { ok: true };
  }

  /** Reset to a fresh game. Only meaningful once a game has ended. */
  resetBoard(): void {
    this.board = initialState();
    this.boardVersion++;
  }

  // ---- accounts & cosmetic entitlements ------------------------------------

  private account(id: string): Account {
    let a = this.accounts.get(id);
    if (!a) this.accounts.set(id, (a = { owned: new Set(), equipped: {} }));
    return a;
  }

  /** Grant a skin to an account. Idempotent — safe to call per settled invoice. */
  grantSkin(accountId: string, skinId: string): void {
    this.account(accountId).owned.add(skinId);
  }

  /** Equip (or unequip with null) an owned skin. Returns false if not owned. */
  equipSkin(accountId: string, slot: SkinSlot, skinId: string | null): boolean {
    const a = this.account(accountId);
    if (skinId === null) {
      delete a.equipped[slot];
      return true;
    }
    if (!a.owned.has(skinId)) return false;
    const item = skinById(skinId);
    if (!item || item.slot !== slot) return false;
    a.equipped[slot] = skinId;
    return true;
  }

  walletOf(accountId: string): Wallet {
    const a = this.account(accountId);
    return { owned: [...a.owned], equipped: { ...a.equipped } };
  }

  // ---- persistence ----------------------------------------------------------

  serialize(): PersistedWorld {
    return {
      entities: [...this.entities.values()].filter((e) => e.kind !== "player"),
      board: this.board, // full GameState (JSON-serializable)
      accounts: [...this.accounts].map(([id, a]) => ({
        id,
        owned: [...a.owned],
        equipped: { ...a.equipped },
      })),
    };
  }

  load(data: PersistedWorld): void {
    for (const e of data.entities) {
      this.entities.set(e.id, e);
      this.indexAdd(e);
      if (isSolid(e)) this.bumpSolid(tileIndex(e.x, e.y), 1);
    }
    if (data.board?.board) this.board = data.board;
    for (const a of data.accounts ?? []) {
      this.accounts.set(a.id, { owned: new Set(a.owned), equipped: { ...a.equipped } });
    }
    // Seats reference live connections, which are gone after a restart.
    this.seats = { white: null, black: null };
  }

  // ---- zone index internals -------------------------------------------------

  private indexAdd(e: Entity): void {
    this.indexAddZone(zoneOf(e.x, e.y), e.id);
  }
  private indexAddZone(zone: number, id: EntityId): void {
    let set = this.zoneIndex.get(zone);
    if (!set) this.zoneIndex.set(zone, (set = new Set()));
    set.add(id);
  }
  private indexRemove(e: Entity): void {
    this.zoneIndex.get(zoneOf(e.x, e.y))?.delete(e.id);
  }
  private bumpSolid(tile: number, delta: number): void {
    const next = (this.solid.get(tile) ?? 0) + delta;
    if (next <= 0) this.solid.delete(tile);
    else this.solid.set(tile, next);
  }
}

function isSolid(e: Entity): boolean {
  return e.kind === "building";
}

function tileIndex(x: number, y: number): number {
  return y * WORLD.width + x;
}

function onBoard8(x: number, y: number): boolean {
  return x >= 0 && x < 8 && y >= 0 && y < 8;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

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

import {
  PieceRegistry,
  applyMove,
  initialState,
  legalMoves,
  resolveLegalMove,
  type GameState,
  type Piece,
} from "@chess-openworld/engine";
import {
  WORLD,
  zoneOf,
  type BoardSnapshot,
  type Color,
  type Entity,
  type EntityId,
  type EntityKind,
} from "@chess-openworld/protocol";

let nextId = 1;
function makeId(prefix: string): EntityId {
  return `${prefix}${nextId++}`;
}

export interface PersistedWorld {
  entities: Entity[];
  board: { fen: null; cells: (string | null)[]; sideToMove: Color };
}

export class World {
  private entities = new Map<EntityId, Entity>();
  /** zone id -> set of entity ids currently in that zone. */
  private zoneIndex = new Map<number, Set<EntityId>>();

  readonly registry = new PieceRegistry();
  board: GameState = initialState();
  /** Bumped on every accepted board move so clients can sync lazily. */
  boardVersion = 0;
  /** Where the shared board's a1 sits in world tiles. */
  readonly boardOrigin = { x: Math.floor(WORLD.width / 2), y: Math.floor(WORLD.height / 2) };

  // ---- entity lifecycle -----------------------------------------------------

  addEntity(kind: EntityKind, x: number, y: number, label: string, extra: Partial<Entity> = {}): Entity {
    const e: Entity = { id: makeId(kind[0]!), kind, x, y, label, ...extra };
    this.entities.set(e.id, e);
    this.indexAdd(e);
    return e;
  }

  removeEntity(id: EntityId): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.indexRemove(e);
    this.entities.delete(id);
  }

  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  /** Move an entity to (x,y), clamped to the world and re-indexed by zone. */
  moveEntity(id: EntityId, x: number, y: number): boolean {
    const e = this.entities.get(id);
    if (!e) return false;
    const nx = clamp(x, 0, WORLD.width - 1);
    const ny = clamp(y, 0, WORLD.height - 1);
    if (nx === e.x && ny === e.y) return false;
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

  boardSnapshot(): BoardSnapshot {
    const moves = legalMoves(this.board, this.registry);
    let status = "playing";
    if (moves.length === 0) status = "game-over";
    return {
      originX: this.boardOrigin.x,
      originY: this.boardOrigin.y,
      cells: this.board.board.map((p) => (p ? `${p.color}:${p.type}` : null)),
      sideToMove: this.board.sideToMove,
      status,
    };
  }

  /** Attempt an engine-validated move on the shared board. */
  tryBoardMove(from: number, to: number): { ok: boolean; reason?: string } {
    const move = resolveLegalMove(this.board, from, to, this.registry);
    if (!move) return { ok: false, reason: "illegal move" };
    this.board = applyMove(this.board, move, this.registry);
    this.boardVersion++;
    return { ok: true };
  }

  // ---- persistence ----------------------------------------------------------

  serialize(): PersistedWorld {
    return {
      entities: [...this.entities.values()].filter((e) => e.kind !== "player"),
      board: {
        fen: null,
        cells: this.board.board.map((p) => (p ? `${p.color}:${p.type}` : null)),
        sideToMove: this.board.sideToMove,
      },
    };
  }

  load(data: PersistedWorld): void {
    for (const e of data.entities) {
      this.entities.set(e.id, e);
      this.indexAdd(e);
    }
    // Rebuild board state from persisted cells.
    const cells = data.board.cells;
    const restored = initialState();
    restored.board = cells.map<Piece | null>((c) => {
      if (!c) return null;
      const [color, type] = c.split(":");
      return { color: color as Color, type: type! };
    });
    restored.sideToMove = data.board.sideToMove;
    this.board = restored;
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
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Wire protocol shared between client and server.
 *
 * The whole MMO is built on these rules:
 *  - Clients send *intents* (ClientMessage). They never assert world state.
 *  - The server validates every intent and broadcasts authoritative results
 *    (ServerMessage) only to players whose interest set is affected.
 *
 * Keeping this in a shared package means client and server can never disagree
 * about the message shape — a big reason to use TypeScript end-to-end.
 */

/** World layout constants. A future deployment can shard zones across servers. */
export const WORLD = {
  /** World size in tiles. */
  width: 192,
  height: 192,
  /** Zone (chunk) edge length in tiles. World is width/zoneSize zones wide. */
  zoneSize: 24,
  /** Server simulation rate. */
  tickHz: 10,
} as const;

export type EntityId = string;

export type Color = "white" | "black";

/** Kinds of things that live on a tile in the open world. */
export type EntityKind = "player" | "piece" | "building" | "artifact";

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  x: number;
  y: number;
  /** For players: display name. For pieces: piece type id (pawn, knight, ...). */
  label: string;
  color?: Color;
  /** Purely cosmetic skin id — never affects rules. */
  skin?: string;
}

/** Authoritative state of the shared demo chess board embedded in the world. */
export interface BoardSnapshot {
  /** World-tile origin of the board's a1 square. */
  originX: number;
  originY: number;
  /** 64 cells, row-major from rank 1; null or "color:type". */
  cells: (string | null)[];
  sideToMove: Color;
  status: string;
}

// ---- Client -> Server -------------------------------------------------------

export type ClientMessage =
  | { t: "join"; name: string }
  | { t: "move"; dx: number; dy: number } // step the avatar by one tile
  | { t: "place"; kind: Extract<EntityKind, "building" | "artifact">; skin?: string }
  | { t: "boardMove"; from: number; to: number } // move on the shared chess board
  | { t: "chat"; text: string }
  | { t: "ping" };

// ---- Server -> Client -------------------------------------------------------

export interface SelfInfo {
  id: EntityId;
  x: number;
  y: number;
}

export type ServerMessage =
  | { t: "welcome"; you: SelfInfo; world: typeof WORLD; board: BoardSnapshot }
  /** Full set of entities currently inside the player's interest region. */
  | { t: "snapshot"; entities: Entity[] }
  /** Incremental interest update produced each server tick. */
  | {
      t: "delta";
      enter: Entity[];
      leave: EntityId[];
      move: { id: EntityId; x: number; y: number }[];
    }
  | { t: "board"; board: BoardSnapshot }
  | { t: "chat"; from: string; text: string }
  | { t: "error"; message: string }
  | { t: "pong" };

/** Zone index for a tile, and the helper to enumerate a Moore-neighborhood. */
export function zoneOf(x: number, y: number): number {
  const zx = Math.floor(x / WORLD.zoneSize);
  const zy = Math.floor(y / WORLD.zoneSize);
  const zonesWide = Math.ceil(WORLD.width / WORLD.zoneSize);
  return zy * zonesWide + zx;
}

/** The set of zone ids a player at (x,y) is interested in (self + 8 neighbors). */
export function interestZones(x: number, y: number): Set<number> {
  const zonesWide = Math.ceil(WORLD.width / WORLD.zoneSize);
  const zonesTall = Math.ceil(WORLD.height / WORLD.zoneSize);
  const zx = Math.floor(x / WORLD.zoneSize);
  const zy = Math.floor(y / WORLD.zoneSize);
  const set = new Set<number>();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = zx + dx;
      const ny = zy + dy;
      if (nx < 0 || ny < 0 || nx >= zonesWide || ny >= zonesTall) continue;
      set.add(ny * zonesWide + nx);
    }
  }
  return set;
}

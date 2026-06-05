/**
 * Wire protocol shared between client and server.
 *
 * Open-battlefield chess: infinite plane, each player owns one army of chess
 * pieces, real-time with per-piece cooldown. No avatars, no buildings, no
 * artifacts. The only entities are pieces.
 */

export const WORLD = {
  /** Zone (chunk) edge length in tiles. Used for interest streaming. */
  zoneSize: 24,
  /** Server simulation rate. */
  tickHz: 10,
  /** Cooldown after a piece moves while an enemy is within `combatRadius`. */
  pieceCooldownMs: 6000,
  /** Reduced cooldown when no enemy is within `combatRadius`. Lets armies
   * march across empty space without painful wait times. */
  travelCooldownMs: 1500,
  /** Radius (tiles) within which a piece is considered "in combat". */
  combatRadius: 12,
  /** Cooldown after a pawn reorients (long; reorient costs a real action). */
  reorientCooldownMs: 20000,
  /** How long the death overlay shows before an army respawns. */
  respawnDelayMs: 30000,
  /** Army size: standard chess setup, 16 pieces. */
  armySize: 16,
  /** Max ride distance for sliders on the plane (caps rook/bishop/queen). */
  maxRideRange: 32,
} as const;

export type PieceId = string;
export type ArmyId = string;

export interface Piece {
  id: PieceId;
  owner: ArmyId;
  /** Display color (hex int as string for JSON), e.g. "#ff5577". */
  color: string;
  /** Piece type id: "pawn", "knight", ... */
  type: string;
  x: number;
  y: number;
  /** Forward vector for pawns ("dx,dy"), null for other pieces. */
  forward: [number, number] | null;
  /** Server epoch ms when this piece may next move. 0 = ready. */
  readyAt: number;
  /** Set to true after the piece moves for the first time. Used by pawn double-step. */
  hasMoved: boolean;
}

// ---- Client -> Server -------------------------------------------------------

/** How an army's pieces are arranged on first spawn. */
export type SpawnMode = "classical" | "blob";

export type ClientMessage =
  | { t: "join"; name: string; spawnMode?: SpawnMode; asSpectator?: boolean }
  /** Move one of your pieces. Server validates ownership, legality, cooldown. */
  | { t: "pieceMove"; pieceId: PieceId; toX: number; toY: number }
  /** Rotate a pawn's forward direction. Long cooldown; only legal on pawns. */
  | { t: "reorient"; pieceId: PieceId; dir: [number, number] }
  /** Camera position — server streams interest around this point. */
  | { t: "focus"; x: number; y: number }
  | { t: "ping" };

// ---- Server -> Client -------------------------------------------------------

export interface PlayerStats {
  elo: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
}

export interface SelfInfo {
  /** null when joined as a spectator (no army). */
  armyId: ArmyId | null;
  name: string;
  color: string;
  /** Spawn center, used by client to center camera initially. */
  spawnX: number;
  spawnY: number;
  stats: PlayerStats;
  spectator: boolean;
}

export type ServerMessage =
  | { t: "welcome"; you: SelfInfo; world: typeof WORLD; serverNow: number }
  /** Full set of pieces currently inside the player's interest region. */
  | { t: "snapshot"; pieces: Piece[]; serverNow: number }
  /** Incremental interest update produced each server tick. */
  | {
      t: "delta";
      enter: Piece[];
      leave: PieceId[];
      move: { id: PieceId; x: number; y: number; readyAt: number }[];
      /** Pieces whose state changed but position did not — cooldown refresh
       * and/or pawn forward direction change. `forward` is included only when
       * it changed (null clears a previous direction). */
      cooldown: { id: PieceId; readyAt: number; forward?: [number, number] | null }[];
      serverNow: number;
    }
  /** Your army was wiped (king captured / checkmate). You are dead until the
   * `respawnAt` timestamp, then you'll receive a fresh snapshot. */
  | {
      t: "dead";
      reason: string;
      killerName: string;
      killerElo: number;
      eloDelta: number;
      newStats: PlayerStats;
      respawnAt: number;
    }
  /** Sent at the moment the dead overlay ends and your new army goes live. */
  | { t: "respawned"; stats: PlayerStats }
  /** Lightweight directory of every army's current state. Sent on join,
   * whenever the set of armies changes, and whenever check status changes. */
  | {
      t: "roster";
      armies: {
        id: ArmyId; name: string; color: string;
        spawnX: number; spawnY: number;
        inCheck: boolean;
        elo: number;
        dead: boolean;
      }[];
    }
  | { t: "error"; message: string }
  | { t: "pong" };

/** Zone key for a tile. String form lets the plane be unbounded (negative ok). */
export function zoneOf(x: number, y: number): string {
  const zx = Math.floor(x / WORLD.zoneSize);
  const zy = Math.floor(y / WORLD.zoneSize);
  return `${zx},${zy}`;
}

/** Set of zone keys near (x,y) — the 3x3 Moore neighborhood. */
export function interestZones(x: number, y: number): Set<string> {
  const zx = Math.floor(x / WORLD.zoneSize);
  const zy = Math.floor(y / WORLD.zoneSize);
  const set = new Set<string>();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      set.add(`${zx + dx},${zy + dy}`);
    }
  }
  return set;
}

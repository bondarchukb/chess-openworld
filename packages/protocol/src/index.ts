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

/** Sat cost / kill bounty per piece type. Capturing a piece pays the
 * captured piece's value from victim → killer. Spawning an army costs the
 * sum of every piece's value up front. */
export const PIECE_SATS: Record<string, number> = {
  pawn: 100,
  knight: 300,
  bishop: 300,
  rook: 500,
  queen: 900,
  king: 2500,
};

/** Sum of PIECE_SATS for the standard 16-piece army (8P 2N 2B 2R 1Q 1K). */
export const ARMY_SATS_COST =
  8 * PIECE_SATS.pawn! +
  2 * PIECE_SATS.knight! +
  2 * PIECE_SATS.bishop! +
  2 * PIECE_SATS.rook! +
  PIECE_SATS.queen! +
  PIECE_SATS.king!;

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

/** Top-level game mode. Open world = roam infinite plane. Domination = play
 * inside a bounded arena, last surviving player wins. */
export type GameMode = "open" | "domination";

/** Domination arena geometry. Tiles strictly inside count as "in arena". */
export const ARENA = {
  centerX: 0,
  centerY: 0,
  /** Half-extent (Chebyshev). Arena is (2·halfSize + 1) tiles per side. */
  halfSize: 10,
} as const;

export type ClientMessage =
  | { t: "join"; name: string; spawnMode?: SpawnMode; gameMode?: GameMode; asSpectator?: boolean }
  /** Move one of your pieces. Server validates ownership, legality, cooldown. */
  | { t: "pieceMove"; pieceId: PieceId; toX: number; toY: number }
  /** Rotate a pawn's forward direction. Long cooldown; only legal on pawns. */
  | { t: "reorient"; pieceId: PieceId; dir: [number, number] }
  /** Camera position — server streams interest around this point. */
  | { t: "focus"; x: number; y: number }
  /** Top up: ask the server to mint a Lightning invoice for `sats`. */
  | { t: "depositRequest"; sats: number }
  /** Cash out `sats` to a Lightning address. */
  | { t: "withdrawRequest"; lnAddress: string; sats: number }
  /** Buy (defect) an enemy piece — pay its sat value to its owner; it joins you. */
  | { t: "buyOpponentPiece"; pieceId: PieceId }
  | { t: "ping" };

// ---- Server -> Client -------------------------------------------------------

export interface PlayerStats {
  elo: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  /** Lightning sats. Starter grant 10,000. Earn on kill, lose on death. */
  sats: number;
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
      /** Sats taken from victim by killer. Negative on victim's wire view. */
      satsDelta: number;
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
        sats: number;
        dead: boolean;
        gameMode: GameMode;
        /** Domination only: does this army still have ≥1 piece inside the arena? */
        inArena: boolean;
      }[];
    }
  /** Domination match concluded with a single survivor. */
  | { t: "dominationWin"; winnerName: string; winnerArmyId: ArmyId; satsJackpot: number }
  /** A Lightning invoice to pay (deposit). Scan the bolt11 / QR. */
  | { t: "invoice"; invoiceId: string; bolt11: string; sats: number }
  /** A deposit settled — balance updated. */
  | { t: "depositCredited"; sats: number; balance: number }
  /** Result of a withdraw request. */
  | { t: "withdrawResult"; ok: boolean; sats: number; balance: number; reason?: string }
  /** Generic balance update (after a purchase, etc.). */
  | { t: "balance"; sats: number }
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

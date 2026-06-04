/**
 * Core engine types.
 *
 * Design notes for the MMO roadmap:
 * - The board is an 8x8 grid here, but coordinates are (x, y) so a future
 *   "open world" can use larger or zoned boards without changing the move math.
 * - Piece behaviour is *data* (see pieces.ts), never hardcoded branching per
 *   piece. Adding a custom piece = adding a PieceDef, not editing the engine.
 * - Everything in this engine is deterministic and side-effect free so it can
 *   run authoritatively on the server and be unit-tested without a client.
 */

export type Color = "white" | "black";

/** Identifier for a piece *kind*. Standard chess uses the six below, but this
 * is an open string so custom pieces ("archbishop", "siege-tower", ...) slot in. */
export type PieceTypeId = string;

/** A square is a 0..63 index. index = y * 8 + x, x = file (0=a), y = rank (0=rank1). */
export type Square = number;

export const BOARD_SIZE = 8;

export interface Piece {
  type: PieceTypeId;
  color: Color;
  /** Cosmetic only — never affects rules. Lets clients swap art freely. */
  skin?: string;
  /** Tracks first-move state for castling / pawn double-step. */
  hasMoved?: boolean;
}

/** A direction step in board units. */
export type Vec = readonly [dx: number, dy: number];

export type MoveKind =
  | "normal"
  | "double-pawn" // pawn two-square advance (sets en passant target)
  | "en-passant"
  | "castle-king"
  | "castle-queen"
  | "promotion";

export interface Move {
  from: Square;
  to: Square;
  kind: MoveKind;
  /** For promotions: the piece type to promote into. */
  promotion?: PieceTypeId;
  /** Square of a captured piece, when it differs from `to` (en passant). */
  captureSquare?: Square;
}

export type GameStatus =
  | "playing"
  | "check"
  | "checkmate"
  | "stalemate"
  | "draw";

export interface GameState {
  board: (Piece | null)[];
  sideToMove: Color;
  /** En passant target square (the square *behind* a double-stepped pawn), or null. */
  enPassant: Square | null;
  /** Plies since last capture or pawn move (for the 50-move rule, used later). */
  halfmoveClock: number;
  /** Full move number, starts at 1, increments after black moves. */
  fullmoveNumber: number;
}

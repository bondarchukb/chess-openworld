/**
 * Data-driven move generation and authoritative validation.
 *
 * Move behaviour is read from PieceDefs (rides/hops/pawn) plus a BoardEffects
 * (terrain/auras), so both custom pieces *and* custom board rules work without
 * changes here. This module is pure and deterministic — the server runs it as
 * the single source of truth; clients only ever *predict*.
 *
 * Implemented: sliders/leapers, pawns (double-step, en passant, under-promotion),
 * castling, king-safety filtering, and terminal detection (checkmate / stalemate
 * / 50-move draw). Threefold repetition needs position history and is left out.
 */

import {
  fileOf,
  findRoyal,
  onBoard,
  opposite,
  pawnDir,
  rankOf,
  xy,
} from "./board.js";
import { grantedHops, isBlocked, NO_EFFECTS, type BoardEffects } from "./effects.js";
import type { PieceDef, PieceRegistry } from "./pieces.js";
import {
  BOARD_SIZE,
  type Color,
  type GameState,
  type GameStatus,
  type Move,
  type Piece,
  type PieceTypeId,
  type Square,
} from "./types.js";

/** Piece types a pawn may promote to. */
export const PROMOTION_TYPES: readonly PieceTypeId[] = ["queen", "rook", "bishop", "knight"];

function pieceAt(state: GameState, sq: Square): Piece | null {
  return state.board[sq] ?? null;
}

/** All squares a non-pawn piece attacks/moves to from `sq` (pseudo-legal). */
function ridesAndHops(
  state: GameState,
  sq: Square,
  def: PieceDef,
  color: Color,
  effects: BoardEffects
): Square[] {
  const out: Square[] = [];
  const x0 = fileOf(sq);
  const y0 = rankOf(sq);

  for (const ride of def.rides ?? []) {
    for (const [dx, dy] of ride.dirs) {
      let step = 1;
      while (step <= ride.range) {
        const x = x0 + dx * step;
        const y = y0 + dy * step;
        if (!onBoard(x, y)) break;
        const target = xy(x, y);
        if (isBlocked(effects, target)) break; // walls stop the ride
        const occ = pieceAt(state, target);
        if (!occ) {
          out.push(target);
        } else {
          if (occ.color !== color) out.push(target); // capture
          break; // blocked either way
        }
        step++;
      }
    }
  }

  // Built-in hops plus any granted by an aura on this square.
  const hops = [...(def.hops ?? []), ...grantedHops(effects, sq)];
  for (const [dx, dy] of hops) {
    const x = x0 + dx;
    const y = y0 + dy;
    if (!onBoard(x, y)) continue;
    const target = xy(x, y);
    if (isBlocked(effects, target)) continue;
    const occ = pieceAt(state, target);
    if (!occ || occ.color !== color) out.push(target);
  }

  return out;
}

/** Pawn pseudo-legal destinations as Move objects (handles double-step + EP). */
function pawnMoves(state: GameState, sq: Square, color: Color, effects: BoardEffects): Move[] {
  const out: Move[] = [];
  const dir = pawnDir(color);
  const x0 = fileOf(sq);
  const y0 = rankOf(sq);
  const startRank = color === "white" ? 1 : BOARD_SIZE - 2;
  const promoteRank = color === "white" ? BOARD_SIZE - 1 : 0;

  // Forward one
  const y1 = y0 + dir;
  if (onBoard(x0, y1) && !pieceAt(state, xy(x0, y1)) && !isBlocked(effects, xy(x0, y1))) {
    pushPawn(out, sq, xy(x0, y1), y1 === promoteRank);
    // Forward two from start
    const y2 = y0 + 2 * dir;
    if (y0 === startRank && !pieceAt(state, xy(x0, y2)) && !isBlocked(effects, xy(x0, y2))) {
      out.push({ from: sq, to: xy(x0, y2), kind: "double-pawn" });
    }
  }

  // Captures (incl. en passant)
  for (const dx of [-1, 1]) {
    const x = x0 + dx;
    if (!onBoard(x, y1)) continue;
    const target = xy(x, y1);
    if (isBlocked(effects, target)) continue;
    const occ = pieceAt(state, target);
    if (occ && occ.color !== color) {
      pushPawn(out, sq, target, y1 === promoteRank);
    } else if (state.enPassant === target) {
      out.push({ from: sq, to: target, kind: "en-passant", captureSquare: xy(x, y0) });
    }
  }

  return out;
}

function pushPawn(out: Move[], from: Square, to: Square, promote: boolean): void {
  if (promote) {
    for (const promotion of PROMOTION_TYPES) out.push({ from, to, kind: "promotion", promotion });
  } else {
    out.push({ from, to, kind: "normal" });
  }
}

/** Castling moves for the side to move, with full path-safety checks. */
function castlingMoves(state: GameState, registry: PieceRegistry, effects: BoardEffects): Move[] {
  const me = state.sideToMove;
  const enemy = opposite(me);
  const rank = me === "white" ? 0 : BOARD_SIZE - 1;
  const kingSq = xy(4, rank);
  const king = pieceAt(state, kingSq);
  const isRoyal = (t: string) => registry.get(t).isRoyal === true;
  if (!king || !isRoyal(king.type) || king.hasMoved) return [];
  // Can't castle out of check.
  if (isSquareAttacked(state, kingSq, enemy, registry, effects)) return [];

  const out: Move[] = [];
  const clearAndSafe = (empties: number[], pathFiles: number[], rookFile: number, kind: Move["kind"]) => {
    const rook = pieceAt(state, xy(rookFile, rank));
    if (!rook || rook.type !== "rook" || rook.color !== me || rook.hasMoved) return;
    for (const f of empties) {
      const s = xy(f, rank);
      if (pieceAt(state, s) || isBlocked(effects, s)) return;
    }
    // King may not pass through or land on an attacked square.
    for (const f of pathFiles) {
      if (isSquareAttacked(state, xy(f, rank), enemy, registry, effects)) return;
    }
    out.push({ from: kingSq, to: xy(pathFiles[pathFiles.length - 1]!, rank), kind });
  };

  // King-side: f,g empty; king crosses f,g.
  clearAndSafe([5, 6], [5, 6], 7, "castle-king");
  // Queen-side: b,c,d empty; king crosses d,c (b need not be safe).
  clearAndSafe([1, 2, 3], [3, 2], 0, "castle-queen");
  return out;
}

/** Pseudo-legal moves for the piece on `sq` (ignores leaving own king in check). */
export function pseudoLegalMoves(
  state: GameState,
  sq: Square,
  registry: PieceRegistry,
  effects: BoardEffects = NO_EFFECTS
): Move[] {
  const piece = pieceAt(state, sq);
  if (!piece) return [];
  const def = registry.get(piece.type);
  if (def.isPawn) return pawnMoves(state, sq, piece.color, effects);
  return ridesAndHops(state, sq, def, piece.color, effects).map((to) => ({
    from: sq,
    to,
    kind: "normal" as const,
  }));
}

/** Is `sq` attacked by any piece of `byColor`? Used for check detection. */
export function isSquareAttacked(
  state: GameState,
  sq: Square,
  byColor: Color,
  registry: PieceRegistry,
  effects: BoardEffects = NO_EFFECTS
): boolean {
  for (let from = 0; from < state.board.length; from++) {
    const p = state.board[from];
    if (!p || p.color !== byColor) continue;
    const def = registry.get(p.type);
    if (def.isPawn) {
      // Pawns attack only diagonally forward.
      const dir = pawnDir(p.color);
      const x0 = fileOf(from);
      const y0 = rankOf(from);
      for (const dx of [-1, 1]) {
        if (onBoard(x0 + dx, y0 + dir) && xy(x0 + dx, y0 + dir) === sq) return true;
      }
    } else if (ridesAndHops(state, from, def, p.color, effects).includes(sq)) {
      return true;
    }
  }
  return false;
}

/** Apply a move to a fresh cloned state. Caller guarantees legality. */
export function applyMove(state: GameState, move: Move, registry: PieceRegistry): GameState {
  const board = state.board.slice();
  const piece = board[move.from];
  if (!piece) throw new Error("No piece at move origin");

  const moved: Piece = { ...piece, hasMoved: true };
  if (move.kind === "promotion" && move.promotion) {
    moved.type = move.promotion;
  }

  const isCapture = board[move.to] != null || move.kind === "en-passant";
  board[move.from] = null;
  board[move.to] = moved;
  if (move.kind === "en-passant" && move.captureSquare != null) {
    board[move.captureSquare] = null;
  }
  // Castling also relocates the rook to the square the king crossed.
  if (move.kind === "castle-king" || move.kind === "castle-queen") {
    const rank = rankOf(move.from);
    const [rookFrom, rookTo] =
      move.kind === "castle-king" ? [xy(7, rank), xy(5, rank)] : [xy(0, rank), xy(3, rank)];
    const rook = board[rookFrom];
    board[rookFrom] = null;
    if (rook) board[rookTo] = { ...rook, hasMoved: true };
  }

  const next: GameState = {
    board,
    sideToMove: opposite(state.sideToMove),
    enPassant: move.kind === "double-pawn"
      ? (move.from + move.to) / 2 // square the pawn skipped over
      : null,
    halfmoveClock: isCapture || piece.type === "pawn" ? 0 : state.halfmoveClock + 1,
    fullmoveNumber:
      state.sideToMove === "black" ? state.fullmoveNumber + 1 : state.fullmoveNumber,
  };
  return next;
}

/** Fully legal moves for the side to move (filters out self-check). */
export function legalMoves(
  state: GameState,
  registry: PieceRegistry,
  effects: BoardEffects = NO_EFFECTS
): Move[] {
  const isRoyal = (type: string) => registry.get(type).isRoyal === true;
  const me = state.sideToMove;
  const candidates: Move[] = [];

  for (let sq = 0; sq < state.board.length; sq++) {
    const p = state.board[sq];
    if (!p || p.color !== me) continue;
    candidates.push(...pseudoLegalMoves(state, sq, registry, effects));
  }
  candidates.push(...castlingMoves(state, registry, effects));

  const moves: Move[] = [];
  for (const move of candidates) {
    const after = applyMove(state, move, registry);
    const king = findRoyal(after.board, me, isRoyal);
    // If we have no royal piece (variant), skip the safety filter.
    if (king === -1 || !isSquareAttacked(after, king, opposite(me), registry, effects)) {
      moves.push(move);
    }
  }
  return moves;
}

/** Classify the position for the side to move. */
export function status(
  state: GameState,
  registry: PieceRegistry,
  effects: BoardEffects = NO_EFFECTS
): GameStatus {
  if (state.halfmoveClock >= 100) return "draw"; // 50-move rule (in plies)
  const moves = legalMoves(state, registry, effects);
  const isRoyal = (t: string) => registry.get(t).isRoyal === true;
  const king = findRoyal(state.board, state.sideToMove, isRoyal);
  const inCheck = king !== -1 && isSquareAttacked(state, king, opposite(state.sideToMove), registry, effects);
  if (moves.length === 0) return inCheck ? "checkmate" : "stalemate";
  return inCheck ? "check" : "playing";
}

/** Validate a requested from→to move and return the resolved Move, or null.
 * For promotions, `promotion` selects the piece (defaults to queen). */
export function resolveLegalMove(
  state: GameState,
  from: Square,
  to: Square,
  registry: PieceRegistry,
  effects: BoardEffects = NO_EFFECTS,
  promotion: PieceTypeId = "queen"
): Move | null {
  const matches = legalMoves(state, registry, effects).filter((m) => m.from === from && m.to === to);
  if (matches.length === 0) return null;
  return matches.find((m) => m.kind !== "promotion" || m.promotion === promotion) ?? matches[0]!;
}

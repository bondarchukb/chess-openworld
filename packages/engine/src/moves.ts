/**
 * Data-driven move generation and authoritative validation.
 *
 * Move behaviour is read from PieceDefs (rides/hops/pawn) so custom pieces work
 * without changes here. This module is pure and deterministic — the server runs
 * it as the single source of truth; clients only ever *predict*.
 *
 * Scope note: standard sliding/leaping pieces and pawns (incl. double-step and
 * en passant) plus king-safety filtering are implemented. Castling and
 * under-promotion are deliberately left as TODOs — they don't affect the MMO
 * world slice and slot in cleanly later.
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
import type { PieceDef, PieceRegistry } from "./pieces.js";
import { BOARD_SIZE, type Color, type GameState, type Move, type Piece, type Square } from "./types.js";

function pieceAt(state: GameState, sq: Square): Piece | null {
  return state.board[sq] ?? null;
}

/** All squares a non-pawn piece attacks/moves to from `sq` (pseudo-legal). */
function ridesAndHops(state: GameState, sq: Square, def: PieceDef, color: Color): Square[] {
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

  for (const [dx, dy] of def.hops ?? []) {
    const x = x0 + dx;
    const y = y0 + dy;
    if (!onBoard(x, y)) continue;
    const target = xy(x, y);
    const occ = pieceAt(state, target);
    if (!occ || occ.color !== color) out.push(target);
  }

  return out;
}

/** Pawn pseudo-legal destinations as Move objects (handles double-step + EP). */
function pawnMoves(state: GameState, sq: Square, color: Color): Move[] {
  const out: Move[] = [];
  const dir = pawnDir(color);
  const x0 = fileOf(sq);
  const y0 = rankOf(sq);
  const startRank = color === "white" ? 1 : BOARD_SIZE - 2;
  const promoteRank = color === "white" ? BOARD_SIZE - 1 : 0;

  // Forward one
  const y1 = y0 + dir;
  if (onBoard(x0, y1) && !pieceAt(state, xy(x0, y1))) {
    pushPawn(out, sq, xy(x0, y1), y1 === promoteRank, "normal");
    // Forward two from start
    const y2 = y0 + 2 * dir;
    if (y0 === startRank && !pieceAt(state, xy(x0, y2))) {
      out.push({ from: sq, to: xy(x0, y2), kind: "double-pawn" });
    }
  }

  // Captures (incl. en passant)
  for (const dx of [-1, 1]) {
    const x = x0 + dx;
    if (!onBoard(x, y1)) continue;
    const target = xy(x, y1);
    const occ = pieceAt(state, target);
    if (occ && occ.color !== color) {
      pushPawn(out, sq, target, y1 === promoteRank, "normal");
    } else if (state.enPassant === target) {
      out.push({
        from: sq,
        to: target,
        kind: "en-passant",
        captureSquare: xy(x, y0),
      });
    }
  }

  return out;
}

function pushPawn(out: Move[], from: Square, to: Square, promote: boolean, kind: "normal"): void {
  if (promote) {
    out.push({ from, to, kind: "promotion", promotion: "queen" }); // auto-queen for now
  } else {
    out.push({ from, to, kind });
  }
}

/** Pseudo-legal moves for the piece on `sq` (ignores leaving own king in check). */
export function pseudoLegalMoves(
  state: GameState,
  sq: Square,
  registry: PieceRegistry
): Move[] {
  const piece = pieceAt(state, sq);
  if (!piece) return [];
  const def = registry.get(piece.type);
  if (def.isPawn) return pawnMoves(state, sq, piece.color);
  return ridesAndHops(state, sq, def, piece.color).map((to) => ({
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
  registry: PieceRegistry
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
    } else if (ridesAndHops(state, from, def, p.color).includes(sq)) {
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
export function legalMoves(state: GameState, registry: PieceRegistry): Move[] {
  const isRoyal = (type: string) => registry.get(type).isRoyal === true;
  const me = state.sideToMove;
  const moves: Move[] = [];

  for (let sq = 0; sq < state.board.length; sq++) {
    const p = state.board[sq];
    if (!p || p.color !== me) continue;
    for (const move of pseudoLegalMoves(state, sq, registry)) {
      const after = applyMove(state, move, registry);
      const king = findRoyal(after.board, me, isRoyal);
      // If we have no royal piece (variant), skip the safety filter.
      if (king === -1 || !isSquareAttacked(after, king, opposite(me), registry)) {
        moves.push(move);
      }
    }
  }
  return moves;
}

/** Validate a requested from→to move and return the resolved Move, or null. */
export function resolveLegalMove(
  state: GameState,
  from: Square,
  to: Square,
  registry: PieceRegistry
): Move | null {
  return legalMoves(state, registry).find((m) => m.from === from && m.to === to) ?? null;
}

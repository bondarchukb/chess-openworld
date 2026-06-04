/**
 * Board geometry helpers and standard position setup.
 *
 * Coordinates: x = file (0 = a-file), y = rank (0 = rank 1, white's back rank).
 * White advances toward +y, black toward -y.
 */

import { BOARD_SIZE, type Color, type GameState, type Piece, type Square } from "./types.js";

export function xy(x: number, y: number): Square {
  return y * BOARD_SIZE + x;
}

export function fileOf(sq: Square): number {
  return sq % BOARD_SIZE;
}

export function rankOf(sq: Square): number {
  return Math.floor(sq / BOARD_SIZE);
}

export function onBoard(x: number, y: number): boolean {
  return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

/** Convert a square to algebraic notation, e.g. 0 -> "a1", 63 -> "h8". */
export function toAlgebraic(sq: Square): string {
  const file = String.fromCharCode("a".charCodeAt(0) + fileOf(sq));
  const rank = String(rankOf(sq) + 1);
  return file + rank;
}

/** Parse algebraic notation, e.g. "e4" -> square index. */
export function fromAlgebraic(s: string): Square {
  const x = s.charCodeAt(0) - "a".charCodeAt(0);
  const y = Number(s[1]) - 1;
  if (!onBoard(x, y)) throw new Error(`Invalid square: ${s}`);
  return xy(x, y);
}

export function opposite(color: Color): Color {
  return color === "white" ? "black" : "white";
}

/** Direction a pawn of the given color advances. */
export function pawnDir(color: Color): number {
  return color === "white" ? 1 : -1;
}

export function emptyBoard(): (Piece | null)[] {
  return new Array<Piece | null>(BOARD_SIZE * BOARD_SIZE).fill(null);
}

const BACK_RANK: readonly string[] = [
  "rook",
  "knight",
  "bishop",
  "queen",
  "king",
  "bishop",
  "knight",
  "rook",
];

/** Build the standard chess starting position. */
export function initialState(): GameState {
  const board = emptyBoard();
  for (let x = 0; x < BOARD_SIZE; x++) {
    board[xy(x, 0)] = { type: BACK_RANK[x]!, color: "white" };
    board[xy(x, 1)] = { type: "pawn", color: "white" };
    board[xy(x, 6)] = { type: "pawn", color: "black" };
    board[xy(x, 7)] = { type: BACK_RANK[x]!, color: "black" };
  }
  return {
    board,
    sideToMove: "white",
    enPassant: null,
    halfmoveClock: 0,
    fullmoveNumber: 1,
  };
}

/** Find the square of a color's first royal (king) piece, or -1. */
export function findRoyal(
  board: (Piece | null)[],
  color: Color,
  isRoyal: (type: string) => boolean
): Square {
  for (let sq = 0; sq < board.length; sq++) {
    const p = board[sq];
    if (p && p.color === color && isRoyal(p.type)) return sq;
  }
  return -1;
}

/** ASCII render, handy for tests and debugging. Uppercase = white. */
export function render(state: GameState): string {
  const glyph: Record<string, string> = {
    pawn: "p",
    knight: "n",
    bishop: "b",
    rook: "r",
    queen: "q",
    king: "k",
  };
  const rows: string[] = [];
  for (let y = BOARD_SIZE - 1; y >= 0; y--) {
    let row = "";
    for (let x = 0; x < BOARD_SIZE; x++) {
      const p = state.board[xy(x, y)];
      if (!p) {
        row += ".";
      } else {
        const g = glyph[p.type] ?? "?";
        row += p.color === "white" ? g.toUpperCase() : g;
      }
    }
    rows.push(row);
  }
  return rows.join("\n");
}

import { describe, expect, it } from "vitest";
import {
  PieceRegistry,
  applyMove,
  emptyBoard,
  fromAlgebraic,
  initialState,
  legalMoves,
  pseudoLegalMoves,
  resolveLegalMove,
  status,
  xy,
  type GameState,
  type Piece,
} from "../src/index.js";

const reg = new PieceRegistry();

/** Build a sparse position from a map of square -> piece. */
function position(pieces: Record<number, Piece>, sideToMove: "white" | "black" = "white"): GameState {
  const board = emptyBoard();
  for (const [sq, p] of Object.entries(pieces)) board[Number(sq)] = p;
  return { board, sideToMove, enPassant: null, halfmoveClock: 0, fullmoveNumber: 1 };
}

describe("data-driven move generation", () => {
  it("opening position has 20 legal moves", () => {
    expect(legalMoves(initialState(), reg).length).toBe(20);
  });

  it("knight on b1 has two opening moves (a3, c3)", () => {
    const moves = pseudoLegalMoves(initialState(), fromAlgebraic("b1"), reg);
    const dests = moves.map((m) => m.to).sort();
    expect(dests).toEqual([fromAlgebraic("a3"), fromAlgebraic("c3")].sort());
  });

  it("rejects an illegal move and accepts a legal one", () => {
    const s = initialState();
    expect(resolveLegalMove(s, fromAlgebraic("e2"), fromAlgebraic("e5"), reg)).toBeNull();
    expect(resolveLegalMove(s, fromAlgebraic("e2"), fromAlgebraic("e4"), reg)).not.toBeNull();
  });

  it("supports registering a custom piece (data-driven)", () => {
    const custom = new PieceRegistry();
    custom.register({
      id: "amazon",
      rides: [{ dirs: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]], range: Infinity }],
      hops: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]],
    });
    expect(custom.has("amazon")).toBe(true);
  });
});

describe("full chess rules", () => {
  it("offers four under-promotion choices on the back rank", () => {
    // White pawn on a7, nothing blocking a8.
    const s = position({ [fromAlgebraic("a7")]: { type: "pawn", color: "white" } });
    const promos = pseudoLegalMoves(s, fromAlgebraic("a7"), reg).filter((m) => m.kind === "promotion");
    expect(promos.map((m) => m.promotion).sort()).toEqual(["bishop", "knight", "queen", "rook"]);
    // resolveLegalMove honors the requested promotion piece.
    const m = resolveLegalMove(s, fromAlgebraic("a7"), fromAlgebraic("a8"), reg, undefined, "knight");
    expect(m?.promotion).toBe("knight");
  });

  it("generates king-side castling and relocates the rook", () => {
    const s = position({
      [fromAlgebraic("e1")]: { type: "king", color: "white" },
      [fromAlgebraic("h1")]: { type: "rook", color: "white" },
      [fromAlgebraic("e8")]: { type: "king", color: "black" },
    });
    const castle = resolveLegalMove(s, fromAlgebraic("e1"), fromAlgebraic("g1"), reg);
    expect(castle?.kind).toBe("castle-king");
    const after = applyMove(s, castle!, reg);
    expect(after.board[fromAlgebraic("g1")]?.type).toBe("king");
    expect(after.board[fromAlgebraic("f1")]?.type).toBe("rook");
  });

  it("forbids castling through an attacked square", () => {
    const s = position({
      [fromAlgebraic("e1")]: { type: "king", color: "white" },
      [fromAlgebraic("h1")]: { type: "rook", color: "white" },
      [fromAlgebraic("f8")]: { type: "rook", color: "black" }, // attacks f1
      [fromAlgebraic("e8")]: { type: "king", color: "black" },
    });
    expect(resolveLegalMove(s, fromAlgebraic("e1"), fromAlgebraic("g1"), reg)).toBeNull();
  });

  it("detects checkmate (back-rank mate)", () => {
    const s = position(
      {
        [fromAlgebraic("g1")]: { type: "king", color: "white" },
        [fromAlgebraic("f2")]: { type: "pawn", color: "white" },
        [fromAlgebraic("g2")]: { type: "pawn", color: "white" },
        [fromAlgebraic("h2")]: { type: "pawn", color: "white" },
        [fromAlgebraic("a1")]: { type: "rook", color: "black" },
        [fromAlgebraic("e8")]: { type: "king", color: "black" },
      },
      "white"
    );
    expect(status(s, reg)).toBe("checkmate");
  });

  it("detects stalemate", () => {
    const s = position(
      {
        [fromAlgebraic("a1")]: { type: "king", color: "white" },
        [fromAlgebraic("b3")]: { type: "queen", color: "black" },
        [fromAlgebraic("c2")]: { type: "king", color: "black" },
      },
      "white"
    );
    expect(status(s, reg)).toBe("stalemate");
  });
});

describe("board effects (artifacts / terrain)", () => {
  it("a blocked square stops a rook sliding through it", () => {
    const s = position({ [fromAlgebraic("a1")]: { type: "rook", color: "white" } });
    const blocked = { blocked: new Set([fromAlgebraic("a4")]) };
    const dests = pseudoLegalMoves(s, fromAlgebraic("a1"), reg, blocked).map((m) => m.to);
    expect(dests).toContain(fromAlgebraic("a3"));
    expect(dests).not.toContain(fromAlgebraic("a4")); // wall
    expect(dests).not.toContain(fromAlgebraic("a5")); // beyond the wall
  });

  it("an aura grants a rook extra knight hops", () => {
    const s = position({ [fromAlgebraic("d4")]: { type: "rook", color: "white" } });
    const knightHops: [number, number][] = [
      [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1],
    ];
    const aura = { grantHops: () => knightHops };
    const dests = pseudoLegalMoves(s, fromAlgebraic("d4"), reg, aura).map((m) => m.to);
    expect(dests).toContain(fromAlgebraic("e6")); // a knight move a plain rook can't make
    expect(dests).toContain(fromAlgebraic("d8")); // still slides as a rook
  });
});

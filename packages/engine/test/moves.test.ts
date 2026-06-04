import { describe, expect, it } from "vitest";
import {
  PieceRegistry,
  fromAlgebraic,
  initialState,
  legalMoves,
  pseudoLegalMoves,
  resolveLegalMove,
} from "../src/index.js";

const reg = new PieceRegistry();

describe("data-driven move generation", () => {
  it("opening position has 20 legal moves", () => {
    expect(legalMoves(initialState(), reg).length).toBe(20);
  });

  it("knight on b1 has two opening moves (a3, c3)", () => {
    const moves = pseudoLegalMoves(initialState(), fromAlgebraic("b1"), reg);
    const dests = moves.map((m) => m.to).sort();
    expect(dests).toEqual([fromAlgebraic("a3"), fromAlgebraic("c3")].sort());
  });

  it("pawn can advance one or two squares from start", () => {
    const moves = pseudoLegalMoves(initialState(), fromAlgebraic("e2"), reg);
    const dests = moves.map((m) => m.to).sort();
    expect(dests).toEqual([fromAlgebraic("e3"), fromAlgebraic("e4")].sort());
  });

  it("rejects an illegal move and accepts a legal one", () => {
    const s = initialState();
    expect(resolveLegalMove(s, fromAlgebraic("e2"), fromAlgebraic("e5"), reg)).toBeNull();
    expect(resolveLegalMove(s, fromAlgebraic("e2"), fromAlgebraic("e4"), reg)).not.toBeNull();
  });

  it("supports registering a custom piece (data-driven)", () => {
    const custom = new PieceRegistry();
    // An "amazon" = queen + knight movement, a classic fairy piece.
    custom.register({
      id: "amazon",
      rides: [{ dirs: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]], range: Infinity }],
      hops: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]],
    });
    expect(custom.has("amazon")).toBe(true);
  });
});

/**
 * Client entrypoint: connect, take input, render the interest set isometrically.
 *
 * The client is deliberately "dumb": it sends intents and draws whatever the
 * server says is around us. All authority lives on the server.
 *
 * Rendering reuses a pool of display nodes keyed by entity id / board square,
 * so we don't allocate a Text per object every frame (that churned the GC and
 * leaked GPU textures). Nodes are created on first sight, repositioned each
 * frame, and destroyed when they leave.
 *
 * Camera: follows your avatar by default; drag to look around, wheel to zoom.
 * The server streams interest around our focus point, so we can roam the map.
 */

import { Application, Container, Graphics, Text } from "pixi.js";
import { WORLD } from "@chess-openworld/protocol";
import { Connection } from "./net.js";
import {
  ENTITY_STYLE,
  TILE_H,
  TILE_W,
  isoToScreen,
  pieceGlyph,
  screenToIso,
  tileColor,
} from "./iso.js";

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.2;

// Where to reach the game server, in priority order:
//  1. VITE_WS_URL  — set this in Vercel to your deployed server (wss://…).
//  2. dev proxy    — `npm run dev` forwards /ws to localhost:8080.
//  3. fallback     — a server on the same host as the page.
const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
const wsProto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl =
  envUrl ??
  (location.port === "5173"
    ? `${wsProto}://${location.host}/ws`
    : `${wsProto}://${location.host}`);

const statusEl = document.getElementById("status")!;
const boardEl = document.getElementById("board")!;
const conn = new Connection(wsUrl);
conn.onStatus = (t) => (statusEl.textContent = t);

const app = new Application();
await app.init({ background: "#1b1030", resizeTo: window, antialias: true });
document.body.appendChild(app.canvas);

const scene = new Container();
const groundLayer = new Graphics();
const entityLayer = new Container();
entityLayer.sortableChildren = true; // depth via zIndex instead of manual sort
scene.addChild(groundLayer, entityLayer);
app.stage.addChild(scene);

// ---- camera state ----------------------------------------------------------

const camera = { cx: 0, cy: 0, zoom: 1, following: true };
/** Selected board square (source of a pending move), or null. */
let selected: number | null = null;

// ---- keyboard --------------------------------------------------------------

const stepFor: Record<string, [number, number]> = {
  ArrowUp: [0, -1], w: [0, -1],
  ArrowDown: [0, 1], s: [0, 1],
  ArrowLeft: [-1, 0], a: [-1, 0],
  ArrowRight: [1, 0], d: [1, 0],
};

window.addEventListener("keydown", (e) => {
  const step = stepFor[e.key];
  if (step) {
    conn.send({ t: "move", dx: step[0], dy: step[1] });
    camera.following = true;
    return;
  }
  if (e.key === "c" || e.key === "C") camera.following = true;
  if (e.key === "b") conn.send({ t: "place", kind: "building", skin: "castle" });
  if (e.key === "f") conn.send({ t: "place", kind: "artifact", skin: "crystal" });
  if (e.key === "Enter") conn.send({ t: "sit" });
  if (e.key === "n" || e.key === "N") conn.send({ t: "newGame" });
});

// ---- mouse: drag to pan, click to interact, wheel to zoom ------------------

let dragging = false;
let lastPtr = { x: 0, y: 0 };
let dragMoved = 0;

app.canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  dragMoved = 0;
  lastPtr = { x: e.clientX, y: e.clientY };
  app.canvas.style.cursor = "grabbing";
});

window.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dpx = e.clientX - lastPtr.x;
  const dpy = e.clientY - lastPtr.y;
  lastPtr = { x: e.clientX, y: e.clientY };
  dragMoved += Math.abs(dpx) + Math.abs(dpy);
  const d = screenToIso(dpx / camera.zoom, dpy / camera.zoom);
  camera.cx -= d.x;
  camera.cy -= d.y;
  camera.following = false;
});

window.addEventListener("pointerup", (e) => {
  dragging = false;
  app.canvas.style.cursor = "grab";
  if (dragMoved < 6) handleClick(e.clientX, e.clientY); // a tap, not a drag
});

app.canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    camera.zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  },
  { passive: false }
);
app.canvas.style.cursor = "grab";

/** Screen pixel -> world tile, inverting the camera transform. */
function pickTile(clientX: number, clientY: number): { x: number; y: number } {
  const cam = isoToScreen(camera.cx, camera.cy);
  const sceneX = app.screen.width / 2 - cam.sx * camera.zoom;
  const sceneY = app.screen.height / 2 - cam.sy * camera.zoom;
  const w = screenToIso((clientX - sceneX) / camera.zoom, (clientY - sceneY) / camera.zoom);
  return { x: Math.round(w.x), y: Math.round(w.y) };
}

/** Click handling: select one of your pieces, then click a destination. */
function handleClick(clientX: number, clientY: number): void {
  const board = conn.board;
  const self = conn.self;
  if (!board || !self) return;
  const { x, y } = pickTile(clientX, clientY);
  const bx = x - board.originX;
  const by = y - board.originY;
  if (bx < 0 || bx > 7 || by < 0 || by > 7) {
    selected = null; // clicked off the board
    return;
  }
  const square = by * 8 + bx;
  const myColor =
    board.seatWhite === self.id ? "white" : board.seatBlack === self.id ? "black" : null;

  if (selected === null) {
    const cell = board.cells[square];
    if (myColor && cell && cell.startsWith(myColor)) selected = square;
    return;
  }
  if (selected === square) {
    selected = null; // clicked the same square again
    return;
  }
  conn.send({ t: "boardMove", from: selected, to: square, promotion: "queen" });
  selected = null;
}

// ---- render loop -----------------------------------------------------------

const pool = new Map<string, Container>();
let groundKey = "";
let lastFocus = { x: -1, y: -1 };
let lastBoardText = "";

app.ticker.add(() => {
  const self = conn.self;
  if (!self) return;

  if (camera.following) {
    camera.cx += (self.x - camera.cx) * 0.2;
    camera.cy += (self.y - camera.cy) * 0.2;
  }
  camera.cx = clamp(camera.cx, 0, WORLD.width - 1);
  camera.cy = clamp(camera.cy, 0, WORLD.height - 1);

  const fx = Math.round(camera.cx);
  const fy = Math.round(camera.cy);
  if (fx !== lastFocus.x || fy !== lastFocus.y) {
    lastFocus = { x: fx, y: fy };
    conn.send({ t: "focus", x: fx, y: fy });
  }

  const cam = isoToScreen(camera.cx, camera.cy);
  scene.scale.set(camera.zoom);
  scene.position.set(
    app.screen.width / 2 - cam.sx * camera.zoom,
    app.screen.height / 2 - cam.sy * camera.zoom
  );

  const board = conn.board;
  const inBoard = (x: number, y: number) =>
    board != null &&
    x >= board.originX && x < board.originX + 8 &&
    y >= board.originY && y < board.originY + 8;

  const halfW = app.screen.width / 2 / camera.zoom;
  const halfH = app.screen.height / 2 / camera.zoom;
  const radius = Math.ceil(halfW / TILE_W + halfH / TILE_H) + 2;
  const ccx = Math.round(camera.cx);
  const ccy = Math.round(camera.cy);

  // Ground: rebuilt only when the visible tile window changes.
  const gkey = `${ccx},${ccy},${radius}`;
  if (gkey !== groundKey) {
    groundKey = gkey;
    groundLayer.clear();
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = ccx + dx;
        const y = ccy + dy;
        if (x < 0 || y < 0 || x >= WORLD.width || y >= WORLD.height) continue;
        const { sx, sy } = isoToScreen(x, y);
        drawDiamond(groundLayer, sx, sy, tileColor(x, y, inBoard(x, y)));
      }
    }
  }

  // Pooled display nodes: reuse by key, create on first sight, cull on leave.
  const used = new Set<string>();
  const place = (key: string, wx: number, wy: number, build: () => Container, depthBias = 0) => {
    let node = pool.get(key);
    if (!node) {
      node = build();
      entityLayer.addChild(node);
      pool.set(key, node);
    }
    const { sx, sy } = isoToScreen(wx, wy);
    node.position.set(sx, sy);
    node.zIndex = wx + wy + depthBias;
    used.add(key);
    return node;
  };

  // Selection highlight (under the piece on that square).
  if (board && selected !== null) {
    const sx = board.originX + (selected % 8);
    const sy = board.originY + Math.floor(selected / 8);
    place("sel", sx, sy, makeHighlight, -0.1);
  }

  // Board pieces — keyed by square+contents, so a node is reused while static
  // and recreated only when that square's piece changes.
  if (board) {
    board.cells.forEach((cell, i) => {
      if (!cell) return;
      const [color, type] = cell.split(":");
      const wx = board.originX + (i % 8);
      const wy = board.originY + Math.floor(i / 8);
      place(`b${i}:${cell}`, wx, wy, () =>
        glyphNode(pieceGlyph(type!), color === "white" ? 0xffffff : 0x222222)
      );
    });
  }

  // World entities — keyed by id; position updates each frame.
  for (const e of conn.entities.values()) {
    const style = ENTITY_STYLE[e.kind] ?? ENTITY_STYLE.player!;
    const label = e.kind === "player" ? e.label : undefined;
    place(`e${e.id}`, e.x, e.y, () => markerNode(style.glyph, style.color, label));
  }

  // Cull nodes that weren't used this frame.
  for (const [key, node] of pool) {
    if (!used.has(key)) {
      node.destroy({ children: true });
      pool.delete(key);
    }
  }

  // Board HUD line.
  if (board) {
    const seat =
      board.seatWhite === self.id ? "White" : board.seatBlack === self.id ? "Black" : "spectator";
    const text = `Board: ${board.status} · ${board.sideToMove} to move · you are ${seat}`;
    if (text !== lastBoardText) {
      lastBoardText = text;
      boardEl.textContent = text;
    }
  }
});

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function drawDiamond(g: Graphics, cx: number, cy: number, color: number): void {
  g.poly([cx, cy - TILE_H / 2, cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx - TILE_W / 2, cy])
    .fill({ color })
    .stroke({ color: 0x000000, alpha: 0.12, width: 1 });
}

function makeHighlight(): Container {
  const c = new Container();
  c.addChild(
    new Graphics()
      .poly([0, -TILE_H / 2, TILE_W / 2, 0, 0, TILE_H / 2, -TILE_W / 2, 0])
      .fill({ color: 0xffe066, alpha: 0.45 })
      .stroke({ color: 0xffe066, width: 2 })
  );
  return c;
}

function glyphNode(glyph: string, color: number): Container {
  const c = new Container();
  const t = new Text({
    text: glyph,
    style: { fontFamily: "serif", fontSize: 30, fill: color, stroke: { color: 0x000000, width: 3 } },
  });
  t.anchor.set(0.5, 0.8);
  c.addChild(t);
  return c;
}

function markerNode(glyph: string, color: number, label?: string): Container {
  const c = new Container();
  const body = new Graphics().circle(0, -14, 10).fill({ color }).stroke({ color: 0x000000, width: 2 });
  c.addChild(body);
  const t = new Text({ text: glyph, style: { fontSize: 16, fill: 0xffffff } });
  t.anchor.set(0.5, 1.4);
  c.addChild(t);
  if (label) {
    const name = new Text({
      text: label,
      style: { fontSize: 12, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
    });
    name.anchor.set(0.5, 3.2);
    c.addChild(name);
  }
  return c;
}

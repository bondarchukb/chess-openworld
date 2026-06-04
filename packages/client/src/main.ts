/**
 * Client entrypoint: connect, take input, render the interest set isometrically.
 *
 * The client is deliberately "dumb": it sends movement intents and draws
 * whatever the server says is around us. All authority lives on the server.
 *
 * Camera: by default it follows your avatar, but you can drag to look around
 * and wheel to zoom. Panning is clamped to the loaded interest region around
 * your avatar — the server only streams entities near you, so we don't let the
 * camera wander into ground we have no data for. Press C (or just walk) to
 * recenter on your avatar.
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

/** How far (in tiles) the camera may roam from the avatar. Kept inside one
 * zone so it never leaves the guaranteed-loaded interest region. */
const PAN_LIMIT = WORLD.zoneSize - 2;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.2;

// Dev uses the Vite proxy at /ws; otherwise connect straight to the server.
const wsUrl =
  location.protocol === "https:" || location.port === "5173"
    ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`
    : "ws://localhost:8080";

const statusEl = document.getElementById("status")!;
const conn = new Connection(wsUrl);
conn.onStatus = (t) => (statusEl.textContent = t);

const app = new Application();
await app.init({ background: "#1b1030", resizeTo: window, antialias: true });
document.body.appendChild(app.canvas);

// scene holds the camera transform; ground is cached, entities redraw per frame.
const scene = new Container();
const groundLayer = new Graphics();
const entityLayer = new Container();
scene.addChild(groundLayer, entityLayer);
app.stage.addChild(scene);

// ---- camera state ----------------------------------------------------------

const camera = {
  cx: 0, // world-tile center (float)
  cy: 0,
  zoom: 1,
  following: true,
};

// ---- keyboard: move the avatar (and recenter the camera) -------------------

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
    camera.following = true; // walking re-centers the camera on you
    return;
  }
  if (e.key === "c" || e.key === "C") camera.following = true;
  if (e.key === "b") conn.send({ t: "place", kind: "building", skin: "castle" });
  if (e.key === "f") conn.send({ t: "place", kind: "artifact", skin: "crystal" });
});

// ---- mouse: drag to pan, wheel to zoom -------------------------------------

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
  // Convert the pixel delta to world tiles (undo zoom), then move the camera
  // opposite to the drag so the world follows the cursor.
  const d = screenToIso(dpx / camera.zoom, dpy / camera.zoom);
  camera.cx -= d.x;
  camera.cy -= d.y;
  camera.following = false; // free look until the user recenters
});

window.addEventListener("pointerup", () => {
  dragging = false;
  app.canvas.style.cursor = "grab";
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

// ---- render loop -----------------------------------------------------------

let groundKey = "";

app.ticker.add(() => {
  const self = conn.self;
  if (!self) return;

  // Follow the avatar smoothly, or hold the free-look position.
  if (camera.following) {
    camera.cx += (self.x - camera.cx) * 0.2;
    camera.cy += (self.y - camera.cy) * 0.2;
  }
  // Clamp to the loaded interest region (and the world edges).
  camera.cx = clamp(camera.cx, Math.max(0, self.x - PAN_LIMIT), Math.min(WORLD.width - 1, self.x + PAN_LIMIT));
  camera.cy = clamp(camera.cy, Math.max(0, self.y - PAN_LIMIT), Math.min(WORLD.height - 1, self.y + PAN_LIMIT));

  // Apply camera transform: scale by zoom, center the camera point on screen.
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

  // How many tiles reach the screen edges from the camera center (pre-zoom).
  const halfW = app.screen.width / 2 / camera.zoom;
  const halfH = app.screen.height / 2 / camera.zoom;
  const radius = Math.ceil(halfW / TILE_W + halfH / TILE_H) + 2;
  const ccx = Math.round(camera.cx);
  const ccy = Math.round(camera.cy);

  // Rebuild the ground only when the visible tile window actually changes.
  const key = `${ccx},${ccy},${radius}`;
  if (key !== groundKey) {
    groundKey = key;
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

  // Entities + board pieces redraw every frame (they move).
  entityLayer.removeChildren();
  const drawables: { x: number; y: number; node: Container }[] = [];
  if (board) {
    board.cells.forEach((cell, i) => {
      if (!cell) return;
      const [color, type] = cell.split(":");
      const bx = board.originX + (i % 8);
      const by = board.originY + Math.floor(i / 8);
      drawables.push({ x: bx, y: by, node: glyphNode(pieceGlyph(type!), color === "white" ? 0xffffff : 0x222222) });
    });
  }
  for (const e of conn.entities.values()) {
    const style = ENTITY_STYLE[e.kind] ?? ENTITY_STYLE.player!;
    const label = e.kind === "player" ? e.label : undefined;
    drawables.push({ x: e.x, y: e.y, node: markerNode(style.glyph, style.color, label) });
  }

  // Depth sort: smaller (x+y) is farther back.
  drawables.sort((a, b) => a.x + a.y - (b.x + b.y));
  for (const d of drawables) {
    const { sx, sy } = isoToScreen(d.x, d.y);
    d.node.position.set(sx, sy);
    entityLayer.addChild(d.node);
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

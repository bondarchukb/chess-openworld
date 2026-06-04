/**
 * Client entrypoint: connect, take input, render the interest set isometrically.
 *
 * The client is deliberately "dumb": it sends movement intents and draws
 * whatever the server says is around us. All authority lives on the server.
 */

import { Application, Container, Graphics, Text } from "pixi.js";
import { Connection } from "./net.js";
import {
  ENTITY_STYLE,
  TILE_H,
  TILE_W,
  isoToScreen,
  pieceGlyph,
  tileColor,
} from "./iso.js";

const VIEW_RADIUS = 14; // tiles drawn around the camera in each direction

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

const scene = new Container();
app.stage.addChild(scene);

// ---- input: one intent per keypress, server clamps to one tile -------------

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
    return;
  }
  if (e.key === "b") conn.send({ t: "place", kind: "building", skin: "castle" });
  if (e.key === "f") conn.send({ t: "place", kind: "artifact", skin: "crystal" });
});

// ---- render loop -----------------------------------------------------------

app.ticker.add(() => {
  scene.removeChildren();
  const self = conn.self;
  if (!self) return;

  const cam = isoToScreen(self.x, self.y);
  const ox = app.screen.width / 2 - cam.sx;
  const oy = app.screen.height / 2 - cam.sy;

  const board = conn.board;
  const inBoard = (x: number, y: number) =>
    board != null &&
    x >= board.originX && x < board.originX + 8 &&
    y >= board.originY && y < board.originY + 8;

  // Ground diamonds around the camera.
  const ground = new Graphics();
  for (let dy = -VIEW_RADIUS; dy <= VIEW_RADIUS; dy++) {
    for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      const x = self.x + dx;
      const y = self.y + dy;
      if (x < 0 || y < 0) continue;
      const { sx, sy } = isoToScreen(x, y);
      drawDiamond(ground, sx + ox, sy + oy, tileColor(x, y, inBoard(x, y)));
    }
  }
  scene.addChild(ground);

  // Chess pieces on the shared board (server-authoritative).
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

  // Players, buildings, artifacts.
  for (const e of conn.entities.values()) {
    const style = ENTITY_STYLE[e.kind] ?? ENTITY_STYLE.player!;
    const label = e.kind === "player" ? e.label : undefined;
    drawables.push({ x: e.x, y: e.y, node: markerNode(style.glyph, style.color, label) });
  }

  // Depth sort: smaller (x+y) is farther back.
  drawables.sort((a, b) => a.x + a.y - (b.x + b.y));
  for (const d of drawables) {
    const { sx, sy } = isoToScreen(d.x, d.y);
    d.node.position.set(sx + ox, sy + oy);
    scene.addChild(d.node);
  }
});

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

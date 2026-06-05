/**
 * Thin websocket wrapper. Holds the local replica of the piece set the server
 * streams (interest set around the camera). Client renders this, never authors.
 */

import type {
  ArmyId,
  ClientMessage,
  Piece,
  PieceId,
  PlayerStats,
  SelfInfo,
  ServerMessage,
} from "@chess-openworld/protocol";

export interface RosterEntry {
  id: ArmyId;
  name: string;
  color: string;
  spawnX: number;
  spawnY: number;
  inCheck: boolean;
  elo: number;
  dead: boolean;
}

export interface DeadInfo {
  reason: string;
  killerName: string;
  killerElo: number;
  eloDelta: number;
  newStats: PlayerStats;
  respawnAt: number;
}

export class Connection {
  private socket: WebSocket;
  self: SelfInfo | null = null;
  pieces = new Map<PieceId, Piece>();
  roster: RosterEntry[] = [];
  stats: PlayerStats | null = null;
  dead: DeadInfo | null = null;
  /** Best-known server clock offset (serverNow - clientNow), ms. */
  serverOffset = 0;
  onStatus: (text: string) => void = () => {};
  onWelcome: (self: SelfInfo) => void = () => {};
  onDead: (info: DeadInfo) => void = () => {};
  onRespawned: () => void = () => {};

  constructor(
    url: string,
    private playerName: string,
    private spawnMode: "classical" | "blob" = "classical",
    private asSpectator: boolean = false,
  ) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      this.onStatus("connected — joining…");
      this.send({ t: "join", name: this.playerName, spawnMode: this.spawnMode, asSpectator: this.asSpectator });
    });
    this.socket.addEventListener("close", () => this.onStatus("disconnected"));
    this.socket.addEventListener("error", () => this.onStatus("connection error"));
    this.socket.addEventListener("message", (ev) => {
      this.handle(JSON.parse(ev.data) as ServerMessage);
    });
  }

  serverNow(): number {
    return Date.now() + this.serverOffset;
  }

  private syncClock(serverNow: number): void {
    this.serverOffset = serverNow - Date.now();
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.self = msg.you;
        this.stats = msg.you.stats;
        this.syncClock(msg.serverNow);
        this.onStatus(`in world as ${msg.you.name}`);
        this.onWelcome(msg.you);
        break;
      case "snapshot":
        this.syncClock(msg.serverNow);
        this.pieces.clear();
        for (const p of msg.pieces) this.pieces.set(p.id, p);
        break;
      case "delta":
        this.syncClock(msg.serverNow);
        for (const p of msg.enter) this.pieces.set(p.id, p);
        for (const m of msg.move) {
          const p = this.pieces.get(m.id);
          if (p) {
            p.x = m.x;
            p.y = m.y;
            p.readyAt = m.readyAt;
          }
        }
        for (const c of msg.cooldown) {
          const p = this.pieces.get(c.id);
          if (p) {
            p.readyAt = c.readyAt;
            if (c.forward !== undefined) p.forward = c.forward;
          }
        }
        for (const id of msg.leave) this.pieces.delete(id);
        break;
      case "dead":
        this.dead = {
          reason: msg.reason,
          killerName: msg.killerName,
          killerElo: msg.killerElo,
          eloDelta: msg.eloDelta,
          newStats: msg.newStats,
          respawnAt: msg.respawnAt,
        };
        this.stats = msg.newStats;
        this.onDead(this.dead);
        break;
      case "respawned":
        this.stats = msg.stats;
        if (this.dead) {
          this.dead = null;
          this.onRespawned();
        }
        break;
      case "roster":
        this.roster = msg.armies;
        break;
      case "error":
        this.onStatus(`server: ${msg.message}`);
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}

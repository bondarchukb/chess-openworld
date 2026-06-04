/**
 * Thin websocket wrapper. Holds the *local replica* of the interest set the
 * server sends us — the client renders this, it never authors world state.
 */

import type {
  BoardSnapshot,
  ClientMessage,
  Entity,
  EntityId,
  ServerMessage,
  SelfInfo,
} from "@chess-openworld/protocol";

export class Connection {
  private socket: WebSocket;
  self: SelfInfo | null = null;
  entities = new Map<EntityId, Entity>();
  board: BoardSnapshot | null = null;
  onStatus: (text: string) => void = () => {};

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      this.onStatus("connected — joining…");
      this.send({ t: "join", name: `guest-${Math.floor(Math.random() * 1000)}` });
    });
    this.socket.addEventListener("close", () => this.onStatus("disconnected"));
    this.socket.addEventListener("message", (ev) => {
      this.handle(JSON.parse(ev.data) as ServerMessage);
    });
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.self = msg.you;
        this.board = msg.board;
        this.onStatus(`in world as ${msg.you.id} @ (${msg.you.x},${msg.you.y})`);
        break;
      case "snapshot":
        this.entities.clear();
        for (const e of msg.entities) this.entities.set(e.id, e);
        break;
      case "delta":
        for (const e of msg.enter) this.entities.set(e.id, e);
        for (const m of msg.move) {
          const e = this.entities.get(m.id);
          if (e) {
            e.x = m.x;
            e.y = m.y;
          }
        }
        for (const id of msg.leave) this.entities.delete(id);
        break;
      case "board":
        this.board = msg.board;
        break;
      case "error":
        this.onStatus(`server: ${msg.message}`);
        break;
    }
    // Keep our own avatar position in sync from the entity stream.
    if (this.self) {
      const me = this.entities.get(this.self.id);
      if (me) {
        this.self.x = me.x;
        this.self.y = me.y;
      }
    }
  }

  send(msg: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}

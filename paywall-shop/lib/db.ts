import Database from "better-sqlite3";
import path from "node:path";

const dbPath = path.resolve(process.cwd(), process.env.DB_PATH ?? "./paywall.db");

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      bolt11 TEXT NOT NULL,
      payment_hash TEXT NOT NULL UNIQUE,
      verify_url TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting_payment',
      preimage TEXT,
      download_token TEXT UNIQUE,
      download_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      paid_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_orders_payment_hash ON orders(payment_hash);
    CREATE INDEX IF NOT EXISTS idx_orders_download_token ON orders(download_token);
  `);
  return _db;
}

export type Order = {
  id: string;
  email: string;
  name: string;
  bolt11: string;
  payment_hash: string;
  verify_url: string;
  amount_sats: number;
  status: "awaiting_payment" | "paid" | "expired";
  preimage: string | null;
  download_token: string | null;
  download_count: number;
  expires_at: number;
  created_at: number;
  paid_at: number | null;
};

export function insertOrder(o: Omit<Order, "status" | "preimage" | "download_token" | "download_count" | "paid_at">) {
  db()
    .prepare(
      `INSERT INTO orders (id,email,name,bolt11,payment_hash,verify_url,amount_sats,expires_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(o.id, o.email, o.name, o.bolt11, o.payment_hash, o.verify_url, o.amount_sats, o.expires_at, o.created_at);
}

export function getOrder(id: string): Order | null {
  return (db().prepare(`SELECT * FROM orders WHERE id=?`).get(id) as Order | undefined) ?? null;
}

export function getOrderByToken(token: string): Order | null {
  return (db().prepare(`SELECT * FROM orders WHERE download_token=?`).get(token) as Order | undefined) ?? null;
}

export function markPaid(id: string, preimage: string, downloadToken: string) {
  db()
    .prepare(`UPDATE orders SET status='paid', preimage=?, download_token=?, paid_at=? WHERE id=? AND status='awaiting_payment'`)
    .run(preimage, downloadToken, Date.now(), id);
}

export function bumpDownloadCount(id: string) {
  db().prepare(`UPDATE orders SET download_count = download_count + 1 WHERE id=?`).run(id);
}

export function countPaid(): number {
  const row = db().prepare(`SELECT COUNT(*) AS c FROM orders WHERE status='paid'`).get() as { c: number };
  return row.c;
}

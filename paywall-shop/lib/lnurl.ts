import { decode } from "light-bolt11-decoder";

type LnurlpMeta = {
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  commentAllowed?: number;
  tag: string;
};

type LnurlpCallbackResp = {
  pr: string;
  verify?: string;
  routes?: unknown[];
  successAction?: unknown;
  status?: string;
  reason?: string;
};

export type Invoice = {
  bolt11: string;
  payment_hash: string;
  verify_url: string;
  amount_sats: number;
  expires_at: number;
};

function parseLightningAddress(addr: string): { user: string; domain: string } {
  const [user, domain] = addr.trim().toLowerCase().split("@");
  if (!user || !domain) throw new Error("invalid lightning address");
  return { user, domain };
}

export async function fetchLnurlpMeta(addr: string): Promise<LnurlpMeta> {
  const { user, domain } = parseLightningAddress(addr);
  const url = `https://${domain}/.well-known/lnurlp/${user}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`lnurlp meta ${res.status}`);
  const data = (await res.json()) as LnurlpMeta;
  if (data.tag !== "payRequest") throw new Error("not a payRequest");
  return data;
}

export function extractPaymentHash(bolt11: string): { hash: string; expiry: number; timestamp: number } {
  const decoded = decode(bolt11);
  const hashSec = decoded.sections.find((s) => s.name === "payment_hash") as { value: string } | undefined;
  const expirySec = decoded.sections.find((s) => s.name === "expiry") as { value: number } | undefined;
  const tsSec = decoded.sections.find((s) => s.name === "timestamp") as { value: number } | undefined;
  if (!hashSec) throw new Error("no payment_hash in bolt11");
  return {
    hash: hashSec.value,
    expiry: expirySec?.value ?? 3600,
    timestamp: tsSec?.value ?? Math.floor(Date.now() / 1000),
  };
}

export async function createInvoice(addr: string, sats: number, comment?: string): Promise<Invoice> {
  const meta = await fetchLnurlpMeta(addr);
  const amountMsat = sats * 1000;
  if (amountMsat < meta.minSendable || amountMsat > meta.maxSendable) {
    throw new Error(`amount out of bounds: ${meta.minSendable}-${meta.maxSendable} msat`);
  }
  const params = new URLSearchParams({ amount: String(amountMsat) });
  if (comment && meta.commentAllowed) params.set("comment", comment.slice(0, meta.commentAllowed));
  const sep = meta.callback.includes("?") ? "&" : "?";
  const res = await fetch(`${meta.callback}${sep}${params.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`callback ${res.status}`);
  const data = (await res.json()) as LnurlpCallbackResp;
  if (data.status === "ERROR" || !data.pr) {
    throw new Error(`lnurl callback error: ${data.reason ?? "unknown"}`);
  }
  if (!data.verify) {
    throw new Error("provider does not support LUD-21 verify");
  }
  const { hash, expiry, timestamp } = extractPaymentHash(data.pr);
  return {
    bolt11: data.pr,
    payment_hash: hash,
    verify_url: data.verify,
    amount_sats: sats,
    expires_at: (timestamp + expiry) * 1000,
  };
}

export type VerifyResult = {
  settled: boolean;
  preimage: string | null;
  pr?: string;
};

export async function verifyInvoice(verify_url: string): Promise<VerifyResult> {
  const res = await fetch(verify_url, { cache: "no-store" });
  if (!res.ok) throw new Error(`verify ${res.status}`);
  const data = (await res.json()) as { status?: string; settled?: boolean; preimage?: string | null; pr?: string };
  return {
    settled: Boolean(data.settled),
    preimage: data.preimage ?? null,
    pr: data.pr,
  };
}

export async function checkPreimage(preimage: string, expectedHash: string): Promise<boolean> {
  const bytes = new Uint8Array(preimage.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === expectedHash.toLowerCase();
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

type RegisterResp = {
  status: "awaiting_payment";
  order_id: string;
  bolt11: string;
  payment_hash: string;
  verify_url: string;
  amount_sats: number;
  price_usd: number;
  btc_usd: number;
  expires_at: number;
};

type ClaimResp = { status: "paid"; ticket_code: string; download_url: string };

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | ({ kind: "awaiting_payment" } & RegisterResp & { qrDataUrl: string })
  | { kind: "claiming" }
  | { kind: "paid"; download_url: string; ticket_code: string }
  | { kind: "error"; message: string };

declare global {
  interface Window {
    webln?: { enable: () => Promise<void>; sendPayment: (pr: string) => Promise<{ preimage: string }> };
  }
}

export function Checkout({
  name,
  priceSats,
  priceUsd,
  promoCode,
  promoSats,
}: {
  name: string;
  priceSats: number;
  priceUsd: number;
  promoCode: string;
  promoSats: number;
}) {
  const [buyerName, setBuyerName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);

  const promoValid = promoCode.length > 0 && code.trim().toUpperCase() === promoCode;
  const effectiveSats = promoValid ? promoSats : priceSats;

  const claim = useCallback(async (order_id: string, preimage?: string) => {
    setState({ kind: "claiming" });
    const res = await fetch("/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id, preimage }),
    });
    const data = (await res.json()) as ClaimResp | { error: string };
    if (!res.ok || "error" in data) {
      setState({ kind: "error", message: ("error" in data && data.error) || "claim failed" });
      return;
    }
    setState({ kind: "paid", download_url: data.download_url, ticket_code: data.ticket_code });
  }, []);

  useEffect(() => {
    if (state.kind !== "awaiting_payment") return;
    const verify_url = state.verify_url;
    const order_id = state.order_id;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(verify_url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { settled?: boolean; preimage?: string | null };
        if (data.settled && data.preimage && !stopped) {
          stopped = true;
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          pollRef.current = null;
          await claim(order_id, data.preimage);
        }
      } catch {
        /* ignore */
      }
    };
    pollRef.current = window.setInterval(tick, 2000);
    tick();
    return () => {
      stopped = true;
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [state, claim]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setState({ kind: "submitting" });
      try {
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: buyerName, email, code: code || undefined }),
        });
        const data = (await res.json()) as RegisterResp | { error: string };
        if (!res.ok || "error" in data) {
          setState({ kind: "error", message: ("error" in data && data.error) || "register failed" });
          return;
        }
        const qrDataUrl = await QRCode.toDataURL(data.bolt11.toUpperCase(), {
          margin: 2,
          width: 320,
          color: { dark: "#0a0a0a", light: "#ffcc33" },
        });
        setState({ kind: "awaiting_payment", qrDataUrl, ...data });
        if (typeof window !== "undefined" && window.webln) {
          try {
            await window.webln.enable();
            await window.webln.sendPayment(data.bolt11);
          } catch {
            /* user dismissed WebLN */
          }
        }
      } catch (err) {
        setState({ kind: "error", message: err instanceof Error ? err.message : "network error" });
      }
    },
    [buyerName, email, code],
  );

  const copyInvoice = useCallback(async (bolt11: string) => {
    try {
      await navigator.clipboard.writeText(bolt11);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div>
      {(state.kind === "idle" || state.kind === "submitting" || state.kind === "error") && (
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name" value={buyerName} setValue={setBuyerName} placeholder="Satoshi Nakamoto" />
          <Field label="Email · for receipt + download" value={email} setValue={setEmail} placeholder="satoshi@gmx.com" type="email" />
          {showCode ? (
            <div>
              <div className="flex items-center justify-between">
                <label className="label">Promo code</label>
                <button
                  type="button"
                  onClick={() => {
                    setShowCode(false);
                    setCode("");
                  }}
                  className="label hover:text-white transition-colors"
                >
                  × remove
                </button>
              </div>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. DEMO"
                className="mt-2 w-full rounded-lg border border-white/15 bg-white/[0.03] px-4 py-3 text-white placeholder-white/30 focus:outline-none focus:border-[#ffcc33]/50 transition uppercase"
              />
              {promoValid && (
                <p className="mt-2 text-xs text-[#7df9c5] font-mono">
                  ✓ code applied · price drops to {promoSats.toLocaleString()} sats
                </p>
              )}
              {!promoValid && code.length > 0 && (
                <p className="mt-2 text-xs text-[#aaa] font-mono">checking…</p>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowCode(true)}
              className="label hover:text-white transition-colors block"
            >
              + have a promo code?
            </button>
          )}
          <button
            type="submit"
            disabled={state.kind === "submitting"}
            className="w-full btn-primary rounded-lg py-4 text-base mt-3 disabled:opacity-50"
          >
            {state.kind === "submitting"
              ? "Generating invoice…"
              : `⚡ Pay ${effectiveSats.toLocaleString()} sats`}
          </button>
          {state.kind === "error" && (
            <p className="text-red-400 text-sm text-center font-mono">{state.message}</p>
          )}
        </form>
      )}

      {state.kind === "awaiting_payment" && (
        <div className="flex flex-col items-center gap-5">
          <div className="rounded-lg p-3 bg-[#ffcc33]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={state.qrDataUrl} alt="Lightning invoice QR" width={320} height={320} />
          </div>
          <div className="text-center">
            <div className="label">Awaiting payment</div>
            <div className="mt-1 font-mono text-2xl text-[#ffcc33] font-bold">⚡{state.amount_sats.toLocaleString()}</div>
            <div className="mt-2 text-sm text-[#aaa]">Scan with any Lightning wallet</div>
          </div>
          <button onClick={() => copyInvoice(state.bolt11)} className="btn-outline rounded-lg px-5 py-2.5 text-sm font-mono">
            {copied ? "copied ✓" : "copy invoice"}
          </button>
          <div className="flex items-center gap-2 text-xs text-[#777] font-mono">
            <span className="text-[#ffcc33] pulse-bolt">●</span>
            listening for settlement…
          </div>
        </div>
      )}

      {state.kind === "claiming" && (
        <div className="text-center py-10">
          <div className="label text-[#ffcc33]">Payment received</div>
          <div className="mt-3 text-2xl font-bold">Packing your kit…</div>
        </div>
      )}

      {state.kind === "paid" && (
        <div className="text-center py-4">
          <div className="label text-[#ffcc33]">Paid</div>
          <div className="mt-3 text-3xl font-bold">Welcome aboard.</div>
          <p className="mt-2 text-[#aaa]">Your kit is ready. Receipt sent to your email.</p>
          <a href={state.download_url} className="mt-6 inline-block btn-primary rounded-lg px-7 py-4">
            ⬇ Download lightning-paywall-kit.zip
          </a>
          <p className="mt-4 label">order · {state.ticket_code}</p>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  setValue,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        required
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="mt-2 w-full rounded-lg border border-white/15 bg-white/[0.03] px-4 py-3 text-white placeholder-white/30 focus:outline-none focus:border-[#ffcc33]/50 transition"
      />
    </div>
  );
}

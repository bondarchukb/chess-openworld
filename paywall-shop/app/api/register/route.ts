import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { createInvoice } from "@/lib/lnurl";
import { insertOrder } from "@/lib/db";
import { getBtcUsd, usdToSats } from "@/lib/btc-price";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { name?: string; email?: string; code?: string };
    const name = (body.name ?? "").trim();
    const email = (body.email ?? "").trim().toLowerCase();
    const code = (body.code ?? "").trim().toUpperCase();
    if (!name || name.length > 100) return NextResponse.json({ error: "invalid name" }, { status: 400 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "invalid email" }, { status: 400 });

    const addr = process.env.LIGHTNING_ADDRESS;
    const priceUsd = Number(process.env.PRICE_USD ?? "49");
    if (!addr) return NextResponse.json({ error: "server missing LIGHTNING_ADDRESS" }, { status: 500 });

    const promoCode = (process.env.PROMO_CODE ?? "").trim().toUpperCase();
    const promoSats = Number(process.env.PROMO_PRICE_SATS ?? "100");
    const promoApplied = promoCode.length > 0 && code === promoCode;

    const btcUsd = await getBtcUsd();
    const sats = promoApplied ? promoSats : usdToSats(priceUsd, btcUsd);
    const productName = process.env.PRODUCT_NAME ?? "Paywall.zip";
    const inv = await createInvoice(addr, sats, `${productName}${promoApplied ? ` [${promoCode}]` : ""} | ${email}`);

    const id = nanoid(16);
    insertOrder({
      id,
      email,
      name: promoApplied ? `${name} [${promoCode}]` : name,
      bolt11: inv.bolt11,
      payment_hash: inv.payment_hash,
      verify_url: inv.verify_url,
      amount_sats: inv.amount_sats,
      expires_at: inv.expires_at,
      created_at: Date.now(),
    });

    return NextResponse.json({
      status: "awaiting_payment",
      order_id: id,
      bolt11: inv.bolt11,
      payment_hash: inv.payment_hash,
      verify_url: inv.verify_url,
      amount_sats: inv.amount_sats,
      price_usd: promoApplied ? null : priceUsd,
      btc_usd: btcUsd,
      promo_applied: promoApplied,
      expires_at: inv.expires_at,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

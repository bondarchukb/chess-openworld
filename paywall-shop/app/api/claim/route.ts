import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { checkPreimage, verifyInvoice } from "@/lib/lnurl";
import { getOrder, markPaid } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { order_id?: string; preimage?: string };
    const orderId = body.order_id;
    const preimageFromClient = body.preimage;
    if (!orderId) return NextResponse.json({ error: "missing order_id" }, { status: 400 });

    const order = getOrder(orderId);
    if (!order) return NextResponse.json({ error: "order not found" }, { status: 404 });

    if (order.status === "paid" && order.download_token) {
      return NextResponse.json({
        status: "paid",
        ticket_code: order.id,
        download_url: `/api/download/${order.download_token}`,
      });
    }

    let preimage: string | null = preimageFromClient ?? null;
    let settled = false;

    if (preimage && (await checkPreimage(preimage, order.payment_hash))) {
      settled = true;
    } else {
      const v = await verifyInvoice(order.verify_url);
      if (v.settled && v.preimage && (await checkPreimage(v.preimage, order.payment_hash))) {
        settled = true;
        preimage = v.preimage;
      }
    }

    if (!settled || !preimage) {
      return NextResponse.json({ error: "payment not settled" }, { status: 402 });
    }

    const token = nanoid(32);
    markPaid(order.id, preimage, token);

    return NextResponse.json({
      status: "paid",
      ticket_code: order.id,
      download_url: `/api/download/${token}`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

import { Landing } from "./landing";
import { getBtcUsd, usdToSats } from "@/lib/btc-price";

export const dynamic = "force-dynamic";

export default async function Home() {
  const name = process.env.PRODUCT_NAME ?? "Paywall.zip";
  const tagline = process.env.PRODUCT_TAGLINE ?? "The Lightning paywall that paid for itself.";
  const description = process.env.PRODUCT_DESCRIPTION ?? "";
  const priceUsd = Number(process.env.PRICE_USD ?? "49");
  const btcUsd = await getBtcUsd();
  const priceSats = usdToSats(priceUsd, btcUsd);
  const promoCode = (process.env.PROMO_CODE ?? "").toUpperCase();
  const promoSats = Number(process.env.PROMO_PRICE_SATS ?? "500");
  return (
    <Landing
      name={name}
      tagline={tagline}
      description={description}
      priceUsd={priceUsd}
      priceSats={priceSats}
      btcUsd={btcUsd}
      promoCode={promoCode}
      promoSats={promoSats}
    />
  );
}

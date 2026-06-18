import { Checkout } from "./checkout";

const VARIANTS = [
  { title: "Your Audiobook", accent: "#7df9c5", second: "#5cc8ff" },
  { title: "Your Coffee", accent: "#ff8a3d", second: "#ffcc33" },
  { title: "Your Course", accent: "#ff4d8d", second: "#8b5cf6" },
];

export function Landing({
  name,
  tagline,
  description,
  priceUsd,
  priceSats,
  btcUsd,
  promoCode,
  promoSats,
}: {
  name: string;
  tagline: string;
  description: string;
  priceUsd: number;
  priceSats: number;
  btcUsd: number;
  promoCode: string;
  promoSats: number;
}) {
  const [firstLine, secondLine] = tagline.split(/\.\s+/);
  const anchorUsd = Math.round(priceUsd * 1.93);

  return (
    <div className="min-h-screen flex flex-col">
      <nav>
        <div className="max-w-5xl mx-auto px-6 py-6">
          <span className="text-[#ffcc33] text-lg">⚡</span>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-6 py-8 md:py-16">
        <div className="w-full max-w-4xl">
          <div className="text-center mb-14">
            <h1 className="font-bold text-[clamp(2.5rem,7vw,5rem)] leading-[0.95] tracking-[-0.03em]">
              {firstLine}.
              <br />
              <span className="text-[#ffcc33] italic">{secondLine}</span>
            </h1>
            <p className="mt-7 text-lg md:text-xl text-[#aaa] max-w-2xl mx-auto leading-relaxed">
              {description}
            </p>
          </div>

          <div className="relative">
            <div className="absolute -inset-1 rounded-3xl bg-gradient-to-br from-[#ffcc33]/40 via-[#ff8a3d]/20 to-[#7df9c5]/30 opacity-60 blur-xl" />

            <div className="relative grid md:grid-cols-[1.05fr_1fr] gap-0 items-stretch rounded-2xl overflow-hidden border border-white/10 bg-[#0c0c0c]">
              <div className="relative aspect-[4/5] md:aspect-auto bg-gradient-to-br from-[#1a1208] via-[#0c0c0c] to-[#081410] flex items-center justify-center p-10 overflow-hidden">
                <div
                  className="absolute inset-0 opacity-[0.07]"
                  style={{
                    backgroundImage:
                      "linear-gradient(rgba(255,204,51,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,204,51,0.4) 1px, transparent 1px)",
                    backgroundSize: "32px 32px",
                  }}
                />

                <div className="relative w-full max-w-[280px] aspect-[3/4]">
                  {VARIANTS.map((v, i) => {
                    const offset = (i - 1) * 14;
                    const rotate = (i - 1) * 5;
                    const z = i === 1 ? 30 : i === 0 ? 10 : 20;
                    const opacity = i === 1 ? 1 : 0.85;
                    return (
                      <div
                        key={v.title}
                        className="absolute inset-0"
                        style={{
                          transform: `translate(${offset}px, ${offset * 0.6}px) rotate(${rotate}deg)`,
                          zIndex: z,
                          opacity,
                        }}
                      >
                        <MiniPaywall {...v} elevated={i === 1} />
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="p-8 md:p-12 flex flex-col">
                <h2 className="font-bold text-3xl md:text-[2.4rem] leading-[1.05] tracking-tight">{name}</h2>

                <div className="mt-7 space-y-3 text-[#ddd]">
                  <Bullet>Save the weekend you&apos;d spend building it</Bullet>
                  <Bullet>Drop in your product. Set your price. Done.</Bullet>
                  <Bullet>Sats go straight to your wallet</Bullet>
                </div>

                <div className="rule-soft my-8" />

                <div className="flex items-baseline gap-3">
                  <span className="text-[#666] line-through text-xl">${anchorUsd}</span>
                  <span className="text-5xl font-bold tracking-tight">${priceUsd}</span>
                </div>
                <div className="label mt-2 font-mono">
                  ⚡{priceSats.toLocaleString()} sats · one-time
                </div>

                <div className="mt-7">
                  <Checkout name={name} priceSats={priceSats} priceUsd={priceUsd} promoCode={promoCode} promoSats={promoSats} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function MiniPaywall({
  title,
  accent,
  second,
  elevated,
}: {
  title: string;
  accent: string;
  second: string;
  elevated?: boolean;
}) {
  return (
    <div
      className="w-full h-full rounded-xl p-5 flex flex-col border"
      style={{
        background: "#0a0a0a",
        borderColor: elevated ? `${accent}55` : "rgba(255,255,255,0.08)",
        boxShadow: elevated
          ? `0 30px 60px -20px ${accent}40, 0 0 80px -20px ${second}30`
          : "0 8px 24px -12px rgba(0,0,0,0.6)",
      }}
    >
      <div className="flex gap-1.5">
        <div className="w-2 h-2 rounded-full bg-white/15" />
        <div className="w-2 h-2 rounded-full bg-white/15" />
        <div className="w-2 h-2 rounded-full bg-white/15" />
      </div>
      <div className="flex-1 flex flex-col justify-center gap-2">
        <div className="text-[9px] uppercase tracking-widest opacity-60" style={{ color: accent }}>
          Checkout
        </div>
        <div className="text-white font-bold text-base leading-tight">{title}</div>
        <div className="space-y-1.5 mt-2">
          <div className="h-1.5 rounded-full" style={{ background: accent, width: "75%" }} />
          <div className="h-1.5 rounded-full bg-white/15" style={{ width: "45%" }} />
          <div className="h-1.5 rounded-full bg-white/15" style={{ width: "60%" }} />
        </div>
        <div
          className="mt-3 rounded-md h-7 flex items-center justify-center text-[9px] font-bold"
          style={{ background: accent, color: "#0a0a0a" }}
        >
          ⚡ PAY SATS
        </div>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-[15px]">
      <span className="text-[#ffcc33] shrink-0 mt-1 text-xs">✓</span>
      <span>{children}</span>
    </div>
  );
}

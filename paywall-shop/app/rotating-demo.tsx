"use client";

import { useEffect, useState } from "react";

const EXAMPLES = [
  {
    kind: "Audiobook",
    title: "Your Audiobook",
    subtitle: "12 hours of clear, no-fluff lessons.",
    cover: "from-emerald-400/40 via-teal-300/25 to-sky-400/25",
    accent: "#7df9c5",
    badge: "12 hours",
  },
  {
    kind: "Course",
    title: "Your Course",
    subtitle: "Cohort of 12. 4 weekly sessions.",
    cover: "from-pink-400/40 via-purple-300/25 to-orange-300/25",
    accent: "#ff4d8d",
    badge: "Cohort",
  },
  {
    kind: "Physical good",
    title: "Your Mate, 1kg",
    subtitle: "Single-origin Misiones. Ships globally.",
    cover: "from-amber-400/40 via-lime-300/25 to-emerald-400/25",
    accent: "#b85c38",
    badge: "Ships globally",
  },
  {
    kind: "Newsletter",
    title: "Your Newsletter",
    subtitle: "Yearly access. No platform rake.",
    cover: "from-yellow-400/40 via-amber-300/25 to-rose-300/25",
    accent: "#ffcc33",
    badge: "Annual",
  },
  {
    kind: "Coaching",
    title: "Your Coaching Slot",
    subtitle: "60-min 1:1. Pre-paid in sats.",
    cover: "from-orange-400/40 via-amber-300/25 to-rose-300/25",
    accent: "#c97b4a",
    badge: "1 of 4",
  },
];

export function RotatingDemo() {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % EXAMPLES.length), 3500);
    return () => clearInterval(t);
  }, [paused]);

  const e = EXAMPLES[idx];

  return (
    <div
      className="relative max-w-md mx-auto"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="absolute -inset-8 bg-gradient-to-br from-[#ffcc33]/15 to-[#7df9c5]/15 blur-3xl rounded-full pointer-events-none" />

      {/* Example badge above card */}
      <div className="relative flex items-center justify-center gap-2 mb-3">
        <span className="label" style={{ color: e.accent }}>
          ◇ Example {idx + 1} / {EXAMPLES.length} · {e.kind}
        </span>
      </div>

      <div className="relative card rounded-2xl overflow-hidden">
        {/* Cover */}
        <div className={`relative aspect-[5/4] bg-gradient-to-br ${e.cover} flex items-center justify-center transition-all duration-700`}>
          <div className="absolute top-4 left-4 label" style={{ color: e.accent }}>
            {e.badge}
          </div>
          <div className="text-6xl font-bold opacity-10">⚡</div>
          <div className="absolute bottom-4 right-4 label opacity-40">cover photo</div>
        </div>

        {/* Body */}
        <div className="p-7">
          <div className="label">Product</div>
          <h3 className="mt-2 text-3xl font-bold leading-tight">{e.title}</h3>
          <p className="mt-2 text-[#aaa]">{e.subtitle}</p>

          <div className="mt-7 rounded-lg border-2 border-dashed border-white/15 px-4 py-4 text-center">
            <div className="label">Your price · in sats</div>
            <div className="mt-1.5 font-mono text-2xl font-bold text-white/30">⚡ — — —</div>
          </div>

          <div
            className="mt-3 rounded-lg py-3 text-center font-bold opacity-60"
            style={{ background: e.accent, color: "#0a0a0a" }}
          >
            Your CTA → checkout
          </div>

          {/* Pagination dots */}
          <div className="mt-6 flex items-center gap-1.5 justify-center">
            {EXAMPLES.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                aria-label={`go to ${i}`}
                className="h-2 rounded-full transition-all"
                style={{
                  background: i === idx ? e.accent : "rgba(255,255,255,0.15)",
                  width: i === idx ? "20px" : "8px",
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

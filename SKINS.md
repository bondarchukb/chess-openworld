# Skin sets — design descriptions

Each skin set is a complete 6-piece kit (pawn / knight / bishop / rook / queen
/ king) sharing a visual language. The renderer tints army colour onto a
white silhouette + black outline, so every skin must work as a flat
2-tone SVG that reads at 50px and at 400% zoom.

These are descriptions for an AI image generator (Midjourney / SDXL / FLUX) to
produce vector-style assets. Prompt template at the bottom.

---

## 1. Wonderland Royals

Porcelain-doll chess pieces with painted rosy cheeks and ribbon trim. Inspired
by Alice in Wonderland's tea-party court.

| Piece | Description |
|---|---|
| Pawn | A porcelain-doll soldier in pinafore, rabbit-ear hood, single button eye. |
| Knight | A March Hare cavalier — long ears braided like reins, pocket-watch chest, leaping pose. |
| Bishop | A Cheshire abbot — slit grin under a tall mitre, vanishing-stripe robes. |
| Rook | A mushroom turret topped with a small spiraling staircase and a teacup parapet. |
| Queen | The Red Queen in a heart-stamped gown, scepter shaped like a flamingo. |
| King | The Mad Hatter as monarch — tall hat with a 10/6 price tag, monocle, tea-pot scepter. |

Mood: pastel, surreal, kind. Recommended army tints: rose-gold, mint, lilac.

---

## 2. Cypherpunk Sats

Bitcoin-maximalist chess for cypherpunks. Faceless, hooded, terminal-glow.

| Piece | Description |
|---|---|
| Pawn | A hoodie figure clutching a small lightning bolt. Pixelated face mask. |
| Knight | A GPU rig on legs — visible cooling fans, ASIC chassis silhouette. |
| Bishop | A cryptographer in monk robes, holding a private-key scroll. |
| Rook | A vault tower with a circuit-board door and ⚡ engraving. |
| Queen | A miner queen — pickaxe + lightning crown, energy halo. |
| King | Satoshi: a tall hooded figure, blank face, white-paper held over chest. |

Mood: dark, glowing edges, sat orange accents. Tints: orange-amber, electric-purple, terminal-green.

---

## 3. Cosmic Whales

Astral chess. Pieces are silhouettes filled with star fields and orbiting
moons. Reads beautifully at high zoom.

| Piece | Description |
|---|---|
| Pawn | A tiny whale calf with a constellation pattern on its body. |
| Knight | A horse-headed nebula curling into itself. |
| Bishop | A jellyfish bishop, mitre as bell, trailing comets. |
| Rook | A space station tower with rotating ring habitats. |
| Queen | A planet wearing a halo ring, swirl-storm gown. |
| King | A blue giant star wearing a crown of black holes. |

Mood: deep navy + nebula colours. Tints: cobalt, magenta, gold-amber.

---

## 4. Renaissance Marble

Sculpted Carrara-marble chess with patina veining. Reads as classical statuary.

| Piece | Description |
|---|---|
| Pawn | A bare-shoulder cherub holding a small spear, drape clinging. |
| Knight | A rearing classical war-horse half-emerging from a marble block. |
| Bishop | A robed senator with a laurel wreath, scroll across chest. |
| Rook | An ionic-column tower with crumbled top, ivy climbing. |
| Queen | A goddess in flowing chiton, scepter as olive branch. |
| King | A laurelled emperor with a draped cloak, orb in hand. |

Mood: warm cream + slate veins. Tints: cream, ochre, slate-blue.

---

## 5. Cyber-Tarot

Neon arcana chess. Each piece is a tarot card character rendered in
glitch-art holographic line work.

| Piece | Description |
|---|---|
| Pawn | The Fool — a glitch jester mid-step, broken sun overhead. |
| Knight | The Chariot — armored figure on a wireframe horse, twin pillars. |
| Bishop | The Hierophant — neon-haloed cleric with two-finger keypress salute. |
| Rook | The Tower — lightning-struck monolith mid-collapse. |
| Queen | The High Priestess — moon crown, vertical scroll, glowing veins. |
| King | The Emperor — throne welded from circuit boards, ram skull crown. |

Mood: black background, hot-pink + cyan neon. Tints: neon-pink, cyan, lime.

---

## 6. Edo Inkbrush

Japanese sumi-e chess. Each piece is a single-stroke ink figure, deliberately
imperfect, as if painted by a calm master.

| Piece | Description |
|---|---|
| Pawn | A foot-soldier silhouette with a single curving spear stroke. |
| Knight | A leaping samurai on a horse, both rendered in three strokes. |
| Bishop | A robed monk holding a single calligraphy brush vertically. |
| Rook | A pagoda — three offset rooflines, ink wash. |
| Queen | A noble lady in long sleeves, fan held aside. |
| King | An ink-brush shogun, helmet horns visible, hand on katana. |

Mood: rice-paper background, single ink colour, gold-flake accent. Tints: ink-black, gold, vermilion.

---

## 7. Sat Beast (BTC-native flagship)

Designed as the flagship skin for the Bitcoin-hackathon submission: a wild
animal kingdom where every piece radiates sat-orange heat.

| Piece | Description |
|---|---|
| Pawn | A wolverine cub with a tiny lightning-fang. |
| Knight | A snow leopard mid-pounce, eyes glowing orange. |
| Bishop | A snowy owl with a circuit-board halo. |
| Rook | A frozen mammoth carrying an obelisk on its back. |
| Queen | A Bengal tigress wearing a circuit crown, lightning collar. |
| King | A great brown bear standing on hind legs, lightning-bolt scepter raised. |

Mood: fur texture, frost + ember palette, lightning accents. Tints: sat-amber, ice-blue, ember-red.

---

## Prompt template for AI generation

```
flat 2-tone vector chess piece, white fill, black 2-pixel outline, transparent
background, centered, 512x512, no shading, no gradients, no perspective,
silhouette must read clearly when tinted with a single colour, viewBox 45x45
margin, top-down chess-board view. Style: <style name>. Subject: <description from above>.
```

Drop into Midjourney with `--style raw --v 6` or SDXL with negative prompts
`gradient, photoreal, perspective, shadow, background`.

After generation, run through SVGO + a path-tracing pass (potrace) to land
in the format the client tints at runtime.

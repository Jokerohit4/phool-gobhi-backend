# Provenance

The initial collection contains 553 single-frame exercise illustrations,
generated with Codex's built-in image-generation tool for Ironvellum in October
2026 and individually reviewed and approved by Alex Mollard. The catalogue
records the SHA-256 hash of every approved source PNG and exported SVG.

Approved PNGs were imported without image edits or recompression. Filenames were
simplified from `<slug>-1.png` to `<slug>.png` because this collection contains
stills only. Rejected versions, drafts, private review reports, generated-image
service outputs outside the approved collection, and old upstream animations
are excluded.

The initial SVGs wrap the corresponding approved Ironvellum vector paths with a
standard SVG viewBox and the same geometry, translation and even-odd fill rule.
They use `currentColor` instead of an app-specific ink colour. The conversion
tools contain the same thresholding, tracing and centre-line reweighting logic
used to produce those paths; they run locally from the included PNGs.

The house style was inspired by Everkinetic (Greg Priday) and Workout Guide
(Bryl Lim). Their source poses and equipment were used as reference during
replacement work; no source drawing files or original animation geometry are
distributed here. Their CC BY-SA artwork credit is retained in ATTRIBUTION.md.
The project offers this collection under CC BY-SA 4.0 without asserting exclusive
rights over public-domain elements or rights the licensor does not hold.

The PNG-to-SVG tools are FOSS; the original AI image-generation model/service is
not part of this repository. Rebuilding vectors reproduces the vectorization,
not a new AI rendering of the exercise. Source PNGs, reviewed artwork and the
conversion implementation are all available for inspection and modification.

On 2026-10-14, missing far legs in Advanced Tuck Front Lever, Archer Push-up and
Advanced Tuck Planche were corrected with the same built-in image-generation
tool. Alex Mollard approved each replacement, and their SVGs were rebuilt from
the corrected PNGs. The catalogue hashes identify these current approved versions.
